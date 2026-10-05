// サーバー側の敵対的 QA テスト（権限・RPC の見え方・JWT と HTTP・並行処理と後片付け・最後まで打つ対局）。
// TEST_DATABASE_URL があるときだけ動く（無ければ skip）。既存の DB テストと並列に走っても邪魔しないよう、
// この接続先に専用のデータベース（qa_server_<pid>_<時刻>）を作り、マイグレーションを適用して、終わったら消す
// （接続ユーザーに CREATE DATABASE の権限が要る。CI の postgres ユーザーは持っている）。
// `todo` が付いたテストは QA で見つけた未修正の問題の再現（直るまで失敗してよい。直ったら todo を外す）。
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import pg from 'pg';
import { SignJWT, generateKeyPair, exportJWK } from 'jose';
import { makeDb } from '../server/game/db.js';
import { createHandler, STATUS, MAX_BODY } from '../server/game/handler.js';
import { MoveError } from '../server/game/rules.js';
import { DEFAULT_CONFIG, payoutsFor } from '../src/structure.js';
import { legalActions, totalChips } from '../src/engine.js';

const DBURL = process.env.TEST_DATABASE_URL;
const skip = !DBURL && 'TEST_DATABASE_URL が無い';
const MIGRATIONS = new URL('../db/migrations/', import.meta.url);

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const tally = a => a.reduce((m, x) => { m[x] = (m[x] || 0) + 1; return m; }, {});
const outcome = p => Promise.resolve(p).then(() => 'ok', e => e.code || `EXC:${e.message}`);
const CFG = n => ({ ...DEFAULT_CONFIG, players: n });
const RPCS = ['me', 'set_nickname', 'room_poll', 'room_peek', 'free_rooms', 'room_hands'];
const CTL = { ZWSP: String.fromCharCode(0x200b), NBSP: String.fromCharCode(0xa0), RLO: String.fromCharCode(0x202e) };

describe('QA server（専用 DB）', { skip }, () => {
  let admin, pool, dbName, dbUrl, now;

  const urlFor = (name, params = {}) => { const u = new URL(DBURL); u.pathname = '/' + name; for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v); return u.toString(); };

  // role で SQL を 1 本実行（Data API と同じく request.jwt.claims を入れて set local role）
  async function as(role, claims, sql, args = []) {
    const c = await pool.connect();
    try {
      await c.query('begin');
      if (claims !== undefined) await c.query("select set_config('request.jwt.claims', $1, true)", [typeof claims === 'string' ? claims : JSON.stringify(claims)]);
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
  const mkDb = (extra = {}) => makeDb(pool, { now: () => now, ...extra });
  const rowOf = async id => (await pool.query('select * from public.rooms where id=$1', [id])).rows[0];

  before(async () => {
    admin = new pg.Pool({ connectionString: DBURL, max: 2 });
    admin.on('error', () => {});
    dbName = `qa_server_${process.pid}_${Date.now()}`;
    await admin.query(`create database ${dbName} template template0 encoding 'UTF8'`);
    dbUrl = urlFor(dbName, { application_name: 'qa-server-index' });
    pool = new pg.Pool({ connectionString: urlFor(dbName), max: 30 });
    pool.on('error', () => {});   // 後片付けで接続が切られても落ちない
    await pool.query(`do $$ begin
      if not exists (select from pg_roles where rolname = 'anonymous') then create role anonymous; end if;
      if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated; end if; end $$`);
    await pool.query('create schema neon_auth; create table neon_auth."user"(id uuid primary key)');
    for (const f of readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()) await pool.query(readFileSync(new URL(f, MIGRATIONS), 'utf8'));
    now = Date.now();
  });
  beforeEach(() => { now = Date.now(); });
  after(async () => {
    try { await pool?.end(); } catch { /* ignore */ }
    try {
      if (admin && dbName) {
        await admin.query('select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()', [dbName]);
        await admin.query(`drop database if exists ${dbName} with (force)`);
      }
    } finally { await admin?.end(); }
  });

  // ================= 1. 権限（RLS・GRANT） =================
  describe('権限', () => {
    test('表は authenticated / anonymous から読み書きできない（RLS 有効・GRANT 無し）', async () => {
      for (const t of ['profiles', 'rooms', 'room_hands']) {
        const { rows: [c] } = await pool.query('select relrowsecurity from pg_class where oid = $1::regclass', [`public.${t}`]);
        assert.equal(c.relrowsecurity, true, `${t} の RLS`);
        for (const role of ['authenticated', 'anonymous', 'public'])
          for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
            const { rows: [g] } = await pool.query('select has_table_privilege($1, $2::regclass, $3) ok', [role, `public.${t}`, priv]);
            assert.equal(g.ok, false, `${role} ${priv} on ${t}`);
          }
      }
      const [u] = await newUsers(1);
      for (const role of ['authenticated', 'anonymous'])
        for (const sql of ['select * from public.rooms', 'select count(*) from public.profiles', 'select * from public.room_hands',
          `insert into public.profiles(uid, nickname) values ('${randomUUID()}', 'x')`, "update public.profiles set nickname = 'h'",
          'delete from public.rooms', 'truncate public.rooms'])
          await assert.rejects(as(role, { sub: u, role }, sql), e => e.code === '42501', `${role}: ${sql}`);
      await assert.rejects(as('authenticated', { sub: u }, 'create table public.evil(a int)'), e => e.code === '42501');
      await assert.rejects(as('authenticated', { sub: u }, 'select * from neon_auth."user"'), e => e.code === '42501');
    });

    test('実行できる関数は ARCHITECTURE §6 の RPC 6 本だけ（anonymous は 0 本）。definer 関数は search_path 固定', async () => {
      const { rows } = await pool.query(`select p.oid, p.proname, p.prosecdef, array_to_string(p.proconfig, ',') cfg,
        has_function_privilege('authenticated', p.oid, 'execute') auth, has_function_privilege('anonymous', p.oid, 'execute') anon,
        has_function_privilege('public', p.oid, 'execute') pub from pg_proc p where p.pronamespace = 'public'::regnamespace`);
      assert.ok(rows.length >= 10);
      assert.deepEqual(rows.filter(r => r.auth).map(r => r.proname).sort(), [...RPCS].sort());
      assert.deepEqual(rows.filter(r => r.anon || r.pub).map(r => r.proname), []);
      for (const r of rows.filter(r => r.prosecdef)) assert.match(r.cfg ?? '', /search_path/, `${r.proname} の search_path`);
      const [u] = await newUsers(1);
      for (const fn of ['purge_rooms()', `active_room('${u}')`, 'current_uid()', "fail('x')"])
        await assert.rejects(as('authenticated', { sub: u }, `select public.${fn}`), e => e.code === '42501', fn);
    });

    test('anonymous は RPC を何も実行できない（JWT の有無にかかわらず）', async () => {
      const [u] = await newUsers(1);
      const calls = ['me()', "set_nickname('x')", `room_poll('${randomUUID()}', 0)`, "room_peek('123456')", 'free_rooms()', `room_hands('${randomUUID()}', 0)`];
      for (const claims of [undefined, { sub: u, role: 'authenticated' }, { sub: u, role: 'anonymous' }, ''])
        for (const c of calls) await assert.rejects(as('anonymous', claims, `select public.${c}`), e => e.code === '42501', c);
    });

    test('JWT が無い・壊れているときの RPC', async () => {
      await assert.rejects(as('authenticated', undefined, 'select public.me()'), /not_authenticated/);
      await assert.rejects(as('authenticated', { sub: null }, 'select public.me()'), /not_authenticated/);
      await assert.rejects(as('authenticated', { sub: randomUUID() }, 'select public.me()'), /not_authenticated/);   // neon_auth.user に居ない
      await assert.rejects(as('authenticated', {}, "select public.set_nickname('abc')"), /not_authenticated/);
      const [u] = await newUsers(1);
      await assert.rejects(rpc(randomUUID(), 'set_nickname', ['abc']), /no_profile/);
      await assert.rejects(as('authenticated', { sub: u }, 'select public.room_poll(null, null)'), /not_found/);
      // search_path の差し替えや同名の一時テーブルでは定義者関数を騙せない（free_rooms は pg_temp の rooms を読まない）
      const c = await pool.connect();
      try {
        await c.query('begin');
        await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: u, role: 'authenticated' })]);
        await c.query('set local role authenticated');
        await c.query("set local search_path = pg_temp, public");
        await c.query("create temp table rooms(id uuid, kind text, status text, created_at timestamptz, code text, names text[], members uuid[], config jsonb)");
        await c.query("insert into pg_temp.rooms values (gen_random_uuid(), 'free', 'waiting', now(), '999999', array['Fake'], array[gen_random_uuid()], '{}')");
        const { rows } = await c.query('select public.free_rooms() as x');
        assert.ok(!rows[0].x.some(r => r.code === '999999'));
        await c.query('rollback');
      } finally { c.release(); }
    });
  });

  // ================= 2. RPC の見え方 =================
  describe('RPC', () => {
    test('room_poll / room_hands は部屋の外の人には何も返さない。room_peek は概要だけ', async () => {
      const [a, b, c, d] = await newUsers(4);
      const db = mkDb();
      const room = await db.create(a, 'private', CFG(3));
      const code = room.view.room.code;
      await assert.rejects(rpc(c, 'room_poll', [room.room, -1]), /not_found/);
      await assert.rejects(rpc(c, 'room_poll', [randomUUID(), -1]), /not_found/);   // 存在しない部屋と区別できない
      await assert.rejects(rpc(c, 'room_hands', [room.room, 0]), /not_found/);
      const peek = await rpc(c, 'room_peek', [code]);
      assert.deepEqual(Object.keys(peek).sort(), ['code', 'config', 'host', 'id', 'kind', 'member', 'seated', 'status']);
      assert.equal(peek.member, false); assert.equal(peek.seated, 1);
      assert.equal((await rpc(a, 'room_peek', [code])).member, true);
      assert.equal(await rpc(c, 'room_peek', ["' or 1=1 --"]), null);
      assert.equal(await rpc(c, 'room_peek', [null]), null);
      assert.equal(await rpc(c, 'room_peek', ['000000']), null);
      await db.join(b, code); await db.join(d, code);        // 3 人で開始（a, b, d）
      await assert.rejects(rpc(c, 'room_poll', [room.room, -1]), /not_found/);
      await assert.rejects(rpc(c, 'room_hands', [room.room, 0]), /not_found/);
      // 進行中は room_peek の status が running
      assert.equal((await rpc(c, 'room_peek', [code])).status, 'running');
      // p_ver が現在以上なら view は null、null / 負の値なら返る
      const p = await rpc(a, 'room_poll', [room.room, -1]);
      assert.ok(p.view); assert.equal((await rpc(a, 'room_poll', [room.room, p.ver])).view, null);
      assert.ok((await rpc(a, 'room_poll', [room.room, null])).view);
      assert.equal((await rpc(a, 'room_poll', [room.room, 2147483647])).view, null);
    });

    test('room_poll の view は自分の手札だけ。保存された views にも山札・鍵・他席の手札は無い', async () => {
      const us = await newUsers(3);
      const g = await playGame(us, { seed: 1 });
      assert.equal(g.leaks.length, 0, g.leaks.join('; '));
    });

    test('free_rooms は募集中の free だけ（private・開始済み・期限切れ・中止は出ない）。項目も限られる', async () => {
      await pool.query("update public.rooms set status = 'cancelled', ended_at = now() where status = 'waiting'");
      const [a, b, c, d, e, f, g] = await newUsers(7);
      const db = mkDb();
      const freeW = await db.create(a, 'free', CFG(3));
      await db.create(b, 'private', CFG(3));
      const started = await db.create(c, 'free', CFG(2)); await db.join(d, started.view.room.code);
      const expired = await db.create(e, 'free', CFG(3));
      const cancelled = await db.create(f, 'free', CFG(3)); await db.leave(f, cancelled.room);
      await pool.query("update public.rooms set created_at = now() - interval '16 minutes' where id = $1", [expired.room]);
      const list = await rpc(g, 'free_rooms');
      assert.deepEqual(list.map(x => x.id), [freeW.room]);
      assert.deepEqual(Object.keys(list[0]).sort(), ['code', 'config', 'createdAt', 'host', 'id', 'seated']);
      assert.equal(list[0].seated, 1);
      // 並びは新しい順で最大 100 件
      const rs = []; for (const u of await newUsers(3)) rs.push((await db.create(u, 'free', CFG(3))).room);
      const ids = (await rpc(g, 'free_rooms')).map(x => x.id);
      assert.deepEqual(ids.slice(0, 3).sort(), [...rs].sort()); assert.equal(ids.length, 4);
    });

    test('me().recent は自分が着いた開始済みの部屋で、終わってから 3 日以内のものだけ。room は居る部屋', async () => {
      const [a, b, c] = await newUsers(3);
      const db = mkDb();
      const r1 = await db.create(a, 'private', CFG(2)); await db.join(b, r1.view.room.code);
      assert.equal((await rpc(a, 'me')).room.id, r1.room);
      assert.equal((await rpc(a, 'me')).room.started, true);
      assert.deepEqual((await rpc(c, 'me')).recent, []);
      await db.leave(a, r1.room);
      const meA = await rpc(a, 'me');
      assert.equal(meA.room, null); assert.deepEqual(meA.recent.map(x => x.id), [r1.room]);
      assert.equal(typeof meA.recent[0].endedAt, 'number');
      assert.deepEqual((await rpc(b, 'me')).recent.map(x => x.id), [r1.room]);
      assert.deepEqual((await rpc(c, 'me')).recent, []);
      // 開始前に中止した部屋・終わってから 3 日たった部屋は出ない
      const r2 = await db.create(a, 'private', CFG(2)); await db.leave(a, r2.room);
      assert.deepEqual((await rpc(a, 'me')).recent.map(x => x.id), [r1.room]);
      await pool.query("update public.rooms set ended_at = now() - interval '3 days 1 minute', updated_at = now() - interval '3 days 1 minute' where id = $1", [r1.room]);
      assert.deepEqual((await rpc(a, 'me')).recent, []);
    });

    test('set_nickname：大文字小文字を無視して一意・長さ・制御文字・注入っぽい入力', async () => {
      const [a, b, c] = await newUsers(3);
      const nm = (u, s) => rpc(u, 'set_nickname', [s]);
      assert.deepEqual(await nm(a, '  Alice '), { nickname: 'Alice' });
      for (const dup of ['alice', 'ALICE', ' aLiCe ']) await assert.rejects(nm(b, dup), /nickname_taken/);
      assert.deepEqual(await nm(a, 'aLiCe'), { nickname: 'aLiCe' });                 // 自分の名前の大文字小文字の変更はできる
      for (const bad of ['', '   ', 'a'.repeat(17), 'x\ty', 'x\ny', 'x\u0007y']) await assert.rejects(nm(b, bad), /nickname_invalid/, JSON.stringify(bad));
      await assert.rejects(rpc(b, 'set_nickname', [null]), /nickname_invalid/);
      assert.deepEqual(await nm(b, 'b'.repeat(16)), { nickname: 'b'.repeat(16) });
      assert.deepEqual(await nm(c, '😀'.repeat(16)), { nickname: '😀'.repeat(16) });   // 文字数はコードポイント
      await assert.rejects(nm(c, '😀'.repeat(17)), /nickname_invalid/);
      for (const s of ["x'; drop table profiles;--", '"; select 1;--', '%_\\', '{a,b}', 'NULL', '日本語ニック']) {
        const r = s.length <= 16 ? await nm(c, s) : null;
        if (r) assert.equal((await pool.query('select nickname from public.profiles where uid = $1', [c])).rows[0].nickname, s);
        else await assert.rejects(nm(c, s), /nickname_invalid/);
      }
      assert.equal((await pool.query('select count(*)::int n from public.profiles')).rows[0].n >= 3, true);   // 表は無事
      // 同名の同時設定は 1 人だけ成功
      const [x, y, z] = await newUsers(3);
      const rs = await Promise.all([x, y, z].map(u => outcome(nm(u, 'RaceName'))));
      assert.equal(rs.filter(r => r === 'ok').length, 1);
    });

    test('me()：初回の同時呼び出しでもプロフィールは 1 つ', async () => {
      const u = randomUUID(); await pool.query('insert into neon_auth."user"(id) values($1)', [u]);
      const rs = await Promise.all(Array.from({ length: 8 }, () => outcome(rpc(u, 'me'))));
      assert.deepEqual(tally(rs), { ok: 8 });
      assert.equal((await pool.query('select count(*)::int n from public.profiles where uid = $1', [u])).rows[0].n, 1);
      assert.match((await rpc(u, 'me')).nickname, /^Player-[0-9A-F]{4}$/);
    });

    test('ニックネームに引用符・波括弧・バックスラッシュがあっても席の名前（text[]）が壊れない', async () => {
      const us = await newUsers(3), odd = ['a",b\\c{}', 'NULL', "it's {x}"];
      for (const [i, u] of us.entries()) await rpc(u, 'set_nickname', [odd[i]]);
      const db = mkDb();
      const r = await db.create(us[0], 'private', CFG(3)); await db.join(us[1], r.view.room.code); const s = await db.join(us[2], r.view.room.code);
      assert.deepEqual([...s.view.names].sort(), [...odd].sort());
      assert.deepEqual([...(await rowOf(r.room)).names].sort(), [...odd].sort());
    });

    test('終局後の room_hands：自分の手札だけ。p_after で差分。上限 200 件', async () => {
      const us = await newUsers(2);
      const g = await playGame(us, { seed: 4 });
      const hs = await rpc(us[0], 'room_hands', [g.roomId, 0]);
      assert.equal(hs.length, g.handNo);
      assert.deepEqual((await rpc(us[0], 'room_hands', [g.roomId, 1])).map(h => h.handNo), hs.slice(1).map(h => h.handNo));
      assert.deepEqual(await rpc(us[0], 'room_hands', [g.roomId, 999]), []);
      assert.equal((await rpc(us[0], 'room_hands', [g.roomId, null])).length, hs.length);
      assert.equal((await rpc(us[0], 'room_hands', [g.roomId, -5])).length, hs.length);
    });

    test('目に見えない文字だけ・ゼロ幅や方向制御を含むニックネームは拒否したい（なりすまし）', async () => {
      const [a, b] = await newUsers(2);
      await rpc(a, 'set_nickname', ['Alice2']);
      for (const bad of [CTL.ZWSP, CTL.NBSP + CTL.NBSP, 'Alice2' + CTL.ZWSP, CTL.RLO + 'ecilA']) await assert.rejects(rpc(b, 'set_nickname', [bad]), /nickname_invalid/, JSON.stringify(bad));
    });
  });

  // ================= 3. handler.js / index.js（本物の JWT 検証経路） =================
  describe('HTTP と JWT（index.js をそのまま読み込む）', () => {
    let jwksSrv, badJwksSrv, ISS, keys, fetchH, fetchBad, evil, users;
    const ORIGINS = 'https://app.example, http://localhost:5180';
    const START = { op: 'create', kind: 'free', config: CFG(2) };

    async function sign(over = {}, { key = keys.ed, kid = key.kid, iss = ISS, aud, exp = '5m', nbf, sub = users[0], role = 'authenticated' } = {}) {
      let j = new SignJWT({ role, ...over }).setProtectedHeader({ alg: key.alg, kid }).setIssuer(iss).setIssuedAt();
      if (sub) j = j.setSubject(sub);
      if (exp) j = j.setExpirationTime(exp);
      if (aud) j = j.setAudience(aud);
      if (nbf) j = j.setNotBefore(nbf);
      return j.sign(key.privateKey);
    }
    const call = async (fetchFn, token, body = START, { method = 'POST', origin, scheme = 'Bearer', raw } = {}) => {
      const headers = {}; if (token) headers.Authorization = `${scheme} ${token}`; if (origin) headers.Origin = origin;
      const r = await fetchFn(new Request('https://game.invalid/', { method, headers, body: method === 'GET' || method === 'HEAD' ? undefined : (raw ?? JSON.stringify(body)) }));
      const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
      return { status: r.status, json, headers: r.headers, text };
    };
    const reset = () => pool.query("update public.rooms set status = 'cancelled', ended_at = now() where status in ('waiting','running','paused')");

    before(async () => {
      users = await newUsers(4);
      keys = {};
      for (const [name, alg] of [['ed', 'EdDSA'], ['rs', 'RS256'], ['es', 'ES256']]) {
        const kp = await generateKeyPair(alg, { extractable: true });
        const jwk = await exportJWK(kp.publicKey); jwk.kid = name; jwk.alg = alg;
        keys[name] = { ...kp, alg, kid: name, jwk };
      }
      evil = await generateKeyPair('EdDSA');
      jwksSrv = http.createServer((q, s) => { s.setHeader('content-type', 'application/json'); s.end(JSON.stringify({ keys: Object.values(keys).map(k => k.jwk) })); });
      badJwksSrv = http.createServer((q, s) => { s.statusCode = 500; s.end('down'); });
      await Promise.all([jwksSrv, badJwksSrv].map(s => new Promise(r => s.listen(0, '127.0.0.1', r))));
      ISS = `http://127.0.0.1:${jwksSrv.address().port}`;
      // index.js は import 時に環境変数を読む。正常な JWKS と、落ちている JWKS の 2 つのインスタンスを作る
      process.env.DATABASE_URL = dbUrl; process.env.NEON_AUTH_BASE_URL = `${ISS}/neondb/auth`; process.env.ALLOWED_ORIGINS = ORIGINS;
      process.env.NEON_AUTH_JWKS_URL = `${ISS}/jwks`;
      fetchH = (await import('../server/game/index.js?qa=good')).default.fetch;
      process.env.NEON_AUTH_JWKS_URL = `http://127.0.0.1:${badJwksSrv.address().port}/jwks`;
      fetchBad = (await import('../server/game/index.js?qa=bad')).default.fetch;
    });
    after(async () => {
      await pool.query("select pg_terminate_backend(pid) from pg_stat_activity where application_name = 'qa-server-index'").catch(() => {});
      await Promise.all([jwksSrv, badJwksSrv].map(s => s && new Promise(r => s.close(r))));
    });

    test('正しい JWT（EdDSA / RS256 / ES256）は通り、DB まで届く', async () => {
      for (const k of [keys.ed, keys.rs, keys.es]) {
        const r = await call(fetchH, await sign({}, { key: k }), START); await reset();
        assert.equal(r.status, 200, k.alg); assert.equal(r.json.view.lobby, true);
      }
      assert.equal((await call(fetchH, await sign({}, { sub: users[1] }), START)).status, 200);
    });

    test('認証：無い / 壊れた / 期限切れ / 発行者違い / 鍵違い / alg none / HS256 すり替え / role・sub の不正はすべて 401', async () => {
      await reset();
      const now_ = Math.floor(Date.now() / 1000), b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
      const hs = createHmac('sha256', JSON.stringify(keys.ed.jwk)).update(`${b64({ alg: 'HS256', typ: 'JWT', kid: 'ed' })}.${b64({ iss: ISS, sub: users[0], role: 'authenticated', exp: now_ + 300 })}`).digest('base64url');
      const cases = {
        'no header': null, 'garbage': 'abc.def.ghi', 'empty parts': '..',
        'expired': await sign({}, { exp: now_ - 60 }), 'not yet valid': await sign({}, { nbf: now_ + 3600 }),
        'issuer other host': await sign({}, { iss: 'https://evil.example' }), 'issuer with path': await sign({}, { iss: `${ISS}/neondb/auth` }),
        'issuer missing': await new SignJWT({ role: 'authenticated' }).setProtectedHeader({ alg: 'EdDSA', kid: 'ed' }).setSubject(users[0]).setExpirationTime('5m').sign(keys.ed.privateKey),
        'other key, known kid': await sign({}, { key: { ...evil, alg: 'EdDSA', kid: 'ed' } }), 'unknown kid': await sign({}, { kid: 'nope' }),
        'alg none': `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ iss: ISS, sub: users[0], role: 'authenticated', exp: now_ + 300 })}.`,
        'HS256 keyed with the JWKS text': `${b64({ alg: 'HS256', typ: 'JWT', kid: 'ed' })}.${b64({ iss: ISS, sub: users[0], role: 'authenticated', exp: now_ + 300 })}.${hs}`,
        'role anonymous': await sign({}, { role: 'anonymous' }), 'role missing': await sign({ role: undefined }, { role: undefined }),
        'role service': await sign({}, { role: 'service_role' }),
        'sub not a uuid': await sign({}, { sub: 'admin' }), 'sub missing': await sign({}, { sub: null }), 'sub injection': await sign({}, { sub: `${users[0]}'; --` }),
      };
      for (const [name, tok] of Object.entries(cases)) { const r = await call(fetchH, tok, START); assert.equal(r.status, 401, name); assert.deepEqual(r.json, { error: 'not_authenticated' }, name); }
      const good = await sign();
      assert.equal((await call(fetchH, good, START, { scheme: 'Basic' })).status, 401);
      assert.equal((await call(fetchH, good + 'x', START)).status, 401);
      assert.equal((await call(fetchH, `${good} extra`, START)).status, 401);
      assert.equal((await pool.query("select count(*)::int n from public.rooms where status = 'waiting'")).rows[0].n, 0);   // 何も作られていない
    });

    test('JWT が正しくてもプロフィールが無い人は 403 no_profile', async () => {
      const u = randomUUID(); await pool.query('insert into neon_auth."user"(id) values($1)', [u]);
      const r = await call(fetchH, await sign({}, { sub: u }), START);
      assert.equal(r.status, 403); assert.deepEqual(r.json, { error: 'no_profile' });
    });

    test('CORS：許可した Origin だけに Access-Control-Allow-Origin。OPTIONS は認証なしで 204', async () => {
      for (const o of ['https://app.example', 'http://localhost:5180']) {
        const p = await call(fetchH, 'x', START, { origin: o, method: 'OPTIONS' });
        assert.equal(p.status, 204); assert.equal(p.headers.get('Access-Control-Allow-Origin'), o);
        assert.match(p.headers.get('Access-Control-Allow-Headers'), /Authorization/i); assert.match(p.headers.get('Access-Control-Allow-Methods'), /POST/);
        const r = await call(fetchH, 'bad', START, { origin: o });
        assert.equal(r.status, 401); assert.equal(r.headers.get('Access-Control-Allow-Origin'), o);   // エラーにも付く（ブラウザが読める）
      }
      for (const o of ['https://evil.example', 'null', 'https://app.example.evil.com', 'HTTPS://APP.EXAMPLE', 'https://app.example/', 'http://localhost:5181']) {
        for (const r of [await call(fetchH, 'x', START, { origin: o, method: 'OPTIONS' }), await call(fetchH, 'bad', START, { origin: o })]) {
          assert.equal(r.headers.get('Access-Control-Allow-Origin'), null, o); assert.equal(r.headers.get('Vary'), 'Origin');
        }
      }
      const noOrigin = await call(fetchH, 'bad', START);
      assert.equal(noOrigin.headers.get('Access-Control-Allow-Origin'), null);
      assert.equal(noOrigin.headers.get('Cache-Control'), 'no-store');
      assert.match(noOrigin.headers.get('Content-Type'), /application\/json/);
    });

    test('メソッドと本文：POST 以外は 405、壊れた本文・未知の op・型違いは 422（500 にならない）', async () => {
      const tok = await sign();
      for (const method of ['GET', 'PUT', 'DELETE', 'PATCH', 'HEAD']) assert.equal((await call(fetchH, tok, null, { method })).status, 405, method);
      const bad = [['bad json', '{nope'], ['empty', ''], ['null', 'null'], ['array', '[]'], ['string', '"x"'], ['number', '5'], ['true', 'true']];
      for (const [name, raw] of bad) assert.equal((await call(fetchH, tok, null, { raw })).status, 422, name);
      const bodies = {
        'unknown op': { op: 'drop' }, 'op proto': { op: '__proto__' }, 'op toString': { op: 'toString' }, 'op null': { op: null }, 'no op': {}, 'op array': { op: ['create'] },
        'create kind proto': { op: 'create', kind: '__proto__', config: {} }, 'create no config': { op: 'create', kind: 'free' }, 'create config array': { op: 'create', kind: 'free', config: [] },
        'create players 7': { op: 'create', kind: 'free', config: { ...CFG(2), players: 7 } }, 'create bad mode': { op: 'create', kind: 'free', config: { ...CFG(2), mode: 'x' } },
        'create players string': { op: 'create', kind: 'free', config: { ...CFG(2), players: '2' } },
        'join short': { op: 'join', code: '12345' }, 'join letters': { op: 'join', code: 'abcdef' }, 'join number': { op: 'join', code: 123456 }, 'join newline': { op: 'join', code: '123456\n' },
        'leave no room': { op: 'leave' }, 'leave bad room': { op: 'leave', room: 'nope' }, 'leave room array': { op: 'leave', room: [randomUUID()] },
        'act float ver': { op: 'act', room: randomUUID(), ver: 1.5, move: { type: 'call' } }, 'act string ver': { op: 'act', room: randomUUID(), ver: '1', move: { type: 'call' } },
        'act no move': { op: 'act', room: randomUUID(), ver: 1 }, 'act move string': { op: 'act', room: randomUUID(), ver: 1, move: 'call' },
        'sitout no room': { op: 'sitout' }, 'tick bad room': { op: 'tick', room: 'x' },
      };
      for (const [name, body] of Object.entries(bodies)) { const r = await call(fetchH, tok, body); assert.equal(r.status, 422, name); assert.deepEqual(r.json, { error: 'malformed' }, name); }
      // 存在しない部屋・部屋の外の人 → 404
      for (const op of ['leave', 'sitout', 'sitin', 'tick']) assert.equal((await call(fetchH, tok, { op, room: randomUUID() })).status, 404, op);
      assert.equal((await call(fetchH, tok, { op: 'act', room: randomUUID(), ver: 1, move: { type: 'call' } })).status, 404);
      assert.equal((await call(fetchH, tok, { op: 'join', code: '000000' })).status, 404);
      assert.equal((await call(fetchH, tok, { ...START, extra: { deep: [1, 2, 3] }, config: { ...CFG(2), evil: 'x'.repeat(100) } })).status, 200);
      assert.deepEqual(Object.keys((await rowOf((await pool.query("select id from public.rooms where status='waiting' order by created_at desc limit 1")).rows[0].id)).config).sort(), ['levelMin', 'mode', 'players', 'speed', 'startBb']);   // 余計な設定キーは保存されない
      await reset();
    });

    test('大きな本文：MAX_BODY を超えると 422（認証済みでも）', async () => {
      const tok = await sign();
      const r = await call(fetchH, tok, { ...START, pad: 'x'.repeat(MAX_BODY + 1) });
      assert.equal(r.status, 422);
      const big = await call(fetchH, tok, null, { raw: JSON.stringify({ op: 'tick', room: randomUUID(), pad: 'x'.repeat(2_000_000) }) });
      assert.equal(big.status, 422);
      assert.equal((await call(fetchH, tok, null, { raw: ' '.repeat(MAX_BODY - 100) + JSON.stringify({ op: 'tick', room: randomUUID() }) })).status, 404);   // 上限ちょうど近くは通る
    });

    test('本文の上限はバイト数で数えたい（日本語 1500 文字 = 4.5KB が通る）', async () => {
      const r = await call(fetchH, await sign(), null, { raw: JSON.stringify({ op: 'tick', room: randomUUID(), pad: 'あ'.repeat(1500) }) });
      assert.equal(r.status, 422);
    });
    test('exp の無い JWT は拒否したい（requiredClaims）', async () => {
      const r = await call(fetchH, await sign({}, { exp: null }), START); await reset();
      assert.equal(r.status, 401);
    });
    test('JWKS に届かないとき 401（ログアウト扱い）ではなく 503 にしたい', async () => {
      const r = await call(fetchBad, await sign(), START);
      assert.notEqual(r.status, 401);
    });
    test('大文字の sub でも席が引ける（uid を小文字にそろえたい）', async () => {
      const u = 'abcdef12-aaaa-4bbb-8ccc-dddddddddddd'; await pool.query('insert into neon_auth."user"(id) values($1)', [u]); await rpc(u, 'me');
      const c = await call(fetchH, await sign({}, { sub: u.toUpperCase() }), START);
      assert.equal(c.status, 200);
      const l = await call(fetchH, await sign({}, { sub: u.toUpperCase() }), { op: 'leave', room: c.json.room });
      assert.equal(l.status, 200); await reset();
    });

    test('エンドツーエンド：create → join → act → in_other_room（room 付き）→ not_your_turn → leave', async () => {
      await reset();
      const [t1, t2, t3] = await Promise.all(users.slice(0, 3).map(u => sign({}, { sub: u })));
      const c = await call(fetchH, t1, START); assert.equal(c.status, 200);
      const again = await call(fetchH, t1, START);
      assert.equal(again.status, 409); assert.deepEqual(again.json, { error: 'in_other_room', room: c.json.room });
      const j = await call(fetchH, t2, { op: 'join', code: c.json.view.room.code }); assert.equal(j.status, 200); assert.equal(j.json.view.status, 'running');
      assert.equal((await call(fetchH, t2, { op: 'join', code: c.json.view.room.code })).status, 200);       // すでに居れば今の部屋
      const late = await call(fetchH, t3, { op: 'join', code: c.json.view.room.code }); assert.equal(late.status, 409); assert.equal(late.json.error, 'room_closed');
      assert.equal((await call(fetchH, t3, { op: 'tick', room: c.json.room })).status, 404);               // 部屋の外の人
      const views = (await Promise.all([users[0], users[1]].map(u => rpc(u, 'room_poll', [c.json.room, -1])))).map(p => p.view);
      const ai = views.findIndex(v => v.seat === v.hand.toAct), v1 = views[ai], tokens = [t1, t2], tm = tokens[ai], to = tokens[1 - ai];
      const wrong = await call(fetchH, to, { op: 'act', room: c.json.room, ver: v1.ver, move: { type: 'fold' } });
      assert.equal(wrong.status, 409); assert.equal(wrong.json.error, 'not_your_turn');
      const stale = await call(fetchH, tm, { op: 'act', room: c.json.room, ver: v1.ver - 1, move: { type: 'call' } });
      assert.equal(stale.status, 409); assert.equal(stale.json.error, 'stale');
      assert.equal((await call(fetchH, tm, { op: 'tick', room: c.json.room })).status, 409);              // not_yet
      const L = legalActions(v1);
      const ok = await call(fetchH, tm, { op: 'act', room: c.json.room, ver: v1.ver, move: L.canCheck ? { type: 'check' } : { type: 'call' } });
      assert.equal(ok.status, 200);
      assert.equal((await call(fetchH, t1, { op: 'leave', room: c.json.room })).status, 200);
      assert.equal((await call(fetchH, t2, { op: 'leave', room: c.json.room })).status, 409);            // game_over（もう終わっている）
    });

    test('エラーコードと HTTP ステータスの対応（ARCHITECTURE §5）。内部エラーの詳細は返さない', async () => {
      const codes = ['in_other_room', 'room_full', 'room_closed', 'not_found', 'stale', 'not_your_turn', 'game_over', 'busy', 'illegal', 'malformed', 'not_yet', 'no_profile', 'not_started'];
      const expected = { in_other_room: 409, room_full: 409, room_closed: 409, not_found: 404, stale: 409, not_your_turn: 409, game_over: 409, busy: 409, illegal: 422, malformed: 422, not_yet: 409, no_profile: 403, not_started: 409 };
      const logged = [];
      let thrown;
      const boom = async () => { throw thrown; };
      const h = createHandler({ allowedOrigins: [], verifyToken: async () => users[0], create: boom, join: boom, leave: boom, request: boom, tick: boom, logError: (m, e) => logged.push(e) });
      const room = randomUUID();
      const post = body => h(new Request('https://f/', { method: 'POST', headers: { Authorization: 'Bearer t' }, body: JSON.stringify(body) }));
      for (const code of codes) {
        thrown = new MoveError(code, code === 'in_other_room' ? { room } : undefined);
        const r = await post({ op: 'tick', room }); assert.equal(r.status, expected[code], code); assert.equal(STATUS[code], expected[code]);
        assert.equal((await r.json()).error, code);
      }
      thrown = new MoveError('something_new'); assert.equal((await post({ op: 'tick', room })).status, 422);   // 未知のコードは 422
      thrown = new Error('connect ECONNREFUSED postgres://user:secret@db/x');
      const r = await post({ op: 'tick', room });
      assert.equal(r.status, 500); assert.equal(await r.text(), JSON.stringify({ error: 'internal' }));
      assert.equal(logged.length, 1);
      for (const op of ['create', 'join', 'leave', 'act', 'sitout', 'sitin']) {   // どの op でも同じ
        const rr = await post({ op, kind: 'free', config: CFG(2), code: '123456', room, ver: 1, move: { type: 'call' } }); assert.equal(rr.status, 500, op);
      }
    });
  });

  // ================= 4. db.js の並行処理と後片付け =================
  describe('並行処理', () => {
    test('残り 1 席に 8 人が同時に join → 成功は 1 人だけ。残りは room_closed', async () => {
      const us = await newUsers(10);
      const db = mkDb();
      const r = await db.create(us[0], 'private', CFG(3)); await db.join(us[1], r.view.room.code);
      const rs = await Promise.all(us.slice(2).map(u => outcome(db.join(u, r.view.room.code))));
      assert.deepEqual(tally(rs), { ok: 1, room_closed: 7 });
      const row = await rowOf(r.room);
      assert.equal(row.members.length, 3); assert.equal(new Set(row.members).size, 3); assert.equal(row.status, 'running');
      assert.equal(row.views.length, 3);
    });

    test('1 人が同時に複数の部屋に入る・作る → 1 つだけ（in_other_room）', async () => {
      const us = await newUsers(8), db = mkDb();
      const rooms = []; for (const u of us.slice(0, 5)) rooms.push(await db.create(u, 'free', CFG(6)));
      const joiner = us[5];
      assert.deepEqual(tally(await Promise.all(rooms.map(r => outcome(db.join(joiner, r.view.room.code))))), { ok: 1, in_other_room: 4 });
      const creator = us[6];
      assert.deepEqual(tally(await Promise.all(Array.from({ length: 8 }, (_, i) => outcome(db.create(creator, i % 2 ? 'free' : 'private', CFG(3)))))), { ok: 1, in_other_room: 7 });
      const mixed = us[7];
      const mr = await Promise.all([db.create(mixed, 'free', CFG(3)), db.join(mixed, rooms[0].view.room.code), db.create(mixed, 'private', CFG(3)), db.join(mixed, rooms[1].view.room.code)].map(outcome));
      assert.equal(mr.filter(x => x === 'ok').length, 1, mr.join());
      for (const u of [joiner, creator, mixed]) assert.equal((await pool.query("select count(*)::int n from public.rooms where members @> array[$1::uuid] and status in ('waiting','running','paused')", [u])).rows[0].n, 1);
    });

    test('同じ ver の act は 1 つだけ成功（残りは stale）。全員が同時に動いても 1 手だけ進む', async () => {
      const us = await newUsers(3), db = mkDb();
      const r = await db.create(us[0], 'private', CFG(3)); await db.join(us[1], r.view.room.code); await db.join(us[2], r.view.room.code);
      const polls = await Promise.all(us.map(u => rpc(u, 'room_poll', [r.room, -1])));
      const me = polls.map(p => p.view).find(v => v.seat === v.hand.toAct), uid = us[polls.findIndex(p => p.view === me)], L = legalActions(me);
      const mv = L.canFold ? { type: 'fold' } : { type: 'call' };
      assert.deepEqual(tally(await Promise.all(Array.from({ length: 10 }, () => outcome(db.request(uid, r.room, { op: 'act', ver: me.ver, move: mv }))))), { ok: 1, stale: 9 });
      const ver2 = (await rowOf(r.room)).ver;
      const res = await Promise.all(us.map(u => outcome(db.request(u, r.room, { op: 'act', ver: ver2, move: { type: 'check' } }))));
      assert.ok(res.filter(x => x === 'ok').length <= 1, res.join());
      assert.ok(res.every(x => ['ok', 'illegal', 'not_your_turn', 'stale'].includes(x)), res.join());
      const row = await rowOf(r.room); assert.equal(row.ver, ver2 + res.filter(x => x === 'ok').length);
      assert.equal(totalChips(row.state), 3 * 100 * 200);
    });

    test('tick の同時呼び出しは 1 回だけ進む（残りは not_yet）。期限前は not_yet', async () => {
      const us = await newUsers(2); let t = Date.now();
      const db = makeDb(pool, { now: () => t });
      const r = await db.create(us[0], 'private', CFG(2)); await db.join(us[1], r.view.room.code);
      assert.equal(await outcome(db.tick(us[0], r.room)), 'not_yet');
      t += 10 * 60000;   // 手番の持ち時間を使い切る
      const res = await Promise.all(Array.from({ length: 12 }, (_, i) => outcome(db.tick(us[i % 2], r.room))));
      assert.deepEqual(tally(res), { ok: 1, not_yet: 11 });
      const row = await rowOf(r.room); assert.equal(row.state.hand.phase, 'settled'); assert.equal(row.ver, 3);   // lobby 1 → 開始 2 → タイムアウト 3
      assert.equal((await pool.query('select count(*)::int n from public.room_hands where room = $1', [r.room])).rows[0].n, 1);
    });

    test('ロック順序：8 部屋 × 6 人が一斉に act / tick / sitout / sitin / me を打ち続けてもデッドロック・busy・500 が出ない', async () => {
      const R = 8, PL = 6, r = rng(5), all = await newUsers(R * PL), db = mkDb();
      const rooms = [];
      for (let k = 0; k < R; k++) {
        const us = all.slice(k * PL, (k + 1) * PL), x = await db.create(us[0], 'free', CFG(PL));
        for (const u of us.slice(1)) await db.join(u, x.view.room.code);
        rooms.push({ id: x.room, us });
      }
      const results = [];
      for (let round = 0; round < 40; round++) {
        now += 4000;
        const batch = [];
        for (const room of rooms) {
          const vs = (await Promise.all(room.us.map(u => rpc(u, 'room_poll', [room.id, -1])))).map(p => p.view);
          if (vs[0].status !== 'running') continue;
          room.us.forEach((u, i) => {
            const v = vs[i], L = v.hand && legalActions(v), k = r();
            let p;
            if (L && k < 0.7) p = db.request(u, room.id, { op: 'act', ver: v.ver, move: L.canCheck ? { type: 'check' } : r() < 0.5 ? { type: 'call' } : { type: 'fold' } });
            else if (k < 0.85) p = db.tick(u, room.id);
            else if (k < 0.9) p = db.request(u, room.id, { op: 'sitout' });
            else if (k < 0.95) p = db.request(u, room.id, { op: 'sitin' });
            else p = db.request(u, room.id, { op: 'act', ver: v.ver - 1, move: { type: 'call' } });
            batch.push(outcome(p));
          });
          batch.push(outcome(rpc(room.us[0], 'me')));
        }
        results.push(...await Promise.all(batch));
        for (const room of rooms) { const row = await rowOf(room.id); if (row.status === 'running') assert.equal(totalChips(row.state), PL * 100 * 200, 'チップの合計'); }
      }
      const t = tally(results);
      assert.ok(results.length > 1000, `ops ${results.length}`);
      for (const k of Object.keys(t)) assert.ok(['ok', 'not_your_turn', 'stale', 'not_yet', 'illegal', 'game_over'].includes(k), `想定外の結果 ${k}: ${JSON.stringify(t)}`);
      assert.ok(t.ok > 100);
    });

    test('約 50 件の混在した操作（作成・参加・退出・tick・me）が複数の部屋に同時に飛んでも詰まらない', async () => {
      const us = await newUsers(60), db = mkDb(), lobbies = [];
      for (let k = 0; k < 12; k++) { const base = k * 5, x = await db.create(us[base], 'free', CFG(3)); lobbies.push({ code: x.view.room.code, id: x.room, host: us[base], js: us.slice(base + 1, base + 4) }); }
      const ops = [];
      for (const l of lobbies) { for (const j of l.js) ops.push(outcome(db.join(j, l.code))); ops.push(outcome(db.leave(l.host, l.id))); ops.push(outcome(db.tick(l.js[0], l.id))); ops.push(outcome(rpc(l.js[1], 'me'))); }
      const t = tally(await Promise.all(ops));
      assert.ok(ops.length >= 50);
      for (const k of Object.keys(t)) assert.ok(['ok', 'room_closed', 'not_found', 'in_other_room', 'not_yet', 'game_over', 'room_full'].includes(k), `${k} ${JSON.stringify(t)}`);
    });

    test('ロック待ちが 5 秒を超えたら busy（409）。ロックを手放すとすぐ通る', async () => {
      const us = await newUsers(2), db = mkDb();
      const r = await db.create(us[0], 'private', CFG(2));
      const c = await pool.connect();
      try {
        await c.query('begin'); await c.query('select 1 from public.rooms where id = $1 for update', [r.room]);
        const t0 = Date.now();
        assert.equal(await outcome(db.tick(us[0], r.room)), 'busy');
        const waited = Date.now() - t0; assert.ok(waited >= 4500 && waited < 9000, `waited ${waited}`);
      } finally { await c.query('rollback'); c.release(); }
      assert.equal(await outcome(db.tick(us[0], r.room)), 'not_yet');
    });

    test('部屋番号：生きている部屋の中で一意。終わった部屋の番号は再利用できる。部屋の外の人は番号で部屋 ID を知っても何もできない', async () => {
      const us = await newUsers(40);
      const same = makeDb(pool, { now: () => now, rnd: () => 0.424242 });   // 乱数が固定 → いつも 424242
      const a = await same.create(us[0], 'private', CFG(3)); assert.equal(a.view.room.code, '424242');
      assert.equal(await outcome(same.create(us[1], 'private', CFG(3))), 'busy');   // 10 回試して諦める
      assert.equal((await pool.query("select count(*)::int n from public.rooms where code = '424242' and status in ('waiting','running','paused')")).rows[0].n, 1);
      await assert.rejects(pool.query(`insert into public.rooms(id,code,kind,host,config,views,members,names) select gen_random_uuid(), code, 'free', host, config, views, members, names from public.rooms where id = $1`, [a.room]), e => e.code === '23505');
      await assert.rejects(pool.query("update public.rooms set code = '12345' where id = $1", [a.room]), e => e.code === '23514');
      await same.leave(us[0], a.room);
      const b = await same.create(us[1], 'private', CFG(3)); assert.equal(b.view.room.code, '424242');
      assert.equal((await rpc(us[5], 'room_peek', ['424242'])).id, b.room);   // 生きている方を優先
      assert.equal((await same.join(us[2], '424242')).room, b.room);
      // 部屋の外の人の操作は何も変えない
      const before = await rowOf(b.room);
      for (const fn of [() => same.leave(us[9], b.room), () => same.tick(us[9], b.room), () => same.request(us[9], b.room, { op: 'sitout' }), () => same.request(us[9], b.room, { op: 'act', ver: before.ver, move: { type: 'fold' } })])
        assert.equal(await outcome(fn()), 'not_found');
      assert.equal((await rowOf(b.room)).ver, before.ver);
      // 並行して作った部屋の番号は重ならない
      const db = mkDb();
      await Promise.all(us.slice(10, 40).map(u => db.create(u, 'free', CFG(6))));
      const { rows } = await pool.query("select code, count(*)::int n from public.rooms where status in ('waiting','running','paused') group by code having count(*) > 1");
      assert.deepEqual(rows, []);
    });

    test('後片付け：待機 15 分・一時停止 10 分・動いていない進行中 2 日で中止、終局から 3 日で削除（ハンド記録ごと）', async () => {
      await pool.query('truncate public.rooms cascade');
      const us = await newUsers(12), db = mkDb();
      const mk = async (a, b) => { const r = await db.create(us[a], 'private', CFG(2)); if (b != null) await db.join(us[b], r.view.room.code); return r; };
      const waiting = await mk(0), running = await mk(1, 2), paused = await mk(3, 4), fin = await mk(5, 6);
      await db.request(us[3], paused.room, { op: 'sitout' }); await db.request(us[4], paused.room, { op: 'sitout' });
      for (let i = 0; i < 5 && (await rowOf(paused.room)).status !== 'paused'; i++) { now += 20000; await db.tick(us[3], paused.room).catch(() => {}); }
      assert.equal((await rowOf(paused.room)).status, 'paused');
      await db.leave(us[5], fin.room); assert.equal((await rowOf(fin.room)).status, 'finished');
      const withHands = await playGame(await newUsers(2), { seed: 9 });
      assert.ok((await pool.query('select count(*)::int n from public.room_hands where room = $1', [withHands.roomId])).rows[0].n > 0);
      const status = async id => (await rowOf(id))?.status ?? 'deleted';
      const purge = () => pool.query('select public.purge_rooms()');
      const shift = (id, col, interval) => pool.query(`update public.rooms set ${col} = now() - interval '${interval}' where id = $1`, [id]);

      await shift(waiting.room, 'created_at', '14 minutes 50 seconds'); await purge(); assert.equal(await status(waiting.room), 'waiting');
      assert.equal((await rpc(us[7], 'free_rooms')).some(x => x.id === waiting.room), false);   // private なので元から出ない
      await shift(waiting.room, 'created_at', '15 minutes 1 second'); await purge(); assert.equal(await status(waiting.room), 'cancelled');
      assert.notEqual((await rowOf(waiting.room)).ended_at, null);
      await shift(paused.room, 'updated_at', '9 minutes 50 seconds'); await purge(); assert.equal(await status(paused.room), 'paused');
      await shift(paused.room, 'updated_at', '10 minutes 1 second'); await purge(); assert.equal(await status(paused.room), 'cancelled');
      await shift(running.room, 'updated_at', '47 hours'); await purge(); assert.equal(await status(running.room), 'running');
      await shift(running.room, 'updated_at', '49 hours'); await purge(); assert.equal(await status(running.room), 'cancelled');
      assert.equal((await rpc(us[1], 'room_poll', [running.room, -1])).view.status, 'cancelled');   // 表の status で上書きされる
      assert.equal(await outcome(db.request(us[1], running.room, { op: 'sitout' })), 'game_over');
      assert.equal((await rpc(us[1], 'me')).room, null);                                          // 居る部屋ではなくなる → 新しい部屋を作れる
      assert.equal(await outcome(db.create(us[1], 'private', CFG(2))), 'ok');
      for (const id of [waiting.room, paused.room, running.room, fin.room, withHands.roomId]) { await shift(id, 'ended_at', '2 days 23 hours'); }
      await purge();
      for (const id of [waiting.room, paused.room, running.room, fin.room, withHands.roomId]) assert.notEqual(await status(id), 'deleted', id);
      for (const id of [waiting.room, paused.room, running.room, fin.room, withHands.roomId]) { await shift(id, 'ended_at', '3 days 1 minute'); }
      await purge();
      for (const id of [waiting.room, paused.room, running.room, fin.room, withHands.roomId]) assert.equal(await status(id), 'deleted', id);
      assert.equal((await pool.query('select count(*)::int n from public.room_hands where room = $1', [withHands.roomId])).rows[0].n, 0);   // ハンド記録も消える
      assert.equal((await pool.query('select count(*)::int n from public.room_hands where room not in (select id from public.rooms)')).rows[0].n, 0);
    });

    test('一時停止の期限（エンジン側 10 分）：全員 sitout → paused → 11 分後の tick で中止', async () => {
      const us = await newUsers(3); let t = Date.now();
      const db = makeDb(pool, { now: () => t });
      const r = await db.create(us[0], 'private', CFG(3)); await db.join(us[1], r.view.room.code); await db.join(us[2], r.view.room.code);
      for (const u of us) await db.request(u, r.room, { op: 'sitout' });
      for (let i = 0; i < 6 && (await rowOf(r.room)).status !== 'paused'; i++) { t += 20000; await db.tick(us[0], r.room).catch(() => {}); }
      assert.equal((await rowOf(r.room)).status, 'paused');
      t += 11 * 60000;
      assert.equal(await outcome(db.tick(us[0], r.room)), 'ok');
      const row = await rowOf(r.room); assert.equal(row.status, 'cancelled'); assert.notEqual(row.ended_at, null);
      assert.equal((await rpc(us[0], 'me')).room, null);
      assert.equal(await outcome(db.tick(us[0], r.room)), 'game_over');
    });

    test('部屋の外の操作：待機中の期限切れの部屋に join すると not_found（先に purge される）。時刻はアプリの時計', async () => {
      const us = await newUsers(3); let t = Date.now();
      const db = makeDb(pool, { now: () => t });
      const r = await db.create(us[0], 'free', CFG(3));
      t += 15 * 60000;       // アプリの時計だけが進む（DB の時計はそのまま）→ joinRoom が room_closed にする
      assert.equal(await outcome(db.join(us[1], r.view.room.code)), 'room_closed');
      assert.equal((await rowOf(r.room)).status, 'waiting');
    });

    test('ランダムな入力を 600 件送っても内部エラー（500）にならず、チップ保存則が壊れない', async () => {
      const us = await newUsers(3), rnd = rng(77), pick = a => a[Math.floor(rnd() * a.length)];
      const db = mkDb(), errs = [];
      const h = createHandler({ allowedOrigins: [], verifyToken: async t => t, ...db, logError: (m, e) => errs.push(e) });
      const post = (uid, body) => h(new Request('https://f/', { method: 'POST', headers: { Authorization: 'Bearer ' + uid }, body: JSON.stringify(body) }));
      const r = await db.create(us[0], 'private', CFG(3)); await db.join(us[1], r.view.room.code); await db.join(us[2], r.view.room.code);
      const weird = [0, -1, 1, 1.5, 2 ** 53, 1e308, -1e308, '100', null, true, [], {}, 'x', 2 ** 31, 4294967296, -0];
      const types = ['fold', 'check', 'call', 'raise', 'allin', 'RAISE', '', null, 5, '__proto__', 'constructor', ['fold']];
      const seen = new Set();
      for (let i = 0; i < 600; i++) {
        const v = (await rpc(us[0], 'room_poll', [r.room, -1])).view; if (v.status !== 'running') break;
        const u = pick(us), k = rnd();
        let body;
        if (k < 0.55) body = { op: 'act', room: r.room, ver: rnd() < 0.7 ? v.ver : pick(weird), move: { type: pick(types), to: pick(weird), x: pick(weird) } };
        else if (k < 0.65) body = { op: 'act', room: r.room, ver: v.ver, move: pick(weird) };
        else if (k < 0.75) body = { op: pick(['sitout', 'sitin']), room: r.room };
        else if (k < 0.95) { now += pick([0, 1000, 5000, 20000, 60000]); body = { op: 'tick', room: r.room }; }
        else body = { op: pick(['act', 'tick', 'join', 'create', 'leave']), room: pick([r.room, randomUUID(), 5, null]), code: pick(['123456', 123, null]), kind: pick(['free', 5]), config: pick([{}, null, 5]) };
        const res = await post(u, body); seen.add(res.status);
        assert.notEqual(res.status, 500, JSON.stringify(body));
        const row = await rowOf(r.room); if (row.status === 'running') assert.equal(totalChips(row.state), 3 * 100 * 200);
      }
      assert.equal(errs.length, 0); assert.ok(seen.has(200) && seen.has(422));
    });
  });

  // ================= 5. 最後まで打つ対局 =================
  describe('対局', () => {
    for (const n of [2, 6]) {
      test(`${n} 人で最後まで：順位・pt・room_hands・views に山札も他席の手札も無い`, async () => {
        const us = await newUsers(n);
        const cfg = { ...CFG(n), startBb: 75, mode: n === 2 ? 'club' : 'rank-4' };
        const g = await playGame(us, { seed: 100 + n, cfg });
        assert.equal(g.status, 'finished');
        assert.equal(g.leaks.length, 0, g.leaks.slice(0, 5).join('; '));
        const st = g.state;
        assert.deepEqual(st.players.map(p => p.place).sort((a, b) => a - b), Array.from({ length: n }, (_, i) => i + 1));
        const pay = payoutsFor(cfg);
        st.players.forEach(p => assert.equal(p.pt, pay[p.place - 1]));
        assert.equal(st.players[st.winner].place, 1);
        assert.equal(totalChips(st), n * cfg.startBb * 200);
        assert.equal(st.players[st.winner].stack, n * cfg.startBb * 200);
        // room_hands：1 ハンド 1 行・連番・チップの合計が保存される
        const rows = (await pool.query('select hand_no, rec, holes from public.room_hands where room = $1 order by hand_no', [g.roomId])).rows;
        assert.equal(rows.length, st.handNo); assert.deepEqual(rows.map(r => r.hand_no), rows.map((_, i) => i + 1));
        for (const r of rows) {
          assert.equal(r.rec.startStacks.reduce((x, y) => x + y, 0), n * cfg.startBb * 200, `hand ${r.hand_no} のチップ`);
          for (const k of ['deck', 'hole', 'holes', 'seed', 'ctr']) assert.equal(r.rec[k], undefined, `rec.${k}`);
          r.rec.shown.forEach((c, s) => { if (c) { assert.deepEqual(c, r.holes[s]); assert.ok(!r.rec.actions.some(a => a.seat === s && a.kind === 'fold'), '降りた席は公開されない'); } });
        }
        // 各自の room_hands は自分の手札だけ。他席の（公開されていない）手札と同じペアは返らない
        for (const [i, u] of us.entries()) {
          const seat = g.seats[i], hs = await rpc(u, 'room_hands', [g.roomId, 0]);
          assert.equal(hs.length, rows.length);
          const text = JSON.stringify(hs);
          hs.forEach((h, k) => {
            assert.deepEqual(h.hole, rows[k].holes[seat]);
            assert.equal(h.holes, undefined); assert.equal(h.deck, undefined);
            rows[k].holes.forEach((c, s) => { if (c && s !== seat && !rows[k].rec.shown[s]) assert.ok(!JSON.stringify(h).includes(`"hole":${JSON.stringify(c)}`), '他席の手札'); });
          });
          assert.ok(!text.includes('"deck"') && !text.includes('"seed"'));
        }
        // 終局後の me()
        for (const u of us) { const me = await rpc(u, 'me'); assert.equal(me.room, null); assert.ok(me.recent.some(x => x.id === g.roomId)); }
        // 終わった後の操作は game_over。もう一度部屋を作れる
        const db = mkDb();
        assert.equal(await outcome(db.tick(us[0], g.roomId)), 'game_over');
        assert.equal(await outcome(db.request(us[0], g.roomId, { op: 'sitout' })), 'game_over');
        assert.equal(await outcome(db.leave(us[0], g.roomId)), 'game_over');
        assert.equal(await outcome(db.create(us[0], 'private', CFG(2))), 'ok');
      });
    }

    test('進行中に抜けた人・途中で終わるハンド：left の順位と pt、残り 1 人で終局', async () => {
      const us = await newUsers(3), db = mkDb();
      const r = await db.create(us[0], 'private', CFG(3)); await db.join(us[1], r.view.room.code); await db.join(us[2], r.view.room.code);
      await db.leave(us[0], r.room);
      assert.equal((await rowOf(r.room)).status, 'running');
      assert.equal((await rpc(us[0], 'me')).room, null);                       // 抜けた人は別の部屋に入れる
      assert.equal((await rpc(us[0], 'room_poll', [r.room, -1])).view.status, 'running');   // 自分の席のビューは読める
      await db.leave(us[1], r.room);
      const row = await rowOf(r.room);
      assert.equal(row.status, 'finished'); assert.deepEqual(row.state.players.map(p => p.status).sort(), ['active', 'left', 'left']);
      assert.deepEqual(row.state.players.map(p => p.place).sort(), [1, 2, 3]);
      assert.equal(totalChips(row.state), 3 * 100 * 200);
    });
  });

  // ---------- 対局を最後まで打つ（makeDb 経由）＋保存された views の漏れ検査 ----------
  const FORBIDDEN = new Set(['deck', 'seed', 'ctr']);
  function scan(o, path, bad) {
    if (Array.isArray(o)) o.forEach((x, i) => scan(x, `${path}[${i}]`, bad));
    else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { if (FORBIDDEN.has(k)) bad.push(`${path}.${k}`); scan(v, `${path}.${k}`, bad); }
  }
  async function leakCheck(roomId) {
    const { rows: [r] } = await pool.query('select views, state, started, status, ver from public.rooms where id = $1', [roomId]);
    const bad = [];
    if (!r.started) return { bad, row: r };
    const h = r.state.hand;
    r.views.forEach((v, s) => {
      scan(v, `view${s}`, bad);
      if (v.seat !== s) bad.push(`view${s}: seat=${v.seat}`);
      if (v.hand) {
        v.hand.hole.forEach((c, t) => { if (c && t !== s && !(v.hand.shown && v.hand.shown[t])) bad.push(`seat ${s} sees the hole of seat ${t} (hand ${v.hand.handNo})`); });
        if (h && h.phase === 'betting') {
          const js = JSON.stringify(v);
          h.hole.forEach((c, t) => { if (c && t !== s && js.includes(`"hole":[${JSON.stringify(c)}`)) bad.push(`seat ${s} view holds seat ${t}'s cards`); });
          const dk = JSON.stringify(h.deck.slice(-6)).slice(1, -1); if (js.includes(dk)) bad.push(`seat ${s} view holds the deck`);
        }
      }
    });
    return { bad, row: r };
  }
  async function playGame(users, { seed = 1, cfg = CFG(users.length) } = {}) {
    const r = rng(seed), db = mkDb({ rnd: rng(seed + 1000) }), leaks = [];
    const first = await db.create(users[0], 'private', cfg);
    for (const u of users.slice(1)) await db.join(u, first.view.room.code);
    const roomId = first.room, row0 = await rowOf(roomId);
    const seats = users.map(u => row0.members.indexOf(u));
    for (let steps = 0; ; steps++) {
      assert.ok(steps < 4000, '終わらない');
      now += 2000 + Math.floor(r() * 20000);
      const { bad, row } = await leakCheck(roomId); leaks.push(...bad);
      if (row.status === 'running') assert.equal(totalChips(row.state), users.length * cfg.startBb * 200);
      const polls = await Promise.all(users.map(u => rpc(u, 'room_poll', [roomId, -1])));
      polls.forEach((p, i) => assert.deepEqual(p.view, { ...row.views[seats[i]], status: row.status, ver: row.ver }, 'room_poll は保存された自分のビュー'));
      const v0 = polls[0].view;
      if (v0.status !== 'running') break;
      if (v0.hand.phase === 'settled') { now = Math.max(now, v0.nextAt); await db.tick(users[0], roomId); continue; }
      const idx = polls.findIndex(p => p.view.seat === p.view.hand.toAct), me = polls[idx].view, L = legalActions(me), x = r();
      let move;
      if (x < 0.1 && L.minTo != null) move = { type: 'allin' };
      else if (x < 0.35 && L.minTo != null) move = { type: 'raise', to: L.minTo + Math.floor(r() * (L.maxTo - L.minTo + 1)) };
      else if (x < 0.5 && L.canFold) move = { type: 'fold' };
      else move = L.canCheck ? { type: 'check' } : { type: 'call' };
      await db.request(users[idx], roomId, { op: 'act', ver: me.ver, move });
    }
    const fin = await leakCheck(roomId); leaks.push(...fin.bad);
    return { roomId, leaks, seats, status: fin.row.status, state: fin.row.state, handNo: fin.row.state.handNo };
  }
});
