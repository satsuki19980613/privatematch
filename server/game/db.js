// game サーバーの DB 側（DATABASE_URL = データベースの所有者で動く）。1 リクエスト = 1 トランザクション。
//   create / join : 本人の profiles 行をロック（同じ人の同時操作を直列にする）→ 居る部屋の確認 → 部屋の作成・参加（満席で開始）
//   leave / act / sitin / sitout / tick : rooms 行をロック（for update）→ ルールを適用 → 保存（ハンドが終わっていれば room_hands に記録）
// ロックの順番は常に profiles → rooms。
import { randomUUID } from 'node:crypto';
import { MoveError, genCode, createRoom, joinRoom, leaveRoom, applyRequest, tickRoom, viewsOf, dueOf } from './rules.js';

const LOCK_TIMEOUT = '5s';
// 山札のシャッフルに使う乱数（Math.random より良いもの。53 bit）
const secureRnd = () => { const a = crypto.getRandomValues(new Uint32Array(2)); return ((a[0] >>> 5) * 67108864 + (a[1] >>> 6)) / 9007199254740992; };

async function tx(pool, fn) {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query(`set local lock_timeout='${LOCK_TIMEOUT}'`);
    const r = await fn(c);
    await c.query('commit');
    return r;
  } catch (e) {
    await c.query('rollback').catch(() => {});
    // ロック待ちの打ち切り・デッドロック・直列化の失敗：呼び出し側がやり直す
    if (e && ['55P03', '40P01', '40001'].includes(e.code)) throw new MoveError('busy');
    throw e;
  } finally { c.release(); }
}

const COLS = 'id,code,kind,host,config,status,started,members,names,state,ver,(extract(epoch from created_at)*1000)::float8 as created_ms,(extract(epoch from started_at)*1000)::float8 as started_ms';
const toRoom = r => ({
  id: r.id, code: r.code, kind: r.kind, host: r.host, config: r.config, status: r.status, started: r.started,
  members: r.members, names: r.names, state: r.state, ver: r.ver, createdAt: Math.round(r.created_ms), startedAt: r.started_ms == null ? null : Math.round(r.started_ms),
});

export function makeDb(pool, deps = {}) {
  const now = deps.now ?? Date.now, rnd = deps.rnd ?? secureRnd;

  const reply = (room, uid, views = viewsOf(room)) => {
    const pos = room.members.indexOf(uid);
    return { room: room.id, ver: room.ver, now: now(), view: pos < 0 ? null : room.started ? views[pos] : views[0] };
  };

  // 本人のプロフィールをロックして名前を返す
  async function lockMe(c, uid) {
    const r = await c.query('select nickname from public.profiles where uid=$1 for update', [uid]);
    if (!r.rows[0]) throw new MoveError('no_profile');
    return r.rows[0].nickname;
  }
  async function activeRoom(c, uid) {
    const r = await c.query('select public.active_room($1) as id', [uid]);
    return r.rows[0].id;
  }
  async function load(c, id) {
    const r = await c.query(`select ${COLS} from public.rooms where id=$1 for update`, [id]);
    if (!r.rows[0]) throw new MoveError('not_found');
    return toRoom(r.rows[0]);
  }
  async function save(c, room, record) {
    const views = viewsOf(room), ended = !['waiting', 'running', 'paused'].includes(room.status);
    await c.query(`update public.rooms set status=$2,started=$3,members=$4::uuid[],names=$5::text[],state=$6,ver=$7,views=$8,due_ms=$9,updated_at=now(),
        started_at=case when $3 and started_at is null then now() else started_at end,ended_at=case when $10 then coalesce(ended_at,now()) else null end where id=$1`,
      [room.id, room.status, room.started, room.members, room.names, room.state == null ? null : JSON.stringify(room.state), room.ver, JSON.stringify(views), dueOf(room), ended]);
    if (record) {
      await c.query('insert into public.room_hands(room,hand_no,rec,holes) values($1,$2,$3,$4) on conflict do nothing',
        [room.id, record.rec.handNo, JSON.stringify(record.rec), JSON.stringify(record.holes)]);
    }
    return views;
  }
  // 部屋の 1 手（rules の関数を適用して保存）
  const step = fn => (uid, id, ...args) => tx(pool, async c => {
    const room = await load(c, id);
    const out = fn(room, uid, ...args);
    const views = await save(c, out.room, out.record);
    return reply(out.room, uid, views);
  });

  return {
    create: (uid, kind, config) => tx(pool, async c => {
      await c.query('select public.purge_rooms()');
      const name = await lockMe(c, uid);
      const cur = await activeRoom(c, uid);
      if (cur) throw new MoveError('in_other_room', { room: cur });
      for (let i = 0; i < 10; i++) {
        const room = createRoom({ id: randomUUID(), code: genCode(rnd), kind, uid, name, config, now: now() });
        const views = viewsOf(room);
        const r = await c.query(`insert into public.rooms(id,code,kind,host,config,status,started,members,names,ver,views,created_at)
            values($1,$2,$3,$4,$5,'waiting',false,$6::uuid[],$7::text[],$8,$9,to_timestamp($10/1000.0)) on conflict do nothing returning id`,
          [room.id, room.code, room.kind, uid, JSON.stringify(room.config), room.members, room.names, room.ver, JSON.stringify(views), room.createdAt]);
        if (r.rows[0]) return reply(room, uid, views);
      }
      throw new MoveError('busy');
    }),

    join: (uid, code) => tx(pool, async c => {
      await c.query('select public.purge_rooms()');
      const name = await lockMe(c, uid);
      const f = await c.query("select id from public.rooms where code=$1 and status in ('waiting','running','paused') order by created_at desc limit 1", [code]);
      if (!f.rows[0]) throw new MoveError('not_found');
      const room = await load(c, f.rows[0].id);
      if (room.members.includes(uid)) return reply(room, uid);
      const cur = await activeRoom(c, uid);
      if (cur) throw new MoveError('in_other_room', { room: cur });
      const next = joinRoom(room, uid, name, now(), rnd);
      const views = await save(c, next, null);
      return reply(next, uid, views);
    }),

    leave: step((room, uid) => leaveRoom(room, uid, now())),
    request: step((room, uid, req) => applyRequest(room, uid, req, now())),
    tick: step((room, uid) => tickRoom(room, uid, now())),
  };
}
