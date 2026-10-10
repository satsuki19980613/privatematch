// 卓のチャット：src/chat.js（幅・切り詰め・正規化）、rules.js の postChat、handler.js の op chat の単体テストと、
// TEST_DATABASE_URL があるときだけ動く DB の結合テスト（専用のデータベースを作って db/migrations を適用する。qa-server.test.js と同じ流儀）。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { CHAT_MAX_UNITS, CHAT_MIN_INTERVAL_MS, CHAT_ROOM_MAX, BUBBLE_MAX_UNITS, chatUnits, clipChat, normalizeChat, splitChat } from '../src/chat.js';
import { createRoom, joinRoom, leaveRoom, postChat, MoveError } from '../server/game/rules.js';
import { createHandler, STATUS } from '../server/game/handler.js';
import { makeDb } from '../server/game/db.js';
import { DEFAULT_CONFIG } from '../src/structure.js';

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const U = i => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const ch = cp => String.fromCodePoint(cp);
const ZWJ = ch(0x200d), VS16 = ch(0xfe0f), ACUTE = ch(0x301);

test('chat：定数', () => {
  assert.equal(CHAT_MAX_UNITS, 80); assert.equal(CHAT_MIN_INTERVAL_MS, 1000); assert.equal(CHAT_ROOM_MAX, 2000);
});

test('chatUnits：全角（W/F・絵文字）は 2、それ以外は 1（コードポイント単位）', () => {
  assert.equal(chatUnits(''), 0);
  assert.equal(chatUnits('abc 1!'), 6);
  assert.equal(chatUnits('あいう'), 6);                 // ひらがな
  assert.equal(chatUnits('カタカナー'), 10);
  assert.equal(chatUnits('ｱｲｳ'), 3);                    // 半角カナは 1
  assert.equal(chatUnits('漢字'), 4);
  assert.equal(chatUnits('𠮷'), 2);                      // CJK 拡張 B（サロゲートペアでも 1 文字）
  assert.equal(chatUnits('한국'), 4);
  assert.equal(chatUnits('ＡＢ１！'), 8);                // 全角英数（FF01–FF60）
  assert.equal(chatUnits('￥￡'), 4);                    // FFE0–FFE6
  assert.equal(chatUnits('。、「」'), 8);                // CJK の記号
  assert.equal(chatUnits(ch(0x3000)), 2);                // 全角スペース
  assert.equal(chatUnits('😀🃏'), 4);
  assert.equal(chatUnits('👍🏽'), 4);                      // 肌の色も 2
  assert.equal(chatUnits('❤'), 1);                      // 文字の見た目が既定の記号は 1
  assert.equal(chatUnits('❤' + VS16), 2);                // 異体字セレクタ付きで 2
  assert.equal(chatUnits('©éß'), 3);
  assert.equal(chatUnits('e' + ACUTE), 2);               // 結合文字も 1
  assert.equal(chatUnits(null), 0);
});

test('clipChat：上限ちょうどまで。書記素の途中では切らない', () => {
  assert.equal(clipChat('a'.repeat(80)), 'a'.repeat(80));
  assert.equal(clipChat('a'.repeat(81)), 'a'.repeat(80));
  assert.equal(clipChat('あ'.repeat(40)), 'あ'.repeat(40));
  assert.equal(clipChat('あ'.repeat(41)), 'あ'.repeat(40));
  assert.equal(clipChat('a'.repeat(79) + 'あ'), 'a'.repeat(79));            // 全角は 2 なので入らない
  assert.equal(clipChat('a'.repeat(78) + 'あい'), 'a'.repeat(78) + 'あ');
  assert.equal(clipChat('a'.repeat(79) + '😀'), 'a'.repeat(79));             // サロゲートペアを割らない
  assert.equal(clipChat('a'.repeat(77) + '👍🏽'), 'a'.repeat(77));            // 絵文字＋肌の色（4）を割らない
  assert.equal(clipChat('a'.repeat(80) + 'e' + ACUTE), 'a'.repeat(80));     // 結合文字を割らない
  assert.equal(clipChat('a'.repeat(79) + 'e' + ACUTE), 'a'.repeat(79) + 'e' + ACUTE); // 幅は NFC で数える（é = 1）
  const fam = '👨' + ZWJ + '👩' + ZWJ + '👧';                               // 8
  assert.equal(clipChat('a'.repeat(73) + fam), 'a'.repeat(73));
  assert.equal(clipChat('a'.repeat(72) + fam + 'b'), 'a'.repeat(72) + fam);
  assert.equal(clipChat(''), '');
  for (const s of ['x'.repeat(200), 'あ'.repeat(60) + 'abc', '😀'.repeat(50)]) assert.ok(chatUnits(clipChat(s)) <= CHAT_MAX_UNITS);
  // 切った結果はそのまま送れる
  assert.equal(normalizeChat(clipChat('あ'.repeat(60))), 'あ'.repeat(40));
});

test('normalizeChat：空白類・見えない文字・NFC・上限', () => {
  for (const v of [undefined, null, 1, {}, [], true]) assert.equal(normalizeChat(v), null);
  for (const v of ['', ' ', '\n\t', ch(0x3000), ch(0x200b), ch(0x202e) + ch(0xfeff)]) assert.equal(normalizeChat(v), null, JSON.stringify(v));
  assert.equal(normalizeChat('  nice  hand  '), 'nice hand');
  assert.equal(normalizeChat('a\r\nb\tc\vd'), 'a b c d');
  assert.equal(normalizeChat('よろしく' + ch(0x3000) + ch(0x3000) + 'ね'), 'よろしく ね');       // 全角スペースは半角 1 つに
  assert.equal(normalizeChat('a' + ch(0xa0) + 'b' + ch(0x2028) + 'c'), 'a b c');
  // set_nickname と同じ集合（見えない文字・ゼロ幅・方向制御）と制御文字は消す
  for (const cp of [0x0, 0x7, 0x1b, 0x7f, 0x84, 0x9f, 0xad, 0x34f, 0x61c, 0x115f, 0x1160, 0x17b4, 0x17b5, 0x180b, 0x180e, 0x200b, 0x200c, 0x200e, 0x200f,
    0x202a, 0x202e, 0x2060, 0x2066, 0x2069, 0x206f, 0x2800, 0x3164, 0xfeff, 0xffa0, 0xfff9, 0xfffc])
    assert.equal(normalizeChat('a' + ch(cp) + 'b'), 'ab', cp.toString(16));
  assert.equal(normalizeChat('a' + '\ud800' + 'b'), 'ab');                                    // 孤立サロゲート
  // ZWJ は絵文字どうしをつなぐものだけ残す
  const fam = '👨' + ZWJ + '👩' + ZWJ + '👧';
  assert.equal(normalizeChat(fam), fam);
  assert.equal(normalizeChat('❤' + VS16 + ZWJ + '🔥'), '❤' + VS16 + ZWJ + '🔥');
  assert.equal(normalizeChat('a' + ZWJ + 'b'), 'ab');
  assert.equal(normalizeChat(ZWJ + '😀' + ZWJ), '😀');
  // NFC（消した文字の両側も合成する）
  assert.equal(normalizeChat('e' + ACUTE), 'é');
  assert.equal(normalizeChat('e' + ch(0x200b) + ACUTE), 'é');
  assert.equal(normalizeChat('か' + ch(0x3099)), 'が');
  // 上限：ちょうどは通す・超えたら null（切らない）
  assert.equal(normalizeChat('a'.repeat(80)), 'a'.repeat(80));
  assert.equal(normalizeChat('a'.repeat(81)), null);
  assert.equal(normalizeChat('あ'.repeat(40)), 'あ'.repeat(40));
  assert.equal(normalizeChat('あ'.repeat(40) + 'a'), null);
  assert.equal(normalizeChat('  ' + 'あ'.repeat(40) + '\n'), 'あ'.repeat(40));                  // 前後の空白は数えない
  assert.equal(normalizeChat('a' + ' '.repeat(50) + 'b'), 'a b');                               // 連続スペースは 1 つにしてから数える
  assert.equal(normalizeChat('a'.repeat(79) + ch(0x200b).repeat(10)), 'a'.repeat(79));
  assert.equal(normalizeChat('e' + ACUTE).length, 1);
});

// ---------------- rules.js の postChat ----------------
function startedRoom(kind, n = 3) {
  let r = createRoom({ id: 'r', code: '123456', kind, uid: U(1), name: 'A', config: { ...DEFAULT_CONFIG, players: n }, now: 0 });
  for (let i = 2; i <= n; i++) r = joinRoom(r, U(i), String.fromCharCode(64 + i), i, rng(7));
  return r;
}
const code = c => e => e instanceof MoveError && e.code === c;

test('postChat：席・文の正規化・連投の間隔', () => {
  const r = startedRoom('private');
  const seat = r.members.indexOf(U(2));
  assert.deepEqual(postChat(r, U(2), '  よろしく\nね ', null, 5000), { seat, text: 'よろしく ね' });
  assert.deepEqual(postChat(r, U(2), 'gg', 4000, 5000), { seat, text: 'gg' });              // ちょうど 1 秒は送れる
  assert.throws(() => postChat(r, U(2), 'gg', 4001, 5000), code('too_fast'));
  assert.throws(() => postChat(r, U(2), 'gg', 5000, 5000), code('too_fast'));
  assert.throws(() => postChat(r, U(9), 'gg', null, 5000), code('not_found'));
  for (const t of ['', '   ', ch(0x200b), 'a'.repeat(81), 'あ'.repeat(41), 42, null, undefined, { text: 'x' }])
    assert.throws(() => postChat(r, U(1), t, null, 5000), code('malformed'), JSON.stringify(t));
  // 部屋は変えない（ver も上げない）
  const before = structuredClone(r);
  postChat(r, U(1), 'nice', null, 5000);
  assert.deepEqual(r, before);
});

test('postChat：PRIVATE MATCH の開始後だけ（終局後も送れる。FREE MATCH・待機中は chat_closed）', () => {
  assert.throws(() => postChat(startedRoom('free'), U(1), 'hi', null, 10), code('chat_closed'));
  const waiting = createRoom({ id: 'w', code: '000001', kind: 'private', uid: U(1), name: 'A', config: { ...DEFAULT_CONFIG, players: 3 }, now: 0 });
  assert.throws(() => postChat(waiting, U(1), 'hi', null, 10), code('chat_closed'));
  assert.throws(() => postChat(waiting, U(2), 'hi', null, 10), code('not_found'));        // メンバーでないほうが先
  // 2 人の部屋で 1 人が退出 → 終局。どちらも送れる
  const r = startedRoom('private', 2);
  const fin = leaveRoom(r, U(1), 100).room;
  assert.equal(fin.status, 'finished');
  assert.equal(postChat(fin, U(2), 'gg', null, 200).text, 'gg');
  assert.equal(postChat(fin, U(1), 'gg', null, 200).text, 'gg');
  assert.throws(() => postChat({ ...fin, status: 'cancelled' }, U(1), 'gg', 150, 200), code('too_fast'));
  // 順番：chat_closed は malformed・too_fast より先
  assert.throws(() => postChat(startedRoom('free'), U(1), '', 0, 1), code('chat_closed'));
  assert.throws(() => postChat(r, U(1), '', 0, 1), code('malformed'));
});

// ---------------- handler.js の op chat ----------------
test('HTTP：op chat の検証と振り分け', async () => {
  assert.equal(STATUS.chat_closed, 409); assert.equal(STATUS.too_fast, 429); assert.equal(STATUS.chat_full, 409);
  const calls = [];
  let fail = null;
  const h = createHandler({
    allowedOrigins: ['https://app.example'],
    verifyToken: async t => (t === 'good' ? U(1) : null),
    chat: async (uid, room, text) => { calls.push([uid, room, text]); if (fail) throw new MoveError(fail); return { now: 1, msg: { seq: 1, seat: 0, text, at: 1 } }; },
    logError: () => {},
  });
  const post = (body, token = 'good') => h(new Request('https://f/', { method: 'POST', headers: { Authorization: `Bearer ${token}`, Origin: 'https://app.example' }, body: JSON.stringify(body) }));
  assert.equal((await post({ op: 'chat', room: U(9), text: 'hi' }, 'bad')).status, 401);
  const ok = await post({ op: 'chat', room: U(9), text: ' hi ' });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { now: 1, msg: { seq: 1, seat: 0, text: ' hi ', at: 1 } });
  assert.deepEqual(calls, [[U(1), U(9), ' hi ']]);                   // 正規化は deps（postChat）がする
  for (const body of [{ op: 'chat', text: 'hi' }, { op: 'chat', room: 'nope', text: 'hi' }, { op: 'chat', room: U(9) }, { op: 'chat', room: U(9), text: 5 },
    { op: 'chat', room: U(9), text: null }, { op: 'chat', room: U(9), text: ['hi'] }]) {
    const r = await post(body);
    assert.equal(r.status, 422, JSON.stringify(body)); assert.deepEqual(await r.json(), { error: 'malformed' });
  }
  assert.equal(calls.length, 1);
  for (const [c, s] of [['too_fast', 429], ['chat_closed', 409], ['chat_full', 409], ['not_found', 404], ['malformed', 422], ['busy', 409]]) {
    fail = c;
    const r = await post({ op: 'chat', room: U(9), text: 'hi' });
    assert.equal(r.status, s, c); assert.deepEqual(await r.json(), { error: c });
  }
  // 大きすぎる本文はバイト数で 422
  fail = null;
  assert.equal((await post({ op: 'chat', room: U(9), text: 'あ'.repeat(2000) })).status, 422);
});

test('マイグレーション：チャットは追加のファイルで、room_poll に chat を足す', () => {
  const dir = new URL('../db/migrations/', import.meta.url);
  const fs = readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  assert.ok(fs.includes('20261007000000_chat.sql'));
  const sql = readFileSync(new URL('20261007000000_chat.sql', dir), 'utf8');
  assert.match(sql, /create table public\.room_chat/);
  assert.match(sql, /alter table public\.room_chat enable row level security/);
  assert.match(sql, /'chat', coalesce\(r\.chat_seq, 0\)/);
  assert.match(sql, /grant execute on function public\.room_poll\(uuid, int\), public\.room_chat\(uuid, int\) to authenticated/);
});

// ---------------- DB の結合テスト ----------------
const DBURL = process.env.TEST_DATABASE_URL;
describe('DB：チャット（専用 DB）', { skip: !DBURL && 'TEST_DATABASE_URL が無い' }, () => {
  let admin, pool, dbName;
  const urlFor = name => { const u = new URL(DBURL); u.pathname = '/' + name; return u.toString(); };
  async function as(role, claims, sql, args = []) {
    const c = await pool.connect();
    try {
      await c.query('begin');
      if (claims !== undefined) await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
      await c.query(`set local role ${role}`);
      const r = await c.query(sql, args);
      await c.query('commit');
      return r.rows;
    } catch (e) { await c.query('rollback').catch(() => {}); throw e; } finally { c.release(); }
  }
  const rpc = (uid, fn, args = []) => as('authenticated', { sub: uid, role: 'authenticated' }, `select public.${fn}(${args.map((_, i) => '$' + (i + 1)).join(',')}) as x`, args).then(r => r[0].x);
  async function newUsers(n) {
    const us = Array.from({ length: n }, () => randomUUID());
    for (const u of us) { await pool.query('insert into neon_auth."user"(id) values($1)', [u]); await rpc(u, 'me'); }
    return us;
  }
  const rejectsCode = (p, c) => assert.rejects(p, e => e.code === c || new RegExp(c).test(e.message));
  // 席の最後の発言を過去にずらす（連投の間隔を待たずに次を送るため）
  const age = (room, ms = 2000) => pool.query(`update public.room_chat set created_at = created_at - make_interval(secs => $2::float8 / 1000) where room = $1`, [room, ms]);

  before(async () => {
    const pg = (await import('pg')).default;
    admin = new pg.Pool({ connectionString: DBURL, max: 2 });
    admin.on('error', () => {});
    dbName = `chat_test_${process.pid}_${Date.now()}`;
    await admin.query(`create database ${dbName} template template0 encoding 'UTF8'`);
    pool = new pg.Pool({ connectionString: urlFor(dbName), max: 8 });
    pool.on('error', () => {});
    await pool.query(`do $$ begin
      if not exists (select from pg_roles where rolname = 'anonymous') then create role anonymous; end if;
      if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated; end if; end $$`);
    await pool.query('create schema neon_auth; create table neon_auth."user"(id uuid primary key, email text not null unique); create table neon_auth.account(id uuid primary key default gen_random_uuid(), "userId" uuid not null references neon_auth."user"(id) on delete cascade, "idToken" text, "accessToken" text, "refreshToken" text)');
    const dir = new URL('../db/migrations/', import.meta.url);
    for (const f of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) await pool.query(readFileSync(new URL(f, dir), 'utf8'));
  });
  after(async () => {
    try { await pool?.end(); } catch { /* ignore */ }
    try {
      if (admin && dbName) await admin.query(`drop database if exists ${dbName} with (force)`);
    } finally { await admin?.end(); }
  });

  test('権限：room_chat の表は読めない。RPC は authenticated だけ', async () => {
    const { rows: [c] } = await pool.query("select relrowsecurity from pg_class where oid = 'public.room_chat'::regclass");
    assert.equal(c.relrowsecurity, true);
    for (const role of ['authenticated', 'anonymous', 'public']) {
      const { rows: [g] } = await pool.query("select has_table_privilege($1, 'public.room_chat', 'SELECT') s, has_table_privilege($1, 'public.room_chat', 'INSERT') i", [role]);
      assert.deepEqual([g.s, g.i], [false, false], role);
      const { rows: [f] } = await pool.query("select has_function_privilege($1, 'public.room_chat(uuid, int)', 'execute') x", [role]);
      assert.equal(f.x, role === 'authenticated', role);
    }
    const [u] = await newUsers(1);
    await assert.rejects(as('authenticated', { sub: u, role: 'authenticated' }, 'select * from public.room_chat'), e => e.code === '42501');
    await assert.rejects(as('anonymous', { sub: u, role: 'authenticated' }, `select public.room_chat('${randomUUID()}', 0)`), e => e.code === '42501');
  });

  test('発言 → room_poll の chat → room_chat。ver は変えない。間隔・上限・FREE MATCH', async () => {
    const us = await newUsers(4);
    const db = makeDb(pool, { rnd: rng(3) });
    const a = await db.create(us[0], 'private', { ...DEFAULT_CONFIG, players: 3 });
    await rejectsCode(db.chat(us[0], a.room, 'hi'), 'chat_closed');               // 待機中
    await db.join(us[1], a.view.room.code);
    await db.join(us[2], a.view.room.code);
    const p0 = await rpc(us[0], 'room_poll', [a.room, -1]);
    assert.equal(p0.chat, 0);
    assert.deepEqual(await rpc(us[0], 'room_chat', [a.room, 0]), []);
    await rejectsCode(db.chat(us[3], a.room, 'hi'), 'not_found');
    await rejectsCode(db.chat(us[0], randomUUID(), 'hi'), 'not_found');
    await rejectsCode(db.chat(us[0], a.room, 'あ'.repeat(41)), 'malformed');

    const m1 = await db.chat(us[0], a.room, '  よろしく\n');
    const seat0 = p0.view.seat;
    assert.equal(m1.msg.seq, 1); assert.equal(m1.msg.seat, seat0); assert.equal(m1.msg.text, 'よろしく');
    assert.ok(Math.abs(m1.msg.at - Date.now()) < 60_000); assert.equal(m1.now, m1.msg.at);
    await rejectsCode(db.chat(us[0], a.room, 'again'), 'too_fast');
    const m2 = await db.chat(us[1], a.room, 'gl');                                 // 別の席は待たなくてよい
    assert.equal(m2.msg.seq, 2);
    const p1 = await rpc(us[2], 'room_poll', [a.room, p0.ver]);
    assert.equal(p1.ver, p0.ver); assert.equal(p1.view, null); assert.equal(p1.chat, 2);   // ver は上がらない
    const log = await rpc(us[2], 'room_chat', [a.room, 0]);
    assert.deepEqual(log.map(m => [m.seq, m.seat, m.text]), [[1, seat0, 'よろしく'], [2, m2.msg.seat, 'gl']]);
    assert.equal(log[0].at, m1.msg.at);
    assert.deepEqual((await rpc(us[2], 'room_chat', [a.room, 1])).map(m => m.seq), [2]);
    assert.deepEqual(await rpc(us[2], 'room_chat', [a.room, 2]), []);
    await rejectsCode(rpc(us[3], 'room_chat', [a.room, 0]), 'not_found');
    await rejectsCode(rpc(us[3], 'room_poll', [a.room, 0]), 'not_found');
    await age(a.room);
    assert.equal((await db.chat(us[0], a.room, 'again')).msg.seq, 3);

    // 新しい方から 200 件を古い順
    await pool.query(`insert into public.room_chat(room, seq, seat, text, created_at) select $1, g, 0, 'm' || g, now() - interval '1 hour'
      from generate_series(4, 250) g`, [a.room]);
    await pool.query('update public.rooms set chat_seq = 250 where id = $1', [a.room]);
    const last = await rpc(us[1], 'room_chat', [a.room, 0]);
    assert.equal(last.length, 200); assert.equal(last[0].seq, 51); assert.equal(last.at(-1).seq, 250);
    assert.deepEqual((await rpc(us[1], 'room_chat', [a.room, 240])).map(m => m.seq), [241, 242, 243, 244, 245, 246, 247, 248, 249, 250]);

    // 上限
    await pool.query('update public.rooms set chat_seq = $2 where id = $1', [a.room, CHAT_ROOM_MAX]);
    await age(a.room, 10_000);
    await rejectsCode(db.chat(us[1], a.room, 'full'), 'chat_full');
    await pool.query('update public.rooms set chat_seq = 251 where id = $1', [a.room]);

    // 終局後も送れる（退出して残り 1 人 → 終局）
    await db.leave(us[0], a.room);
    await db.leave(us[1], a.room);
    assert.equal((await rpc(us[2], 'room_poll', [a.room, -1])).view.status, 'finished');
    assert.equal((await db.chat(us[0], a.room, 'gg')).msg.seq, 252);

    // FREE MATCH：送れない・読むと []
    const f = await db.create(us[3], 'free', { ...DEFAULT_CONFIG, players: 2 });
    await db.join(us[1], f.view.room.code);
    await rejectsCode(db.chat(us[3], f.room, 'hi'), 'chat_closed');
    assert.deepEqual(await rpc(us[3], 'room_chat', [f.room, 0]), []);
    assert.equal((await rpc(us[3], 'room_poll', [f.room, -1])).chat, 0);

    // 部屋が消えると発言も消える
    await pool.query('delete from public.rooms where id = $1', [a.room]);
    assert.equal((await pool.query('select count(*)::int n from public.room_chat where room = $1', [a.room])).rows[0].n, 0);
  });
});

test('clipChat の結果はそのまま送れる（合成除外の文字は NFC で幅が増える）', () => {
  const s = 'य़'.repeat(80);                 // NFC で 2 文字に分かれる
  assert.notEqual(normalizeChat(clipChat(s)), null);
  assert.equal(chatUnits(clipChat(s).normalize('NFC')), 80);
});

test('normalizeChat：見た目が空（結合文字・異体字セレクタ・タグ文字だけ）は null', () => {
  for (const s of ['️️', '́́', '\u{E0061}\u{E0062}', '\u{1D173}', ' ️ '])
    assert.equal(normalizeChat(s), null, JSON.stringify(s));
  assert.equal(normalizeChat('❤️'), '❤️');
});

test('splitChat：吹き出し 1 つ（BUBBLE_MAX_UNITS = 40）に入らない発言は、最少の数に均等に分ける（最後だけ短い切れ端にしない）', () => {
  assert.equal(BUBBLE_MAX_UNITS, 40);
  assert.deepEqual(splitChat('gg'), ['gg']);
  assert.deepEqual(splitChat('あ'.repeat(20)), ['あ'.repeat(20)]);                     // ちょうど 40 は 1 つ
  assert.deepEqual(splitChat('あ'.repeat(21)), ['あ'.repeat(10), 'あ'.repeat(11)]);    // 20 + 1 にしない
  assert.deepEqual(splitChat('a'.repeat(80)), ['a'.repeat(40), 'a'.repeat(40)]);
  // 均等な位置に近い句読点・空白の後ろで切る（空白は落とす）
  assert.deepEqual(splitChat('さっきのリバーは本当にきつかった。次のハンドで取り返すからね、見てて'), ['さっきのリバーは本当にきつかった。', '次のハンドで取り返すからね、見てて']);
  assert.deepEqual(splitChat('I really thought my flush was good there, but your full house got me again'), ['I really thought my flush was good', 'there, but your full house got me again']);
  // 書記素を割らない
  assert.deepEqual(splitChat('😀'.repeat(25)), ['😀'.repeat(12), '😀'.repeat(13)]);
  const fam = '👨‍👩‍👧';
  for (const p of splitChat('a' + fam.repeat(9))) assert.ok(!p.startsWith('‍') && !p.endsWith('‍'));
});

test('性質：splitChat は上限内・順序どおり・数は最少・長さはほぼ均等（ランダムな 2000 文）', () => {
  let x = 7; const rnd = n => ((x = (x * 1103515245 + 12345) % 2147483648) % n);
  const pool = ['a', 'b', ' ', 'あ', '漢', '、', '。', '!', '😀', 'ｱ', 'é'];
  for (let i = 0; i < 2000; i++) {
    let s = ''; while (chatUnits(s) < 41 + rnd(40)) s += pool[rnd(pool.length)];
    s = normalizeChat(clipChat(s)); if (!s) continue;
    const parts = splitChat(s), total = chatUnits(s);
    for (const p of parts) assert.ok(p && chatUnits(p) <= BUBBLE_MAX_UNITS && p === p.trim(), JSON.stringify([s, p]));
    assert.equal(parts.join('').replace(/ /g, ''), s.replace(/ /g, ''), '順序と中身');
    if (total > BUBBLE_MAX_UNITS) {
      assert.equal(parts.length, Math.ceil(total / BUBBLE_MAX_UNITS), JSON.stringify(s));
      // 最後の分も均等な長さから大きく外れない（切れ目を句読点に寄せるずれ 6 ＋ 書記素 1 つ分 ＋ 落とした空白）
      assert.ok(chatUnits(parts[parts.length - 1]) >= total / parts.length - 10, JSON.stringify([s, parts]));
    }
  }
});
