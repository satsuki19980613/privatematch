// スクリプト共通の Neon プロジェクト。NEON_API_KEY（API キー）と NEON_PROJECT_ID（プロジェクト ID）は環境変数で受け取る
// （GitHub Actions では Secrets / Variables から入る）。接続文字列（パスワード入り）は必要なときに取得し、表示しない。
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const ROOT = resolve(import.meta.dirname, '..');
const NEONCTL = resolve(ROOT, 'node_modules/neonctl/bin/cli.js');

export function project() {
  const p = process.env.NEON_PROJECT_ID;
  if (!p) { console.error('環境変数 NEON_PROJECT_ID（Neon のプロジェクト ID）が必要です'); process.exit(2); }
  return p;
}
export function run(cmd, args, { env } = {}) {
  return new Promise((ok, fail) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    let out = '', err = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d); p.on('error', fail);
    p.on('close', code => code === 0 ? ok(out) : fail(new Error(err.trim() || out.trim() || `${cmd} exit ${code}`)));
  });
}
export const neon = (...args) => run(process.execPath, [NEONCTL, ...args, '--project-id', project(), '--no-color']);
export function branchArg() {
  const i = process.argv.indexOf('--branch'); const b = i > 0 ? process.argv[i + 1] : null;
  if (!b) { console.error('--branch <branch> が必要です'); process.exit(2); }
  return b;
}
export async function connectionString(branch) {
  const url = (await neon('connection-string', branch, '--role-name', 'neondb_owner')).trim();
  if (!url.startsWith('postgres')) throw new Error(`接続文字列を取得できません（ブランチ ${branch}）`);
  return url.replace('sslmode=require', 'sslmode=verify-full');
}
/** GitHub Actions のステップ出力に書く（Actions の外では何もしない） */
export function output(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}
/** 末尾の / を取る */
export const noTrail = s => { let n = s.length; while (s[n - 1] === '/') { n--; } return s.slice(0, n); };
/** 出力の中の URL のうち、test に合い、suffix で終わるものを優先して 1 つ */
export function pickUrl(text, test, suffix) {
  const urls = [...new Set(text.match(/https:\/\/[^"'\s,)]+/g) || [])].filter(u => test.test(u)).map(noTrail);
  return urls.find(u => u.endsWith(suffix)) || urls.toSorted((a, b) => a.length - b.length)[0] || null;
}
