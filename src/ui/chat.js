// 卓のチャット（PRIVATE MATCH の卓だけ）：差分読み・送信・未読、入力欄（ドックの位置に入れ替わる）、吹き出し（自分の札とボードの間のレーン）。
// table.js から start / stop / onPoll / onView を呼ぶ。fitTable はレーンと入力ボタンを fitLane / fitsLane で衝突判定に入れる。
// ヘッダの履歴ボタン（#chatLogBtn）とモーダルは ingame.js（chatEnabled / messages / subscribe / unread / markRead を使う）。
import { $, app, esc, toast, REDUCE, EASE } from './util.js';
import { settleSoon, snapshot, viewportHooks } from './viewport.js';
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
  return S.msgs.map(m => ({ seq: m.seq, seat: m.seat, name: v ? (v.names[m.seat] ?? '') : '', text: m.text, at: m.at, mine: !!v && m.seat === v.seat }));
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
        fresh.slice(-2).forEach(m => bubble(m));
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
  const lane = $('#chatLane'), btn = $('#chatBtn');
  if (lane) lane.hidden = !on;
  if (btn) btn.hidden = !on;
  if (!on) { closeComposer(true); modeKey = ''; }
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
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeComposer(); return; }
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
  el.textContent = String(left);
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

/* ===================== 吹き出し ===================== */
const live = [];   // { el, m, timer, gone }
const nameOf = m => (S.v && m.seat === S.v.seat ? 'YOU' : (S.v && S.v.names[m.seat]) || '');
const dwell = text => Math.max(3500, Math.min(7000, 3000 + chatUnits(text) * 100));
const active = () => live.filter(b => !b.gone);
const GAP = 4;

function bubble(m) {
  const lane = $('#chatLane'); if (!lane || lane.hidden || !S.v) return null;
  const mine = m.seat === S.v.seat;
  const before = new Map(active().map(b => [b, b.el.offsetTop]));
  const el = document.createElement('div');
  el.className = 'cb ' + (mine ? 'you' : 'op');
  el.innerHTML = `<div class="cb-in"><b class="cb-n">${esc(nameOf(m))}</b><span class="cb-t">${esc(m.text)}</span></div>`;
  lane.appendChild(el);
  const b = { el, m, timer: 0, gone: false };
  live.push(b);
  trim(b, before);
  slide(before);
  if (REDUCE) el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 240, easing: 'linear' });
  else el.animate([{ opacity: 0, transform: 'translateY(6px) scale(.96)', filter: 'blur(6px)' }, { opacity: 1, transform: 'none', filter: 'blur(0)' }],
    { duration: 480, easing: 'cubic-bezier(.16,.84,.3,1)' });
  b.timer = setTimeout(() => retire(b), dwell(m.text));
  ping(m.seat, mine);
  return b;
}
/** レーンに入らない古いものを押し出す（同時に見えるのは最大 2 つ。入らなければ最新 1 つ） */
function trim(keep, before) {
  const lane = $('#chatLane'); if (!lane) return;
  const H = lane.clientHeight - (parseFloat(getComputedStyle(lane).paddingBottom) || 0);
  let act = active();
  const total = () => act.reduce((s, b) => s + b.el.offsetHeight, 0) + GAP * Math.max(0, act.length - 1);
  while (act.length > 1 && (act.length > 2 || total() > H + 1)) {
    const old = act.find(b => b !== keep) || act[0];
    retire(old, false, true, before && before.get(old));
    act = active();
  }
  act.forEach((b, i) => b.el.classList.toggle('old', i < act.length - 1));
}
/** 流れから外れた分、残りの吹き出しを元の位置から滑らかに動かす */
function slide(before) {
  for (const [b, top] of before) {
    if (b.gone) continue;
    const d = top - b.el.offsetTop;
    if (Math.abs(d) > .5 && !REDUCE) b.el.animate([{ transform: `translateY(${d}px)` }, { transform: 'none' }], { duration: 420, easing: EASE, composite: 'add' });
  }
}
function retire(b, quick, pushed, top0) {
  if (!b || b.gone) return;
  const lane = $('#chatLane');
  clearTimeout(b.timer);
  const before = pushed ? null : new Map(active().filter(x => x !== b).map(x => [x, x.el.offsetTop]));
  b.gone = true;
  const el = b.el, top = top0 ?? el.offsetTop;
  // 流れから外して今の位置に残し、薄くしながら少し上へ
  el.style.position = 'absolute'; el.style.top = top + 'px'; el.style.left = '0'; el.style.right = '0';
  el.style.marginInline = 'auto'; el.style.width = 'max-content'; el.style.maxWidth = '100%';
  el.classList.add('gone');
  const done = () => { el.remove(); const k = live.indexOf(b); if (k >= 0) live.splice(k, 1); };
  if (before) slide(before);
  if (lane && !pushed) trim();
  if (REDUCE || quick) { const a = el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: quick ? 160 : 300, fill: 'forwards' }); a.onfinish = done; setTimeout(done, 600); return; }
  const a = el.animate([{ opacity: pushed ? .6 : 1, transform: 'none', filter: 'blur(0)' }, { opacity: 0, transform: 'translateY(-8px) scale(.98)', filter: 'blur(4px)' }],
    { duration: pushed ? 420 : 620, easing: 'cubic-bezier(.4,0,.6,1)', fill: 'forwards' });
  a.onfinish = done; setTimeout(done, 1000);
}
function clearBubbles() {
  for (const b of live) clearTimeout(b.timer);
  live.length = 0;
  const lane = $('#chatLane'); if (lane) lane.innerHTML = '';
}
// 送信者の席のプレートの縁を一瞬光らせる
function ping(seat, mine) {
  const s = document.getElementById('seat' + seat); if (!s || REDUCE) return;
  s.classList.remove('cping', 'cping-y'); void s.offsetWidth;
  s.classList.add('cping'); if (mine) s.classList.add('cping-y');
  clearTimeout(s._cpT); s._cpT = setTimeout(() => s.classList.remove('cping', 'cping-y'), 1500);
}

/* ===================== fitTable との連携 ===================== */
// レーンの大きさ：l2 = 吹き出し 2 つ、l1 = 1 つ（2 行まで）、off = 置けない（吹き出しは出さない）
let mode = 'l2', modeKey = '';
function setMode(m) {
  const lane = $('#chatLane'); if (!lane) return;
  lane.classList.toggle('l2', m === 'l2'); lane.classList.toggle('l1', m === 'l1'); lane.classList.toggle('top', m === 'top');
  lane.style.display = m === 'off' ? 'none' : '';
}
// ベットが無い席にも同じ大きさの見えないチップを置いて、ベットが出ても配置が変わらないようにする（レーンとの判定だけに使う）
function ghosts(add) {
  if (!add) { document.querySelectorAll('#seats .bchip.ghost').forEach(e => e.remove()); return; }
  document.querySelectorAll('#seats .seat').forEach(s => {
    if (s.querySelector('.bchip')) return;
    const g = document.createElement('div'); g.className = 'bchip ghost'; g.setAttribute('aria-hidden', 'true');
    g.innerHTML = '<i></i><b>00,000</b>';
    s.appendChild(g);
  });
}
/** fitTable の二分探索を包む。search() は今のレーンの状態で入る最大の --cw を返す */
export function fitLane(key, search) {
  placeBtn();   // 向きで置き場所（卓の中 / 右の列）が変わる
  if (!S.on || !$('#chatLane')) return search();
  ghosts(true);
  try {
    if (key === modeKey) {
      setMode(mode);
      const c = search();
      if (c > 14 || mode === 'top') return c;   // 入らなくなった（ベットや札の変化）：決め直す
    }
    {
      modeKey = key;
      setMode('off'); const c0 = search();
      setMode('l2'); const c2 = search();
      if (c2 >= c0 * .9 && c2 > 14) { mode = 'l2'; return c2; }
      setMode('l1'); const c1 = search();
      // 卓を小さくしすぎるなら、卓の中には置かず上の情報の行に 1 つずつ出す（小さい画面の 5〜6 人）
      const ok = c => c >= Math.max(20, c0 * .72);
      mode = ok(c1) ? 'l1' : ok(c2) ? 'l2' : 'top';
      setMode(mode);
      return mode === 'l1' ? c1 : mode === 'l2' ? c2 : search();
    }
  } finally { ghosts(false); }
}
/** fits() の追加の判定：入力ボタンとレーンが卓の中にあり、どの席・真ん中・ベット（見えないものも）とも重ならない。
 *  レーンの幅は、レーンの高さの帯に入る物を左右に避けて中央から広げられるだけ（最大は CSS の幅、最小は短い文が 1 行に入る幅） */
export function fitsLane(T0, G, rectOf, hit) {
  if (!S.on) return true;
  const btn = $('#chatBtn'), lane = $('#chatLane'), B = btn && btn.parentNode === $('#table') ? rectOf(btn) : null;   // 横向きは右の列（卓の外）
  const others = G.flat().concat([...document.querySelectorAll('#seats .bchip.ghost')].map(rectOf).filter(Boolean));
  const inside = r => r.l >= T0.left - 1 && r.r <= T0.right + 1 && r.t >= T0.top - 1 && r.b <= T0.bottom + 1;
  if (B) { if (!inside(B)) return false; for (const g of others) if (hit(B, g, 4)) return false; }
  if (!lane || lane.hidden || lane.style.display === 'none' || lane.classList.contains('top')) return true;
  lane.style.width = ''; lane.style.setProperty('--lane-dy', '0px');
  const L = rectOf(lane); if (!L) return true;
  if (L.l < T0.left - 1 || L.r > T0.right + 1 || L.t < T0.top - 1) return false;
  const cx = (L.l + L.r) / 2, h = L.b - L.t, obs = B ? others.concat([B]) : others;
  const cf = parseFloat(getComputedStyle(lane).getPropertyValue("--cf")) || 12, min = cf * 8 + 14;
  // 盤のすぐ下から自分の札へ向かって下げていき、最初に十分な幅が取れた高さに置く
  for (let dy = 0; L.b + dy <= T0.bottom + 1; dy += 3) {
    const t = L.t + dy, b = L.b + dy;
    let half = (L.r - L.l) / 2, blocked = false;
    for (const g of obs) {
      if (g.b <= t - 4 || g.t >= b + 4) continue;
      if (g.r <= cx) half = Math.min(half, cx - g.r - 6);
      else if (g.l >= cx) half = Math.min(half, g.l - cx - 6);
      else { blocked = true; break; }
    }
    if (blocked) { if (dy > 0) return false; continue; }   // 真ん中をふさぐもの（自分の席）に当たった：これより下は無い
    if (half * 2 >= min) {
      lane.style.width = Math.floor(half * 2) + 'px';
      if (dy) lane.style.setProperty('--lane-dy', dy + 'px');
      return h > 0;
    }
  }
  return false;
}
// キーボードで卓を縮小表示にする間は、レーンの置き方を元のまま保つ（viewport.js が測ったあとで戻す）
viewportHooks({
  laneSave: () => ({ mode, modeKey }),
  laneLoad: x => { if (!x) return; mode = x.mode; modeKey = x.modeKey; setMode(mode); },
});
/** 配置が変わったあと（レーンの大きさが変わったら入らない吹き出しを押し出す） */
export function afterFit() { placeBtn(); if (S.on && live.length) trim(); }

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

if (import.meta.env && import.meta.env.DEV) window.__chat = { S, live, get mode() { return mode; }, bubble: m => bubble(m) };
