// 本物のサーバーとの通信確認（GitHub Actions の Live から。.github/workflows/live.yml）
//   node scripts/live-check.mjs prod  本番：サイト・ログイン中継・Function・Data API に、ログインせずに届くか（何も書き込まない）
//   node scripts/live-check.mjs e2e   開発用ブランチ：テスト用の利用者を作り、部屋の作成から終局・記録の取得まで本物の通信で遊ぶ
// 環境変数：SITE（prod）、AUTH_URL / DATA_URL / GAME_URL（両方）、ORIGIN（e2e。開発用ブランチが許す http://localhost:5180）
import { appendFileSync } from 'node:fs';
import { legalActions } from '../src/engine.js';

const mode = process.argv[2];
const env = n => { const v = process.env[n]; if (!v) { console.error(`環境変数 ${n} が必要です`); process.exit(2); } return v.replace(/\/+$/, ''); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = []; const lat = {};
let failed = 0;
function check(name, ok, detail = '') {
  results.push({ name, ok, detail }); if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'NG  '} ${name}${detail ? ` — ${detail}` : ''}`);
}
async function timed(label, url, init = {}) {
  const t = performance.now();
  const r = await fetch(url, { redirect: 'manual', ...init });
  const body = await r.text();
  (lat[label] ??= []).push(performance.now() - t);
  let json = null; try { json = JSON.parse(body); } catch { /* not json */ }
  return { status: r.status, headers: r.headers, body, json };
}
function summary(title) {
  const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
  const lines = [`### ${title}`, '', `${results.length - failed} / ${results.length} 件 OK`, '', '| 確認 | 結果 | 詳細 |', '|---|---|---|',
    ...results.map(r => `| ${r.name} | ${r.ok ? 'OK' : '**NG**'} | ${String(r.detail).replace(/\|/g, '\\|').slice(0, 200)} |`),
    '', '| 通信 | 回数 | 中央値 ms | 95% ms | 最大 ms |', '|---|---|---|---|---|',
    ...Object.entries(lat).map(([k, a]) => `| ${k} | ${a.length} | ${pct(a, 0.5).toFixed(0)} | ${pct(a, 0.95).toFixed(0)} | ${Math.max(...a).toFixed(0)} |`), ''];
  console.log(lines.join('\n'));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
}

/* ---------- 本番（読み取りだけ） ---------- */
async function prod() {
  const SITE = env('SITE'), DATA = env('DATA_URL'), GAME = env('GAME_URL') + '/';
  const top = await timed('site', SITE + '/');
  check('サイト / が 200', top.status === 200, `${top.status}`);
  const csp = top.headers.get('content-security-policy') || '';
  check('CSP ヘッダがある', csp.includes("default-src"), csp.slice(0, 120));
  check('CSP が Neon への通信を許す', /connect-src[^;]*neon\.tech/.test(csp));
  const assets = [...top.body.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map(m => m[1]);
  check('ビルドした JS / CSS が index.html にある', assets.length >= 2, assets.join(' '));
  for (const a of assets) { const r = await timed('site', SITE + a); check(`${a} が 200`, r.status === 200, `${r.status} ${r.headers.get('content-type')}`); }
  const js = assets.find(a => a.endsWith('.js'));
  if (js) {
    const r = await timed('site', SITE + js);
    check('JS に本番の Data API / Function の URL が入っている', r.body.includes(DATA) && r.body.includes(GAME.replace(/\/$/, '')));
  }
  for (const p of ['/manifest.webmanifest', '/sw.js', '/theme.js', '/icon.svg']) {
    const r = await timed('site', SITE + p); check(`${p} が 200`, r.status === 200, `${r.status}`);
  }
  const ok = await timed('auth relay', SITE + '/api/auth/ok');
  check('ログイン中継 /api/auth/ok が 200', ok.status === 200, `${ok.status} ${ok.body.slice(0, 80)}`);
  const sess = await timed('auth relay', SITE + '/api/auth/get-session');
  check('未ログインの get-session が 200・利用者なし', sess.status === 200 && !(sess.json && sess.json.user), `${sess.status} ${sess.body.slice(0, 80)}`);
  const tok = await timed('auth relay', SITE + '/api/auth/token');
  check('未ログインの token が 401', tok.status === 401, `${tok.status} ${tok.body.slice(0, 80)}`);
  const so = await timed('auth relay', SITE + '/api/auth/sign-in/social', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: SITE },
    body: JSON.stringify({ provider: 'google', callbackURL: SITE + '/', errorCallbackURL: SITE + '/?error=login_failed', disableRedirect: true }) });
  const gurl = so.json && so.json.url || '';
  check('Google ログインの開始が Google の同意画面の URL を返す', so.status === 200 && /^https:\/\/accounts\.google\.com\//.test(gurl), `${so.status} ${gurl.slice(0, 60) || so.body.slice(0, 120)}`);
  const sc = so.headers.getSetCookie();
  check('ログイン開始の Cookie がこのサイトのもの（Domain 無し・Secure）', sc.length > 0 && sc.every(c => !/;\s*domain=/i.test(c) && /;\s*secure/i.test(c)), sc.map(c => c.split(';')[0].split('=')[0]).join(', '));
  const nf = await timed('auth relay', SITE + '/api/auth/sign-up/email', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  check('中継しないパス（sign-up/email）は 404', nf.status === 404, `${nf.status}`);

  // Function：CORS とログイン必須
  const pre = await timed('function', GAME, { method: 'OPTIONS', headers: { Origin: SITE, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } });
  check('Function の preflight がサイトを許す', pre.status === 204 && pre.headers.get('access-control-allow-origin') === SITE, `${pre.status} ${pre.headers.get('access-control-allow-origin')}`);
  const evil = await timed('function', GAME, { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' } });
  check('Function の preflight がほかのサイトを許さない', !evil.headers.get('access-control-allow-origin'), `${evil.headers.get('access-control-allow-origin')}`);
  const g0 = await timed('function', GAME, { method: 'POST', headers: { Origin: SITE, 'Content-Type': 'application/json' }, body: '{"op":"tick"}' });
  check('Function はトークン無しを 401 で断る', g0.status === 401 && g0.headers.get('access-control-allow-origin') === SITE, `${g0.status} ${g0.body.slice(0, 80)}`);
  const g1 = await timed('function', GAME, { method: 'POST', headers: { Origin: SITE, 'Content-Type': 'application/json', Authorization: 'Bearer eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ4In0.AAAA' }, body: '{"op":"tick"}' });
  check('Function は偽のトークンを 401 で断る', g1.status === 401, `${g1.status}`);

  // Data API：CORS とログイン必須
  const dpre = await timed('data api', DATA + '/rpc/me', { method: 'OPTIONS', headers: { Origin: SITE, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } });
  const acao = dpre.headers.get('access-control-allow-origin');
  check('Data API の preflight がサイトを許す', dpre.status < 300 && (acao === '*' || acao === SITE), `${dpre.status} ${acao} ${dpre.headers.get('access-control-allow-headers')}`);
  const d0 = await timed('data api', DATA + '/rpc/me', { method: 'POST', headers: { Origin: SITE, 'Content-Type': 'application/json' }, body: '{}' });
  check('Data API はトークン無しを断る（4xx）', d0.status >= 400 && d0.status < 500, `${d0.status} ${d0.body.slice(0, 160)}`);
  const d1 = await timed('data api', DATA + '/rpc/me', { method: 'POST', headers: { Origin: SITE, 'Content-Type': 'application/json', Authorization: 'Bearer eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ4In0.AAAA' }, body: '{}' });
  check('Data API は偽のトークンを断る（4xx）', d1.status >= 400 && d1.status < 500, `${d1.status} ${d1.body.slice(0, 160)}`);
  for (const t of ['profiles', 'rooms', 'room_hands']) {
    const r = await timed('data api', `${DATA}/${t}?select=*&limit=1`, { headers: { Origin: SITE } });
    check(`Data API で表 ${t} を直接読めない`, r.status >= 400, `${r.status} ${r.body.slice(0, 100)}`);
  }
  summary('本番の通信確認');
}

/* ---------- 開発用ブランチで実際に遊ぶ ---------- */
async function e2e() {
  const AUTH = env('AUTH_URL'), DATA = env('DATA_URL'), GAME = env('GAME_URL') + '/', ORIGIN = env('ORIGIN');
  const RUN = Date.now().toString(36);
  const users = [];
  async function signUp(i) {
    const email = `pm-live-${RUN}-${i}@example.com`;
    const r = await timed('auth', AUTH + '/sign-up/email', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({ email, password: `Pw-${RUN}-${i}-live!`, name: `Live ${i}` }) });
    const cookie = r.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
    if (r.status !== 200 || !cookie) throw new Error(`sign-up ${r.status} ${r.body.slice(0, 200)}`);
    const t = await timed('auth', AUTH + '/token', { headers: { Cookie: cookie, Origin: ORIGIN } });
    if (t.status !== 200 || !t.json || !t.json.token) throw new Error(`token ${t.status} ${t.body.slice(0, 200)}`);
    const claims = JSON.parse(Buffer.from(t.json.token.split('.')[1], 'base64url'));
    return { i, email, cookie, jwt: t.json.token, uid: claims.sub, claims };
  }
  const call = async (label, url, u, body) => {
    const r = await timed(label, url, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN, ...(u ? { Authorization: `Bearer ${u.jwt}` } : {}) }, body: JSON.stringify(body) });
    return { ...r, code: r.json && (r.json.error || r.json.message) };
  };
  const rpc = (u, name, args = {}) => call(`rpc ${name}`, `${DATA}/rpc/${name}`, u, args);
  const game = (u, body) => call(`game ${body.op}`, GAME, u, body);

  for (let i = 0; i < 4; i++) users.push(await signUp(i));
  const c0 = users[0].claims;
  check('テスト用の利用者を 4 人作り JWT を得た', users.every(u => u.jwt && u.uid), `role=${c0.role} iss=${c0.iss} aud=${c0.aud} exp-iat=${c0.exp - c0.iat}s`);

  // プロフィール
  for (const u of users) {
    const r = await rpc(u, 'me');
    check(`me（${u.i}）が 200・自動のニックネーム`, r.status === 200 && /^Player-/.test(r.json && r.json.nickname), `${r.status} ${r.body.slice(0, 120)}`);
    const n = await rpc(u, 'set_nickname', { p_name: `L${RUN.slice(-5)}${u.i}` });
    check(`set_nickname（${u.i}）`, n.status === 200, `${n.status} ${n.body.slice(0, 120)}`);
  }
  const dup = await rpc(users[1], 'set_nickname', { p_name: `l${RUN.slice(-5)}0`.toUpperCase() });
  check('同じニックネーム（大文字小文字違い）は nickname_taken', dup.code === 'nickname_taken', `${dup.status} ${dup.code}`);
  const anon = await rpc(null, 'me');
  check('トークン無しの me は断られる', anon.status >= 400, `${anon.status} ${anon.body.slice(0, 120)}`);

  // FreeMatch：作る → 一覧に出る → 作成者が抜けると消える
  const fr = await game(users[0], { op: 'create', kind: 'free', config: { players: 2, startBb: 75, speed: 'normal', levelMin: 3, mode: 'club' } });
  check('FreeMatch の部屋を作る', fr.status === 200 && fr.json.view && fr.json.view.lobby, `${fr.status} ${fr.body.slice(0, 120)}`);
  const list = await rpc(users[1], 'free_rooms');
  check('ほかの人の free_rooms に出る', list.status === 200 && list.json.some(x => x.id === fr.json.room), `${list.status} ${list.json && list.json.length} 件`);
  const fl = await game(users[0], { op: 'leave', room: fr.json.room });
  check('作成者が抜けると中止', fl.status === 200 && fl.json.view && fl.json.view.status === 'cancelled', `${fl.status} ${fl.body.slice(0, 120)}`);
  const list2 = await rpc(users[1], 'free_rooms');
  check('中止した部屋は free_rooms から消える', list2.status === 200 && !list2.json.some(x => x.id === fr.json.room));

  // PrivateMatch：3 人で終局まで
  const cfg = { players: 3, startBb: 75, speed: 'normal', levelMin: 3, mode: 'rank-3' };
  const cr = await game(users[0], { op: 'create', kind: 'private', config: cfg });
  check('PrivateMatch の部屋を作る', cr.status === 200 && cr.json.view && cr.json.view.lobby && /^\d{6}$/.test(cr.json.view.room.code), `${cr.status} ${cr.body.slice(0, 160)}`);
  const room = cr.json.room, code = cr.json.view.room.code;
  const again = await game(users[0], { op: 'create', kind: 'private', config: cfg });
  check('部屋に居るうちは別の部屋を作れない（in_other_room）', again.code === 'in_other_room' && again.json.room === room, `${again.status} ${again.code}`);
  const peek = await rpc(users[1], 'room_peek', { p_code: code });
  check('部屋番号で概要が見える', peek.status === 200 && peek.json && peek.json.id === room && peek.json.seated === 1 && peek.json.member === false, peek.body.slice(0, 160));
  const bad = await game(users[1], { op: 'join', code: code === '000000' ? '000001' : '000000' });
  check('無い部屋番号は not_found', bad.code === 'not_found', `${bad.status} ${bad.code}`);
  const notMember = await rpc(users[3], 'room_poll', { p_room: room, p_ver: -1 });
  check('参加していない部屋は room_poll できない', notMember.status >= 400 && /not_found/.test(notMember.body), `${notMember.status}`);
  const j1 = await game(users[1], { op: 'join', code });
  check('2 人目が参加', j1.status === 200 && j1.json.view.lobby && j1.json.view.members.length === 2, `${j1.status} ${j1.body.slice(0, 120)}`);
  const j2 = await game(users[2], { op: 'join', code });
  check('3 人目で満席になり開始', j2.status === 200 && j2.json.view && !j2.json.view.lobby && j2.json.view.status === 'running', `${j2.status} ${j2.body.slice(0, 120)}`);
  const j3 = await game(users[3], { op: 'join', code });
  check('満席の部屋には入れない', ['room_full', 'room_closed'].includes(j3.code), `${j3.status} ${j3.code}`);

  const players = users.slice(0, 3);
  const views = new Map();
  async function poll(u) {
    const r = await rpc(u, 'room_poll', { p_room: room, p_ver: -1 });
    if (r.status !== 200 || !r.json.view) throw new Error(`room_poll ${r.status} ${r.body.slice(0, 200)}`);
    views.set(u.uid, r.json.view); return r.json.view;
  }
  let leaks = 0, stale = false, wrongTurn = false, acts = 0, ticks = 0, conserve = true;
  const start = cfg.startBb * 200 * cfg.players;
  const deadline = Date.now() + 12 * 60_000;
  let v;
  while (Date.now() < deadline) {
    for (const u of players) {
      const x = await poll(u);
      if ('deck' in (x.hand || {}) || 'seed' in x) leaks++;
      if (x.hand) x.hand.hole.forEach((c, s) => { if (c && s !== x.seat && !(x.hand.shown && x.hand.shown[s])) leaks++; });
    }
    v = views.get(players[0].uid);
    if (v.status !== 'running' && v.status !== 'paused') break;
    const h = v.hand;
    if (h && h.phase === 'betting') {
      const sum = v.players.reduce((a, p) => a + p.stack, 0) + h.commits.reduce((a, b) => a + b, 0);
      if (sum !== start) conserve = false;
    }
    if (h && h.phase === 'betting' && h.toAct != null) {
      const u = players.find(p => views.get(p.uid).seat === h.toAct), mine = views.get(u.uid), L = legalActions(mine, h.toAct);
      if (!L) { await sleep(500); continue; }
      if (!wrongTurn) {
        const o = players.find(p => p !== u);
        const r = await game(o, { op: 'act', room, ver: views.get(o.uid).ver, move: { type: 'call' } });
        check('手番でない人の act は not_your_turn', r.code === 'not_your_turn', `${r.status} ${r.code}`); wrongTurn = true;
      }
      if (!stale) {
        const r = await game(u, { op: 'act', room, ver: mine.ver - 1, move: { type: 'fold' } });
        check('古い ver の act は stale', r.code === 'stale', `${r.status} ${r.code}`); stale = true;
      }
      // 序盤は普通に打ち、5 ハンド目からはオールインで早く終わらせる
      const move = h.handNo >= 5 ? (L.minTo != null ? { type: 'allin' } : L.canCheck ? { type: 'check' } : { type: 'call' })
        : L.canCheck ? (L.minTo != null && acts % 3 === 0 ? { type: 'raise', to: L.minTo } : { type: 'check' }) : { type: 'call' };
      const r = await game(u, { op: 'act', room, ver: mine.ver, move });
      if (r.status !== 200) check(`act ${JSON.stringify(move)}`, false, `${r.status} ${r.body.slice(0, 160)}`);
      acts++;
    } else {
      const wait = Math.max(0, (v.nextAt ?? 0) - (Date.now()));
      await sleep(Math.min(3500, wait + 200));
      const r = await game(players[ticks % 3], { op: 'tick', room });
      if (r.status !== 200 && r.code !== 'not_yet') check('tick', false, `${r.status} ${r.body.slice(0, 160)}`);
      ticks++;
    }
  }
  check('3 人の試合が終局した', v && v.status === 'finished', `status=${v && v.status} hands=${v && v.handNo} acts=${acts} ticks=${ticks}`);
  check('他席の手札・山札・乱数の種がビューに漏れない', leaks === 0, `${leaks} 件`);
  check('チップの合計が常に一定', conserve);
  const places = v.players.map(p => p.place).sort();
  check('順位が 1〜3 に 1 つずつ', JSON.stringify(places) === '[1,2,3]', JSON.stringify(v.players.map(p => [p.place, p.pt])));

  // 記録
  for (const u of players) {
    const r = await rpc(u, 'room_hands', { p_room: room, p_after: 0 });
    const hs = r.json || [], seat = views.get(u.uid).seat;
    const nos = hs.map(x => x.handNo);
    check(`room_hands（${u.i}）が全ハンド・自分の手札だけ`, r.status === 200 && hs.length === v.handNo && nos.every((n, i) => n === i + 1) && hs.every(x => Array.isArray(x.hole) && x.hole.length === 2),
      `${r.status} ${hs.length}/${v.handNo} seat=${seat}`);
    const later = await rpc(u, 'room_hands', { p_room: room, p_after: v.handNo - 1 });
    check(`room_hands の差分（${u.i}）`, later.status === 200 && later.json.length === 1);
    const me = await rpc(u, 'me');
    check(`終局後の me（${u.i}）：部屋なし・recent にある`, me.status === 200 && me.json.room == null && me.json.recent.some(x => x.id === room));
  }
  const other = await rpc(users[3], 'room_hands', { p_room: room, p_after: 0 });
  check('参加していない人は room_hands を読めない', other.status >= 400 || (Array.isArray(other.json) && other.json.length === 0), `${other.status} ${other.body.slice(0, 80)}`);
  summary('開発用ブランチで本物の通信を使って 1 試合');
}

try { await (mode === 'prod' ? prod() : mode === 'e2e' ? e2e() : Promise.reject(new Error('prod か e2e を指定してください'))); }
catch (e) { check('実行', false, e.message); summary('通信確認（途中で止まった）'); }
process.exit(failed ? 1 : 0);
