// 卓の中のヘッダのボタンと、中央に開くすりガラスのモーダル 2 つ：チャット履歴（#chatDlg）と この試合のハンド履歴（#handsDlg）。
// チャットのデータは ui/chat.js、ハンドは端末の IndexedDB（history/store.js）。ハンドの詳細は STATS と同じ #handDlg（stats.openHand）を上に重ねる。
import { $, esc, fmt, head, openDlg, cardText, fmtBb, REDUCE, EASE } from './util.js';
import * as chat from './chat.js';
import * as table from './table.js';
import * as store from '../history/store.js';
import { syncRoom, gameSummary } from '../history/sync.js';
import { netOfRecord, positionsOf } from '../history/hand.js';
import { handStats, pctLabel } from '../history/stats.js';
import { openHand } from './stats.js';
import * as player from './player.js';

const inGame = () => document.body.dataset.screen === 'game' && table.active();
const p2 = n => String(n).padStart(2, '0');
const hhmm = ms => { const d = new Date(ms); return `${p2(d.getHours())}:${p2(d.getMinutes())}`; };
const DOTS = '<div class="gd-empty"><span class="dots"><i></i><i></i><i></i></span></div>';

/* ===================== ヘッダのボタン ===================== */
let lastUnread = 0;
function syncButtons() {
  const on = inGame() && chat.chatEnabled(), b = $('#chatLogBtn');
  if (b.hidden === on) b.hidden = !on;
  const n = on ? chat.unread() : 0, badge = b.querySelector('.badge');
  badge.hidden = !n;
  b.setAttribute('aria-label', n ? `Chat (${n} unread)` : 'Chat');
  if (n > lastUnread && !REDUCE && badge.animate) badge.animate([{ transform: 'scale(.2)', opacity: 0 }, { transform: 'scale(1.5)', opacity: 1, offset: .6 }, { transform: 'none', opacity: 1 }], { duration: 420, easing: EASE });
  lastUnread = n;
  if (!on && $('#chatDlg').open) $('#chatDlg').close();
}

/* ===================== チャット履歴 ===================== */
const chatDlg = () => $('#chatDlg');
let shown = [];        // 一覧に出しているメッセージ（seq の並び）
const GROUP_MS = 3 * 60_000;

function msgHTML(m, prev) {
  const cont = prev && prev.seat === m.seat && m.at - prev.at < GROUP_MS;
  const who = m.mine ? 'YOU' : esc(m.name || `Seat ${m.seat + 1}`);
  return `<li class="cm ${m.mine ? 'mine' : 'opp'} t-${m.tone || 'p1'}${cont ? ' cont' : ''}">${cont ? '' : `<div class="cm-h"><b class="cm-n">${who}</b><time>${hhmm(m.at)}</time></div>`}<p class="cm-t">${esc(m.text)}</p></li>`;
}
function openChatLog() {
  if (!inGame() || !chat.chatEnabled()) return;
  const v = table.currentView();
  $('#chatBody').innerHTML = `<div class="gd-head">${head('CHAT', v ? `#${esc(v.room.code)}` : '')}</div>
    <div class="gd-scroll" id="chatScroll" tabindex="-1"></div>
    <div class="gd-foot"><button class="btn ghost wide gd-write" id="chatWrite" type="button"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13 7l4 4"/></svg>Message</button></div>`;
  shown = [];
  renderChat(true);
  $('#chatWrite').onclick = () => { chatDlg().close(); chat.openComposer(); };
  openDlg('#chatDlg');
  chat.markRead();
  const sc = $('#chatScroll'); sc.scrollTop = sc.scrollHeight; sc.focus({ preventScroll: true });
}
/** 一覧を今のメッセージに合わせる（末尾に増えただけなら追記。下を見ていたら最下部へ） */
function renderChat(first) {
  const sc = $('#chatScroll'); if (!sc) return;
  const list = chat.messages();
  const atBottom = first || sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 32;
  if (!list.length) { sc.innerHTML = '<div class="gd-empty">No messages</div>'; shown = []; return; }
  const appendOnly = shown.length && list.length > shown.length && shown.every((s, i) => list[i].seq === s);
  if (appendOnly) {
    const ol = sc.querySelector('.cm-list'), add = list.slice(shown.length);
    add.forEach((m, i) => {
      ol.insertAdjacentHTML('beforeend', msgHTML(m, list[shown.length + i - 1]));
      if (!REDUCE) ol.lastElementChild.animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 260, easing: EASE });
    });
  } else if (list.length !== shown.length || list.some((m, i) => m.seq !== shown[i])) {
    sc.innerHTML = `<ol class="cm-list">${list.map((m, i) => msgHTML(m, list[i - 1])).join('')}</ol>`;
  }
  shown = list.map(m => m.seq);
  if (atBottom) sc.scrollTo({ top: sc.scrollHeight, behavior: first || REDUCE ? 'auto' : 'smooth' });
}
function onChat() {
  syncButtons();
  if (!chatDlg().open) return;
  renderChat(false);
  if (chat.unread() > 0) chat.markRead();
}

/* ===================== この試合のハンド履歴 ===================== */
const handsDlg = () => $('#handsDlg');
let H = null; // { id, g, hands, last, timer }

async function loadHands(h) {
  let hands = [];
  try { hands = await store.handsOf(h.id); } catch (e) { /* IndexedDB が使えない */ }
  let g = null;
  try { g = await store.getGame(h.id); } catch (e) { /* 同上 */ }
  const v = table.currentView();
  if (!g && v && !v.lobby) g = gameSummary(v, h.id, hands.length);
  return { hands, g };
}
async function openHandLog() {
  if (!inGame()) return;
  const id = table.activeId(), v = table.currentView();
  if (H) clearInterval(H.timer);
  H = { id, g: null, hands: null, last: 0, timer: 0 };
  const h = H;
  $('#handsBody').innerHTML = `<div class="gd-head">${head('HAND HISTORY', v ? `${v.room.kind === 'free' ? 'FREE' : 'PRIVATE'} #${esc(v.room.code)}` : '')}<div class="gd-sum" id="handsSum"></div></div>
    <div class="gd-scroll" id="handsScroll" tabindex="-1">${DOTS}</div>`;
  $('#handsScroll').onclick = e => {
    const b = e.target.closest('[data-hand]'); if (!b || !H || !H.g) return;
    const rec = (H.hands || []).find(x => x.handNo === +b.dataset.hand);
    if (rec) openHand(H.g, rec);
  };
  openDlg('#handsDlg');
  $('#handsScroll').focus({ preventScroll: true });
  // 手元の分ですぐ描き、サーバーから写し終えたら描き直す
  Object.assign(h, await loadHands(h)); if (H !== h) return;
  if (h.hands.length) renderHands();
  await syncRoom(id); if (H !== h) return;
  Object.assign(h, await loadHands(h)); if (H !== h) return;
  renderHands();
  // 開いている間に終わったハンドも足す
  h.timer = setInterval(() => refreshHands(h), 1500);
}
async function refreshHands(h) {
  if (H !== h || h.busy || !handsDlg().open) return;
  const v = table.currentView(), cur = v && v.hand;
  const done = cur ? (cur.phase === 'settled' ? cur.handNo : cur.handNo - 1) : 0;
  if (done <= h.last) return;
  h.busy = true;
  await syncRoom(h.id);
  if (H === h) { Object.assign(h, await loadHands(h)); if (H === h) renderHands(); }
  h.busy = false;
}
function renderHands() {
  const h = H, sc = $('#handsScroll'); if (!sc || !h) return;
  const { g, hands } = h;
  h.last = hands.length ? hands[hands.length - 1].handNo : 0;
  if (!g || !hands.length) { sc.innerHTML = '<div class="gd-empty">No hands</div>'; $('#handsSum').innerHTML = ''; return; }
  const seat = g.seat, st = handStats(hands, () => seat);
  $('#handsSum').innerHTML = `<span>${fmt(hands.length)}<i>HANDS</i></span><span>${pctLabel(st.vpip)}%<i>VPIP</i></span><span>${pctLabel(st.pfr)}%<i>PFR</i></span><span class="${st.netBb > 0 ? 'gain' : st.netBb < 0 ? 'loss' : ''}">${st.netBb > 0 ? '+' : ''}${st.netBb.toFixed(1)}<i>BB</i></span>`;
  const top = sc.scrollTop;
  sc.innerHTML = `<ul class="gh-list">${hands.slice().reverse().map(r => {
    let net = 0, pos = null;
    try { net = netOfRecord(r, seat); pos = positionsOf(r)[seat]; } catch (e) { /* 壊れた行 */ }
    const tone = net > 0 ? 'gain' : net < 0 ? 'loss' : '';
    const hole = r.hole && r.hole.length ? r.hole.map(cardText).join('') : '<span class="ct none">–</span>';
    const board = r.board && r.board.length ? r.board.map(cardText).join('') : '';
    return `<li><button class="gh-row" type="button" data-hand="${r.handNo}">
      <span class="gh-no">#${fmt(r.handNo)}</span><span class="gh-lv">LV${fmt(r.level)} <b>${fmt(r.sb)}/${fmt(r.bb)}</b></span><span class="gh-pos">${pos ?? ''}</span>
      <span class="gh-net ${tone}">${net > 0 ? '+' : net < 0 ? '−' : '±'}${fmt(Math.abs(net))}<small>${net > 0 ? '+' : net < 0 ? '−' : ''}${fmtBb(Math.abs(net), r.bb)} BB</small></span>
      <span class="gh-cards"><span class="gh-hole">${hole}</span>${board ? `<span class="gh-board">${board}</span>` : ''}</span></button></li>`;
  }).join('')}</ul>`;
  sc.scrollTop = top;
}
function stopHands() { if (H) clearInterval(H.timer); H = null; }

/* ===================== 配線 ===================== */
/** 両方のモーダル（と、そこから開いたハンドの詳細）を閉じる */
export function closeAll() {
  for (const d of ['#handDlg', '#handsDlg', '#chatDlg']) { const e = $(d); if (e && e.open && (d !== '#handDlg' || H)) e.close(); }
  player.close();
  stopHands();
}
export function init() {
  $('#chatLogBtn').addEventListener('click', openChatLog);
  $('#handLogBtn').addEventListener('click', openHandLog);
  player.init();   // 席を押すとプレイヤーのスタッツとメモ
  handsDlg().addEventListener('close', () => { if (handsDlg().open) return; if ($('#handDlg').open) $('#handDlg').close(); stopHands(); });
  chatDlg().addEventListener('close', () => { shown = []; });
  chat.subscribe(onChat);   // メッセージ・未読・chatEnabled が変わるたび
  // 卓に入った・出た（画面の切り替え）でボタンを合わせ、卓の外ではモーダルを閉じる
  new MutationObserver(() => { if (document.body.dataset.screen !== 'game') closeAll(); syncButtons(); })
    .observe(document.body, { attributes: true, attributeFilter: ['data-screen'] });
  syncButtons();
}
