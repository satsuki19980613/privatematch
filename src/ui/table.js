// 卓：2〜6 席（自分は常に下）、ボード、ポット、操作ドック、ハンドの結果（ショーダウンの演出）、ポーリングと tick、試合の結果と再戦。
// 状態はサーバーのビュー（room_poll / act / tick）だけから作る。ルールで決めるのは legalActions(view) だけ。
import { legalActions, dueAt, fxSeat } from '../engine.js';
import { BLIND_TABLES, modeLabel, ACTION_MS, levelMsOf, RUNOUT, runoutMs, FX, FX_MS } from '../structure.js';
import { equities, pctOf, bestFive } from '../equity.js';
import { PACE, plan, nextToApply, flipOf } from '../pace.js';
import { rematchLeader } from '../../server/game/rules.js';
import { $, app, esc, fmt, head, openDlg, toast, setHTML, cardHTML, fly, ordinal, clock, REDUCE, EASE, fmtPt, fmtBb, localGet, localSet } from './util.js';
import { syncRoom } from '../history/sync.js';
import * as chat from './chat.js';
import { viewportHooks, gliding } from './viewport.js';
import { quickSizes, stepChips } from '../betsize.js';
import { getSizes } from './settings.js';
import { markOf, onNotes } from '../history/notes.js';
import * as fxshow from './fxshow.js';
import { getFx } from './gif.js';

const GRACE_MS = 1500;
const sum = a => a.reduce((s, x) => s + x, 0);
const net = () => app.net;

let T = null; // 動いている卓（無ければ null）

/* ===================== 入る / 出る ===================== */
export function enter(id) {
  leave();
  T = { id, ver: -1, v: null, busy: false, timer: 0, lockUntil: 0, pre: null, rs: null, resultShown: false, tickAt: 0, tickBusy: false,
    clockCache: null, sh: { handNo: -1, board: -1, settled: -1, revealed: -1, bet: [], init: false }, synced: 0, syncT: 0, leaving: false,
    ro: null, winC: null, rmBusy: false, endSynced: false, q: [], holdUntil: 0, pumpT: 0, sg: null, settledAt: 0, resT: 0 };
  $('#dock').innerHTML = '<div id="dockMain" style="display:contents"></div>';
  chat.start(id);
  // 前の卓の描画の記録も消す（同じ人数・同じ席の卓に入り直したとき＝再戦で、席を作り直さずに止まっていた）
  for (const s of ['#seats', '#pot', '#boardC', '#tInfo', '#betM']) { const e = $(s); e.innerHTML = ''; e._h = null; e._k = null; }
  setHTML($('#dockMain'), '<span class="dk-title">…</span><span class="dots"><i></i><i></i><i></i></span>');
  $('#dock').classList.add('idle');
  document.body.dataset.screen = 'game';
  $('#table').classList.toggle('u-chip', chipUnit);
  syncHeader();
  refit();
  poll();
  T.tickTimer = setInterval(() => { maybeTick(); tickClock(); }, 400);
}
export function leave() {
  if (!T) return;
  document.querySelectorAll('.rsheet').forEach(e => e.remove());
  clearTimeout(T.timer); clearInterval(T.tickTimer); clearTimeout(T.syncT); clearTimeout(T.lockT); clearTimeout(T.pumpT); clearTimeout(T.resT);
  if (T.ro) { T.ro.done = true; T.ro.timers.forEach(clearTimeout); }
  if (T.sg) { T.sg.done = true; T.sg.timers.forEach(clearTimeout); }
  document.querySelectorAll('.fly,.ai-banner,.dock-ghost').forEach(e => e.remove());
  fxshow.clear();
  $('#table').classList.remove('tense');
  for (const d of ['#overDlg', '#leaveDlg']) if ($(d).open) $(d).close();
  chat.stop();
  T = null;
  syncHeader();
}
export const active = () => !!T;
export const activeId = () => (T ? T.id : null);
/** 今のビュー（無ければ null）。卓の外のモジュール（チャット・ハンド履歴）が読む */
export const currentView = () => (T ? T.v : null);

/* ===================== ヘッダ（Leave） ===================== */
function syncHeader() {
  const lb = $('#leaveBtn');
  // 卓に居る間は常に出す（観戦中・終局後は確かめずにメニューへ）
  if (lb) lb.hidden = !T || !T.v || T.leaving;
}
/** 自分はもう打っていない（飛んだ・退出した・終局した）＝観戦 */
const watching = v => v.status === 'finished' || v.status === 'cancelled' || ['out', 'left'].includes(v.players[v.seat].status);
export function askLeave() {
  const t = T; if (!t || !t.v || t.leaving) return;
  if (watching(t.v)) return toMenu();
  $('#leaveBody').innerHTML = head('LEAVE', '退出しますか？') +
    `<p>退出すると戻れません。チップは卓に残り、手番は自動でチェック/フォールドされます。最後まで残った人の順位で pt が決まります。</p>
    <div class="btns"><button class="btn ghost" data-close type="button">Cancel</button><button class="btn danger" id="leaveOk" type="button">Leave</button></div>`;
  openDlg('#leaveDlg');
  $('#leaveOk').onclick = async () => {
    if (T !== t || t.leaving) return;
    t.leaving = true; $('#leaveOk').disabled = true; syncHeader();
    try { const r = await net().game({ op: 'leave', room: t.id }); if (T === t) { clock.offset = r.now - Date.now(); receive(r.view, true); } }
    catch (e) { /* もう終わっていれば同じこと */ }
    $('#leaveDlg').close();
    if (T === t) { await syncRoom(t.id); if (T === t) app.nav.toMenu(); }
  };
}

/* ===================== 同期 ===================== */
async function poll() {
  const t = T; if (!t) return; clearTimeout(t.timer);
  try {
    const r = await net().rpc('room_poll', { p_room: t.id, p_ver: t.ver });
    if (t !== T) return;
    clock.offset = r.now - Date.now();
    if (r.view && !t.busy) receive(r.view);
    if (t !== T) return;   // 再戦の卓へ移った
    chat.onPoll(r.chat);
  } catch (e) {
    if (t !== T) return;
    if (e.code === 'not_found') { toast('卓が見つかりません'); return app.nav.toMenu(); }
  }
  if (t !== T) return;
  maybeTick();
  const v = t.v;
  // 終わった：もう読まない（再戦の受付中は、残った人と再戦の開始を知るために読み続ける）
  if (v && (v.status === 'cancelled' || (v.status === 'finished' && !rematchLive(v)))) return;
  const mine = v && v.hand && v.hand.toAct === v.seat;
  t.timer = setTimeout(poll, document.hidden ? 4000 : v && v.status === 'finished' ? 1500 : mine ? 2500 : 1000);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && T) poll(); });

// 期限を過ぎたものを進める（時間切れ・次のハンド・一時停止の期限）。判断はサーバー。409 not_yet は普通のこと
async function maybeTick() {
  const t = T, v = t && t.v; if (!v || t.tickBusy || t.busy || Date.now() < t.tickAt) return;
  if (v.status !== 'running' && v.status !== 'paused') return;
  const at = dueAt(v); if (at == null) return;
  const grace = v.status === 'running' && v.hand && v.hand.phase === 'betting' ? GRACE_MS : 0;
  if (clock.now() < at + grace) return;
  t.tickBusy = true;
  try {
    const r = await net().game({ op: 'tick', room: t.id });
    if (t === T) { clock.offset = r.now - Date.now(); receive(r.view); }
  } catch (e) {
    if (t === T) t.tickAt = Date.now() + (e.code === 'not_yet' ? 500 + Math.random() * 500 : 1500);
  } finally { t.tickBusy = false; }
}

/* ===================== ビューの受け取りと適用 ===================== */
// 受け取ったビューは列に並べ、前の遷移を見せ終わってから（PACE。src/pace.js）1 つずつ当てる。遷移を重ねないので、
// 画面の状態（ベットのシート・手番の合図・操作ボタン）が古いビューと新しいビューの間で食い違うことが無い。
// now = 自分の操作の返事など、待たずにすぐ当てる（並んでいるものも含めて最新まで飛ばす）
function receive(v, now) {
  const t = T; if (!t || !v || v.lobby) return;
  const top = t.q.length ? t.q[t.q.length - 1].v.ver : t.ver;
  if (v.ver <= top) return;
  t.q.push({ v, at: Date.now() });
  if (now) { const last = t.q[t.q.length - 1]; t.q = []; apply(last.v, true); return; }
  pump();
}
function pump() {
  const t = T; if (!t) return;
  clearTimeout(t.pumpT);
  for (let guard = 0; guard < 50 && T === t && t.q.length; guard++) {
    // 裏に回っている間は動きを見せないので、最新だけを当てる
    const n = document.hidden ? { take: t.q[t.q.length - 1], late: true } : nextToApply(t.q, t.holdUntil, Date.now());
    if (!n.take) { t.pumpT = setTimeout(pump, n.wait + 5); renderDock(); return; }
    t.q = n.late ? [] : t.q.slice(1);
    apply(n.take.v, n.late);
  }
}
document.addEventListener('visibilitychange', () => { if (T) pump(); });
function apply(v, instant) {
  const t = T; if (!v || v.ver <= t.ver || v.lobby) return;
  // 再戦が始まった：席に残っていれば新しい卓へ
  if (v.rematch && v.rematch.next && v.rematch.stay.includes(v.seat)) { closeOver(); toast('REMATCH'); app.nav.enterTable(v.rematch.next.id); return; }
  const prev = t.v;
  t.v = v; t.ver = v.ver;
  const h = v.hand;
  if (t.ro && !t.ro.done && (!h || h.handNo !== t.ro.handNo)) endRunout(false);   // 演出の途中で次のハンドが来た（遅れて飛ばしたとき）
  endStage();
  // 前のビューからの遷移を順に見せる（読み込み直し・裏に回っていた・遅れて飛ばしたときは結果をそのまま）
  const p = !instant && t.sh.init && !document.hidden ? plan(prev, v) : null;
  if (p && p.kind !== 'init' && p.kind !== 'none') startStage(p, v);
  t.holdUntil = Date.now() + (p ? p.hold : 0);
  if (h && h.toAct === v.seat && (!prev || !prev.hand || prev.hand.toAct !== v.seat || prev.hand.handNo !== h.handNo || prev.hand.street !== h.street))
    t.lockUntil = Date.now() + (p ? p.turnAt : 0) + PACE.lock;
  // ベットのシートは開いたときの手番のものだけ（手番が移った・街やハンドが変わった・遷移を見せ始めた）
  if ((t.rs || sheetOpen()) && (!(h && h.toAct === v.seat && h.phase === 'betting' && v.status === 'running') || !t.rs || t.rs.handNo !== h.handNo || t.rs.street !== h.street || stage())) closeSheet();
  // 終わったハンドを端末に写す（少し待ってまとめて）
  // （演出の間はハンド履歴に結果が出ないよう、終わってから）
  if (h && h.phase === 'settled' && h.handNo > t.synced) { t.synced = h.handNo; clearTimeout(t.syncT); t.syncT = setTimeout(() => syncRoom(t.id), 800 + (p && p.veil ? p.hold + runoutMs(h.runFrom) + (fxOf(v) != null ? FX_MS : 0) : 0)); }
  chat.onView(v);
  if (privateRoom(v) && v.fx) fxshow.prepare(v.fx);   // 勝者の演出 GIF を先に読んでおく
  render();
  if (!stage()) autoPre();
  checkResult();
}

/* ---------- 遷移を 1 拍ずつ見せる（src/pace.js の plan を時間どおりに当てる） ---------- */
/** 見せている途中の遷移（無ければ null）。bets / shown / board は、その時点で見せるベット・アクションの数・ボードの枚数 */
function stage() {
  const t = T, h = t && t.v && t.v.hand;
  return t && t.sg && !t.sg.done && h && t.sg.handNo === h.handNo ? t.sg : null;
}
/** 結果を伏せている間（ショーダウンの演出、フォールドで終わる前の一拍）なら その状態 */
function veiled() { const sg = stage(); return runout() || (sg && sg.veil ? sg : null); }
function startStage(p, v) {
  const t = T, h = v.hand;
  const sg = t.sg = { handNo: h.handNo, kind: p.kind, veil: p.veil, board: p.board, bets: p.bets0, shown: p.shown0, street: p.street0, adj: null,
    turnAt: Date.now() + p.turnAt, timers: [], done: false };
  const at = (ms, f) => sg.timers.push(setTimeout(() => { if (T === t && t.sg === sg && !sg.done) f(); }, ms));
  p.steps.forEach((st, i) => {
    const go = () => { Object.assign(sg, { bets: st.bets, shown: st.shown, street: st.street, adj: st.adj }); if (i) render(); };
    if (i === 0) go(); else at(st.at, go);
  });
  if (p.gatherAt != null) at(p.gatherAt, () => { gather(); sg.bets = sg.bets && sg.bets.map(() => 0); sg.adj = null; render(); });
  if (p.revealAt != null) at(p.revealAt, () => { sg.board = null; sg.veil = false; sg.shown = null; sg.street = null; render(); });
  if (p.runoutAt != null) at(p.runoutAt, () => { finishStage(false); startRunout(v); render(); });
  else at(p.turnAt, () => finishStage(true));
}
function endStage() { const sg = T && T.sg; if (sg && !sg.done) { sg.done = true; sg.timers.forEach(clearTimeout); } }
function finishStage(show) {
  endStage();
  if (show) { render(); autoPre(); checkResult(); }
}

/* ---------- 結果 ---------- */
function checkResult() {
  const t = T, v = t.v; if (!v || veiled()) return;   // 結果を伏せている間（ショーダウンの演出など）は出さない
  const me = v.players[v.seat], ended = v.status === 'finished' || v.status === 'cancelled';
  // 勝負が決まったハンドを見せた直後は、ボード・勝者・チップの動きを見てもらってから出す（PACE.result。すぐ出すとボードが見えないという声）
  const want = (ended && !t.overShown) || (!ended && me.status === 'out' && !t.resultShown);
  const wait = want ? t.settledAt + PACE.result - Date.now() : 0;
  if (wait > 0) { clearTimeout(t.resT); t.resT = setTimeout(() => { if (T === t) checkResult(); }, wait + 20); return; }
  if (ended && !t.overShown) { t.overShown = true; showResult(); return; }
  if (ended && $('#overDlg').open) { showResult(); return; }   // 開いている間は席に残った人を更新する
  if (!ended && me.status === 'out' && !t.resultShown) showResult();
}
/** 再戦の受付中で、自分がまだ去っていない */
function rematchLive(v) {
  const rm = v.rematch;
  return !!rm && !rm.next && clock.now() < rm.closesAt && !rm.gone.includes(v.seat);
}
const stayTag = (v, s) => (v.rematch && v.rematch.stay.includes(s) && !v.rematch.next ? '<span class="stay-b">STAY</span>' : '');
function closeOver() { const d = $('#overDlg'); if (d.open) d.close(); }
function showResult() {
  const t = T; t.resultShown = true;
  const v = t.v, me = v.seat, p = v.players[me], ended = v.status === 'finished' || v.status === 'cancelled';
  const cancelled = v.status === 'cancelled';
  if (ended && !t.endSynced) { t.endSynced = true; syncRoom(t.id, v); }
  const order = v.players.map((x, s) => ({ s, p: x.place ?? 99 })).sort((a, b) => a.p - b.p || a.s - b.s);
  const rows = order.map(({ s, p: pl }) => `<li class="${s === me ? 'me-row' : ''}"><span class="pn">${pl < 99 ? pl : '–'}</span><span class="nm2">${s === me ? '<span class="me">YOU</span> ' : ''}${esc(v.names[s])}${stayTag(v, s)}</span><span class="pr">${v.players[s].pt == null ? '' : fmtPt(v.players[s].pt) + ' pt'}</span></li>`).join('');
  // 終局後：席に残る（再戦を待つ）か Menu か。残ったら卓へ戻ってドックで再戦を待つ／始める
  const canStay = v.status === 'finished' && rematchLive(v) && p.status !== 'left', staying = canStay && v.rematch.stay.includes(me);
  const btns = !ended ? '<button class="btn ghost" data-act="watch" type="button">Watch</button><button class="btn primary" data-act="menu" type="button">Menu</button>'
    : canStay ? `<button class="btn ghost" data-act="menu" type="button">Menu</button>${staying ? '<button class="btn primary" data-act="watch" type="button">Table</button>' : `<button class="btn primary" data-act="stay" type="button"${t.rmBusy ? ' disabled' : ''}>席に残る</button>`}`
    : '<button class="btn primary" data-act="menu" type="button">Menu</button>';
  const title = cancelled ? 'Cancelled' : p.place === 1 ? 'Winner' : ended ? 'Game over' : 'Eliminated';
  $('#overBody').innerHTML = `${head('RESULT', title, p.place === 1 ? 'c' : '')}
    <div class="over-hd"><span class="place${p.place === 1 ? ' p1' : ''}">${p.place ?? '–'}<sup>${p.place ? ordinal(p.place).slice(String(p.place).length) : ''}</sup></span>
      <span class="over-gain ${(p.pt ?? 0) > 0 ? 'up' : (p.pt ?? 0) < 0 ? 'down' : 'even'}">${cancelled ? '' : fmtPt(p.pt)}<small>${cancelled ? '中止（pt なし）' : 'PT'}</small></span></div>
    <div class="cfg-sum">${esc(modeLabel(v.config.mode))} ・ ${v.config.players}人 ・ ${v.handNo} hands</div>
    <ul class="over-rows">${rows}</ul>
    <div class="btns">${btns}</div>`;
  const dlg = $('#overDlg'); if (!dlg.open) openDlg('#overDlg');
  $('#overBody').onclick = e => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    if (b.dataset.act === 'watch') { dlg.close(); render(); }
    if (b.dataset.act === 'stay') stay();
    if (b.dataset.act === 'menu') toMenu();
  };
  dlg.oncancel = e => e.preventDefault();
}

/* ---------- 再戦 ---------- */
const privateRoom = v => !!(v && v.room && v.room.kind === 'private');
// 席に残る・再戦で送る演出 GIF（試合の途中で設定を変えた分も再戦に入る。PRIVATE MATCH だけ）
const fxBody = () => (privateRoom(T && T.v) ? { fx: getFx() } : {});
async function stay() {
  const t = T; if (!t || t.rmBusy) return;
  t.rmBusy = true; if ($('#overDlg').open) showResult();
  try {
    const r = await net().game({ op: 'stay', room: t.id, ...fxBody() });
    if (T !== t) return;
    t.rmBusy = false; clock.offset = r.now - Date.now(); receive(r.view, true); closeOver(); render(); poll();
  } catch (e) {
    if (T !== t) return;
    t.rmBusy = false; toast(e.code === 'room_closed' ? '再戦の受付は終わりました' : '通信エラー。もう一度');
    if ($('#overDlg').open) showResult();
  }
}
async function rematch() {
  const t = T; if (!t || t.rmBusy) return;
  t.rmBusy = true; renderDock();
  try {
    const r = await net().game({ op: 'rematch', room: t.id, ...fxBody() });
    if (T !== t) return;
    clock.offset = r.now - Date.now(); toast('REMATCH'); app.nav.enterRoom(r.room, r);
  } catch (e) {
    if (T !== t) return;
    t.rmBusy = false;
    toast({ not_enough: '残っている人が足りません', room_closed: '再戦の受付は終わりました', not_host: '再戦はホストが始めます', in_other_room: 'ほかの部屋に入っています' }[e.code] || '通信エラー。もう一度');
    poll(); renderDock();
  }
}
/** Menu へ。終局後・飛んだ後は再戦の対象から外れることをサーバーに伝える（返事は待たない） */
function toMenu() {
  const t = T; if (!t) return;
  const v = t.v, me = v && v.players[v.seat];
  if (v && (v.status === 'finished' || me.status === 'out')) net().game({ op: 'leave', room: t.id }).catch(() => {});
  closeOver(); app.nav.toMenu();
}

/* ===================== スタックの単位（BB / チップ数） ===================== */
// 端末に保存（pm-stk）。描くのは両方で、#table.u-chip で見せる方を切り替える（CSS でふわっと入れ替える。描き直さない）
let chipUnit = localGet('pm-stk') === 'chip';
export function toggleUnit() {
  chipUnit = !chipUnit;
  localSet('pm-stk', chipUnit ? 'chip' : 'bb');
  $('#table').classList.toggle('u-chip', chipUnit);
}

/* ===================== 席の配置 ===================== */
// 自分から見た相対位置 k（1 = 自分の次の席 = 左隣）→ [x%, y%, 横の基準, 縦の基準, ベットを置く向き]
const LAYOUT = {
  2: [[50, 0, .5, 0, 't']],
  3: [[0, 30, 0, .5, 'l'], [100, 30, 1, .5, 'r']],
  4: [[0, 30, 0, .5, 'l'], [50, 0, .5, 0, 't'], [100, 30, 1, .5, 'r']],
  5: [[0, 58, 0, .5, 'l'], [24, 0, .5, 0, 't'], [76, 0, .5, 0, 't'], [100, 58, 1, .5, 'r']],
  6: [[0, 66, 0, .5, 'l'], [0, 24, 0, .5, 'l'], [50, 0, .5, 0, 't'], [100, 24, 1, .5, 'r'], [100, 66, 1, .5, 'r']],
};
function ensureSeats(v) {
  const box = $('#seats'), key = v.n + ':' + v.seat;
  if (box._k === key) return;
  box._k = key; box.innerHTML = '';
  for (let k = 0; k < v.n; k++) {
    const s = (v.seat + k) % v.n, el = document.createElement('div');
    const [x, y, ax, ay, side] = k === 0 ? [50, 100, .5, 1, 'b'] : LAYOUT[v.n][k - 1];
    el.className = `seat side-${side}${k === 0 ? ' me' : ' opp'}`; el.id = 'seat' + s; el.dataset.seat = s;
    // 押すとプレイヤーのモーダル（ui/player.js）
    el.tabIndex = 0; el.setAttribute('aria-haspopup', 'dialog');
    el.style.cssText = `left:${x}%;top:${y}%;transform:translate(${-ax * 100}%,${-ay * 100}%)`;
    box.appendChild(el);
  }
}

/* ===================== 描画 ===================== */
const PL = { fold: 'FOLD', check: 'CHECK', call: 'CALL', bet: 'BET', raise: 'RAISE', allin: 'ALL-IN' };
function render() {
  const t = T; if (!t || !t.v) return;
  const v = t.v, h = v.hand, ro = runout(), sg = stage();
  syncHeader(); ensureSeats(v);
  let ch = renderInfo();
  for (let s = 0; s < v.n; s++) ch = setHTML($('#seat' + s), seatHTML(s)) || ch;
  const pot = h ? (h.phase === 'settled' && !veiled() ? sum(h.won) : sum(h.commits)) : 0;
  ch = setHTML($('#pot'), `<span>POT</span><b>${fmtBb(pot, h ? h.bb : 1)}<i>BB</i></b>${pot ? `<small>${fmt(pot)}</small>` : ''}`) || ch;
  $('#pot').classList.toggle('zero', !pot);
  // ボード：演出の間は開いた分だけ（リバーを伏せて置いている間は裏の札）
  const board = h ? h.board : [], nb = ro ? ro.board : sg && sg.board != null ? sg.board : board.length, hits = winCards(h);
  ch = setHTML($('#boardC'), Array.from({ length: 5 }, (_, i) => i < nb && board[i] != null ? cardHTML(board[i], { hit: hits.has(board[i]) })
    : ro && ro.back && i === nb ? riverHTML(board[nb]) : '<div class="slot"></div>').join('')) || ch;
  $('#table').classList.toggle('tense', !!(ro && ro.tense));
  ch = renderDock() || ch;
  afterRender();
  tickClock();
  if (ch) refit();
}

function renderInfo() {
  const v = T.v, h = v.hand, c = v.config;
  const lv = h ? h.level : 1, bl = BLIND_TABLES[c.speed][lv - 1] || [0, 0];
  const alive = v.players.filter(p => p.status !== 'out').length + (veiled() ? h.eliminated.length : 0);
  return setHTML($('#tInfo'), `<div class="lv"><b>${fmt(bl[0] / 2)}/${fmt(bl[0])}</b><span>(${fmt(bl[1])}) LV ${lv}</span></div>
    <div class="nx" id="nx"><span>NEXT</span><b id="nxv"></b></div>
    <div class="pz"><span class="mx">${alive}/${v.n}</span><b>#${esc(v.room.code)}</b></div>`);
}
function nextLevelText() {
  const v = T.v, c = v.config, h = v.hand, lv = h ? h.level : 1;
  if (lv >= BLIND_TABLES[c.speed].length) return { t: 'MAX', soon: false };
  // 3 分たったらハンドの終わりまで 0:00 で止まり、次のハンドで上がって数え直す
  const ms = (v.levelStartAt ?? v.startedAt + (lv - 1) * levelMsOf(c)) + levelMsOf(c) - clock.now();
  const s = Math.max(0, Math.ceil(ms / 1000));
  return { t: `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`, soon: s <= 15 };
}

function clockBarHTML(s) {
  const v = T.v, h = v.hand;
  if (!h || h.deadline == null || v.status !== 'running') return '';
  const key = h.deadline + ':' + s + ':' + v.ver;
  if (!T.clockCache || T.clockCache.key !== key) {
    const total = Math.max(1, h.deadline - h.turnStart), left = Math.max(0, h.deadline - clock.now());
    T.clockCache = { key, html: `<div class="clock ${s === v.seat ? 'me' : 'op'}" aria-hidden="true"><i style="--from:${Math.min(1, left / total).toFixed(4)};animation-duration:${left}ms"></i></div>` };
  }
  return T.clockCache.html;
}

/** その席のこのストリートの最後のアクション（遷移を見せている途中なら、見せたところまでのその街のもの） */
function lastAction(h, s, sg) {
  const n = sg && sg.shown != null ? sg.shown : h.actions.length, street = sg && sg.street != null ? sg.street : h.street;
  for (let i = n - 1; i >= 0; i--) { const a = h.actions[i]; if (a.street !== street) break; if (a.seat === s) return { ...a, i }; }
  return null;
}
/** 見せている途中で、まだ見せていないアクションにその席の kind があるか（フォールド・オールインを先に見せない） */
const hiddenKind = (h, s, sg, kind) => !!(sg && sg.shown != null && h.actions.slice(sg.shown).some(a => a.seat === s && a.kind === kind));
function seatHTML(s) {
  const v = T.v, h = v.hand, me = s === v.seat, p = v.players[s], bb = h ? h.bb : 200, ro = runout(), sg = stage(), vl = veiled();
  // settled = 結果を見せてよい（ショーダウンの演出・フォールドで終わる前の一拍の間は、まだ賭けの直後のように見せる）
  const done = h && h.phase === 'settled', settled = done && !vl, inHand = h && h.startStacks[s] > 0;
  const out = p.status === 'out' && !(done && h.eliminated.some(e => e.seat === s));
  const folded = h && inHand && h.folded[s] && !hiddenKind(h, s, sg, 'fold');
  const allIn = h && inHand && h.allIn[s] && !hiddenKind(h, s, sg, 'allin');
  // 手番の合図は遷移を見せ終わってから
  const acting = h && v.status === 'running' && h.phase === 'betting' && h.toAct === s && !sg;
  const winner = settled && isWinner(h, s), hits = winCards(h);
  const mk = me ? 0 : markOf(v.names[s]);   // メモの色の印（history/notes.js）
  const cls = ['sp', me ? 'me-s' : 'opp-s', acting ? 'act' : '', folded && !settled ? 'fold' : '', out ? 'out' : '', winner ? 'win' : '', mk ? 'mk mk' + mk : ''].filter(Boolean).join(' ');
  // 手札（演出で表に返すまでは相手の札は裏）
  let cards = '';
  if (h && inHand && !out) {
    const hole = h.hole[s];
    // 相手の表になった札は、演出で返すまで裏（ランアウトが始まる前の一拍＝結果を伏せている間も。ここで表を描くと一瞬見えてしまっていた）
    if (hole && (me || !vl || (ro && ro.reveal))) cards = hole.map(c => cardHTML(c, { dim: folded && !settled, hit: hits.has(c) })).join('');
    else if (!folded && !settled) cards = cardHTML(null) + cardHTML(null);
  }
  if (ro && ro.eq && h.shown && h.shown[s]) cards += eqHTML(ro, s);
  // 札の下の 1 行：結果 > 最後のアクション > 状態
  let note = '';
  const la = h && (!done || sg) ? lastAction(h, s, sg) : null;
  if (ro && inHand && !out) note = folded ? 'FOLD' : allIn ? '<span class="ai">ALL-IN</span>' : '';
  else if (winner) note = `${h.won[s] > h.commits[s] ? `<span class="w up">+${fmtBb(h.won[s] - h.commits[s], bb)} BB</span>` : '<span class="w up">CHOP</span>'}${h.names && h.names[s] ? `<span class="hn">${esc(h.names[s])}</span>` : ''}`;
  else if (settled && h.names && h.names[s]) note = `<span class="hn">${esc(h.names[s])}</span>`;
  else if (p.status === 'out' && !(vl && h.eliminated.some(e => e.seat === s))) note = p.place ? ordinal(p.place).toUpperCase() : 'OUT';   // このハンドで飛んだ順位は演出の後
  else if (p.status === 'left') note = 'LEFT';
  else if (la && !acting) note = `<span class="pl k-${la.kind}" data-i="${la.i}">${PL[la.kind]}</span>`;
  else if (folded) note = 'FOLD';
  else if (allIn) note = '<span class="ai">ALL-IN</span>';
  else if (p.status === 'sitout') note = 'AWAY';
  if (p.status === 'sitout' && note && !note.includes('AWAY') && !settled) note += '<span class="away">AWAY</span>';
  const name = me ? 'YOU' : esc(v.names[s]);
  const dbtn = h && h.btn === s && !out ? '<b class="dbtn" title="Dealer">D</b>' : '';
  const clk = acting ? clockBarHTML(s) : '';
  const bets = shownBets(), bet = bets && bets[s] > 0 ? `<div class="bchip"><i></i><b>${fmtBb(bets[s], bb)}<small>BB</small></b></div>` : '';
  // 結果を伏せている間は配る前、遷移の途中はまだ見せていないベットを足したスタック
  const stack = p.stack - (vl && h.won ? h.won[s] : 0) + (sg && sg.adj ? sg.adj[s] : 0);
  // スタックは BB かチップ数のどちらか（#table.u-chip。スタックを押すと切り替わり、ふわっと入れ替わる）
  return `<div class="hole">${cards}</div><div class="${cls}"><div class="sp-hd"><i class="gem"></i><span class="nm">${name}</span></div>
    <div class="stk" data-stk="${s}"><span class="su bb"><b>${fmtBb(stack, bb)}</b><small>BB</small></span><span class="su ch"><b>${fmt(stack)}</b></span></div><div class="note">${stayTag(v, s)}${note}</div>${clk}${dbtn}</div>${bet}`;
}
/** いま見せるベット（遷移の途中ならその時点のもの。精算済みなら無し） */
function shownBets() {
  const h = T.v.hand, sg = stage();
  if (!h) return null;
  if (sg && sg.bets) return sg.bets;
  return h.phase === 'settled' ? null : h.streetBet;
}
/** 勝率の札（演出の間だけ。数字は ro.eqShow を数えながら動かす） */
function eqHTML(ro, s) {
  const fin = ro.eq[s], top = Math.max(...ro.eq), x = ro.eqShow ? ro.eqShow[s] : fin;
  return `<b class="eq${fin === top && fin > 0 ? ' lead' : ''}${fin === 0 ? ' dead' : ''}" data-s="${s}"><span>${pctOf(x)}</span><small>%</small></b>`;
}
/** ショーダウンで勝った役の札（勝った席の 5 枚。結果を見せてよいときだけ） */
const NONE = new Set();
function winCards(h) {
  if (!h || h.phase !== 'settled' || !h.shown || h.board.length < 5 || veiled()) return NONE;
  if (T.winC && T.winC.handNo === h.handNo) return T.winC.set;
  const set = new Set();
  for (const pot of h.pots) if (pot.eligible.length > 1) for (const s of pot.winners) for (const c of bestFive([...h.shown[s], ...h.board])) set.add(c);
  T.winC = { handNo: h.handNo, set };
  return set;
}
/** そのハンドでポットを勝ち取った席か（ショーダウンで返ってきただけのコールされなかった分は除く） */
function isWinner(h, s) {
  if (!h || h.phase !== 'settled') return false;
  if (!h.shown) return h.won[s] > 0;
  return h.pots.some(p => p.eligible.length > 1 && p.winners.includes(s));
}

/* ---------- 描画のあとの演出 ---------- */
function afterRender() {
  const t = T, v = t.v, h = v.hand, sh = t.sh, ro = runout(), sg = stage();
  if (!h) return;
  const board = ro ? ro.board : sg && sg.board != null ? sg.board : h.board.length, settled = h.phase === 'settled' && !veiled();
  const bets = shownBets() || [];
  const keepNotes = () => { sh.la = [...document.querySelectorAll('#seats .note .pl[data-i]')].map(e => e.dataset.i); };
  if (REDUCE) { sh.init = true; sh.handNo = h.handNo; sh.board = board; sh.bet = bets.slice(); sh.settled = settled ? h.handNo : sh.settled; keepNotes(); return; }
  const flip = (el, delay, ms = PACE.flip + 120) => el && el.animate([{ transform: 'perspective(600px) rotateY(90deg)' }, { transform: 'none' }], { duration: ms, delay, easing: EASE, fill: 'backwards' });
  const cards = [...document.querySelectorAll('#boardC .card')];
  const fo = flipOf(sh.board);   // 街が進んだとき：フロップは 1.8 倍ゆっくり
  if (sh.init && sh.handNo === h.handNo && board > sh.board) cards.slice(Math.max(0, sh.board), board).forEach((c, i) => flip(c, i * (ro ? ro.stagger : fo.stagger), ro ? ro.flipMs : fo.ms));
  sh.board = board;
  if (sh.handNo !== h.handNo) {
    // 配る：ボタンの次の席から 1 枚ずつ（PACE.deal / dealStagger）
    const seats = [...document.querySelectorAll('#seats .seat')].sort((a, b) => ((+a.dataset.seat - h.btn - 1 + v.n) % v.n) - ((+b.dataset.seat - h.btn - 1 + v.n) % v.n));
    const holes = seats.map(e => [...e.querySelectorAll('.hole .card')]), order = [];
    for (let k = 0; k < 2; k++) for (const cs of holes) if (cs[k]) order.push(cs[k]);
    order.forEach((c, i) => c.animate([{ transform: 'translateY(-22px) rotate(-5deg) scale(.9)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: PACE.deal, delay: i * PACE.dealStagger, easing: EASE, fill: 'backwards' }));
    sh.handNo = h.handNo; sh.bet = []; sh.la = [];
  }
  if (settled && sh.settled !== h.handNo) {
    sh.settled = h.handNo;
    if (sh.init) {
      t.settledAt = Date.now();
      // 相手の手札を表に返し（演出で返していなければ）、勝った席と役の札を弾ませ、ポットから勝った席へチップを飛ばす
      if (sh.revealed !== h.handNo) document.querySelectorAll('.seat.opp .hole .card:not(.back)').forEach((c, i) => flip(c, 120 + i * 90));
      // （勝った席の弾み・役の札・チップの動きは 1.8 倍ゆっくり。PACE.chip）
      document.querySelectorAll('.sp.win').forEach(e => e.animate([{ transform: 'none' }, { transform: 'scale(1.06)', offset: .35 }, { transform: 'none' }], { duration: 1000, easing: EASE }));
      document.querySelectorAll('.card.hit').forEach((c, i) => c.animate([{ transform: 'none' }, { transform: 'translateY(-5px)', offset: .4 }, { transform: 'none' }], { duration: 1000, delay: i * 80, easing: EASE }));
      const pot = $('#pot b');
      h.won.forEach((w, s) => { if (w > 0) fly(pot, document.querySelector(`[data-stk="${s}"] .su.${chipUnit ? 'ch' : 'bb'} b`), `+${fmtBb(w, h.bb)} BB`, s === v.seat ? 'y' : 'c', 120, null, PACE.chip); });
    }
  }
  // 増えたベットのチップと、新しく見せたアクションの札を出す（PACE.pop）
  bets.forEach((b, s) => {
    if (!(sh.init && b > (sh.bet[s] || 0))) return;
    const el = $('#seat' + s)?.querySelector('.bchip');
    if (el) el.animate([{ transform: 'translateY(-8px) scale(.9)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: PACE.pop, easing: EASE });
  });
  sh.bet = bets.slice();
  const prevLa = new Set(sh.la || []);
  document.querySelectorAll('#seats .note .pl[data-i]').forEach(e => {
    if (sh.init && !prevLa.has(e.dataset.i)) e.animate([{ transform: 'scale(.6)', opacity: 0 }, { transform: 'scale(1.08)', opacity: 1, offset: .7 }, { transform: 'none', opacity: 1 }], { duration: PACE.pop, easing: EASE });
  });
  keepNotes();
  sh.init = true;
}

/* ===================== ショーダウンの演出（オールインのランアウトを含む） ===================== */
// 精算済みのビューはボード 5 枚・全員の手札・勝者を一度に運んでくるので、それを RUNOUT（structure.js。エンジンが次のハンドまで待つ時間と同じ）の順に見せる：
//   ベットをポットへ（オールインなら ALL-IN の帯）→ 手札を表に → 勝率 → フロップ → ターン（それぞれ勝率を更新して止める）
//   → リバー（まだ逆転があれば伏せて置き、端を持ち上げてから表に）→（PRIVATE MATCH で勝者が演出 GIF を設定していれば、
//   勝負が決まって一間おいてから卓の中央に GIF → 消してボードに戻る。structure.js の FX）→ 勝者の 5 枚・ポットの移動・順位。
// 演出の間は結果（勝者・役名・増えたスタック・飛んだ順位・ドックの WINS・結果のダイアログ）を伏せる。
/** 演出 GIF を出す席（PRIVATE MATCH の精算済みのショーダウンだけ。engine.js の fxSeat） */
const fxOf = v => (privateRoom(v) ? fxSeat(v.hand, v.fx) : null);
/** 演出中なら その状態、そうでなければ null */
function runout() {
  const t = T, h = t && t.v && t.v.hand;
  return t && t.ro && !t.ro.done && h && t.ro.handNo === h.handNo ? t.ro : null;
}
function startRunout(v) {
  const t = T, h = v.hand, from = Math.min(h.runFrom, h.board.length), R = RUNOUT;
  if (t.ro && !t.ro.done) endRunout(false);
  const ro = t.ro = { handNo: h.handNo, from, board: from, back: false, reveal: false, tense: false, eq: null, eqShow: null, flipMs: 420, stagger: 110, done: false, timers: [] };
  const at = (ms, f) => ro.timers.push(setTimeout(() => { if (T === t && t.ro === ro && !ro.done) f(); }, ms));
  const eqAt = n => equities(h.shown, h.board.slice(0, n), { seed: h.handNo * 7919 + n });
  // 勝負が決まった時刻 won から結果へ。勝者の演出 GIF があるときだけ一間（FX.wait）おいて中央に出し、消してボードに戻ってからポットを勝者へ。
  // GIF が無ければ間をおかずにすぐ結果へ。=> 結果へ移る時刻
  const fs = fxOf(v);
  const finale = won => {
    if (fs == null) { at(won, () => endRunout(true)); return won; }
    const y = won + FX.wait;
    at(y, () => { if (!fxshow.play($('#table'), v.fx[fs], v.names[fs], fs === v.seat)) endRunout(true); });   // 読み込めていなければ出さずに結果へ
    at(y + FX.in + FX.show, () => fxshow.hide());
    at(won + FX_MS, () => endRunout(true));
    return won + FX_MS;
  };
  const holdTo = end => { t.holdUntil = Math.max(t.holdUntil, Date.now() + end + PACE.beat); };
  const seats = h.shown.map((c, s) => (c ? s : -1)).filter(s => s >= 0);
  gather();
  if (from < 5 || seats.some(s => h.allIn[s])) banner('ALL-IN');
  let x = R.gather;
  at(x, () => { ro.reveal = true; render(); revealHoles(); });
  // 普通のショーダウン：手札を表にして見せたら結果へ
  if (from >= 5) { holdTo(finale(x + R.show)); return; }
  at(x + 450, () => setEq(eqAt(from)));
  x += R.reveal;
  for (const n of [3, 4]) {
    if (from >= n) continue;
    // フロップは 1.8 倍ゆっくり返し（3 枚が開ききってから勝率）、ターンはそのまま
    const flop = n === 3, ms = flop ? 828 : 460, st = flop ? 270 : 150, eqAtMs = flop ? ms + 2 * st + 200 : 650;
    at(x, () => { ro.board = n; ro.stagger = st; ro.flipMs = ms; render(); });
    at(x + eqAtMs, () => setEq(eqAt(n)));
    x += flop ? R.flop : R.street;
  }
  // リバー：まだ勝ちの目が 2 人以上にある（引き分けしかない場合を除く）なら溜める
  const pre = eqAt(4), alive = pre.filter(e => e > 0);
  const tense = alive.length > 1 && alive.some(e => Math.abs(e - alive[0]) > 1e-9);
  if (tense) {
    // 1 枚の札（裏と表を背中合わせにした立体）を、置く → 端を持ち上げる → そのまま止まらずに返す。最後に普通の札へ（見た目は同じ）
    at(x, () => { ro.back = true; ro.tense = true; render(); riverDeal(); });
    at(x + RIVER.peelAt, () => riverPeel());
    at(x + RIVER.turnAt, () => riverTurn(() => { ro.back = false; ro.board = 5; T.sh.board = 5; render(); }));
    at(x + 1850, () => { ro.tense = false; setEq(eqAt(5)); });
    holdTo(finale(x + R.river));   // 表が見えて勝率が決まったところ
  } else {
    // 決着がついている：普通にめくって早めに結果へ（次のハンドまでの時間は、そのぶん結果を長く見せる）
    at(x, () => { ro.board = 5; ro.flipMs = 460; render(); });
    at(x + 550, () => setEq(eqAt(5)));
    holdTo(finale(x + 700));
  }
}
function endRunout(show) {
  const t = T, ro = t && t.ro; if (!ro || ro.done) return;
  ro.done = true; ro.timers.forEach(clearTimeout);
  fxshow.hide(show ? FX.out : 0);
  $('#table').classList.remove('tense');
  if (show) { render(); checkResult(); pump(); }
}
// 前のビューで出ていたベットをポットへ飛ばす（ビューを描き替える前に呼ぶ）
function gather() {
  const pot = $('#pot b');
  document.querySelectorAll('#seats .bchip').forEach((el, i) => fly(el, pot, el.textContent, el.closest('.seat.me') ? 'y' : 'c', i * 40, null, PACE.gather + 120));
}
function banner(text) {
  if (REDUCE || document.hidden) return;
  const el = document.createElement('div'); el.className = 'ai-banner'; el.setAttribute('aria-hidden', 'true'); el.innerHTML = `<b>${text}</b>`;
  $('#table').appendChild(el);
  el.animate([{ clipPath: 'inset(0 50% 0 50%)' }, { clipPath: 'inset(0 0 0 0)', offset: .16 }, { clipPath: 'inset(0 0 0 0)', opacity: 1, offset: .78 }, { clipPath: 'inset(0 0 0 0)', opacity: 0 }], { duration: 1500, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'both' });
  el.firstChild.animate([{ letterSpacing: '.7em', opacity: 0, transform: 'scale(1.15)' }, { letterSpacing: '.24em', opacity: 1, transform: 'none' }], { duration: 520, delay: 80, easing: EASE, fill: 'backwards' });
  setTimeout(() => el.remove(), 1600);
}
function revealHoles() {
  const t = T; t.sh.revealed = t.ro.handNo;
  if (REDUCE) return;
  document.querySelectorAll('.seat.opp .hole .card:not(.back)').forEach((c, i) => c.animate([{ transform: 'perspective(600px) rotateY(90deg)' }, { transform: 'none' }], { duration: 440, delay: Math.floor(i / 2) * 160 + (i % 2) * 70, easing: EASE, fill: 'backwards' }));
}
/** 勝率を next へ（数字は数えながら、札は小さく弾む） */
function setEq(next) {
  const ro = T.ro, from = ro.eqShow || next.map(() => 0);
  ro.eq = next; ro.eqShow = from.slice(); render();
  const t0 = performance.now(), D = REDUCE ? 0 : 560;
  const step = now => {
    if (!T || T.ro !== ro || ro.done) return;
    const k = D ? Math.min(1, Math.max(0, now - t0) / D) : 1, e = 1 - (1 - k) ** 3;
    ro.eqShow = next.map((x, s) => from[s] + (x - from[s]) * e);
    document.querySelectorAll('#seats .eq[data-s]').forEach(el => { const sp = el.firstChild, txt = String(pctOf(ro.eqShow[+el.dataset.s])); if (sp.textContent !== txt) sp.textContent = txt; });
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  ro.timers.push(setTimeout(() => step(t0 + D), D + 80));   // 描画が止まっていても（裏のタブなど）最後の値にはする
  if (!REDUCE) document.querySelectorAll('#seats .eq[data-s]').forEach(el => el.animate([{ transform: 'translateX(-50%) scale(1.3)' }, { transform: 'translateX(-50%)' }], { duration: 420, easing: EASE }));
}
// リバーの溜め（勝負が残っているとき）。札は 1 つの立体（外側 = 置く・持ち上げる、内側 = 回す）で、途中で差し替えない。
//   deal 0〜360：上から置く → peel 400〜1100：端を -24° までゆっくり持ち上げ、少し浮かせる（ease-in-out で速さ 0 で止まる）
//   → turn 1100〜1750：速さ 0 から加速して -180° まで返し、浮きを戻しながら減速して止まる（表が見えるのは前と同じ 1750）
const RIVER = { deal: 360, peelAt: 400, peel: 700, turnAt: 1100, turn: 650, lift: 'translateY(-6%) scale(1.06)', peelDeg: -24 };
const riverHTML = c => `<div class="flip3d" aria-hidden="true"><div class="f-in"><div class="card back f-b"></div><div class="f-f">${cardHTML(c)}</div></div></div>`;
const riverEls = () => { const o = document.querySelector('#boardC .flip3d'); return o ? [o, o.firstElementChild] : [null, null]; };
function riverDeal() {
  const [o] = riverEls(); if (!o || REDUCE) return;
  o.animate([{ transform: 'translateY(-55%) rotate(-6deg) scale(.92)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: RIVER.deal, easing: EASE, fill: 'both' });
}
function riverPeel() {
  const [o, i] = riverEls(); if (!o || REDUCE) return;
  const k = { duration: RIVER.peel, easing: 'cubic-bezier(.45,.05,.55,.95)', fill: 'forwards' };
  o.animate([{ transform: 'none' }, { transform: RIVER.lift }], k);
  i.animate([{ transform: 'rotateY(0deg)' }, { transform: `rotateY(${RIVER.peelDeg}deg)` }], k);
}
function riverTurn(done) {
  const [o, i] = riverEls();
  let fired = false; const go = () => { if (!fired) { fired = true; done(); } };
  if (!o || REDUCE) return go();
  const k = { duration: RIVER.turn, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'forwards' };
  o.animate([{ transform: RIVER.lift }, { transform: RIVER.lift, offset: .45 }, { transform: 'none' }], k);
  const an = i.animate([{ transform: `rotateY(${RIVER.peelDeg}deg)` }, { transform: 'rotateY(-180deg)' }], k);
  an.onfinish = go; setTimeout(go, RIVER.turn + 120);
}

/* ---------- 400 ms ごとの時計 ---------- */
function tickClock() {
  const t = T; if (!t || !t.v) return;
  const nx = $('#nxv'); if (nx) { const x = nextLevelText(); if (nx.textContent !== x.t) nx.textContent = x.t; $('#nx').classList.toggle('soon', x.soon); }
  const secs = $('#secs'), h = t.v.hand;
  if (secs && h && h.deadline != null) {
    // 15 秒の持ち時間を数え、使い切ったらタイムバンクの残りを（色を変えて）数える
    const now = clock.now(), bank = now - h.turnStart > ACTION_MS;
    const l = Math.max(0, bank ? h.deadline - now : h.turnStart + ACTION_MS - now), s = String(Math.ceil(l / 1000));
    if (secs.textContent !== s) secs.textContent = s;
    secs.classList.toggle('low', +s <= 5); secs.classList.toggle('bank', bank);
  }
  const ps = $('#pauseLeft'); if (ps && t.v.pausedAt) { const l = Math.max(0, Math.ceil((dueAt(t.v) - clock.now()) / 1000)); ps.textContent = `${Math.floor(l / 60)}:${String(l % 60).padStart(2, '0')}`; }
  const d = $('#dock');
  if (d.classList.contains('lock') && t.lockUntil - Date.now() <= 0) d.classList.remove('lock');
  if (t.v.status === 'finished') renderDock();   // 再戦を始められる人は時間で変わる（作成者を待つのは 1 分）
}

/* ===================== ドック ===================== */
const autoPreKey = () => T.v.hand.handNo + ':' + T.v.hand.street;
function autoPre() {
  const t = T, v = t.v, h = v.hand; if (!h || h.toAct !== v.seat || h.phase !== 'betting' || !t.pre || stage()) return;
  if (t.pre !== autoPreKey()) { t.pre = null; return; }
  t.pre = null;
  const l = legalActions(v, v.seat); if (!l) return;
  setTimeout(() => { if (T === t && t.v.ver === v.ver) submit({ type: l.canCheck ? 'check' : 'fold' }); }, 250);
}
function renderDock() {
  const t = T, v = t.v, h = v.hand, me = v.seat, p = v.players[me], dock = $('#dock'), el = $('#dockMain');
  // 遷移を見せている間・次のビューを待っている間は操作ボタンを出さない（古い状態で押させない）
  const sg = stage(), waiting = sg || t.q.length > 0;
  const l = v.status === 'running' && !waiting ? legalActions(v, me) : null;
  let html = '', mode = 'idle';   // 'turn'（自分の番の操作）| 'wait'（ハンドに参加して待っている。turn と同じ 2 段の形）| 'idle'（1 段）
  const ro = runout(), rm = v.rematch;
  // ハンドに参加していて、まだ動ける（降りていない・オールインでない）。待っている間は相手が動いても・遷移の途中でも形を変えない
  const inHand = h && h.phase === 'betting' && v.status === 'running' && p.status === 'active' && h.startStacks[me] > 0 && !h.folded[me] && !h.allIn[me];
  if (ro) {
    const street = ro.back || ro.board === 5 ? 'RIVER' : ro.board === 4 ? 'TURN' : ro.board === 3 ? 'FLOP' : '';
    html = `<span class="eyebrow">${ro.from < 5 || h.allIn.some(Boolean) ? 'ALL-IN' : 'SHOWDOWN'}</span><span class="dk-title">${street}</span><span class="dots"><i></i><i></i><i></i></span>`;
  } else if (inHand && !l) {
    // 待っている間：上の段に次に動く人、下の段の左（自分の番の Fold / Check と同じ位置）に Check/Fold の予約
    mode = 'wait';
    const a = h.toAct, armed = t.pre === autoPreKey();
    html = `<div class="dk-top"><span class="dk-title ${a === me ? 'y' : ''}">${a == null ? '' : a === me ? 'YOU' : esc(v.names[a])}</span><span class="dots" style="margin-left:0"><i></i><i></i><i></i></span>
      <button class="pre away-btn dk-away" data-act="sitout" type="button">離席</button></div>
      <div class="dk-row"><button class="dk-pre" data-act="pre" type="button" aria-pressed="${armed}">Check/Fold</button><span class="dk-sp"></span></div>`;
  } else if (sg && (sg.veil || h.phase !== 'settled')) {
    // 遷移の途中：街が変わるなら街の名前、ほかは待ちの点だけ
    const street = sg.kind === 'street' ? ['', 'FLOP', 'TURN', 'RIVER'][h.street] : '';
    html = `<span class="dk-title">${street}</span><span class="dots"><i></i><i></i><i></i></span>${h.phase === 'betting' && v.status === 'running' && p.status === 'active' ? '<button class="pre away-btn" data-act="sitout" type="button">離席</button>' : ''}`;
  } else if (v.status === 'finished' && rm && !rm.next && rm.stay.includes(me) && rematchLive(v)) {
    // 席に残った：再戦を始められる人は Rematch、ほかの人は待つ
    const lead = rematchLeader(rm, v.endedAt, clock.now()), n = rm.stay.length;
    html = `<span class="eyebrow">REMATCH</span><span class="dk-title rm-n"><b>${n}</b><small>/${v.n}</small></span>${lead === me
      ? `<button class="btn accent" data-act="rematch" type="button" style="flex:0 1 34%;min-width:92px;margin-left:auto"${n < 2 || t.rmBusy ? ' disabled' : ''}>Rematch<small>${n}人</small></button>`
      : '<span class="dots"><i></i><i></i><i></i></span>'}<button class="pre plain" data-act="menu" type="button">Menu</button>`;
  } else if (v.status === 'finished' || v.status === 'cancelled') {
    html = `<span class="eyebrow">${v.status === 'cancelled' ? 'CANCELLED' : 'GAME OVER'}</span><span class="dk-title ${p.place === 1 ? 'y' : ''}">${p.place ? ordinal(p.place) : ''}</span><button class="btn primary dk-res" data-act="result" type="button">Result</button><button class="pre plain" data-act="menu" type="button">Menu</button>`;
  } else if (p.status === 'out') {
    // 観戦中：結果と、メニューへ戻るボタン
    html = `<span class="eyebrow">WATCHING</span><span class="dk-title">${p.place ? ordinal(p.place) : 'OUT'}</span><button class="btn primary dk-res" data-act="result" type="button">Result</button><button class="pre plain" data-act="menu" type="button">Menu</button>`;
  } else if (p.status === 'sitout' || v.status === 'paused') {
    html = `<span class="eyebrow">${v.status === 'paused' ? 'PAUSED' : 'SITTING OUT'}</span><span class="dk-title">${v.status === 'paused' ? '<b class="secs" id="pauseLeft"></b>' : ''}</span>${p.status === 'sitout' ? '<button class="btn accent" data-act="sitin" type="button" style="flex:0 0 36%">I\'m back</button>' : ''}`;
  } else if (h && h.phase === 'settled') {
    const ws = h.won.map((_, s) => s).filter(s => isWinner(h, s));
    const w = ws.length === 1 ? ws[0] : null;
    const who = w === null ? (ws.length ? 'SPLIT POT' : 'HAND OVER') : w === me ? 'YOU WIN' : esc(v.names[w]) + ' WINS';
    html = `<span class="dk-title ${w === me ? 'y' : w === null ? '' : 'c'}">${who}</span><span class="dk-stats">${w !== null ? `<b>+${fmtBb(Math.max(0, h.won[w] - h.commits[w]), h.bb)}<i>BB</i></b>${h.names && h.names[w] ? esc(h.names[w]) : ''}` : ''}</span>`;
  } else if (l) {
    mode = 'turn';
    const pot = l.pot, facing = l.canFold, bb = h.bb, B = x => `${fmtBb(x, bb)}<i>BB</i>`;
    const callAllin = facing && l.callPut >= p.stack;
    const canRaise = l.minTo != null;
    const rLabel = l.aggression === 'bet' ? 'Bet' : 'Raise', allinOnly = canRaise && l.minTo === l.maxTo;
    const rz = canRaise ? `<button class="btn accent" data-act="raise" type="button">${allinOnly ? 'All-in' : rLabel}<small>${allinOnly ? fmtBb(l.maxTo, bb) : fmtBb(l.minTo, bb) + '+'} BB</small></button>` : '';
    html = `<div class="dk-top"><span class="you-act">YOUR TURN</span><span class="dk-stats">POT<b>${B(pot)}</b>${facing ? `CALL<b>${B(l.callPut)}</b>` : ''}</span><span class="secs" id="secs"></span></div>
      <div class="dk-row">${facing
        ? `<button class="btn ghost" data-act="fold" type="button">Fold</button><button class="btn primary" data-act="call" type="button">${callAllin ? 'All-in' : 'Call'}<small>${fmtBb(l.callPut, bb)} BB</small></button>${rz}`
        : `<button class="btn primary" data-act="check" type="button">Check</button>${rz}`}</div>`;
  } else {
    // 降りた・オールイン・参加していないハンド：1 段（このハンドの間は形が変わらない）
    const a = h ? h.toAct : null, who = a != null ? esc(v.names[a]) : '';
    html = `${h && h.folded[me] ? '<span class="eyebrow">FOLDED</span>' : h && h.allIn[me] ? '<span class="eyebrow">ALL-IN</span>' : ''}<span class="dk-title">${who}</span><span class="dots" style="margin-left:0"><i></i><i></i><i></i></span>
      <button class="pre away-btn" data-act="sitout" type="button">離席</button>`;
  }
  // 中身が変わるときは、前の表示を上に重ねて溶かし、新しい表示を浮かび上がらせる（Check/Fold の予約の切り替えはそのまま）
  const key = mode + html.replace(/ aria-pressed="[^"]*"/g, '');
  const fade = t.dockKey != null && key !== t.dockKey && !REDUCE && !document.hidden;
  if (fade) dockGhost(dock);
  t.dockKey = key;
  dock.classList.toggle('idle', mode === 'idle');
  // 自分の番の操作は、出てから PACE.lock の間・送信中・次のビュー待ちは押せない（見た目は変えない。ちらつかせない）
  const locked = mode === 'turn' && (Date.now() < t.lockUntil || t.busy || t.q.length > 0);
  dock.classList.toggle('lock', locked);
  if (locked && Date.now() < t.lockUntil) { clearTimeout(t.lockT); t.lockT = setTimeout(() => { if (T === t) renderDock(); }, t.lockUntil - Date.now() + 20); }
  const changed = setHTML(el, html);
  if (fade && changed) [...el.children].forEach(e => e.animate([{ opacity: 0 }, { opacity: 1 }], { duration: DOCK_FADE.in, easing: 'ease-out', fill: 'backwards' }));
  return changed;
}
// ドックの切り替え：前の表示の写しを同じ場所に重ねて消していく（新しい表示はその下で浮かび上がる）
const DOCK_FADE = { out: 200, in: 280 };
function dockGhost(dock) {
  document.querySelectorAll('.dock-ghost').forEach(e => e.remove());
  const r = dock.getBoundingClientRect(); if (!r.width) return;
  const g = dock.cloneNode(true);
  g.removeAttribute('id'); g.querySelectorAll('[id]').forEach(e => e.removeAttribute('id'));
  g.classList.add('dock-ghost'); g.setAttribute('aria-hidden', 'true');
  Object.assign(g.style, { position: 'fixed', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px', margin: '0', zIndex: 30, pointerEvents: 'none' });
  document.body.appendChild(g);
  const an = g.animate([{ opacity: 1 }, { opacity: 0 }], { duration: DOCK_FADE.out, easing: 'ease-in', fill: 'forwards' });
  an.onfinish = () => g.remove(); setTimeout(() => g.remove(), DOCK_FADE.out + 100);
}

$('#dock').addEventListener('click', e => {
  const t = T; if (!t || !t.v) return;
  const b = e.target.closest('[data-act]'); if (!b) return;
  const act = b.dataset.act, v = t.v;
  if (act === 'result') return showResult();
  if (act === 'rematch') return rematch();
  if (act === 'menu') return toMenu();
  if (act === 'pre') { t.pre = t.pre === autoPreKey() ? null : autoPreKey(); renderDock(); return; }
  if (act === 'sitout' || act === 'sitin') return seatOp(act);
  if (act === 'rs-close') return closeSheet();   // 閉じるのはいつでも（手番が移った・送信中でも）
  if (t.busy || t.q.length || stage() || Date.now() < t.lockUntil || !v.hand || v.hand.toAct !== v.seat || v.hand.phase !== 'betting') return;
  if (act === 'fold' || act === 'check' || act === 'call') return submit({ type: act });
  // 開いている間にもう一度押したら閉じる（2 枚目は作らない）。開く動きの途中の 2 度押し（連打）は無視して開いたままにする
  if (act === 'raise') return sheetOpen() ? (t.rs && Date.now() - t.rs.openedAt < PACE.sheetIn ? undefined : closeSheet()) : openSheet();
  if (act === 'rs-ok') {
    const rs = t.rs; closeSheet();
    if (!rs || rs.handNo !== v.hand.handNo || rs.street !== v.hand.street) return;   // 開いた後に状況が変わった
    return submit(rs.to === rs.l.maxTo ? { type: 'allin' } : { type: 'raise', to: rs.to });
  }
});
async function seatOp(op) {
  const t = T; if (!t || t.busy) return;
  t.busy = true;
  try { const r = await net().game({ op, room: t.id }); if (t !== T) return; t.busy = false; clock.offset = r.now - Date.now(); receive(r.view); }
  catch (e) { if (t !== T) return; t.busy = false; poll(); }
}
async function submit(move) {
  const t = T; if (!t || t.busy) return;
  closeSheet();   // シートを開いたまま Call / Check / Fold を押しても残さない
  t.busy = true; renderDock();
  try {
    const r = await net().game({ op: 'act', room: t.id, ver: t.ver, move });
    if (t !== T) return;
    t.busy = false; clock.offset = r.now - Date.now(); receive(r.view);
  } catch (e) {
    if (t !== T) return;
    t.busy = false;
    if (['stale', 'not_your_turn', 'game_over'].includes(e.code)) poll();
    else toast(e.code === 'illegal' ? 'その操作はできません' : '通信エラー。もう一度');
    renderDock();
  }
}

/* ---------- ベット/レイズのシート ---------- */
// BB の候補は額そのものなので見出しを付けない（2.5BB / 2.5BB と 2 回出さない）
const qLabel = k => k.endsWith('bb') ? '' : k;
function openSheet() {
  const t = T, v = t.v, l = legalActions(v, v.seat); if (!l || l.minTo == null) return;
  closeSheet(true);
  const lo = l.minTo, hi = l.maxTo, unit = stepChips(getSizes(), v.hand.bb), q = quickSizes(l, v.hand, getSizes());
  const vals = [lo]; for (let x = (Math.floor(lo / unit) + 1) * unit; x < hi; x += unit) vals.push(x);
  for (const [, x] of q) if (!vals.includes(x)) vals.push(x);
  if (!vals.includes(hi)) vals.push(hi);
  vals.sort((a, b) => a - b);
  t.rs = { to: lo, vals, q, l, handNo: v.hand.handNo, street: v.hand.street, openedAt: Date.now() };
  const host = document.createElement('div'); host.className = 'rsheet';
  const bet = l.aggression === 'bet', bb = v.hand.bb;
  const mine = (v.hand.hole[v.seat] || []).map(c => cardHTML(c)).join('');
  const qb = (k, x, cls = '') => `<button type="button"${cls} data-q="${x}" aria-pressed="false">${k}<b>${fmtBb(x, bb)}<i>BB</i></b></button>`;
  // 候補は横にスクロール（数はベットサイズの設定しだい）。All-in は右端に固定
  host.innerHTML = `<div class="rs-top"><div class="rs-cards">${mine}</div><div class="grow"><span class="eyebrow">${bet ? 'BET' : 'RAISE TO'}</span><span class="sub">POT ${fmtBb(l.pot, bb)} BB</span></div><b id="rsv">${fmtBb(lo, bb)}<i>BB</i></b></div>
    <input type="range" id="rsr" min="0" max="${vals.length - 1}" step="1" value="0" ${vals.length < 2 ? 'disabled' : ''} aria-label="${bet ? 'Bet' : 'Raise'} amount">
    <div class="quick"><div class="q-scroll">${q.map(([k, x]) => qb(qLabel(k), x)).join('')}</div>${hi > lo ? qb('All-in', hi, ' class="q-all"') : ''}</div>
    <div class="rs-btns"><button class="btn ghost" data-act="rs-close" type="button">Back</button><button class="btn accent" data-act="rs-ok" type="button"><span id="rsk">${bet ? 'Bet' : 'Raise'}</span><small id="rsv2">${fmt(lo)}</small></button></div>`;
  $('#dock').appendChild(host);
  const rs = t.rs, q1 = s => host.querySelector(s), r = q1('#rsr'), sc = q1('.q-scroll');
  // 端にまだ候補があるときは、その側を薄くする
  const edges = () => { const m = sc.scrollWidth - sc.clientWidth; sc.classList.toggle('more-l', sc.scrollLeft > 2); sc.classList.toggle('more-r', sc.scrollLeft < m - 2); };
  const sync = (reveal) => {
    if (t.rs !== rs) return;
    q1('#rsv').innerHTML = `${fmtBb(rs.to, bb)}<i>BB</i>`; q1('#rsv2').textContent = fmtBb(rs.to, bb) + ' BB · ' + fmt(rs.to);
    q1('#rsk').textContent = rs.to === hi ? 'All-in' : bet ? 'Bet' : 'Raise';
    r.value = t.rs.vals.indexOf(t.rs.to); r.style.setProperty('--fill', (t.rs.vals.length > 1 ? r.value / (t.rs.vals.length - 1) * 100 : 100) + '%');
    host.querySelectorAll('[data-q]').forEach(b => b.setAttribute('aria-pressed', String(+b.dataset.q === t.rs.to)));
    // スライダーで候補の額に来たら、その候補が見えるところまで送る
    const on = reveal && sc.querySelector('[aria-pressed="true"]');
    // .q-scroll は position:relative（offsetLeft はその中の位置）
    if (on) { const x = on.offsetLeft, w = on.offsetWidth; if (x < sc.scrollLeft || x + w > sc.scrollLeft + sc.clientWidth) sc.scrollTo({ left: x - (sc.clientWidth - w) / 2, behavior: REDUCE ? 'auto' : 'smooth' }); }
  };
  r.oninput = () => { if (t.rs === rs) { rs.to = rs.vals[+r.value]; sync(true); } };
  host.querySelectorAll('[data-q]').forEach(b => b.onclick = () => { if (t.rs === rs) { rs.to = +b.dataset.q; sync(); } });
  sc.addEventListener('scroll', edges, { passive: true });
  // マウスのホイール（縦）でも横に送る
  sc.addEventListener('wheel', e => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && sc.scrollWidth > sc.clientWidth) { e.preventDefault(); sc.scrollLeft += e.deltaY; } }, { passive: false });
  host.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); closeSheet(); } });
  sync(); edges(); r.focus({ preventScroll: true });
}
/** ベットサイズの設定が変わった：開いているシートを作り直す */
export function sizesChanged() { if (T && T.v && T.rs && sheetOpen()) openSheet(); }
/** 開いているベットのシートがあるか（閉じかけのものは数えない） */
const sheetOpen = () => !!document.querySelector('.rsheet:not(.closing)');
/** シートを閉じる。開いているものは全部（何枚あっても）。now = アニメ無しで今すぐ消す */
function closeSheet(now) {
  if (T) T.rs = null;
  document.querySelectorAll('.rsheet').forEach(el => {
    if (now || REDUCE) return el.remove();
    if (el.classList.contains('closing')) return;
    el.classList.add('closing');
    const an = el.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(6px)' }], { duration: PACE.sheetOut, easing: 'cubic-bezier(.4,0,1,1)', fill: 'forwards' });
    an.onfinish = () => el.remove(); setTimeout(() => el.remove(), PACE.sheetOut + 150);
  });
}

/* ===================== 配置：全部が収まる最大のカードの大きさ ===================== */
const rectOf = e => { if (!e) return null; const r = e.getBoundingClientRect(); return r.width > 0 ? { l: r.left, r: r.right, t: r.top, b: r.bottom } : null; };
const hit = (a, b, m = 3) => a.l < b.r + m && b.l < a.r + m && a.t < b.b + m && b.t < a.b + m;
function fits() {
  const st = $('#stage'), tb = $('#table');
  if (st.scrollHeight > st.clientHeight + 1 || $('#tInfo').scrollWidth > $('#tInfo').clientWidth + 1) return false;
  const T0 = tb.getBoundingClientRect();
  // 席ごと（手札・プレート・ベット）と、真ん中（ポット・ボード）がそれぞれ重ならず、卓の中に収まること
  const G = [...document.querySelectorAll('#seats .seat')].map(seat => [...seat.children].filter(e => !e.classList.contains('ghost')).map(rectOf).filter(Boolean));
  const mid = [rectOf($('#pot')), rectOf($('#boardC'))].filter(Boolean);
  G.push(mid);
  const bw = $('#boardC').getBoundingClientRect().width;
  if (bw > (T0.right - T0.left) * .62) return false;
  for (const g of G.flat()) if (g.l < T0.left - 1 || g.r > T0.right + 1 || g.t < T0.top - 1 || g.b > T0.bottom + 1) return false;
  for (let i = 0; i < G.length; i++) for (let j = i + 1; j < G.length; j++) for (const a of G[i]) for (const b of G[j]) if (hit(a, b)) return false;
  return chat.fitsLane(T0, G, rectOf, hit);   // チャットの入力ボタン（PRIVATE の卓だけ）
}
function largest(lo, hi, set) {
  set(lo); if (!fits()) return lo;
  set(hi); if (fits()) return hi;
  while (hi - lo > .5) { const m = (lo + hi) / 2; set(m); if (fits()) lo = m; else hi = m; }
  return Math.floor(lo * 2) / 2;
}
let fitKey = '', fitWait = false;
export function fitTable(force, glide) {
  const b = document.body; if (b.dataset.screen !== 'game' || !T || !T.v) return;
  if (gliding() && !glide) { fitWait = true; return; }   // キーボードでの縮小・復帰の途中：終わってから
  if (b.classList.contains('kbmin') && !glide) return;     // キーボードで卓を薄くしている間は大きさを変えない
  if (document.activeElement && document.activeElement.id === 'pdMemo') return;   // プレイヤーのメモを書く間（モーダルの裏の卓は動かさない。閉じたキーボードの resize で合わせ直す）
  const app_ = $('.app'), st = $('#stage'), vw = app_.clientWidth, vh = app_.clientHeight, key = vw + 'x' + vh + ':' + T.v.n;
  if (!force && key === fitKey) return; fitKey = key;
  if (!b.classList.contains('kb')) b.classList.toggle('land', vw > vh * 1.25 && vh < 600);   // キーボードの間は向きの判定を変えない
  const c = chat.fitLane(key + (b.classList.contains('land') ? 'L' : ''), () => largest(14, b.classList.contains('land') ? 50 : 80, x => st.style.setProperty('--cw', x + 'px')));
  st.style.setProperty('--cw', c + 'px');
  chat.afterFit();
}
viewportHooks({
  measure: () => { if (document.body.dataset.screen !== 'game' || !T || !T.v) return null; fitTable(true, true); return { cw: parseFloat($('#stage').style.getPropertyValue('--cw')), tableH: $('#table').clientHeight }; },
  focused: () => document.activeElement === $('#chatIn'),
  done: () => { if (fitWait) { fitWait = false; fitTable(true); } },
});
let fitT = 0;
export const refit = () => { clearTimeout(fitT); fitT = setTimeout(() => fitTable(true), 30); };
addEventListener('resize', refit);
addEventListener('orientationchange', refit);
if (window.ResizeObserver) new ResizeObserver(refit).observe(document.querySelector('.app'));
if (window.visualViewport) visualViewport.addEventListener('resize', refit);
if (document.fonts && document.fonts.ready) document.fonts.ready.then(refit);


// メモの印が変わったら席を描き直す
onNotes(() => { if (T && T.v) render(); });

if (import.meta.env && import.meta.env.DEV) window.__table = { get T() { return T; }, render };
