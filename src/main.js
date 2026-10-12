// PrivateMatch — 入口：起動、画面の切り替え、アカウント、招待 URL。各画面は src/ui/*。
import './ui/viewport.js';
import * as realNet from './net.js';
import { app, $, toast, closeAllDlg, localSet, REDUCE, INVITE_KEY } from './ui/util.js';
import { renderMenu, setPane, openJoin, currentPane } from './ui/menu.js';
import * as room from './ui/room.js';
import * as table from './ui/table.js';
import * as stats from './ui/stats.js';
import * as friend from './ui/friend.js';
import * as ingame from './ui/ingame.js';
import { openRules } from './ui/rules.js';
import { openSettings, onSizesChange } from './ui/settings.js';
import { onFxChange } from './ui/gif.js';
import { syncRecent } from './history/sync.js';
import { useDemo } from './klipy.js';
import * as update from './ui/update.js';

app.net = realNet; // http://localhost:<port>/?fake では src/fakeNet.js に差し替える（開発のみ）

const CODE = /^\d{6}$/;

/* ---------- 画面 ---------- */
function showScreen(n) {
  document.body.dataset.screen = n;
  if (n !== 'game') document.body.classList.remove('land');
}
function toMenu() {
  ingame.closeAll(); table.leave(); room.stop(); closeAllDlg(); stats.invalidate(); friend.invalidate();
  showScreen('menu'); setPane('main');
  if (app.user) void refreshMe();
  void update.check();   // 試合の間に新しい版が出ていたら、ここで読み込み直す
}
function enterRoom(id, first) {
  if (table.activeId() === id) return;
  table.leave(); closeAllDlg(); showScreen('menu');
  if (first?.view && !first.view.lobby) return enterTable(id);
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
  if (!synced && app.prof?.recent) { synced = true; syncRecent(app.prof.recent).then(() => stats.invalidate(), () => { /* この端末に保存できない：次の起動でまた試す */ }); }
  // 部屋に居る（再読み込みなど）：待機室か卓へ戻る
  const r = app.prof?.room;
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
  if (u.searchParams.has('room')) { if (!code && CODE.test(u.searchParams.get('room'))) { code = u.searchParams.get('room'); } u.searchParams.delete('room'); history.replaceState(null, '', u.pathname + u.search + u.hash); }
  if (code && app.prof && !app.prof.room) void openJoin(code);
}

/* ---------- ヘッダ・ダイアログ ---------- */
$('#rulesBtn').addEventListener('click', openRules);
$('#setBtn').addEventListener('click', openSettings);
onSizesChange(table.sizesChanged);
// 部屋に入った後に演出 GIF を変えたら、すぐ部屋にも反映する（PRIVATE MATCH と FRIEND MATCH。サーバーが FREE MATCH は無視する）
onFxChange(fx => {
  const id = table.activeId() || room.activeId();
  if (id) app.net.game({ op: 'fx', room: id, fx }).catch(() => {});
});
$('#leaveBtn').addEventListener('click', table.askLeave);
ingame.init(); // チャット履歴・ハンド履歴のボタンとモーダル
$('#themeToggle').addEventListener('click', () => {
  const r = document.documentElement, cur = r.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'), next = cur === 'dark' ? 'light' : 'dark';
  r.dataset.theme = next; localSet('pm-theme', next);
  const t = $('#themeToggle'); if (t.animate && !REDUCE) t.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(180deg)' }], { duration: 500, easing: 'cubic-bezier(.2,.8,.2,1)' });
});
document.addEventListener('click', e => { const cl = e.target.closest('[data-close]'); if (cl) cl.closest('dialog').close(); });
document.querySelectorAll('dialog').forEach(d => d.addEventListener('click', e => { if (e.target === d && d.id !== 'overDlg') d.close(); }));

/* ---------- 起動 ---------- */
async function boot() {
  const q = new URLSearchParams(location.search);
  // ?demo：ログインもサーバーも使わない（Bot と打てる・STATS にサンプル）。開発中は ?fake も同じ代役を使う
  if (q.has('demo') || (import.meta.env.DEV && q.has('fake'))) {
    app.net = await import('./fakeNet.js');
    // 演出 GIF は KLIPY の代わりに手元の見本（src/fxDemo.js）
    useDemo((await import('./fxDemo.js')).demo);
    if (q.has('demo')) { document.body.classList.add('demo'); try { await (await import('./demo.js')).seed(); } catch (e) { /* IndexedDB が使えない */ } }
  }
  app.booting = app.net.online;
  // Discord の確認（FRIEND MATCH）から戻ってきた URL なら、その値を受け取っておく（ログインの確認が URL の error を消す前に）
  const discord = friend.takeReturn();
  stashInvite();
  showScreen('menu'); renderMenu();
  if (!app.net.online) return;
  if (app.net === realNet) realNet.onSessionLost(() => { table.leave(); room.stop(); app.user = null; app.prof = null; showScreen('menu'); renderMenu(); toast('ログインし直してください'); });
  try { app.user = await app.net.currentUser(); } catch (e) { app.user = null; }
  app.booting = false;
  // まだログインしていないブラウザに戻ってきた（Discord のアプリ内ブラウザから始めたときなど）：ログインのあとで、もう一度確認してもらう
  if (!app.user) { friend.deferReturn(discord); return renderMenu(); }
  stashInvite();
  await afterLogin(discord);
}
// ログイン済みの起動：Discord の戻り（あれば）を確かめてから、プロフィールと居る部屋を読む
async function afterLogin(discord) {
  const linked = discord ? await friend.finishReturn(discord) : false;
  await refreshMe();
  if (!linked) return friend.resumeGate();
  // 確認できたら FRIEND MATCH の入口へ（部屋に戻った・招待 URL の確認が開いたときはそちらを優先）
  if (friend.isFriend() && !app.prof?.room && !$('#joinDlg').open) setPane('friend');
}
// 自動更新（src/ui/update.js）：読み込み直してよいのは、メニューに居て（待機室・卓ではない）、ダイアログも入力の途中も無いとき
const typing = () => ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
update.init(() => !app.booting && document.body.dataset.screen === 'menu' && currentPane() !== 'room' && !document.querySelector('dialog[open]') && !typing());
// アプリとしてインストールできるように（キャッシュはしない。public/sw.js）
if ('serviceWorker' in navigator && !import.meta.env.DEV) addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
await boot();
