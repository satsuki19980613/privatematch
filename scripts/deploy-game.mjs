// Neon Function "game" を配備する：node scripts/deploy-game.mjs --branch <branch>
// 許可する Origin は APP_ORIGIN（本番のサイト。例 https://privatematch.pages.dev）。ALLOW_LOCALHOST=1（開発用ブランチ）なら localhost も。
// FRIEND MATCH のメンバー確認（Discord）の設定 DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET / DISCORD_GUILD_ID / DISCORD_ROLE_ID があれば Function に渡す
// （無ければ FRIEND MATCH だけが使えない。docs/SETUP.md）。
// 呼び出し URL は標準出力と（GitHub Actions なら）ステップ出力 game_url に出す。
import { branchArg, neon, noTrail, output, pickUrl } from './neon.mjs';

const branch = branchArg();
const local = process.env.ALLOW_LOCALHOST === '1' ? ['http://localhost:5180', 'http://localhost:4180'] : [];
const origins = [process.env.APP_ORIGIN, ...local].filter(Boolean).map(noTrail);
const discord = ['DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'DISCORD_GUILD_ID', 'DISCORD_ROLE_ID'].filter(k => process.env[k]).flatMap(k => ['--env', `${k}=${process.env[k]}`]);
const out = await neon('functions', 'deploy', 'game', '--branch', branch, '--src', 'server/game/index.js', '--runtime', 'nodejs24',
  '--env', `ALLOWED_ORIGINS=${origins.join(',')}`, ...discord, '--output', 'json');
let url = pickUrl(out, /compute/, '/');
if (!url) url = pickUrl(await neon('functions', 'get', 'game', '--branch', branch, '--output', 'json'), /compute/, '/');
if (!url) { console.log(out); throw new Error('Function の URL が分かりません'); }
url += '/';
output('game_url', url);
console.log(`配備しました（${branch}）: ${url}`);
