// 卓の席を押すと開くプレイヤーのモーダル（#playerDlg。ingame.js と同じすりガラス）：その卓のゲームモードでの VPIP・PFR・生存ターン・HANDS
// （終わった試合の集計。モードをまたいで混ぜない）と、この試合の分。相手の席ならメモと色の印（history/notes.js。この端末に保存）。
// 相手の数字は、この端末に残っている「一緒に打った試合」のハンド記録（全員のアクションが入っている）から数える。
import { modeLabel } from '../structure.js';
import { $, esc, fmt, head, openDlg } from './util.js';
import * as table from './table.js';
import * as chat from './chat.js';
import * as store from '../history/store.js';
import { syncRoom } from '../history/sync.js';
import { finishedGames, byMode, playerStats, pctLabel, seatIn } from '../history/stats.js';
import { MARKS, NOTE_MAX, noteOf, setNote } from '../history/notes.js';

const dlg = () => $('#playerDlg');
const DOTS = '<span class="dots"><i></i><i></i><i></i></span>';
let P = null;   // 開いている人 { name, self, mode, roomId, saveT, timer }

// 数が無いとき（–）は単位を付けない
const unitOf = (value, unit) => (unit && value !== '–' ? `<small>${unit}</small>` : '');
const tile = (label, value, unit = '', sub = '') => `<div class="pd-stat"><span class="statlbl">${label}</span><b>${value}${unitOf(value, unit)}</b>${sub ? `<span class="pd-sub">${sub}</span>` : ''}</div>`;
function statsHTML(st) {
  if (!st) return `<div class="pd-grid pd-wait">${DOTS}</div>`;
  return `<div class="pd-grid">
    ${tile('VPIP', pctLabel(st.vpip), '%')}
    ${tile('PFR', pctLabel(st.pfr), '%')}
    ${tile('生存ターン', st.survival == null ? '–' : st.survival.toFixed(1))}
    ${tile('HANDS', fmt(st.hands), '', `${fmt(st.games)} GAMES`)}
  </div>`;
}
const nowHTML = st => `<div class="pd-now"><span class="eyebrow">THIS GAME</span>${st
  ? `<span>HANDS<b>${fmt(st.hands)}</b></span><span>VPIP<b>${pctLabel(st.vpip)}${unitOf(pctLabel(st.vpip), '%')}</b></span><span>PFR<b>${pctLabel(st.pfr)}${unitOf(pctLabel(st.pfr), '%')}</b></span>`
  : DOTS}</div>`;
function marksHTML(mark) {
  const b = (k, label) => `<button type="button" class="pd-mk mk${k}" data-mk="${k}" aria-pressed="${mark === k}" aria-label="${label}"></button>`;
  return `<div class="pd-marks" role="group" aria-label="Mark">${b(0, 'No mark')}${Array.from({ length: MARKS }, (_, i) => b(i + 1, `Mark ${i + 1}`)).join('')}</div>`;
}

/** 自分の手番か（開いている間に回ってきたら知らせる。持ち時間は止まらない） */
function myTurn() {
  const v = table.currentView(), h = v && v.hand;
  return !!(h && v.status === 'running' && h.phase === 'betting' && h.toAct === v.seat);
}
/** 席 s のプレイヤーを開く */
export function openPlayer(s) {
  const v = table.currentView(); if (!v || v.lobby || !v.names[s]) return;
  flush();
  if (P) clearInterval(P.timer);
  const self = s === v.seat, name = v.names[s];
  P = { name, self, mode: v.config.mode, roomId: table.activeId(), saveT: 0, timer: 0 };
  const note = self ? null : noteOf(name);
  $('#playerBody').innerHTML = `<div class="gd-head">${head(`PLAYER ・ ${esc(modeLabel(P.mode))}`, `<i class="gem pd-gem${self ? ' me' : ` mk${note.mark}`}"></i><span class="pd-nm">${self ? 'YOU' : esc(name)}</span><button class="pd-turn" id="pdTurn" type="button" hidden><i></i>YOUR TURN</button>`, 'pd-h')}</div>
    <div class="gd-scroll pd-body" id="pdScroll" tabindex="-1">
      <div id="pdStats">${statsHTML(null)}</div>
      <div id="pdNow">${nowHTML(null)}</div>
      ${self ? '' : `<div class="pd-note">${marksHTML(note.mark)}
        <textarea class="pd-memo" id="pdMemo" rows="3" maxlength="${NOTE_MAX}" placeholder="Memo" aria-label="Memo" autocomplete="off" spellcheck="false">${esc(note.text)}</textarea></div>`}
    </div>`;
  if (!self) {
    const p = P, memo = $('#pdMemo');
    $('#playerBody').querySelector('.pd-marks').onclick = e => {
      const b = e.target.closest('[data-mk]'); if (!b || P !== p) return;
      const mk = +b.dataset.mk;
      setNote(p.name, { mark: mk });
      $('#playerBody').querySelectorAll('[data-mk]').forEach(x => x.setAttribute('aria-pressed', String(+x.dataset.mk === mk)));
      $('#playerBody').querySelector('.pd-gem').className = `gem pd-gem mk${mk}`;
    };
    memo.addEventListener('input', () => { clearTimeout(p.saveT); p.saveT = setTimeout(() => save(p), 400); });
    memo.addEventListener('focus', place); memo.addEventListener('blur', () => { save(p); setTimeout(place, 0); table.refit(); });
  }
  const turn = $('#pdTurn'), syncTurn = () => { const on = myTurn(); if (turn.hidden === on) turn.hidden = !on; };
  turn.onclick = () => close();
  syncTurn(); P.timer = setInterval(syncTurn, 300);
  const d = dlg(); d.classList.remove('pd-kb'); d.style.marginTop = '';   // 前にキーボードで上へ寄せたまま閉じていた
  openDlg('#playerDlg');
  $('#pdScroll').focus({ preventScroll: true });
  load(P);
}
function save(p) {
  clearTimeout(p.saveT);
  const m = $('#pdMemo');
  if (m && P === p) setNote(p.name, { text: m.value });
}
/** 書きかけのメモを保存する（閉じる・別の人を開くとき） */
function flush() { if (P && !P.self) save(P); }

async function load(p) {
  const cur = () => P === p && dlg().open;
  // この試合：手元の分ですぐ数え、サーバーから写し終えたら数え直す
  const v = table.currentView(), g = { roomId: p.roomId, seat: v ? v.seat : null, names: v ? v.names : [] };
  let hs = [];
  const nowOf = () => playerStats([g], () => hs, p.self ? null : p.name);
  try { hs = await store.handsOf(p.roomId); } catch (e) { /* IndexedDB が使えない */ }
  if (!cur()) return;
  $('#pdNow').innerHTML = nowHTML(nowOf());
  // このモードの終わった試合（相手はその人が居た試合だけ）
  let st = { hands: 0, vpip: { n: 0, d: 0 }, pfr: { n: 0, d: 0 }, games: 0, survival: null };
  try {
    const who = p.self ? null : p.name;
    const games = byMode(finishedGames(await store.allGames()), p.mode).filter(g => seatIn(g, who) >= 0);
    if (!cur()) return;
    // 自分は（そのモードの）全試合なので 1 回でまとめて読む。相手は一緒に打った試合だけを並べて読む
    const hands = p.self ? await store.handsByRoom() : new Map(await Promise.all(games.map(async g => [g.roomId, await store.handsOf(g.roomId)])));
    if (!cur()) return;
    st = playerStats(games, id => hands.get(id), who);
  } catch (e) { /* 同上 */ }
  if (!cur()) return;
  $('#pdStats').innerHTML = statsHTML(st);
  await syncRoom(p.roomId);
  try { hs = await store.handsOf(p.roomId); } catch (e) { return; }
  if (cur()) $('#pdNow').innerHTML = nowHTML(nowOf());
}

// スマホでメモを書く間：キーボードの上に見える範囲の上端へ寄せる（真ん中のままだと下半分がキーボードに隠れる）
function place() {
  const d = dlg(), vv = window.visualViewport;
  if (!d.open) return;
  const on = vv && document.activeElement === $('#pdMemo') && window.innerHeight - vv.height > 100;
  d.classList.toggle('pd-kb', !!on);
  d.style.marginTop = on ? Math.round(vv.offsetTop + 8) + 'px' : '';
  if (on) $('#pdMemo').scrollIntoView({ block: 'nearest' });
}

export function close() { const d = dlg(); if (d && d.open) d.close(); }

export function init() {
  // 席を押す（チャットの入力欄が開いていたら、その一押しは入力欄を閉じるだけ）
  let composer = false;
  addEventListener('pointerdown', () => { composer = chat.composerOpen(); }, true);
  const seats = $('#seats');
  // 指・マウスでは席にフォーカスを移さない（Tab のときだけ。フォーカスが残ると PC の Enter＝チャットを開くが効かない）
  seats.addEventListener('mousedown', e => { if (e.target.closest('.seat')) e.preventDefault(); });
  seats.addEventListener('click', e => {
    const s = e.target.closest('.seat'); if (!s || composer) return;
    if (e.target.closest('.stk')) return table.toggleUnit();   // スタックを押す：BB / チップ数の切り替え（全員の席）
    openPlayer(+s.dataset.seat);
  });
  seats.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const s = e.target.closest('.seat'); if (!s || e.target !== s) return;
    e.preventDefault(); openPlayer(+s.dataset.seat);
  });
  // 閉じる動きの途中で位置を戻すと跳ねるので、margin は次に開くときに戻す
  dlg().addEventListener('close', () => { flush(); if (P) clearInterval(P.timer); P = null; });
  if (window.visualViewport) { visualViewport.addEventListener('resize', place); visualViewport.addEventListener('scroll', place); }
}
