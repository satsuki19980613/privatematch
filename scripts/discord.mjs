// Discord のアプリの準備（FRIEND MATCH の「番号での確認」。server/game/discord.js）。scripts/deploy-game.mjs が呼ぶ。
//   prepareDiscord : アプリ自身として Discord に入り（client credentials。利用者のデータには触れない）、アプリの公開鍵を読む
//   registerLink   : /link コマンドを登録する（アプリ全体のコマンド。使えるのはサーバーの中だけ）
// どちらも、うまくいかなくても配備は止めない（番号での確認だけが使えないままになる）。GitHub Actions には警告を出す。
// 設定：DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET。DISCORD_PUBLIC_KEY があれば、公開鍵はそれを使う（Discord から読めないときの手当て）。
import { LINK_COMMAND } from '../server/game/discord.js';

const API = 'https://discord.com/api/v10';
const TIMEOUT_MS = 10_000, TRIES = 3, WAIT_MS = 2000;
const HEX64 = /^[0-9a-f]{64}$/i;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const warn = text => console.log(`${process.env.GITHUB_ACTIONS ? '::warning::' : '警告: '}${text}`);

// Discord を呼ぶ。届かない・混んでいる（429 / 5xx）ときは少し待ってやり直す。=> 応答の JSON
async function call(path, init, left = TRIES) {
  let res = null;
  try { res = await fetch(API + path, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) }); } catch { /* 届かない：下でやり直す */ }
  if (res?.ok) return res.json();
  const retry = !res || res.status === 429 || res.status >= 500;
  if (!retry || left <= 1) throw new Error(`Discord ${path}: ${res ? res.status : '届きません'}`);
  await sleep(WAIT_MS);
  return call(path, init, left - 1);
}

// アプリ自身のトークン（コマンドの登録に使える scope だけ）
async function appToken(clientId, clientSecret) {
  const basic = 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const b = await call('/oauth2/token', {
    method: 'POST', headers: { Authorization: basic, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'applications.commands.update' }).toString(),
  });
  if (typeof b?.access_token !== 'string' || !b.access_token) throw new Error('Discord のトークンが取れません');
  return b.access_token;
}

/** 配備の前：=> { clientId, token, publicKey }（Discord の設定が無い・読めないときは、その値が null） */
export async function prepareDiscord(env) {
  const clientId = env.DISCORD_CLIENT_ID || null, given = HEX64.test(env.DISCORD_PUBLIC_KEY ?? '') ? env.DISCORD_PUBLIC_KEY : null;
  if (!clientId || !env.DISCORD_CLIENT_SECRET) return { clientId, token: null, publicKey: given };
  try {
    const token = await appToken(clientId, env.DISCORD_CLIENT_SECRET);
    if (given) return { clientId, token, publicKey: given };
    const key = (await call('/oauth2/@me', { headers: { Authorization: `Bearer ${token}` } }))?.application?.verify_key;
    if (!HEX64.test(key ?? '')) warn('Discord からアプリの公開鍵を読めませんでした。Variable DISCORD_PUBLIC_KEY に入れてください（docs/SETUP.md）。番号での確認は使えません');
    return { clientId, token, publicKey: HEX64.test(key ?? '') ? key : null };
  } catch (e) {
    warn(`Discord の準備に失敗しました（${e.message}）。${given ? '' : '番号での確認は使えません'}`);
    return { clientId, token: null, publicKey: given };
  }
}

/** 配備のあと：/link コマンドを登録する（同じ内容なら何度登録しても変わらない）。url = Function の URL（Discord に登録する呼び出し先） */
export async function registerLink(app, url) {
  if (!app.publicKey) return;
  if (!app.token) return warn('Discord に入れなかったので、/link コマンドは登録していません（前に登録したものがあればそのまま使えます）');
  try {
    await call(`/applications/${encodeURIComponent(app.clientId)}/commands`, {
      method: 'PUT', headers: { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify([LINK_COMMAND]),
    });
    console.log(`Discord の /${LINK_COMMAND.name} コマンドを登録しました。Interactions Endpoint URL: ${url}`);
  } catch (e) {
    warn(`/link コマンドを登録できませんでした（${e.message}）`);
  }
}
