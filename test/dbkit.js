// DB の結合テストの道具（test/friend.test.js が使う。ファイル名が *.test.js でないので、単体では走らない）。
// TEST_DATABASE_URL の接続先に専用のデータベースを作り、Neon と同じロールと neon_auth のひな形を用意して db/migrations を適用する。
// ほかのテストファイルと並列に走っても邪魔しない。終わったら close() で消す（接続ユーザーに CREATE DATABASE の権限が要る）。
import { readFileSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { legalActions } from '../src/engine.js';

export const DBURL = process.env.TEST_DATABASE_URL;
const MIGRATIONS = new URL('../db/migrations/', import.meta.url);
const NEON_AUTH = `create schema neon_auth;
  create table neon_auth."user"(id uuid primary key, email text not null unique, name text not null, image text);
  create table neon_auth.account(id uuid primary key default gen_random_uuid(), "userId" uuid not null references neon_auth."user"(id) on delete cascade, "idToken" text, "accessToken" text, "refreshToken" text);
  create table neon_auth.session(id uuid primary key default gen_random_uuid(), "userId" uuid not null references neon_auth."user"(id) on delete cascade, "ipAddress" text, "userAgent" text)`;
const ROLES = `do $$ begin
  if not exists (select from pg_roles where rolname = 'anonymous') then create role anonymous; end if;
  if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated; end if; end $$`;

// 1 つずつ順に（前のものが終わってから次へ）
const inOrder = (list, fn) => list.reduce((prev, x) => prev.then(() => fn(x)), Promise.resolve());

/** 専用のデータベースを作って開く。=> { pool, as, rpc, newUsers, close } */
export async function openTestDb(prefix) {
  const admin = new pg.Pool({ connectionString: DBURL, max: 2 });
  admin.on('error', () => {});
  const name = `${prefix}_${process.pid}_${Date.now()}`;
  await admin.query(`create database ${name} template template0 encoding 'UTF8'`);
  const url = new URL(DBURL); url.pathname = '/' + name;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 10 });
  pool.on('error', () => {});   // 後片付けで接続が切られても落ちない
  await pool.query(ROLES);
  await pool.query(NEON_AUTH);
  await inOrder(readdirSync(MIGRATIONS).filter(x => x.endsWith('.sql')).sort((a, b) => a.localeCompare(b)), f => pool.query(readFileSync(new URL(f, MIGRATIONS), 'utf8')));

  // role で SQL を 1 本実行（Data API と同じく request.jwt.claims を入れて set local role）
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
  // RPC を本人として呼ぶ
  const rpc = (uid, fn, args = []) => as('authenticated', { sub: uid, role: 'authenticated' }, `select public.${fn}(${args.map((_, i) => '$' + (i + 1)).join(',')}) as x`, args).then(r => r[0].x);
  // 利用者を n 人作る（プロフィールも）
  async function newUsers(n) {
    const us = Array.from({ length: n }, () => randomUUID());
    await inOrder(us, async u => { await pool.query('insert into neon_auth."user"(id) values($1)', [u]); await rpc(u, 'me'); });
    return us;
  }
  async function close() {
    await pool.end().catch(() => {});
    try { await admin.query(`drop database if exists ${name} with (force)`); } finally { await admin.end(); }
  }
  return { pool, as, rpc, newUsers, close };
}

/**
 * 始まった部屋を最後まで打つ（だいたいチェック / コール、ときどきオールイン）。clock = { t }（makeDb の now が読む時計）を進めながら。
 * => 終局したときの uids[0] のビュー
 */
export async function playOut(ctx, room, uids, clock, guard = 1) {
  if (guard > 5000) throw new Error('終局しない');
  const { db, rpc } = ctx;
  clock.t += 1000;
  const views = (await Promise.all(uids.map(u => rpc(u, 'room_poll', [room, -1])))).map(p => p.view);
  const v = views[0];
  if (v.status !== 'running') return v;
  if (v.hand.phase === 'settled') {
    clock.t = Math.max(clock.t, v.nextAt);
    await db.tick(uids[0], room);
  } else {
    const at = views.findIndex(x => x.seat === x.hand.toAct), L = legalActions(views[at]);
    let move = { type: L.canCheck ? 'check' : 'call' };
    if (L.minTo != null && guard % 5 === 0) move = { type: 'allin' };
    await db.request(uids[at], room, { op: 'act', ver: views[at].ver, move });
  }
  return playOut(ctx, room, uids, clock, guard + 1);
}
