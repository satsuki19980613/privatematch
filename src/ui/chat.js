// 卓のチャット（PRIVATE MATCH の卓だけ）：差分読み・送信・未読、入力欄（ドックの位置に入れ替わる）、吹き出し（発言した人の席の真上）。
// table.js から start / stop / onPoll / onView を呼ぶ。fitTable は入力ボタンを fitLane / fitsLane で衝突判定に入れる。
// ヘッダの履歴ボタン（#chatLogBtn）とモーダルは ingame.js（chatEnabled / messages / subscribe / unread / markRead を使う）。
import { $, app, esc, toast, REDUCE, EASE } from './util.js';
import { settleSoon, snapshot, expectKeyboard } from './viewport.js';
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
  const i = $('#chatIn'), was = document.activeElement === i;
  if (!was) snapshot();
  try { i.focus({ preventScroll: true }); } catch (e) { i.focus(); }
  if (!was) expectKeyboard(true);   // 卓の縮小をキーボードと同時に始める（2 回目から。viewport.js）
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
  // 続けて打てるように、送っても入力欄とキーボードはそのまま（閉じるのは入力ボタン・×・外側を押したとき）
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
  expectKeyboard(false);   // 戻す動きもキーボードが下がるのと同時に
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
  el.innerHTML = `<div class="cb-in"><b class="cb-n">${esc(nameOf(m))}</b><span class="cb-t"><i>${esc(m.text)}</i></span></div>`;
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
  const pw = p ? p.width : h.width, hh = h && p && h.bottom <= p.top + 2 ? h.height : 0;   // 札の高さ（札がプレートの上にあるとき）
  const c = h || p;   // 横に置くときにしっぽで指す高さ（札。無ければプレート）
  // 横に置くときの的：札（無ければプレート）と、プレート（札の横に空きが無いとき）
  const side = { cl: c.left, cr: c.right, cy: (c.top + c.bottom) / 2, sides: [c, p].filter((r, i, a) => r && a.indexOf(r) === i).map(r => ({ l: r.left, r: r.right, t: r.top, b: r.bottom, cy: (r.top + r.bottom) / 2 })) };
  if (!h || !p) return { left: c.left, right: c.right, top: c.top, bottom: c.bottom, ...side, pw, hh };
  return { left: Math.min(h.left, p.left), right: Math.max(h.right, p.right), top: Math.min(h.top, p.top), bottom: Math.max(h.bottom, p.bottom), ...side, pw, hh };
}
// よけたいもの（重み）：ほかの席の札・ベット・ディーラーボタン（1）とプレート（名前とスタック。2）、ポット・ボード（1）、ドック（6）。
// 発言した人自身の席は、ベット（1）・表になった札（1.5）・プレート（.05。ほかの席にかぶるよりは本人のプレートにかぶせる）。伏せた札にはかぶせてよい
function obstacles(seat) {
  const out = [];
  document.querySelectorAll('#seats .seat').forEach(s => {
    const own = s.id === 'seat' + seat;
    for (const c of s.children) {
      const r = rect(c); if (!r) continue;
      const sp = c.classList.contains('sp');
      if (!own) out.push([r, sp ? 2 : 1]);
      else if (sp) out.push([r, .05]);
      else if (c.classList.contains('bchip')) out.push([r, 1]);
      else if (c.classList.contains('hole') && c.querySelector('.card:not(.back)')) out.push([r, 1.5]);
    }
  });
  for (const id of ['pot', 'boardC']) { const r = rect(document.getElementById(id)); if (r) out.push([r, 1]); }
  const d = rect($('#dock')); if (d) out.push([d, 6]);
  const cb = $('#chatBtn'), r = cb && !cb.hidden && cb.style.visibility !== 'hidden' ? rect(cb) : null; if (r) out.push([r, 2]);
  return out;
}
const M = 4, TAIL = 7;
// 吹き出しの形の候補（幅 × 文字の大きさ）を測っておく。標準・細め・横長と、それぞれ少し小さい文字（11px まで）
function shapes(b, a, R, BL, BR) {
  const el = b.el, mine = b.seat === (S.v && S.v.seat);
  const prev = el.style.fontSize; el.style.fontSize = '';
  const fs = parseFloat(getComputedStyle(el).fontSize) || 13; el.style.fontSize = prev;
  const small = Math.max(11, Math.round(fs * .86 * 10) / 10);
  // 札の横の空き（横に置く細い形の幅）
  const gap = Math.round(Math.max(a.cl - R.left - BL, BR - (a.cr - R.left)) - TAIL - 4);
  const key = [Math.round(a.pw), Math.round(R.width), fs, BL, BR, gap >> 3].join('|');
  if (b.key === key && b.shapes) return b.shapes;
  const room = BR - BL, caps = [
    [Math.max(a.pw * 1.15, 104, mine ? Math.min(R.width * .62, 260) : 0), 0],
    [Math.max(a.pw * .95, 120), 300],
    [Math.max(a.pw * 1.6, 170), 300],
  ];
  const out = [];
  for (const f of small < fs - .4 ? [fs, small] : [fs]) for (const [c, pen] of caps) {
    const cap = Math.round(Math.min(room, c));
    if (out.some(o => o.cap === cap && o.fs === f)) continue;
    el.style.setProperty('--cbw', cap + 'px'); el.style.fontSize = f === fs ? '' : f + 'px';
    const cin = el.querySelector('.cb-in');
    if (cin.scrollHeight > cin.clientHeight + 1) continue;   // 4 行に収まらない（切れる）形は使わない
    out.push({ cap, fs: f, w: el.offsetWidth, h: el.offsetHeight, pen: pen + (f === fs ? 0 : 600) });
  }
  // 札の横の狭い空きに入る細い形（小さい文字。4 行に収まるときだけ）
  if (gap >= 90 && gap < Math.min(...out.map(o => o.cap))) {
    const cap = Math.round(gap), f = small, cin = el.querySelector('.cb-in');
    el.style.setProperty('--cbw', cap + 'px'); el.style.fontSize = f + 'px';
    if (cin.scrollHeight <= cin.clientHeight + 1) out.push({ cap, fs: f, w: el.offsetWidth, h: el.offsetHeight, pen: 1000 });
  }
  // 最後の手段：1 行の帯（長い文は横に流して全部読ませる）。とても狭い卓（小さい画面の 5〜6 人・キーボードで縮小表示）用
  el.classList.add('tk');
  for (const c of [...new Set([Math.round(Math.max(a.pw * .95, 96)), Math.round(Math.max(Math.min(gap, a.pw), 84))])]) {
    const cap = Math.min(room, c);
    el.style.setProperty('--cbw', cap + 'px'); el.style.fontSize = small + 'px';
    out.push({ cap, fs: small, w: el.offsetWidth, h: el.offsetHeight, pen: 1400, tk: true });
  }
  el.classList.remove('tk');
  b.key = key; b.shapes = out; b.cur = null; b.applied = -1;   // 測るときに形を変えたので、選んだ形を付け直させる
  return out;
}
// 帯の文が入りきらなければ、往復で横に流す（読む速さ：1 秒に約 40px。端で少し止まる）
function ticker(el) {
  const box = el.querySelector('.cb-t'), t = box && box.firstElementChild; if (!t) return;
  const over = Math.ceil(t.scrollWidth - box.clientWidth);
  el.style.setProperty('--shift', over > 2 ? -over + 'px' : '0px');
  el.style.setProperty('--tdur', over > 2 ? (2.4 + over / 40).toFixed(2) + 's' : '0s');
  el.classList.toggle('run', over > 2 && !REDUCE);
}
function place(b, placed) {
  const L = layer(), a = anchorOf(b.seat), el = b.el;
  if (!L || !a) { el.style.visibility = 'hidden'; return; }
  const R = L.getBoundingClientRect(), tb = $('#table'), ti = $('#tInfo'), land = document.body.classList.contains('land');
  // 置ける範囲：横向きは卓の列だけ（右の列のドック・情報に出ない）。縦向きは情報の行より下
  const BL = land && tb ? Math.max(M, tb.offsetLeft) : M, BR = land && tb ? Math.min(R.width - M, tb.offsetLeft + tb.offsetWidth) : R.width - M;
  const TOP = !land && ti && ti.offsetHeight ? Math.max(M, ti.offsetTop + ti.offsetHeight + 2) : M, BOT = R.height - M;
  const mine = b.seat === (S.v && S.v.seat), cx = (a.left + a.right) / 2 - R.left, at = a.top - R.top;
  // 2px の余白を取って縁が触れないようにする
  const obs = obstacles(b.seat).map(([r, k]) => ({ l: r.left - R.left - 2, r: r.right - R.left + 2, t: r.top - R.top - 2, b: r.bottom - R.top + 2, k })).concat((placed || []).map(o => ({ ...o, l: o.l - 2, r: o.r + 2, t: o.t - 2, b: o.b + 2 })));
  const area = (X, Y, w, h) => { let c = 0; for (const o of obs) { const dx = Math.min(o.r, X + w) - Math.max(o.l, X); if (dx <= 0) continue; const dy = Math.min(o.b, Y + h) - Math.max(o.t, Y); if (dy > 0) c += o.k * dx * dy; } return c; };
  // 吹き出しとしっぽ（上なら下に、横なら席の側に）の分を合わせた箱で重なりを数える
  const cost = (side, X, Y, w, h) => side === 'up' ? area(X, Y, w, h + TAIL) : side[0] === 'd' ? area(X, Y - TAIL, w, h + TAIL) : side[0] === 'l' ? area(X, Y, w + TAIL, h) : area(X - TAIL, Y, w + TAIL, h);
  const inside = (X, Y, w, h) => X >= BL - .5 && X + w <= BR + .5 && Y >= TOP - .5 && Y + h <= BOT + .5;
  const list = shapes(b, a, R, BL, BR);
  // 候補の位置（形 i ごと）：上（元の位置・少し上へ・相手は札とプレートの上まで下へ）、席の左右（しっぽは横向き）
  const spots = (sh, fn) => {
    const y0 = Math.round(Math.max(TOP, at - sh.h - TAIL - 2));
    const lo = Math.max(BL, cx - sh.w + 14), hi = Math.min(BR - sh.w, cx - 14), mid = Math.max(BL, Math.min(BR - sh.w, cx - sh.w / 2));
    const st = sh.tk ? 2 : 4, sx = sh.tk ? 3 : 5;   // 帯は小さいので細かく探す
    const ys = [y0];
    for (let d = st; d <= 40 && y0 - d >= TOP; d += st) ys.push(y0 - d);
    if (!mine) for (let d = st; d <= a.hh + 34; d += st) ys.push(y0 + d);
    const xs = [mid]; for (let X = lo; X <= hi; X += sx) xs.push(X);
    for (const Y of ys) for (const X of xs) fn('up', X, Y, (Y < y0 ? (y0 - Y) * 10 : (Y - y0) * 8) + Math.abs(X - mid) * .5);
    // 横：札の横（無理ならプレートの横）。しっぽの高さ（的の真ん中）が吹き出しの縦の範囲に入るように、上下にずらしながら
    a.sides.forEach((t, k) => {
      const tl = t.l - R.left, tr = t.r - R.left, ty = t.cy - R.top, ty0 = Math.round(ty - sh.h / 2);
      for (const side of ['l', 'r']) for (let g = 0; g <= 24; g += 6) {
        const X = side === 'l' ? Math.round(tl - TAIL - 2 - g - sh.w) : Math.round(tr + TAIL + 2 + g);
        for (let d = 0; d <= sh.h / 2 - 12; d += 5) for (const Y of d ? [ty0 - d, ty0 + d] : [ty0]) fn(side + k, X, Y, 500 + k * 150 + g * 6 + d * 2);
      }
      // 最後の手段：的の下（しっぽは上向き）。自分の吹き出しは自分の札の下＝自分のプレートの上
      const tcx = (t.l + t.r) / 2 - R.left, tb = t.b - R.top;
      const lo = Math.max(BL, tcx - sh.w + 14), hi = Math.min(BR - sh.w, tcx - 14), md = Math.max(BL, Math.min(BR - sh.w, tcx - sh.w / 2));
      for (let g = 0; g <= 24; g += 6) { const Y = Math.round(tb + TAIL + 2 + g); for (let X = lo; X <= hi; X += 5) fn('d' + k, X, Y, 900 + k * 150 + g * 6 + Math.abs(X - md) * .5); }
    });
  };
  // いまの置き方（席からの相対位置）がまだ何にも重ならなければそのまま（毎フレームの探し直しをしない・ちらつかせない）
  const tgt = side => a.sides[+side[1]] || a.sides[0];
  const base = side => { if (side === 'up') return [cx, at]; const t = tgt(side); return side[0] === 'd' ? [(t.l + t.r) / 2 - R.left, t.b - R.top] : [(side[0] === 'l' ? t.l : t.r) - R.left, t.cy - R.top]; };
  let pick = null;
  if (b.cur && list[b.cur.i]) {
    const sh = list[b.cur.i], [bx, by] = base(b.cur.side), X = bx + b.cur.rx, Y = by + b.cur.ry;
    if ((b.cur.side === 'up' || a.sides[+b.cur.side[1]]) && inside(X, Y, sh.w, sh.h) && cost(b.cur.side, X, Y, sh.w, sh.h) === 0) pick = { ...b.cur, x: X, y: Y };
  }
  if (!pick) {
    let bestScore = Infinity;
    list.forEach((sh, i) => spots(sh, (side, X, Y, pen) => {
      if (!inside(X, Y, sh.w, sh.h)) return;
      const score = cost(side, X, Y, sh.w, sh.h) * 1000 + sh.pen + pen;
      if (score < bestScore) { bestScore = score; pick = { i, side, x: X, y: Y }; }
    }));
    if (pick) { const [bx, by] = base(pick.side); pick.rx = pick.x - bx; pick.ry = pick.y - by; }
  }
  if (!pick) { el.style.visibility = 'hidden'; return; }
  b.cur = pick;
  const sh = list[pick.i];
  if (b.applied !== pick.i) {
    b.applied = pick.i; el.style.setProperty('--cbw', sh.cap + 'px'); el.style.fontSize = sh.fs === list[0].fs ? '' : sh.fs + 'px';
    el.classList.toggle('tk', !!sh.tk);
    if (sh.tk) ticker(el);
  }
  const x = Math.round(pick.x), y = Math.round(pick.y);
  const dir = pick.side[0];
  if (b.side !== dir) { b.side = dir; el.classList.toggle('sl', dir === 'l'); el.classList.toggle('sr', dir === 'r'); el.classList.toggle('sd', dir === 'd'); }
  el.style.visibility = '';
  el.style.translate = `${x}px ${y}px`;
  if (dir === 'd') {
    const [ex, ey] = base(pick.side);
    el.style.setProperty('--tx', Math.round(Math.max(10, Math.min(sh.w - 10, ex - x))) + 'px');
    el.style.setProperty('--stem', Math.max(0, Math.round(y - ey - TAIL - 2)) + 'px');
  } else if (pick.side === 'up') {
    el.style.setProperty('--tx', Math.round(Math.max(10, Math.min(sh.w - 10, cx - x))) + 'px');
    // 上にずらしたときは、しっぽの柄を伸ばして席までつなぐ
    el.style.setProperty('--stem', Math.max(0, Math.round(at - (y + sh.h) - TAIL - 2)) + 'px');
  } else {
    const [ex, ey] = base(pick.side);
    el.style.setProperty('--ty', Math.round(Math.max(10, Math.min(sh.h - 10, ey - y))) + 'px');
    el.style.setProperty('--stem', Math.max(0, Math.round(dir === 'l' ? ex - (x + sh.w) - TAIL - 2 : x - ex - TAIL - 2)) + 'px');
  }
  if (placed && !b.gone) placed.push(pick.side === 'up' ? { l: x, r: x + sh.w, t: y, b: y + sh.h + TAIL, k: 4, b0: b }
    : dir === 'd' ? { l: x, r: x + sh.w, t: y - TAIL, b: y + sh.h, k: 4, b0: b }
    : { l: dir === 'l' ? x : x - TAIL, r: dir === 'l' ? x + sh.w + TAIL : x + sh.w, t: y, b: y + sh.h, k: 4, b0: b });
}
// 吹き出しがある間だけ毎フレーム席に合わせる（キーボードでの縮小・配り直し・向きの変化にそのまま付いていく）。
// それでも吹き出しどうしが重なったまま（0.25 秒）なら、古い方を先に消す（発言は履歴に残っている）
let raf = 0;
function loop() {
  raf = 0; if (!live.length) return;
  const placed = [], now = performance.now();
  for (const b of live) place(b, placed);
  for (let i = 0; i < placed.length; i++) {
    const p = placed[i]; let hit = false;
    for (let j = i + 1; j < placed.length; j++) { const q = placed[j]; if (Math.min(p.r, q.r) - Math.max(p.l, q.l) > 1 && Math.min(p.b, q.b) - Math.max(p.t, q.t) > 1) { hit = true; break; } }
    const b = p.b0;
    if (!hit) b.clash = 0; else if (!b.clash) b.clash = now; else if (now - b.clash > 250) retire(b, true);
  }
  raf = requestAnimationFrame(loop);
}
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
