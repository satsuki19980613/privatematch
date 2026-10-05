// db/migrations/*.sql のうち未適用のものを適用する：node scripts/db.mjs migrate --branch <branch>
// 1 ファイル = 1 トランザクション。適用済みのファイルは migrations.applied に記録する。
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { ROOT, branchArg, connectionString } from './neon.mjs';

const cmd = process.argv[2];
if (cmd !== 'migrate') { console.error('usage: node scripts/db.mjs migrate --branch <branch>'); process.exit(2); }
const branch = branchArg();
const client = new pg.Client({ connectionString: process.env.DATABASE_URL || await connectionString(branch) });
await client.connect();
try {
  await client.query('create schema if not exists migrations; revoke all on schema migrations from public; create table if not exists migrations.applied (name text primary key, applied_at timestamptz not null default now())');
  const applied = new Set((await client.query('select name from migrations.applied')).rows.map(r => r.name));
  const dir = resolve(ROOT, 'db/migrations'); let n = 0;
  for (const f of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
    if (applied.has(f)) continue;
    await client.query('begin');
    try { await client.query(readFileSync(resolve(dir, f), 'utf8')); await client.query('insert into migrations.applied(name) values($1)', [f]); await client.query('commit'); }
    catch (e) { await client.query('rollback'); throw new Error(`${f}: ${e.message}`); }
    console.log(`適用: ${f}`); n++;
  }
  console.log(n ? `${n} 件を適用しました（${branch}）。` : `未適用のマイグレーションはありません（${branch}）。`);
} finally { await client.end(); }
