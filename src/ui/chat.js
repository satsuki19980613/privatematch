// 卓のチャット（PRIVATE MATCH の卓だけ）：差分読み・送信・未読、入力欄（ドックの位置に入れ替わる）、吹き出し（発言した人の席の真上）。
// table.js から start / stop / onPoll / onView を呼ぶ。fitTable は入力ボタンを fitLane / fitsLane で衝突判定に入れる。
// ヘッダの履歴ボタン（#chatLogBtn）とモーダルは ingame.js（chatEnabled / messages / subscribe / unread / markRead を使う）。
import { $, app, esc, toast, REDUCE, EASE } from './util.js';
import { settleSoon, snapshot } from './viewport.js';
import { CHAT_MAX_UNITS, CHAT_MIN_INTERVAL_MS, chatUnits, clipChat, normalizeChat } from '../chat.js';

const S = {
  room: null, v: null, on: false, token: 0,
  seq: 0,            // ここまで読んだ（room_chat の p_after）
  seen: new Set(),   // 知っている seq（自分の送信の返り値も含む）
  loaded: false, loading: false, again: false,
  msgs: [],          // { seq, seat, text, at, local? } 古い順
  unread: 0, lastSent: 0, sending: false,
};
const subs = new Set();
const notify = () => subs.forEach(f => { try { f(); } catch (e) { /* 購読側の失敗は無視 */ } });

/* ===================== 公開 API（ingame.js が使う） ===================== */
export function chatEnabled() { return S.on; }
export function messages() {
  const v = S.v;
  return S.msgs.map(m => ({ seq: m.seq, seat: m.seat, name: v ? (v.names[m.seat] ?? '') : '', text: m.text, at: m.at, mine: !!v && m.seat === v.seat, tone: toneOf(m.seat) }));
}
export function subscribe(fn) { subs.add(fn); return () => subs.delete(fn); }
export function unread() { return S.unread; }
export function markRead() { if (S.unread) { S.unread = 0; notify(); } }
export function openComposer() {
  if (!S.on) return;
  const cz = composer(); if (!cz) return;
  if (!isOpen()) {
    cz.hidden = false; $('#dock').classList.add('cz');
    $('#chatBtn')?.setAttribute('aria-pressed', 'true');
    if (!REDUCE) cz.animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 260, easing: EASE });
    syncTurn(); syncLeft();
  }
  const i = $('#chatIn');
  if (document.activeElement !== i) snapshot();
  try { i.focus({ preventScroll: true }); } catch (e) { i.focus(); }
}

/* ===================== table.js からのフック ===================== */
export function start(roomId) {
  stop();
  S.room = roomId; S.token++;
  ensureComposer();
}
export function stop() {
  closeComposer(true);
  S.token++;
  Object.assign(S, { room: null, v: null, on: false, seq: 0, loaded: false, loading: false, again: false, msgs: [], unread: 0, lastSent: 0, sending: false });
  S.seen = new Set();
  clearBubbles();
  setOn(false);
  notify();
}
/** room_poll の応答ごと（seq = 部屋の最新の発言番号） */
export function onPoll(seq) {
  if (!S.on || !S.loaded || seq == null) return;
  if (+seq > S.seq) pull(false);
}
/** ビューの適用ごと */
export function onView(v) {
  if (!S.room || !v) return;
  S.v = v;
  const on = !!(v.room && v.room.kind === 'private');
  if (on !== S.on) { setOn(on); notify(); }
  if (on && !S.loaded && !S.loading) pull(true);
  syncTurn();
}

/* ===================== 取得・送信 ===================== */
async function pull(silent) {
  if (S.loading) { S.again = true; return; }
  const tk = S.token; S.loading = true;
  try {
    const list = await app.net.rpc('room_chat', { p_room: S.room, p_after: S.seq });
    if (tk !== S.token) return;
    const fresh = [];
    for (const m of Array.isArray(list) ? list : []) {
      if (m.seq > S.seq) S.seq = m.seq;
      if (S.seen.has(m.seq)) continue;
      S.seen.add(m.seq);
      // 自分の送信が返り値より先に読めた：楽観的に出した吹き出しをそのまま使う
      const mine = S.v && m.seat === S.v.seat && S.msgs.find(x => x.local && x.seq == null && x.text === m.text);
      if (mine) { mine.seq = m.seq; mine.at = m.at; continue; }
      const msg = { seq: m.seq, seat: m.seat, text: m.text, at: m.at };
      S.msgs.push(msg); fresh.push(msg);
    }
    S.msgs.sort((a, b) => (a.seq ?? Infinity) - (b.seq ?? Infinity));
    if (fresh.length) {
      if (silent || !S.loaded) { /* 入室時の履歴：既読扱い・吹き出しにしない */ }
      else {
        S.unread += fresh.filter(m => !S.v || m.seat !== S.v.seat).length;
        fresh.slice(-5).forEach(m => bubble(m));
      }
      notify();
    }
    S.loaded = true;
  } catch (e) {
    if (tk !== S.token) return;
    S.loaded = true;   // 読めなかった分は次の poll で
  } finally {
    if (tk === S.token) {
      S.loading = false;
      if (S.again) { S.again = false; pull(false); }
    }
  }
}

async function send() {
  const i = $('#chatIn'); if (!i || !S.on || S.sending) return;
  const text = normalizeChat(i.value);
  if (!text) { i.value = ''; syncLeft(); return; }
  const wait = S.lastSent + CHAT_MIN_INTERVAL_MS - Date.now();
  if (wait > 0) { S.sending = true; syncLeft(); setTimeout(() => { S.sending = false; send(); }, wait + 30); return; }
  const tk = S.token, v = S.v;
  const local = { seq: null, seat: v.seat, text, at: Date.now(), local: true };
  S.msgs.push(local); S.lastSent = Date.now();
  i.value = ''; syncLeft();
  const b = bubble(local); notify();
  if (coarse()) closeComposer();
  try {
    const r = await app.net.game({ op: 'chat', room: S.room, text });
    if (tk !== S.token) return;
    const m = r && r.msg;
    if (m && local.seq == null) { local.seq = m.seq; local.at = m.at; local.text = m.text; S.seen.add(m.seq); }
    S.msgs.sort((a, b2) => (a.seq ?? Infinity) - (b2.seq ?? Infinity));
    notify();
  } catch (e) {
    if (tk !== S.token) return;
    S.msgs = S.msgs.filter(x => x !== local); notify();
    if (b) retire(b, true);
    const ii = $('#chatIn'); if (ii && !ii.value) { ii.value = text; syncLeft(); }
    const c = e && e.code;
    if (c === 'too_fast') { S.lastSent = Date.now(); toast('少し待ってから'); }
    else toast(c === 'chat_closed' ? 'チャットは使えません' : c === 'malformed' ? '送れない文字があります' : c === 'chat_full' ? 'チャットの上限です' : '送信できませんでした');
  }
}

/* ===================== 有効 / 無効 ===================== */
function setOn(on) {
  S.on = on;
  document.body.classList.toggle('chat', on);
  const L = layer(), btn = $('#chatBtn');
  if (L) L.hidden = !on;
  if (btn) btn.hidden = !on;
  if (!on) closeComposer(true);
}

/* ===================== 入力欄（ドックの位置に入れ替わる） ===================== */
const SEND_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="miter" aria-hidden="true"><path d="M4 12h14M13 6l6 6-6 6"/></svg>';
const composer = () => $('#composer');
const isOpen = () => { const c = composer(); return !!c && !c.hidden; };
const coarse = () => matchMedia('(pointer:coarse)').matches;
let composing = false;

function ensureComposer() {
  const dock = $('#dock'); if (!dock || $('#composer')) return;
  const cz = document.createElement('div');
  cz.className = 'composer'; cz.id = 'composer'; cz.hidden = true;
  cz.innerHTML = `<div class="cz-top"><button class="cz-turn" id="czTurn" type="button" hidden><i></i>YOUR TURN</button><span class="cz-left" id="czLeft"></span><button class="cz-x" id="czX" type="button" aria-label="Close"></button></div>
    <div class="cz-row"><input class="cz-in" id="chatIn" type="text" inputmode="text" enterkeyhint="send" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" aria-label="Chat message"><button class="cz-send" id="czSend" type="button" aria-label="Send">${SEND_SVG}</button></div>`;
  dock.appendChild(cz);
  const i = cz.querySelector('#chatIn');
  // ボタンを押しても入力欄のフォーカスを外さない（外れると閉じてしまう）
  cz.querySelectorAll('button').forEach(b => b.addEventListener('pointerdown', e => e.preventDefault()));
  cz.querySelector('#czSend').onclick = () => send();
  cz.querySelector('#czTurn').onclick = () => closeComposer();
  cz.querySelector('#czX').onclick = () => closeComposer();
  i.addEventListener('compositionstart', () => { composing = true; });
  i.addEventListener('compositionend', () => { composing = false; clipInput(); });
  i.addEventListener('input', () => { if (!composing) clipInput(); syncLeft(); });
  i.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (e.isComposing || e.keyCode === 229 || composing) return;   // IME の変換の取り消し
      e.preventDefault(); e.stopPropagation(); closeComposer(); return;
    }
    if (e.key === 'Enter') {
      if (e.isComposing || e.keyCode === 229 || composing) return;   // IME の確定は送信しない
      e.preventDefault(); send();
    }
  });
  i.addEventListener('blur', () => { setTimeout(() => { if (isOpen() && document.activeElement !== i && !document.hidden) closeComposer(); }, 0); });
}
function clipInput() {
  const i = $('#chatIn'); if (!i) return;
  if (chatUnits(i.value) > CHAT_MAX_UNITS) { i.value = clipChat(i.value); try { i.setSelectionRange(i.value.length, i.value.length); } catch (e) { /* */ } }
  syncLeft();
}
function syncLeft() {
  const el = $('#czLeft'), i = $('#chatIn'); if (!el || !i) return;
  const left = CHAT_MAX_UNITS - chatUnits(i.value);
  el.textContent = String(Math.max(0, left));   // IME の変換中は切らないので一時的に超えることがある
  el.classList.toggle('low', left <= 6);
  const send = $('#czSend'); if (send) send.disabled = S.sending || !normalizeChat(i.value);
}
function syncTurn() {
  const b = $('#czTurn'); if (!b) return;
  const v = S.v, h = v && v.hand;
  const mine = !!(v && h && v.status === 'running' && h.phase === 'betting' && h.toAct === v.seat);
  if (b.hidden === mine) b.hidden = !mine;
}
function closeComposer(silent) {
  const cz = composer(); if (!cz || cz.hidden) return;
  const i = $('#chatIn');
  cz.hidden = true; $('#dock').classList.remove('cz');
  $('#chatBtn')?.setAttribute('aria-pressed', 'false');
  if (i && document.activeElement === i) i.blur();
  settleSoon();
  if (!silent && !REDUCE) { const m = $('#dockMain'); if (m) m.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: EASE }); }
}
export const composerOpen = isOpen;

// 外側を押したら閉じる（入力欄・入力ボタンの上は除く）
document.addEventListener('pointerdown', e => {
  if (!isOpen()) return;
  if (e.target.closest('#composer') || e.target.closest('#chatBtn')) return;
  closeComposer();
}, true);
// PC：卓で何もフォーカスしていないときの Enter で入力欄を開く
document.addEventListener('keydown', e => {
  if (e.key !== 'Enter' || !S.on || isOpen() || e.isComposing) return;
  const a = document.activeElement;
  if (a && a !== document.body) return;
  if (document.querySelector('dialog[open]') || document.body.dataset.screen !== 'game') return;
  e.preventDefault(); openComposer();
});
{
  const b = document.getElementById('chatBtn');
  if (b) {
    b.addEventListener('pointerdown', e => { if (isOpen()) e.preventDefault(); });
    b.addEventListener('click', () => { if (isOpen()) closeComposer(); else openComposer(); });
  }
}

/* ===================== 吹き出し（発言した人の席の真上） ===================== */
// 吹き出しは #chatBubbles（#stage を覆う層。卓の配置には関わらない）に置き、動いている間は毎フレーム、その席の札（無ければプレート）の
// 真上に合わせる。卓がキーボードで縮小表示になっても文字の大きさは変わらない。1 席に 1 つ（同じ人の次の発言は前のものと入れ替わる）
const live = [];   // { el, seat, timer, gone }
const nameOf = m => (S.v && m.seat === S.v.seat ? 'YOU' : (S.v && S.v.names[m.seat]) || '');
const dwell = text => Math.max(3500, Math.min(7000, 3000 + chatUnits(text) * 100));
const layer = () => $('#chatBubbles');
/** 席の色：YOU と、自分から見た席の順（1 = 左隣 … 5）。吹き出し・履歴・席の合図で同じ色を使う */
export function toneOf(seat) {
  const v = S.v; if (!v) return 'p1';
  return seat === v.seat ? 'you' : 'p' + (((seat - v.seat) % v.n + v.n) % v.n);
}

function bubble(m) {
  const L = layer(); if (!L || L.hidden || !S.v) return null;
  for (const x of live) if (!x.gone && x.seat === m.seat) retire(x, true);
  const el = document.createElement('div');
  el.className = 'cb t-' + toneOf(m.seat);
  el.innerHTML = `<div class="cb-in"><b class="cb-n">${esc(nameOf(m))}</b><span class="cb-t">${esc(m.text)}</span></div>`;
  L.appendChild(el);
  const b = { el, seat: m.seat, timer: 0, gone: false };
  live.push(b);
  place(b); kick();
  if (REDUCE) el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 240, easing: 'linear' });
  else el.animate([{ opacity: 0, transform: 'translateY(8px) scale(.94)', filter: 'blur(6px)' }, { opacity: 1, transform: 'none', filter: 'blur(0)' }],
    { duration: 480, easing: 'cubic-bezier(.16,.84,.3,1)' });
  b.timer = setTimeout(() => retire(b), dwell(m.text));
  ping(m.seat);
  return b;
}
// 席の札とプレートを合わせた箱（画面の座標。卓の縮小表示の変形も込み）と、プレートの幅
const rect = e => { if (!e) return null; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 ? r : null; };
function anchorOf(seat) {
  const s = document.getElementById('seat' + seat); if (!s) return null;
  const h = rect(s.querySelector('.hole .card') && s.querySelector('.hole')), p = rect(s.querySelector('.sp'));
  if (!h && !p) return null;
  const pw = p ? p.width : h.width;
  if (!h || !p) { const r = h || p; return { left: r.left, right: r.right, top: r.top, pw }; }
  return { left: Math.min(h.left, p.left), right: Math.max(h.right, p.right), top: Math.min(h.top, p.top), pw };
}
// よけたいもの：ほかの席（札・プレート・ベット・ディーラーボタン）とポット・ボード
function obstacles(seat) {
  const out = [];
  document.querySelectorAll('#seats .seat').forEach(s => {
    if (s.id === 'seat' + seat) return;
    for (const c of s.children) { const r = rect(c); if (r) out.push(r); }
  });
  for (const id of ['pot', 'boardC']) { const r = rect(document.getElementById(id)); if (r) out.push(r); }
  return out;
}
const M = 4, TAIL = 7;
function place(b, placed) {
  const L = layer(), a = anchorOf(b.seat), el = b.el;
  if (!L || !a) { el.style.visibility = 'hidden'; return; }
  // 幅はその席のプレートくらいまで（隣の席の上に広がらない。長い文は 3 行まで折り返す）。
  // 上に余白が足りない席（上の段など）は画面の幅まで広げて行を減らす（一度広げたらその吹き出しの間はそのまま）
  const R = L.getBoundingClientRect(), room = a.top - R.top - TAIL - 2 - M;
  const fitCap = () => { const cap = Math.round(b.wide ? R.width - 2 * M : Math.max(a.pw * 1.15, 104, b.seat === (S.v && S.v.seat) && !b.narrow ? Math.min(R.width * .62, 260) : 0));
    if (Math.abs((b.cap || 0) - cap) > 1) { b.cap = cap; el.style.setProperty('--cbw', cap + 'px'); } };
  fitCap();
  if (!b.wide && el.offsetHeight > room) { b.wide = true; fitCap(); }
  const w = el.offsetWidth, h = el.offsetHeight;
  const cx = (a.left + a.right) / 2 - R.left;
  const y = Math.round(Math.max(M, a.top - R.top - h - TAIL - 2));
  // 横の位置：しっぽが席を指せる範囲で、ほかの物との重なりが一番少ないところ（同じなら真ん中に近いところ）
  const lo = Math.max(M, cx - w + 14), hi = Math.min(R.width - M - w, cx - 14), mid = Math.max(M, Math.min(R.width - M - w, cx - w / 2));
  let x = mid;
  if (hi > lo) {
    // ほかの吹き出しとの重なりは席の物より重く見る
    const obs = obstacles(b.seat).map(r => ({ l: r.left - R.left, r: r.right - R.left, t: r.top - R.top, b: r.bottom - R.top, k: 1 }))
      .concat(placed || []).filter(o => o.b > y && o.t < y + h + TAIL);
    if (obs.length) {
      const cost = X => obs.reduce((sum, o) => sum + o.k * Math.max(0, Math.min(o.r, X + w) - Math.max(o.l, X)) * Math.max(0, Math.min(o.b, y + h + TAIL) - Math.max(o.t, y)), 0);
      let best = cost(mid);
      if (best > 0) for (let X = lo; X <= hi; X += 4) { const c = cost(X); if (c < best - 1 || (Math.abs(c - best) <= 1 && Math.abs(X - mid) < Math.abs(x - mid))) { best = c; x = X; } }
      // 自分の吹き出しは広めにしてあるので、それでもぶつかるなら席の幅まで細くする（以後そのまま）
      if (best > 0 && !b.narrow && !b.wide && b.seat === (S.v && S.v.seat)) { b.narrow = true; return place(b, placed); }
    }
  }
  x = Math.round(x);
  el.style.visibility = '';
  el.style.translate = `${x}px ${y}px`;
  el.style.setProperty('--tx', Math.round(Math.max(10, Math.min(w - 10, cx - x))) + 'px');
  if (placed && !b.gone) placed.push({ l: x, r: x + w, t: y, b: y + h + TAIL, k: 4 });
}
// 吹き出しがある間だけ毎フレーム席に合わせる（キーボードでの縮小・配り直し・向きの変化にそのまま付いていく）
let raf = 0;
function loop() { raf = 0; if (!live.length) return; const placed = []; for (const b of live) place(b, placed); raf = requestAnimationFrame(loop); }
const kick = () => { if (!raf && live.length) raf = requestAnimationFrame(loop); };
function retire(b, quick) {
  if (!b || b.gone) return;
  clearTimeout(b.timer);
  b.gone = true;
  const el = b.el; el.classList.add('gone');
  const done = () => { el.remove(); const k = live.indexOf(b); if (k >= 0) live.splice(k, 1); };
  const a = REDUCE || quick
    ? el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: quick ? 160 : 300, fill: 'forwards' })
    : el.animate([{ opacity: 1, transform: 'none', filter: 'blur(0)' }, { opacity: 0, transform: 'translateY(-8px) scale(.98)', filter: 'blur(4px)' }],
      { duration: 620, easing: 'cubic-bezier(.4,0,.6,1)', fill: 'forwards' });
  a.onfinish = done; setTimeout(done, 1000);
}
function clearBubbles() {
  for (const b of live) clearTimeout(b.timer);
  live.length = 0;
  cancelAnimationFrame(raf); raf = 0;
  const L = layer(); if (L) L.innerHTML = '';
}
// 送信者の席のプレートの縁を、その人の色で一瞬光らせる
function ping(seat) {
  const s = document.getElementById('seat' + seat); if (!s || REDUCE) return;
  s.classList.remove('cping', ...[...s.classList].filter(c => c.startsWith('t-'))); void s.offsetWidth;
  s.classList.add('cping', 't-' + toneOf(seat));
  clearTimeout(s._cpT); s._cpT = setTimeout(() => s.classList.remove('cping'), 1500);
}

/* ===================== fitTable との連携 ===================== */
/** 測る間だけ、席のベットチップの入場アニメ（translateY・scale）を終わりの位置に置く（transform 込みの矩形で判定しないため） */
export function settle(fn) {
  if (!S.on) return fn();
  const run = [];
  for (const e of document.querySelectorAll('#seats .bchip')) for (const a of e.getAnimations()) {
    const end = a.effect && a.effect.getComputedTiming().endTime;
    if (a.playState === 'running' && end != null && isFinite(end)) { run.push([a, a.currentTime]); a.currentTime = end - 1; }
  }
  try { return fn(); } finally { for (const [a, t] of run) { try { a.currentTime = t; } catch (e) { /* 終わっていた */ } } }
}
/** fitTable の二分探索を包む（入力ボタンの置き場所を決めてから測る） */
export function fitLane(key, search) {
  placeBtn();   // 向きで置き場所（卓の中 / 右の列）が変わる
  return S.on ? settle(search) : search();
}
/** fits() の追加の判定：卓の中の入力ボタンが卓からはみ出さず、どの席・真ん中・ベットとも重ならない */
export function fitsLane(T0, G, rectOf, hit) {
  if (!S.on) return true;
  const btn = $('#chatBtn'), B = btn && btn.parentNode === $('#table') ? rectOf(btn) : null;   // 横向きは右の列（卓の外）
  if (!B) return true;
  if (B.l < T0.left - 1 || B.r > T0.right + 1 || B.t < T0.top - 1 || B.b > T0.bottom + 1) return false;
  for (const g of G.flat()) if (hit(B, g, 4)) return false;
  return true;
}
/** 配置が変わったあと */
export function afterFit() { placeBtn(); kick(); }

// 入力ボタンの場所：縦向き・PC は卓の左下（#table の中。fits() が席と重ならないことを保証する）。
// 横向き（body.land）は右の列でドックのすぐ下（入らなければすぐ上。どちらも無理なら隠す）。tinfo・ドック・ヘッダとは重ならない
function placeBtn() {
  const btn = $('#chatBtn'), tb = $('#table'), st = $('#stage'), dock = $('#dock'); if (!btn || !tb || !st || !dock) return;
  const land = document.body.classList.contains('land') && document.body.dataset.screen === 'game';
  if (!land) {
    if (btn.parentNode !== tb) { tb.appendChild(btn); btn.classList.remove('side'); btn.style.left = btn.style.top = btn.style.visibility = ''; }
    return;
  }
  if (btn.parentNode !== st) { st.appendChild(btn); btn.classList.add('side'); }
  if (btn.hidden) return;
  const S0 = st.getBoundingClientRect(), D = dock.getBoundingClientRect(), I = $('#tInfo').getBoundingClientRect(), hd = document.querySelector('.top');
  const H = hd ? hd.getBoundingClientRect() : null, s = btn.offsetHeight, gap = 8;
  const above = Math.max(I.height ? I.bottom : 0, H ? H.bottom : 0);
  let top = D.bottom + gap;
  if (top + s > S0.bottom - 2) top = D.top - gap - s <= above + 4 ? null : D.top - gap - s;
  btn.style.visibility = top == null ? 'hidden' : '';
  if (top == null) return;
  btn.style.left = Math.round(D.left - S0.left) + 'px';
  btn.style.top = Math.round(top - S0.top) + 'px';
}
// 横向きではドックの大きさ・位置が変わるたびに追従する（キーボードでの縮小の途中も）
if (window.ResizeObserver) {
  const ro = new ResizeObserver(() => { if (document.body.classList.contains('land')) placeBtn(); });
  for (const id of ['stage', 'dock']) { const e = document.getElementById(id); if (e) ro.observe(e); }
}

if (import.meta.env && import.meta.env.DEV) window.__chat = { S, live, bubble: m => bubble(m) };
