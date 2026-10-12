// game サーバーの DB 側（DATABASE_URL = データベースの所有者で動く）。1 リクエスト = 1 トランザクション。
//   create / join : 本人の profiles 行をロック（同じ人の同時操作を直列にする）→ 居る部屋の確認 → 部屋の作成・参加（満席で開始）
//   leave / act / sitin / sitout / tick : rooms 行をロック（for update）→ ルールを適用 → 保存（ハンドが終わっていれば room_hands に記録）
//   chat : rooms 行をロック → その席の最後の発言時刻（DB の時計）→ postChat → chat_seq を +1 して room_chat に追加（rooms.ver は変えない）
//   stay : rooms 行をロック → 席に残る（終局後の再戦の受付。演出 GIF を変えていれば再戦の分を書き換える）
//   fx : rooms 行をロック → 演出 GIF を変える（部屋に入った後に設定で変えた分）
//   rematch : 席に残った人の profiles 行をロック → rooms 行をロック → ほかの部屋に居る人を除いて新しい部屋を作って開始 → 元の部屋に rematch.next
//   FRIEND MATCH（kind = friend）: create / join は Discord で確認できた人だけ（friend_ok。そうでなければ not_friend）。終局した手で、全員の結果を friend_results に残す
//   discordCode / discordInteract : 番号での確認（アプリが番号を出し、Discord のサーバーで /link 番号 と打つ。discord.js）
//   discordStart / discordLink : Discord での確認（discord.js）。確認できたら friend_members に鍵付きハッシュと時刻を入れる（同じ Discord アカウントは 1 人だけ）
// ロックの順番は常に profiles → rooms。
// 回数の制限（db/migrations/20261010200000_rate_limit.sql）：create は成功した分を数える（上限を超えたら too_many。ほかの理由で失敗した分は巻き戻るので数えない）。
// join は部屋番号のはずれを数える（はずれをコミットしてから not_found を返す。上限に達していれば番号を調べる前に too_many）。
// flood はリクエストごとに 1 回、トランザクションの外で数える（失敗したリクエストも数える。20261010210000_rate_req.sql）。
import { randomUUID } from 'node:crypto';
import { LINK_REPLY } from './discord.js';
import { MoveError, genCode, createRoom, joinRoom, leaveRoom, applyRequest, tickRoom, viewsOf, dueOf, postChat, stayRoom, rematchRoom, setRoomFx, friendResults } from './rules.js';
import { CHAT_ROOM_MAX } from '../../src/chat.js';
import { secureRnd } from '../../src/rnd.js';

const LOCK_TIMEOUT = '5s';

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

const COLS = 'id,code,kind,host,config,status,started,members,names,fx,state,ver,rematch,(extract(epoch from created_at)*1000)::float8 as created_ms,(extract(epoch from started_at)*1000)::float8 as started_ms';
const toRoom = r => ({
  id: r.id, code: r.code, kind: r.kind, host: r.host, config: r.config, status: r.status, started: r.started,
  members: r.members, names: r.names, fx: r.fx ?? null, state: r.state, ver: r.ver, rematch: r.rematch ?? null, createdAt: Math.round(r.created_ms), startedAt: r.started_ms == null ? null : Math.round(r.started_ms),
});

// uuid の文字列順
const byText = (a, b) => (a < b ? -1 : Number(a > b));

// 本人のプロフィールをロックして名前を返す
async function lockMe(c, uid) {
  const r = await c.query('select nickname from public.profiles where uid=$1 for update', [uid]);
  if (!r.rows[0]) throw new MoveError('no_profile');
  return r.rows[0].nickname;
}
// メンバーとして残す（同じ Discord アカウントは 1 人だけ：ほかの人に付いていた確認は外す）。=> 確認が切れる時刻（ms）
async function saveMember(c, uid, key) {
  await lockMe(c, uid);
  await c.query('delete from public.friend_members where discord_key=$2 and uid<>$1', [uid, key]);
  const r = await c.query(`insert into public.friend_members(uid,discord_key,verified_at) values($1,$2,now())
      on conflict (uid) do update set discord_key=excluded.discord_key,verified_at=excluded.verified_at
      returning floor(extract(epoch from verified_at + public.friend_ttl())*1000)::float8 as until_ms`, [uid, key]);
  return r.rows[0].until_ms;
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
      started_at=case when $3 and started_at is null then now() else started_at end,ended_at=case when $10 then coalesce(ended_at,now()) else null end,rematch=$11,fx=$12 where id=$1`,
    [room.id, room.status, room.started, room.members, room.names, room.state == null ? null : JSON.stringify(room.state), room.ver, JSON.stringify(views), dueOf(room), ended,
      room.rematch == null ? null : JSON.stringify(room.rematch), room.fx == null ? null : JSON.stringify(room.fx)]);
  if (record) {
    await c.query('insert into public.room_hands(room,hand_no,rec,holes) values($1,$2,$3,$4) on conflict do nothing',
      [room.id, record.rec.handNo, JSON.stringify(record.rec), JSON.stringify(record.holes)]);
  }
  return views;
}

// FRIEND MATCH に入れる人か（Discord での確認が切れていない）
async function needFriend(c, uid) {
  if (!(await c.query('select public.friend_ok($1) as ok', [uid])).rows[0].ok) throw new MoveError('not_friend');
}
// 終局した FRIEND MATCH の結果を残す（スタッツとランキングの元。部屋が消えても残る）
async function saveResults(c, room) {
  if (room.kind !== 'friend' || room.status !== 'finished') return;
  const recs = (await c.query('select rec from public.room_hands where room=$1 order by hand_no', [room.id])).rows.map(r => r.rec);
  await c.query(`insert into public.friend_results(room,uid,mode,players,place,pt,hands,vpip,pfr)
      select $1,x.uid,$2,$3,x.place,x.pt,x.hands,x.vpip,x.pfr
      from jsonb_to_recordset($4::jsonb) as x(uid uuid, place int, pt numeric, hands int, vpip int, pfr int) on conflict do nothing`,
    [room.id, room.config.mode, room.config.players, JSON.stringify(friendResults(room, recs))]);
}

// 番号での確認：番号が使える時間と、空いている番号を引き直す回数
const CODE_TTL = '10 minutes', CODE_TRIES = 8;
// コマンドへの返事（type 4 = メッセージ、flags 64 = 打った本人にだけ見える）
const say = text => ({ type: 4, data: { content: text, flags: 64 } });

export function makeDb(pool, deps = {}) {
  const now = deps.now ?? Date.now, rnd = deps.rnd ?? secureRnd, discord = deps.discord ?? null;
  // Discord の確認の回数（10 分に 10 回。OAuth2 も番号も同じ数え方）
  async function discordHit(uid) {
    const hit = await pool.query("select public.rate_hit($1,'discord') as ok", [uid]).catch(e => { if (e?.code === '23503') { throw new MoveError('no_profile'); } throw e; });
    if (!hit.rows[0].ok) throw new MoveError('too_many');
  }

  const reply = (room, uid, views = viewsOf(room)) => {
    const pos = room.members.indexOf(uid);
    return { room: room.id, ver: room.ver, now: now(), view: pos < 0 ? null : room.started ? views[pos] : views[0] };
  };

  // 部屋の 1 手（rules の関数を適用して保存）
  const step = fn => (uid, id, ...args) => tx(pool, async c => {
    const room = await load(c, id);
    const out = fn(room, uid, ...args);
    const views = await save(c, out.room, out.record);
    if (room.status !== 'finished') await saveResults(c, out.room);
    return reply(out.room, uid, views);
  });

  return {
    // 連打の制限（handler がログイン済みのリクエストごとに呼ぶ）。=> 上限の内なら true。neon_auth に居ない人は数えない（この先で no_profile / not_found になる）
    flood: uid => pool.query("select public.rate_hit($1,'req') as ok", [uid]).then(r => r.rows[0].ok, e => { if (e?.code === '23503') { return true; } throw e; }),

    create: (uid, kind, config, fx) => tx(pool, async c => {
      await c.query('select public.purge_rooms()');
      const name = await lockMe(c, uid);
      if (kind === 'friend') await needFriend(c, uid);
      const cur = await activeRoom(c, uid);
      if (cur) throw new MoveError('in_other_room', { room: cur });
      if (!(await c.query("select public.rate_hit($1,'create') as ok", [uid])).rows[0].ok) throw new MoveError('too_many');
      for (let i = 0; i < 10; i++) {
        const room = createRoom({ id: randomUUID(), code: genCode(rnd), kind, uid, name, config, now: now(), fx });
        const views = viewsOf(room);
        const r = await c.query(`insert into public.rooms(id,code,kind,host,config,status,started,members,names,fx,ver,views,created_at)
            values($1,$2,$3,$4,$5,'waiting',false,$6::uuid[],$7::text[],$8,$9,$10,to_timestamp($11/1000.0)) on conflict do nothing returning id`,
          [room.id, room.code, room.kind, uid, JSON.stringify(room.config), room.members, room.names, JSON.stringify(room.fx), room.ver, JSON.stringify(views), room.createdAt]);
        if (r.rows[0]) return reply(room, uid, views);
      }
      throw new MoveError('busy');
    }),

    join: async (uid, code, fx) => {
      const out = await tx(pool, async c => {
        await c.query('select public.purge_rooms()');
        const name = await lockMe(c, uid);
        if ((await c.query("select public.rate_blocked($1,'code') as no", [uid])).rows[0].no) throw new MoveError('too_many');
        const f = await c.query("select id from public.rooms where code=$1 and status in ('waiting','running','paused') order by created_at desc limit 1", [code]);
        if (!f.rows[0]) { await c.query("select public.rate_hit($1,'code')", [uid]); return null; }
        const room = await load(c, f.rows[0].id);
        if (room.members.includes(uid)) return reply(room, uid);
        if (room.kind === 'friend') await needFriend(c, uid);
        const cur = await activeRoom(c, uid);
        if (cur) throw new MoveError('in_other_room', { room: cur });
        const next = joinRoom(room, uid, name, now(), rnd, fx);
        const views = await save(c, next, null);
        return reply(next, uid, views);
      });
      if (!out) throw new MoveError('not_found');
      return out;
    },

    leave: step((room, uid) => leaveRoom(room, uid, now())),
    stay: step((room, uid, fx) => stayRoom(room, uid, now(), fx)),
    setFx: step((room, uid, fx) => setRoomFx(room, uid, fx)),

    // 再戦：席に残った人で同じ設定の新しい部屋を始める。=> 新しい部屋の reply
    rematch: (uid, id, fx) => tx(pool, async c => {
      await c.query('select public.purge_rooms()');
      // ロックの順番（profiles → rooms）を守るため、先にロックせずに残った人を読み、その人たちの profiles をロックしてから部屋をロックする
      const pre = await c.query('select members,rematch from public.rooms where id=$1', [id]);
      if (!pre.rows[0]) throw new MoveError('not_found');
      const stay = (pre.rows[0].rematch?.stay ?? []).map(s => pre.rows[0].members[s]);
      const uids = [...new Set([uid, ...stay])].filter(Boolean).sort(byText);
      const prof = await c.query('select uid,nickname from public.profiles where uid = any($1::uuid[]) order by uid for update', [uids]);
      if (!prof.rows.some(r => r.uid === uid)) throw new MoveError('no_profile');
      const names = new Map(prof.rows.map(r => [r.uid, r.nickname]));
      const room = await load(c, id);
      const busy = new Set();
      for (const u of room.members) if (u !== uid && (room.rematch?.stay ?? []).includes(room.members.indexOf(u)) && (!names.has(u) || await activeRoom(c, u))) busy.add(u);
      for (let i = 0; i < 10; i++) {
        const out = rematchRoom(room, uid, { id: randomUUID(), code: genCode(rnd), names, busy, fx }, now(), rnd);
        const next = out.next, views = viewsOf(next);
        const r = await c.query(`insert into public.rooms(id,code,kind,host,config,status,started,members,names,fx,state,ver,views,due_ms,created_at,started_at)
            values($1,$2,$3,$4,$5,$6,true,$7::uuid[],$8::text[],$9,$10,$11,$12,$13,to_timestamp($14/1000.0),now()) on conflict do nothing returning id`,
          [next.id, next.code, next.kind, next.host, JSON.stringify(next.config), next.status, next.members, next.names, JSON.stringify(next.fx), JSON.stringify(next.state), next.ver, JSON.stringify(views), dueOf(next), next.createdAt]);
        if (!r.rows[0]) continue;
        await save(c, out.room, null);
        return reply(next, uid, views);
      }
      throw new MoveError('busy');
    }),
    request: step((room, uid, req) => applyRequest(room, uid, req, now())),

    // Discord の同意の画面へ（state はその人に出す。discord.js）。=> { url }
    discordStart: async (uid, redirect) => {
      if (!discord) throw new MoveError('friend_off');
      return { url: discord.authorizeUrl(redirect, discord.stateFor(uid, now())) };
    },
    // Discord から戻った code を確かめ、メンバーなら friend_members に入れる。=> { ok: true, until }
    // state がその人に出したものでなければ断る（ほかの人の code を混ぜられない）。
    // 回数は Discord に問い合わせる前に数える（失敗した分も数える）。メンバーでなければ前の確認も消す（サーバーを抜けた人）
    discordLink: async (uid, { code, state }, redirect) => {
      if (!discord) throw new MoveError('friend_off');
      if (!discord.checkState(state, uid, now())) throw new MoveError('discord_failed');
      await discordHit(uid);
      const v = await discord.verify(code, redirect);
      if (!v.member) {
        await pool.query('delete from public.friend_members where uid=$1', [uid]);
        throw new MoveError('not_member');
      }
      return tx(pool, async c => ({ ok: true, until: await saveMember(c, uid, v.key) }));
    },
    // 番号での確認：その人の番号を出す（前の番号は消す。10 分だけ使える）。=> { code, until, guild }
    discordCode: async uid => {
      if (!discord?.interactions) throw new MoveError('friend_off');
      await discordHit(uid);
      return tx(pool, async c => {
        await lockMe(c, uid);
        await c.query('delete from public.friend_codes where uid=$1 or expires_at <= now()', [uid]);
        // 候補をいくつか引き、まだ使われていない最初の 1 つを入れる
        const tries = Array.from({ length: CODE_TRIES }, () => genCode(rnd));
        const r = await c.query(`insert into public.friend_codes(code,uid,expires_at)
            select t.c, $2, now() + interval '${CODE_TTL}' from unnest($1::text[]) with ordinality as t(c, i)
            where not exists (select 1 from public.friend_codes f where f.code = t.c) order by t.i limit 1
            on conflict (code) do nothing returning code, floor(extract(epoch from expires_at)*1000)::float8 as until_ms`, [tries, uid]);
        if (!r.rows[0]) throw new MoveError('busy');
        return { code: r.rows[0].code, until: r.rows[0].until_ms, guild: discord.guild };
      });
    },
    // Discord からの呼び出し（Interactions）。raw = 本文そのまま（署名はこれに付いている）。
    // => Discord に返す JSON。署名が合わなければ null（401 にする）
    discordInteract: async (raw, signature, timestamp) => {
      if (!discord?.checkSignature(raw, signature, timestamp)) return null;
      let body = null;
      try { body = JSON.parse(raw); } catch { /* 読めなければ「使えません」と返す */ }
      const it = discord.readInteraction(body);
      if (it.type === 'pong') return { type: 1 };
      if (it.type !== 'claim') return say(it.text);
      // 番号は 1 回で消す。その番号を出した人をメンバーにする
      const ok = await tx(pool, async c => {
        const f = await c.query('delete from public.friend_codes where code=$1 and expires_at > now() returning uid', [it.code]);
        if (!f.rows[0]) return false;
        await saveMember(c, f.rows[0].uid, it.key);
        return true;
      });
      return say(ok ? LINK_REPLY.ok : LINK_REPLY.badCode);
    },
    tick: step((room, uid) => tickRoom(room, uid, now())),

    // チャットの発言。=> { now, msg: { seq, seat, text, at } }（時刻は DB の時計。room_chat の at と同じ）
    chat: (uid, id, text) => tx(pool, async c => {
      const r = await c.query('select kind,started,members,chat_seq from public.rooms where id=$1 for update', [id]);
      if (!r.rows[0]) throw new MoveError('not_found');
      const room = r.rows[0], seat = room.members.indexOf(uid);
      // 時刻はミリ秒で切りそろえる（room_chat の at = floor(created_at の epoch ms) と一致させる）
      const t = await c.query(`select floor(extract(epoch from clock_timestamp())*1000)::float8 as now_ms,
          (select (extract(epoch from max(created_at))*1000)::float8 from public.room_chat where room=$1 and seat=$2) as last_ms`, [id, seat]);
      const at = t.rows[0].now_ms;
      const out = postChat(room, uid, text, t.rows[0].last_ms, at);
      if (room.chat_seq >= CHAT_ROOM_MAX) throw new MoveError('chat_full');
      const u = await c.query('update public.rooms set chat_seq=chat_seq+1 where id=$1 returning chat_seq', [id]);
      const seq = u.rows[0].chat_seq;
      await c.query("insert into public.room_chat(room,seq,seat,text,created_at) values($1,$2,$3,$4,'epoch'::timestamptz + $5::bigint * interval '1 millisecond')",
        [id, seq, out.seat, out.text, at]);
      return { now: at, msg: { seq, seat: out.seat, text: out.text, at } };
    }),
  };
}
