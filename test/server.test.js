// 部屋のルール（rules.js）・HTTP（handler.js）の単体テストと、TEST_DATABASE_URL があるときだけ動く DB の結合テスト。
// 結合テストのデータベースには neon_auth."user"(id uuid) と anonymous / authenticated ロールを用意し、db/migrations を適用しておく
// （docs/ARCHITECTURE.md §7）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRoom, joinRoom, leaveRoom, applyRequest, tickRoom, viewsOf, MoveError } from '../server/game/rules.js';
import { createHandler } from '../server/game/handler.js';
import { makeDb } from '../server/game/db.js';
import { DEFAULT_CONFIG, WAITING_EXPIRES_MS } from '../src/structure.js';
import { legalActions } from '../src/engine.js';

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const U = i => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const cfg3 = { ...DEFAULT_CONFIG, players: 3 };

test('部屋：満席で開始し、席はシャッフルされ、ビューは自分の手札だけ', () => {
  let r = createRoom({ id: 'r', code: '123456', kind: 'private', uid: U(1), name: 'A', config: cfg3, now: 0 });
  assert.equal(viewsOf(r).length, 1); assert.equal(viewsOf(r)[0].lobby, true);
  r = joinRoom(r, U(2), 'B', 10, rng(1));
  assert.equal(r.started, false);
  assert.throws(() => applyRequest(r, U(1), { op: 'sitout' }, 11), e => e.code === 'not_started');
  r = joinRoom(r, U(3), 'C', 20, rng(1));
  assert.equal(r.started, true); assert.equal(r.status, 'running');
  assert.deepEqual([...r.members].sort(), [U(1), U(2), U(3)]);
  const vs = viewsOf(r);
  assert.equal(vs.length, 3);
  vs.forEach((v, s) => { assert.equal(v.seat, s); assert.ok(v.hand.hole[s]); assert.equal(v.hand.hole.filter(Boolean).length, 1); assert.equal(v.hand.deck, undefined); });
  assert.throws(() => joinRoom(r, U(4), 'D', 30, rng(1)), e => e.code === 'room_closed');
});

test('部屋：満員・期限切れ・作成者の退出で中止', () => {
  let r = createRoom({ id: 'r', code: '000001', kind: 'free', uid: U(1), name: 'A', config: { ...DEFAULT_CONFIG, players: 3 }, now: 0 });
  assert.throws(() => joinRoom(r, U(2), 'B', WAITING_EXPIRES_MS, rng(1)), e => e.code === 'room_closed');
  r = joinRoom(r, U(2), 'B', 5, rng(1));
  const left = leaveRoom(r, U(2), 6).room;
  assert.deepEqual(left.members, [U(1)]);
  const cancelled = leaveRoom(r, U(1), 7).room;
  assert.equal(cancelled.status, 'cancelled');
});

test('部屋：アクションは ver を確かめ、ハンドが終わると記録を返す', () => {
  let r = createRoom({ id: 'r', code: '000002', kind: 'private', uid: U(1), name: 'A', config: { ...DEFAULT_CONFIG, players: 2 }, now: 0 });
  r = joinRoom(r, U(2), 'B', 1, rng(2));
  const s = r.state.hand.toAct, uid = r.members[s];
  assert.throws(() => applyRequest(r, uid, { op: 'act', ver: r.ver - 1, move: { type: 'fold' } }, 2), e => e.code === 'stale');
  assert.throws(() => applyRequest(r, r.members[1 - s], { op: 'act', ver: r.ver, move: { type: 'fold' } }, 2), e => e.code === 'not_your_turn');
  const out = applyRequest(r, uid, { op: 'act', ver: r.ver, move: { type: 'fold' } }, 2);
  assert.ok(out.record); assert.equal(out.record.rec.handNo, 1); assert.equal(out.record.holes.filter(Boolean).length, 2);
  assert.ok(out.record.rec.shown.every(x => x === null));     // 降ろして終わったハンドは誰も公開しない
  assert.throws(() => tickRoom(out.room, uid, 3), e => e.code === 'not_yet');
  const t = tickRoom(out.room, uid, 2 + 3000);
  assert.equal(t.room.state.hand.handNo, 2); assert.equal(t.record, null);
});

test('HTTP：認証・入力の検証・エラーの対応', async () => {
  const calls = [];
  const h = createHandler({
    allowedOrigins: ['https://app.example'],
    verifyToken: async t => (t === 'good' ? U(1) : null),
    create: async (uid, kind, config) => { calls.push(['create', uid, kind, config]); return { room: 'x' }; },
    join: async (uid, code) => { if (code === '999999') throw new MoveError('room_full'); return { room: 'y' }; },
    leave: async () => ({}), request: async (uid, room, req) => { calls.push(['req', req]); return {}; }, tick: async () => { throw new MoveError('not_yet'); },
    logError: () => {},
  });
  const post = (body, token = 'good') => h(new Request('https://f/', { method: 'POST', headers: { Authorization: `Bearer ${token}`, Origin: 'https://app.example' }, body: JSON.stringify(body) }));
  assert.equal((await post({ op: 'create', kind: 'free', config: {} }, 'bad')).status, 401);
  const ok = await post({ op: 'create', kind: 'free', config: { players: 2 } });
  assert.equal(ok.status, 200); assert.equal(ok.headers.get('Access-Control-Allow-Origin'), 'https://app.example');
  assert.equal((await post({ op: 'create', kind: 'secret', config: {} })).status, 422);
  assert.equal((await post({ op: 'join', code: '12345' })).status, 422);
  const full = await post({ op: 'join', code: '999999' });
  assert.equal(full.status, 409); assert.deepEqual(await full.json(), { error: 'room_full' });
  assert.equal((await post({ op: 'act', room: U(9), ver: 3, move: { type: 'call' } })).status, 200);
  assert.deepEqual(calls.at(-1), ['req', { op: 'act', ver: 3, move: { type: 'call' } }]);
  assert.equal((await post({ op: 'tick', room: U(9) })).status, 409);
  assert.equal((await post({ op: 'sitin', room: 'nope' })).status, 422);
  assert.equal((await h(new Request('https://f/', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } }))).headers.get('Access-Control-Allow-Origin'), null);
});

// ---------------- DB の結合テスト ----------------
const DBURL = process.env.TEST_DATABASE_URL;
test('DB：作成 → 番号で参加 → 開始 → 対局 → 記録と RPC', { skip: !DBURL && 'TEST_DATABASE_URL が無い' }, async () => {
  const pg = (await import('pg')).default;
  const pool = new pg.Pool({ connectionString: DBURL, max: 4 });
  try {
    await pool.query('truncate public.rooms, public.profiles cascade; delete from neon_auth."user"');
    for (let i = 1; i <= 4; i++) await pool.query('insert into neon_auth."user"(id) values($1)', [U(i)]);
    // RPC を本人として呼ぶ（Data API と同じく request.jwt.claims を入れて authenticated で実行）
    const rpc = async (uid, fn, args = []) => {
      const c = await pool.connect();
      try {
        await c.query('begin');
        await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: 'authenticated' })]);
        await c.query('set local role authenticated');
        const r = await c.query(`select public.${fn}(${args.map((_, i) => '$' + (i + 1)).join(',')}) as x`, args);
        await c.query('commit');
        return r.rows[0].x;
      } catch (e) { await c.query('rollback'); throw e; } finally { c.release(); }
    };
    for (let i = 1; i <= 4; i++) await rpc(U(i), 'me');
    await rpc(U(1), 'set_nickname', ['Alice']);
    await assert.rejects(rpc(U(2), 'set_nickname', ['alice']), /nickname_taken/);

    let t = Date.now();
    const db = makeDb(pool, { now: () => t, rnd: rng(5) });
    const a = await db.create(U(1), 'free', { ...DEFAULT_CONFIG, players: 3 });
    assert.equal(a.view.lobby, true);
    await assert.rejects(db.create(U(1), 'private', DEFAULT_CONFIG), e => e.code === 'in_other_room');
    const code = (await rpc(U(2), 'room_peek', [a.view.room.code])).code;
    assert.equal(code, a.view.room.code);
    const free = await rpc(U(4), 'free_rooms');
    assert.equal(free.length, 1); assert.equal(free[0].host, 'Alice');
    assert.equal((await rpc(U(1), 'me')).room.id, a.room);
    await db.join(U(2), code);
    const started = await db.join(U(3), code);
    assert.equal(started.view.status, 'running');
    assert.equal((await rpc(U(4), 'free_rooms')).length, 0);
    await assert.rejects(db.join(U(4), code), e => e.code === 'room_closed');
    await assert.rejects(rpc(U(4), 'room_poll', [a.room, -1]), /not_found/);

    // 全員がチェック/コールで最後まで打つ
    let guard = 0;
    for (;;) {
      if (++guard > 5000) throw new Error('too long');
      t += 1000;
      const polls = await Promise.all([U(1), U(2), U(3)].map(u => rpc(u, 'room_poll', [a.room, -1])));
      const v = polls[0].view;
      if (v.status !== 'running') break;
      if (v.hand.phase === 'settled') { t = Math.max(t, v.nextAt); await db.tick(U(1), a.room); continue; }
      const me = polls.map(p => p.view).find(x => x.seat === x.hand.toAct);
      const L = legalActions(me);
      const uid = [U(1), U(2), U(3)][polls.findIndex(p => p.view === me)];
      const move = L.minTo != null && guard % 7 === 0 ? { type: 'allin' } : L.canCheck ? { type: 'check' } : { type: 'call' };
      await db.request(uid, a.room, { op: 'act', ver: me.ver, move });
    }
    const fin = await rpc(U(1), 'room_poll', [a.room, -1]);
    assert.equal(fin.view.status, 'finished');
    assert.deepEqual(fin.view.players.map(p => p.place).sort(), [1, 2, 3]);
    const hands = await rpc(U(2), 'room_hands', [a.room, 0]);
    assert.ok(hands.length >= 1);
    const seat2 = (await rpc(U(2), 'room_poll', [a.room, -1])).view.seat;
    for (const h of hands) {
      if (h.startStacks[seat2] > 0) assert.equal(h.hole.length, 2); else assert.equal(h.hole, null);
      h.shown.forEach((c, s) => { if (c) assert.ok(!h.actions.some(x => x.seat === s && x.kind === 'fold')); });
    }
    assert.equal((await rpc(U(1), 'me')).room, null);
    assert.equal((await rpc(U(1), 'me')).recent[0].id, a.room);
    // 終わったので別の部屋を作れる
    const b = await db.create(U(1), 'private', DEFAULT_CONFIG);
    assert.equal(b.view.room.kind, 'private');
    await db.leave(U(1), b.room);
    assert.equal((await rpc(U(1), 'room_poll', [b.room, -1])).view.status, 'cancelled');
  } finally { await pool.end(); }
});

test('マイグレーションのファイル名は時刻順', () => {
  const fs = readdirSync(new URL('../db/migrations/', import.meta.url)).filter(f => f.endsWith('.sql'));
  assert.deepEqual(fs, [...fs].sort());
  for (const f of fs) assert.match(readFileSync(new URL('../db/migrations/' + f, import.meta.url), 'utf8'), /\S/);
});
