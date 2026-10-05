// 本番の公開の住所を .env.production と src/prodConfig.js に書く：node scripts/write-config.mjs
// 値は環境変数 AUTH_URL / DATA_URL / GAME_URL（Deploy の前のステップの出力）。変わったかどうかを（GitHub Actions なら）ステップ出力 changed に出す。
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT, output } from './neon.mjs';

const { AUTH_URL, DATA_URL, GAME_URL } = process.env;
if (!AUTH_URL || !DATA_URL || !GAME_URL) { console.error('AUTH_URL / DATA_URL / GAME_URL が必要です'); process.exit(2); }
const files = {
  '.env.production': `# 本番の公開の住所（秘密ではない）。GitHub Actions の Deploy が scripts/write-config.mjs で書き換えてコミットする。
VITE_NEON_AUTH_URL=${AUTH_URL}
VITE_NEON_DATA_API_URL=${DATA_URL}
VITE_GAME_URL=${GAME_URL}
`,
  'src/prodConfig.js': `// 本番の Neon Auth の URL（公開の住所。秘密ではない）。GitHub Actions の Deploy が scripts/write-config.mjs で書き換えてコミットする。
// functions/api/auth/[[path]].js（ログインの中継）が読む。サイト側の URL は .env.production にある。
export const NEON_AUTH_URL = ${JSON.stringify(AUTH_URL)};
`,
};
let changed = false;
for (const [f, text] of Object.entries(files)) {
  const p = resolve(ROOT, f);
  let cur = ''; try { cur = readFileSync(p, 'utf8'); } catch { /* 無ければ作る */ }
  if (cur !== text) { writeFileSync(p, text); changed = true; console.log(`更新: ${f}`); }
}
output('changed', String(changed));
if (!changed) console.log('本番の住所は変わっていません');
