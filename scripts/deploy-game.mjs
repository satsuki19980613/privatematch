// Neon Function "game" を配備する：node scripts/deploy-game.mjs --branch <branch>
// 許可する Origin は APP_ORIGIN（本番のサイト。例 https://privatematch.pages.dev）と開発用の localhost。
// 呼び出し URL は標準出力と（GitHub Actions なら）ステップ出力 game_url に出す。
import { branchArg, neon, output, pickUrl } from './neon.mjs';

const branch = branchArg();
const origins = [process.env.APP_ORIGIN, 'http://localhost:5180', 'http://localhost:4180'].filter(Boolean).map(s => s.replace(/\/+$/, ''));
const out = await neon('functions', 'deploy', 'game', '--branch', branch, '--src', 'server/game/index.js', '--runtime', 'nodejs24',
  '--env', `ALLOWED_ORIGINS=${origins.join(',')}`, '--output', 'json');
let url = pickUrl(out, /compute/, '/');
if (!url) url = pickUrl(await neon('functions', 'get', 'game', '--branch', branch, '--output', 'json'), /compute/, '/');
if (!url) { console.log(out); throw new Error('Function の URL が分かりません'); }
url += '/';
output('game_url', url);
console.log(`配備しました（${branch}）: ${url}`);
