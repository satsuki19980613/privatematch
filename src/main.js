// PrivateMatch — 入口：起動、画面の切り替え、アカウント、招待 URL。各画面は src/ui/*。
import './ui/viewport.js';
import * as realNet from './net.js';
import { app, $, toast, closeAllDlg, localSet, REDUCE } from './ui/util.js';
import { renderMenu, setPane, openJoin } from './ui/menu.js';
import * as room from './ui/room.js';
import * as table from './ui/table.js';
import * as stats from './ui/stats.js';
import { openRules } from './ui/rules.js';
import { syncRecent } from './history/sync.js';

app.net = realNet; // http://localhost:<port>/?fake では src/fakeNet.js に差し替える（開発のみ）

const INVITE_KEY = 'pm-invite';
const CODE = /^[0-9]{6}$/;

/* ---------- 画面 ---------- */
function showScreen(n) {
  document.body.dataset.screen = n;
  if (n !== 'game') document.body.classList.remove('land');
}
function toMenu() {
  table.leave(); room.stop(); closeAllDlg(); stats.invalidate();
  showScreen('menu'); setPane('main');
  if (app.user) refreshMe();
}
function enterRoom(id, first) {
  if (table.activeId() === id) return;
  table.leave(); closeAllDlg(); showScreen('menu');
  if (first && first.view && !first.view.lobby) return enterTable(id);
  room.enter(id, first);
}
function enterTable(id) {
  room.stop(); closeAllDlg(); showScreen('game');
  table.enter(id);
}

/* ---------- アカウント ---------- */
let synced = false;
async function refreshMe() {
  try { app.prof = await app.net.rpc('me'); }
  catch (e) { if (e.code === 'not_authenticated') { app.user = null; app.prof = null; } renderMenu(); return null; }
  if (!synced && app.prof && app.prof.recent) { synced = true; syncRecent(app.prof.recent).then(() => stats.invalidate()); }
  // 部屋に居る（再読み込みなど）：待機室か卓へ戻る
  const r = app.prof && app.prof.room;
  if (r && !table.active() && !room.activeId()) { enterRoom(r.id); return app.prof; }
  renderMenu();
  takeInvite();
  return app.prof;
}
async function logout() {
  try { await app.net.signOut(); } catch (e) { /* ignore */ }
  table.leave(); room.stop();
  app.user = null; app.prof = null; showScreen('menu'); setPane('main');
}
Object.assign(app.nav, { toMenu, enterRoom, enterTable, refreshMe, logout });

/* ---------- 招待 URL（/?room=123456）。ログインの往復をまたぐのでセッションに預ける ---------- */
function stashInvite() {
  const u = new URL(location.href), code = u.searchParams.get('room');
  if (code == null) return;
  if (CODE.test(code)) { try { sessionStorage.setItem(INVITE_KEY, code); } catch (e) { /* ignore */ } }
  // ログイン前はログインの戻り先に残すため、URL から消すのはログイン後
  if (app.user) { u.searchParams.delete('room'); history.replaceState(null, '', u.pathname + u.search + u.hash); }
}
function takeInvite() {
  let code = null;
  try { code = sessionStorage.getItem(INVITE_KEY); sessionStorage.removeItem(INVITE_KEY); } catch (e) { /* ignore */ }
  const u = new URL(location.href);
  if (u.searchParams.has('room')) { if (!code && CODE.test(u.searchParams.get('room'))) code = u.searchParams.get('room'); u.searchParams.delete('room'); history.replaceState(null, '', u.pathname + u.search + u.hash); }
  if (code && app.prof && !app.prof.room) openJoin(code);
}

/* ---------- ヘッダ・ダイアログ ---------- */
$('#rulesBtn').addEventListener('click', openRules);
$('#leaveBtn').addEventListener('click', table.askLeave);
$('#themeToggle').addEventListener('click', () => {
  const r = document.documentElement, cur = r.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'), next = cur === 'dark' ? 'light' : 'dark';
  r.dataset.theme = next; localSet('pm-theme', next);
  const t = $('#themeToggle'); if (t.animate && !REDUCE) t.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(180deg)' }], { duration: 500, easing: 'cubic-bezier(.2,.8,.2,1)' });
});
document.addEventListener('click', e => { const cl = e.target.closest('[data-close]'); if (cl) cl.closest('dialog').close(); });
document.querySelectorAll('dialog').forEach(d => d.addEventListener('click', e => { if (e.target === d && d.id !== 'overDlg') d.close(); }));

/* ---------- 起動 ---------- */
async function boot() {
  if (import.meta.env.DEV && new URLSearchParams(location.search).has('fake')) { app.net = await import('./fakeNet.js'); }
  app.booting = app.net.online;
  stashInvite();
  showScreen('menu'); renderMenu();
  if (!app.net.online) return;
  if (app.net === realNet) realNet.onSessionLost(() => { table.leave(); room.stop(); app.user = null; app.prof = null; showScreen('menu'); renderMenu(); toast('ログインし直してください'); });
  try { app.user = await app.net.currentUser(); } catch (e) { app.user = null; }
  app.booting = false;
  if (!app.user) return renderMenu();
  stashInvite();
  await refreshMe();
}
boot();
// アプリとしてインストールできるように（キャッシュはしない。public/sw.js）
if ('serviceWorker' in navigator && !import.meta.env.DEV) addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
