// 卓：2〜6 席（自分は常に下）、ボード、ポット、操作ドック、ハンドの結果、ポーリングと tick、試合の結果。
// 状態はサーバーのビュー（room_poll / act / tick）だけから作る。ルールで決めるのは legalActions(view) だけ。
import { legalActions, dueAt } from '../engine.js';
import { BLIND_TABLES, modeLabel, ACTION_MS } from '../structure.js';
import { $, app, esc, fmt, head, openDlg, toast, setHTML, cardHTML, fly, ordinal, clock, REDUCE, EASE, fmtPt, fmtBb } from './util.js';
import { syncRoom } from '../history/sync.js';
import * as chat from './chat.js';
import { viewportHooks, gliding } from './viewport.js';

const GRACE_MS = 1500, LOCK_MS = 350;
const sum = a => a.reduce((s, x) => s + x, 0);
const net = () => app.net;

let T = null; // 動いている卓（無ければ null）

/* ===================== 入る / 出る ===================== */
export function enter(id) {
  leave();
  T = { id, ver: -1, v: null, busy: false, timer: 0, lockUntil: 0, pre: null, rs: null, resultShown: false, tickAt: 0, tickBusy: false,
    clockCache: null, sh: { handNo: -1, board: -1, settled: -1, bet: [], init: false }, synced: 0, syncT: 0, leaving: false };
  $('#dock').innerHTML = '<div id="dockMain" style="display:contents"></div>';
  chat.start(id);
  for (const s of ['#seats', '#pot', '#boardC', '#tInfo', '#betM']) { const e = $(s); e.innerHTML = ''; e._h = null; }
  setHTML($('#dockMain'), '<span class="dk-title">…</span><span class="dots"><i></i><i></i><i></i></span>');
  $('#dock').classList.add('idle');
  document.body.dataset.screen = 'game';
  syncHeader();
  refit();
  poll();
  T.tickTimer = setInterval(() => { maybeTick(); tickClock(); }, 400);
}
export function leave() {
  if (!T) return;
  const h = $('#rsheet'); if (h) h.remove();
  clearTimeout(T.timer); clearInterval(T.tickTimer); clearTimeout(T.syncT); clearTimeout(T.lockT);
  document.querySelectorAll('.fly').forEach(e => e.remove());
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
  const v = T && T.v, me = v && v.players[v.seat];
  const gone = !v || v.status === 'finished' || v.status === 'cancelled' || (me && (me.status === 'out' || me.status === 'left'));
  if (lb) lb.hidden = !T || gone || T.leaving;
}
export function askLeave() {
  const t = T; if (!t || !t.v || t.leaving) return;
  $('#leaveBody').innerHTML = head('LEAVE', '退出しますか？') +
    `<p>退出すると戻れません。チップは卓に残り、手番は自動でチェック/フォールドされます。最後まで残った人の順位で pt が決まります。</p>
    <div class="btns"><button class="btn ghost" data-close type="button">Cancel</button><button class="btn danger" id="leaveOk" type="button">Leave</button></div>`;
  openDlg('#leaveDlg');
  $('#leaveOk').onclick = async () => {
    if (T !== t || t.leaving) return;
    t.leaving = true; $('#leaveOk').disabled = true; syncHeader();
    try { const r = await net().game({ op: 'leave', room: t.id }); if (T === t) { clock.offset = r.now - Date.now(); apply(r.view); } }
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
    if (r.view && !t.busy) apply(r.view);
    chat.onPoll(r.chat);
  } catch (e) {
    if (t !== T) return;
    if (e.code === 'not_found') { toast('卓が見つかりません'); return app.nav.toMenu(); }
  }
  if (t !== T) return;
  maybeTick();
  const v = t.v;
  if (v && (v.status === 'finished' || v.status === 'cancelled')) return;   // 終わった：もう読まない
  const mine = v && v.hand && v.hand.toAct === v.seat;
  t.timer = setTimeout(poll, document.hidden ? 4000 : mine ? 2500 : 1000);
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
    if (t === T) { clock.offset = r.now - Date.now(); apply(r.view); }
  } catch (e) {
    if (t === T) t.tickAt = Date.now() + (e.code === 'not_yet' ? 500 + Math.random() * 500 : 1500);
  } finally { t.tickBusy = false; }
}

/* ===================== ビューの適用 ===================== */
function apply(v) {
  const t = T; if (!v || v.ver <= t.ver || v.lobby) return;
  const prev = t.v;
  t.v = v; t.ver = v.ver;
  const h = v.hand;
  if (h && h.toAct === v.seat && (!prev || !prev.hand || prev.hand.toAct !== v.seat || prev.hand.handNo !== h.handNo)) t.lockUntil = Date.now() + LOCK_MS;
  if (t.rs && !(h && h.toAct === v.seat && h.phase === 'betting')) closeSheet();
  // 終わったハンドを端末に写す（少し待ってまとめて）
  if (h && h.phase === 'settled' && h.handNo > t.synced) { t.synced = h.handNo; clearTimeout(t.syncT); t.syncT = setTimeout(() => syncRoom(t.id), 800); }
  chat.onView(v);
  render();
  autoPre();
  checkResult();
}

/* ---------- 結果 ---------- */
function checkResult() {
  const t = T, v = t.v; if (!v) return;
  const me = v.players[v.seat], ended = v.status === 'finished' || v.status === 'cancelled';
  if (ended && !t.overShown) { t.overShown = true; showResult(); return; }
  if (!ended && me.status === 'out' && !t.resultShown) showResult();
}
function showResult() {
  const t = T; t.resultShown = true;
  const v = t.v, me = v.seat, p = v.players[me], ended = v.status === 'finished' || v.status === 'cancelled';
  const cancelled = v.status === 'cancelled';
  if (ended) syncRoom(t.id, v);
  const order = v.players.map((x, s) => ({ s, p: x.place ?? 99 })).sort((a, b) => a.p - b.p || a.s - b.s);
  const rows = order.map(({ s, p: pl }) => `<li class="${s === me ? 'me-row' : ''}"><span class="pn">${pl < 99 ? pl : '–'}</span><span class="nm2">${s === me ? '<span class="me">YOU</span> ' : ''}${esc(v.names[s])}</span><span class="pr">${v.players[s].pt == null ? '' : fmtPt(v.players[s].pt) + ' pt'}</span></li>`).join('');
  const title = cancelled ? 'Cancelled' : p.place === 1 ? 'Winner' : ended ? 'Game over' : 'Eliminated';
  $('#overBody').innerHTML = `${head('RESULT', title, p.place === 1 ? 'c' : '')}
    <div class="over-hd"><span class="place${p.place === 1 ? ' p1' : ''}">${p.place ?? '–'}<sup>${p.place ? ordinal(p.place).slice(String(p.place).length) : ''}</sup></span>
      <span class="over-gain ${(p.pt ?? 0) > 0 ? 'up' : (p.pt ?? 0) < 0 ? 'down' : 'even'}">${cancelled ? '' : fmtPt(p.pt)}<small>${cancelled ? '中止（pt なし）' : 'PT'}</small></span></div>
    <div class="cfg-sum">${esc(modeLabel(v.config.mode))} ・ ${v.config.players}人 ・ ${v.handNo} hands</div>
    <ul class="over-rows">${rows}</ul>
    <div class="btns">${ended ? '' : '<button class="btn ghost" data-act="watch" type="button">Watch</button>'}<button class="btn primary" data-act="menu" type="button">Menu</button></div>`;
  const dlg = $('#overDlg'); if (!dlg.open) openDlg('#overDlg');
  $('#overBody').onclick = e => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    if (b.dataset.act === 'watch') { dlg.close(); render(); }
    if (b.dataset.act === 'menu') { dlg.close(); app.nav.toMenu(); }
  };
  dlg.oncancel = e => e.preventDefault();
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
    el.style.cssText = `left:${x}%;top:${y}%;transform:translate(${-ax * 100}%,${-ay * 100}%)`;
    box.appendChild(el);
  }
}

/* ===================== 描画 ===================== */
const PL = { fold: 'FOLD', check: 'CHECK', call: 'CALL', bet: 'BET', raise: 'RAISE', allin: 'ALL-IN' };
function render() {
  const t = T; if (!t || !t.v) return;
  const v = t.v, h = v.hand;
  syncHeader(); ensureSeats(v);
  let ch = renderInfo();
  for (let s = 0; s < v.n; s++) ch = setHTML($('#seat' + s), seatHTML(s)) || ch;
  const pot = h ? (h.phase === 'settled' ? sum(h.won) : sum(h.commits)) : 0;
  ch = setHTML($('#pot'), `<span>POT</span><b>${fmt(pot)}</b>${h && h.phase !== 'settled' && pot ? `<small>${fmtBb(pot, h.bb)} BB</small>` : ''}`) || ch;
  $('#pot').classList.toggle('zero', !pot);
  const board = h ? h.board : [];
  ch = setHTML($('#boardC'), Array.from({ length: 5 }, (_, i) => board[i] != null ? cardHTML(board[i]) : '<div class="slot"></div>').join('')) || ch;
  ch = renderDock() || ch;
  afterRender();
  tickClock();
  if (ch) refit();
}

function renderInfo() {
  const v = T.v, h = v.hand, c = v.config;
  const lv = h ? h.level : 1, bl = BLIND_TABLES[c.speed][lv - 1] || [0, 0];
  const alive = v.players.filter(p => p.status !== 'out').length;
  return setHTML($('#tInfo'), `<div class="lv"><b>${fmt(bl[0] / 2)}/${fmt(bl[0])}</b><span>(${fmt(bl[1])}) LV ${lv}</span></div>
    <div class="nx" id="nx"><span>NEXT</span><b id="nxv"></b></div>
    <div class="pz"><span class="mx">${alive}/${v.n}</span><b>#${esc(v.room.code)}</b></div>`);
}
function nextLevelText() {
  const v = T.v, c = v.config, h = v.hand, lv = h ? h.level : 1;
  if (lv >= BLIND_TABLES[c.speed].length) return { t: 'MAX', soon: false };
  const ms = v.startedAt + lv * c.levelMin * 60000 - clock.now();
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

/** その席のこのストリートの最後のアクション */
function lastAction(h, s) {
  for (let i = h.actions.length - 1; i >= 0; i--) { const a = h.actions[i]; if (a.street !== h.street) break; if (a.seat === s) return a; }
  return null;
}
function seatHTML(s) {
  const v = T.v, h = v.hand, me = s === v.seat, p = v.players[s], bb = h ? h.bb : 200;
  const settled = h && h.phase === 'settled', inHand = h && h.startStacks[s] > 0;
  const out = p.status === 'out' && !(settled && h.eliminated.some(e => e.seat === s));
  const folded = h && inHand && h.folded[s];
  const acting = h && v.status === 'running' && h.phase === 'betting' && h.toAct === s;
  const winner = isWinner(h, s);
  const cls = ['sp', me ? 'me-s' : 'opp-s', acting ? 'act' : '', folded && !settled ? 'fold' : '', out ? 'out' : '', winner ? 'win' : ''].filter(Boolean).join(' ');
  // 手札
  let cards = '';
  if (h && inHand && !out) {
    const hole = h.hole[s];
    if (hole) cards = hole.map(c => cardHTML(c, { dim: folded && !settled })).join('');
    else if (!folded && !settled) cards = cardHTML(null) + cardHTML(null);
  }
  // 札の下の 1 行：結果 > 最後のアクション > 状態
  let note = '';
  const la = h && !settled ? lastAction(h, s) : null;
  if (winner) note = `${h.won[s] > h.commits[s] ? `<span class="w up">+${fmt(h.won[s] - h.commits[s])}</span>` : '<span class="w up">CHOP</span>'}${h.names && h.names[s] ? `<span class="hn">${esc(h.names[s])}</span>` : ''}`;
  else if (settled && h.names && h.names[s]) note = `<span class="hn">${esc(h.names[s])}</span>`;
  else if (p.status === 'out') note = p.place ? ordinal(p.place).toUpperCase() : 'OUT';
  else if (p.status === 'left') note = 'LEFT';
  else if (la && !acting) note = `<span class="pl k-${la.kind}">${PL[la.kind]}</span>`;
  else if (folded) note = 'FOLD';
  else if (h && h.allIn[s] && inHand) note = '<span class="ai">ALL-IN</span>';
  else if (p.status === 'sitout') note = 'AWAY';
  if (p.status === 'sitout' && note && !note.includes('AWAY') && !settled) note += '<span class="away">AWAY</span>';
  const name = me ? 'YOU' : esc(v.names[s]);
  const dbtn = h && h.btn === s && !out ? '<b class="dbtn" title="Dealer">D</b>' : '';
  const clk = acting ? clockBarHTML(s) : '';
  const bet = h && !settled && h.streetBet[s] > 0 ? `<div class="bchip"><i></i><b>${fmt(h.streetBet[s])}</b></div>` : '';
  return `<div class="hole">${cards}</div><div class="${cls}"><div class="sp-hd"><i class="gem"></i><span class="nm">${name}</span></div>
    <div class="stk"><b data-stk="${s}">${fmt(p.stack)}</b><small>${fmtBb(p.stack, bb)} BB</small></div><div class="note">${note}</div>${clk}${dbtn}</div>${bet}`;
}
/** そのハンドでポットを勝ち取った席か（ショーダウンで返ってきただけのコールされなかった分は除く） */
function isWinner(h, s) {
  if (!h || h.phase !== 'settled') return false;
  if (!h.shown) return h.won[s] > 0;
  return h.pots.some(p => p.eligible.length > 1 && p.winners.includes(s));
}

/* ---------- 描画のあとの演出 ---------- */
function afterRender() {
  const t = T, v = t.v, h = v.hand, sh = t.sh;
  if (!h) return;
  const board = h.board.length;
  if (REDUCE) { sh.init = true; sh.handNo = h.handNo; sh.board = board; sh.bet = h.streetBet.slice(); sh.settled = h.phase === 'settled' ? h.handNo : sh.settled; return; }
  const flip = (el, delay) => el && el.animate([{ transform: 'perspective(600px) rotateY(90deg)' }, { transform: 'none' }], { duration: 420, delay, easing: EASE, fill: 'backwards' });
  const cards = [...document.querySelectorAll('#boardC .card')];
  if (sh.init && sh.handNo === h.handNo && board > sh.board) cards.slice(Math.max(0, sh.board)).forEach((c, i) => flip(c, i * 110));
  sh.board = board;
  if (sh.handNo !== h.handNo) {
    document.querySelectorAll('.seat .hole .card').forEach((c, i) => c.animate([{ transform: 'translateY(-22px) rotate(-5deg)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 420, delay: i * 50, easing: EASE, fill: 'backwards' }));
    sh.handNo = h.handNo; sh.bet = [];
  }
  if (h.phase === 'settled' && sh.settled !== h.handNo) {
    sh.settled = h.handNo;
    if (sh.init) {
      // 相手の手札を表に返し、ポットから勝った席へチップを飛ばす
      document.querySelectorAll('.seat.opp .hole .card:not(.back)').forEach((c, i) => flip(c, 120 + i * 90));
      const pot = $('#pot b');
      h.won.forEach((w, s) => { if (w > 0) fly(pot, document.querySelector(`[data-stk="${s}"]`), '+' + fmt(w), s === v.seat ? 'y' : 'c', 350); });
    }
  }
  h.streetBet.forEach((b, s) => {
    if (!(sh.init && b > (sh.bet[s] || 0))) return;
    const el = $('#seat' + s)?.querySelector('.bchip');
    if (el) el.animate([{ transform: 'translateY(-8px) scale(.9)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 320, easing: EASE });
  });
  sh.bet = h.streetBet.slice();
  sh.init = true;
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
}

/* ===================== ドック ===================== */
const autoPreKey = () => T.v.hand.handNo + ':' + T.v.hand.street;
function autoPre() {
  const t = T, v = t.v, h = v.hand; if (!h || h.toAct !== v.seat || h.phase !== 'betting' || !t.pre) return;
  if (t.pre !== autoPreKey()) { t.pre = null; return; }
  t.pre = null;
  const l = legalActions(v, v.seat); if (!l) return;
  setTimeout(() => { if (T === t && t.v.ver === v.ver) submit({ type: l.canCheck ? 'check' : 'fold' }); }, 250);
}
function renderDock() {
  const t = T, v = t.v, h = v.hand, me = v.seat, p = v.players[me], dock = $('#dock'), el = $('#dockMain');
  const l = v.status === 'running' ? legalActions(v, me) : null;
  let html = '', idle = true;
  if (v.status === 'finished' || v.status === 'cancelled') {
    html = `<span class="eyebrow">${v.status === 'cancelled' ? 'CANCELLED' : 'GAME OVER'}</span><span class="dk-title ${p.place === 1 ? 'y' : ''}">${p.place ? ordinal(p.place) : ''}</span><button class="btn primary" data-act="result" type="button" style="flex:0 0 40%">Result</button>`;
  } else if (p.status === 'out') {
    html = `<span class="dk-title">${p.place ? ordinal(p.place) : 'OUT'}</span><span class="dots"><i></i><i></i><i></i></span><button class="btn primary" data-act="result" type="button" style="flex:0 0 40%">Result</button>`;
  } else if (p.status === 'sitout' || v.status === 'paused') {
    html = `<span class="eyebrow">${v.status === 'paused' ? 'PAUSED' : 'SITTING OUT'}</span><span class="dk-title">${v.status === 'paused' ? '<b class="secs" id="pauseLeft"></b>' : ''}</span>${p.status === 'sitout' ? '<button class="btn accent" data-act="sitin" type="button" style="flex:0 0 36%">I\'m back</button>' : ''}`;
  } else if (h && h.phase === 'settled') {
    const ws = h.won.map((_, s) => s).filter(s => isWinner(h, s));
    const w = ws.length === 1 ? ws[0] : null;
    const who = w === null ? (ws.length ? 'SPLIT POT' : 'HAND OVER') : w === me ? 'YOU WIN' : esc(v.names[w]) + ' WINS';
    html = `<span class="dk-title ${w === me ? 'y' : w === null ? '' : 'c'}">${who}</span><span class="dk-stats">${w !== null ? `<b>+${fmt(Math.max(0, h.won[w] - h.commits[w]))}</b>${h.names && h.names[w] ? esc(h.names[w]) : ''}` : ''}</span>`;
  } else if (l) {
    idle = false;
    const pot = l.pot, facing = l.canFold;
    const callAllin = facing && l.callPut >= p.stack;
    const canRaise = l.minTo != null;
    const rLabel = l.aggression === 'bet' ? 'Bet' : 'Raise', allinOnly = canRaise && l.minTo === l.maxTo;
    const rz = canRaise ? `<button class="btn accent" data-act="raise" type="button">${allinOnly ? 'All-in' : rLabel}<small>${allinOnly ? fmt(l.maxTo) : fmt(l.minTo) + '+'}</small></button>` : '';
    html = `<div class="dk-top"><span class="you-act">YOUR TURN</span><span class="dk-stats">POT<b>${fmt(pot)}</b>${facing ? `CALL<b>${fmt(l.callPut)}</b>` : ''}</span><span class="secs" id="secs"></span></div>
      <div class="dk-row">${facing
        ? `<button class="btn ghost" data-act="fold" type="button">Fold</button><button class="btn primary" data-act="call" type="button">${callAllin ? 'All-in' : 'Call'}<small>${fmt(l.callPut)}</small></button>${rz}`
        : `<button class="btn primary" data-act="check" type="button">Check</button>${rz}`}</div>`;
  } else {
    const a = h ? h.toAct : null, who = a != null ? esc(v.names[a]) : '';
    const inHand = h && h.startStacks[me] > 0 && !h.folded[me] && !h.allIn[me];
    const armed = h && t.pre === autoPreKey();
    html = `${h && h.folded[me] ? '<span class="eyebrow">FOLDED</span>' : ''}<span class="dk-title">${who}</span><span class="dots" style="margin-left:0"><i></i><i></i><i></i></span>
      ${inHand && a != null && a !== me ? `<button class="pre" data-act="pre" type="button" aria-pressed="${armed}">Check/Fold</button>` : ''}
      <button class="pre away-btn" data-act="sitout" type="button">離席</button>`;
  }
  dock.classList.toggle('idle', idle);
  const locked = !idle && (Date.now() < t.lockUntil || t.busy);
  dock.classList.toggle('lock', locked);
  if (locked && Date.now() < t.lockUntil) { clearTimeout(t.lockT); t.lockT = setTimeout(() => { if (T === t) renderDock(); }, t.lockUntil - Date.now() + 20); }
  return setHTML(el, html);
}

$('#dock').addEventListener('click', e => {
  const t = T; if (!t || !t.v) return;
  const b = e.target.closest('[data-act]'); if (!b) return;
  const act = b.dataset.act, v = t.v;
  if (act === 'result') return showResult();
  if (act === 'pre') { t.pre = t.pre === autoPreKey() ? null : autoPreKey(); renderDock(); return; }
  if (act === 'sitout' || act === 'sitin') return seatOp(act);
  if (t.busy || Date.now() < t.lockUntil || !v.hand || v.hand.toAct !== v.seat) return;
  if (act === 'fold' || act === 'check' || act === 'call') return submit({ type: act });
  if (act === 'raise') return openSheet();
  if (act === 'rs-close') return closeSheet();
  if (act === 'rs-ok') { const to = t.rs && t.rs.to, l = t.rs && t.rs.l; closeSheet(); return submit(to === l.maxTo ? { type: 'allin' } : { type: 'raise', to }); }
});
async function seatOp(op) {
  const t = T; if (!t || t.busy) return;
  t.busy = true;
  try { const r = await net().game({ op, room: t.id }); if (t !== T) return; t.busy = false; clock.offset = r.now - Date.now(); apply(r.view); }
  catch (e) { if (t !== T) return; t.busy = false; poll(); }
}
async function submit(move) {
  const t = T; if (!t || t.busy) return;
  t.busy = true; renderDock();
  try {
    const r = await net().game({ op: 'act', room: t.id, ver: t.ver, move });
    if (t !== T) return;
    t.busy = false; clock.offset = r.now - Date.now(); apply(r.view);
  } catch (e) {
    if (t !== T) return;
    t.busy = false;
    if (['stale', 'not_your_turn', 'game_over'].includes(e.code)) poll();
    else toast(e.code === 'illegal' ? 'その操作はできません' : '通信エラー。もう一度');
    renderDock();
  }
}

/* ---------- ベット/レイズのシート ---------- */
function quickValues(l, v) {
  const lo = l.minTo, hi = l.maxTo, h = v.hand, out = [];
  if (h.street === 0) {
    const base = Math.max(l.streetLastBetTo, h.bb);
    for (const k of [2, 2.5, 3]) out.push([k + 'x', Math.round(base * k)]);
  } else for (const [f, label] of [[1 / 3, '1/3'], [1 / 2, '1/2'], [2 / 3, '2/3'], [1, 'Pot']]) out.push([label, l.streetLastBetTo + Math.round(f * (l.pot + l.toCall))]);
  const list = out.filter(([, x]) => x > lo && x < hi);
  list.unshift(['Min', lo]);
  const uniq = []; for (const q of list) if (!uniq.some(u => u[1] === q[1])) uniq.push(q);
  if (hi > lo) uniq.push(['All-in', hi]);
  return uniq;
}
function openSheet() {
  const t = T, v = t.v, l = legalActions(v, v.seat); if (!l || l.minTo == null) return;
  const lo = l.minTo, hi = l.maxTo, unit = Math.max(1, Math.round(v.hand.bb / 2)), q = quickValues(l, v);
  const vals = [lo]; for (let x = (Math.floor(lo / unit) + 1) * unit; x < hi; x += unit) vals.push(x);
  for (const [, x] of q) if (!vals.includes(x)) vals.push(x);
  if (!vals.includes(hi)) vals.push(hi);
  vals.sort((a, b) => a - b);
  t.rs = { to: lo, vals, q, l };
  const host = document.createElement('div'); host.className = 'rsheet'; host.id = 'rsheet';
  const bet = l.aggression === 'bet', bb = v.hand.bb;
  const mine = (v.hand.hole[v.seat] || []).map(c => cardHTML(c)).join('');
  host.innerHTML = `<div class="rs-top"><div class="rs-cards">${mine}</div><div class="grow"><span class="eyebrow">${bet ? 'BET' : 'RAISE TO'}</span><span class="sub">POT ${fmt(l.pot)}</span></div><b id="rsv">${fmt(lo)}</b></div>
    <input type="range" id="rsr" min="0" max="${vals.length - 1}" step="1" value="0" ${vals.length < 2 ? 'disabled' : ''} aria-label="${bet ? 'Bet' : 'Raise'} amount">
    <div class="quick">${q.map(([k, x]) => `<button type="button" data-q="${x}" aria-pressed="false">${k}<b>${fmtBb(x, bb)}<i>BB</i></b></button>`).join('')}</div>
    <div class="rs-btns"><button class="btn ghost" data-act="rs-close" type="button">Back</button><button class="btn accent" data-act="rs-ok" type="button"><span id="rsk">${bet ? 'Bet' : 'Raise'}</span><small id="rsv2">${fmt(lo)}</small></button></div>`;
  $('#dock').appendChild(host);
  const r = $('#rsr');
  const sync = () => {
    $('#rsv').textContent = fmt(t.rs.to); $('#rsv2').textContent = fmt(t.rs.to) + ' · ' + fmtBb(t.rs.to, bb) + ' BB';
    $('#rsk').textContent = t.rs.to === hi ? 'All-in' : bet ? 'Bet' : 'Raise';
    r.value = t.rs.vals.indexOf(t.rs.to); r.style.setProperty('--fill', (t.rs.vals.length > 1 ? r.value / (t.rs.vals.length - 1) * 100 : 100) + '%');
    host.querySelectorAll('[data-q]').forEach(b => b.setAttribute('aria-pressed', String(+b.dataset.q === t.rs.to)));
  };
  r.oninput = () => { t.rs.to = t.rs.vals[+r.value]; sync(); };
  host.querySelectorAll('[data-q]').forEach(b => b.onclick = () => { t.rs.to = +b.dataset.q; sync(); });
  host.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); closeSheet(); } });
  sync(); r.focus({ preventScroll: true });
}
function closeSheet() { if (T) T.rs = null; const h = $('#rsheet'); if (h) h.remove(); }

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
  return chat.fitsLane(T0, G, rectOf, hit);   // チャットのレーンと入力ボタン（PRIVATE の卓だけ）
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
  const app_ = $('.app'), st = $('#stage'), vw = app_.clientWidth, vh = app_.clientHeight, key = vw + 'x' + vh + ':' + T.v.n;
  if (!force && key === fitKey) return; fitKey = key;
  if (!b.classList.contains('kb')) b.classList.toggle('land', vw > vh * 1.25 && vh < 600);   // キーボードの間は向きの判定を変えない
  const c = chat.fitLane(key + (b.classList.contains('land') ? 'L' : ''), () => largest(14, b.classList.contains('land') ? 50 : 80, x => st.style.setProperty('--cw', x + 'px')));
  st.style.setProperty('--cw', c + 'px');
  if (b.classList.contains('chat')) fits();   // レーンの幅をこの大きさで決め直す
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


if (import.meta.env && import.meta.env.DEV) window.__table = { get T() { return T; }, render };
