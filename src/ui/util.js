// 画面の共通部品とアプリの状態（フレームワークなし：素の DOM と Web Animations API）。Multiplier と同じ作り。
export const $ = s => document.querySelector(s);
export const REDUCE = matchMedia('(prefers-reduced-motion: reduce)').matches;
export const EASE = 'cubic-bezier(.2,.8,.2,1)';
export const esc = t => String(t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const fmt = n => Math.round(Number(n) || 0).toLocaleString('en-US');
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const setHTML = (el, h) => { if (el._h !== h) { el.innerHTML = h; el._h = h; return true; } return false; };
export const head = (eye, title, cls = '') => `<div class="eyebrow">${eye}</div><h2${cls ? ` class="${cls}"` : ''}>${title}</h2>`;

// アプリの状態。net は起動時に決まる（net.js か ?fake）。nav.* は main.js が入れる
export const app = {
  net: null, user: null, prof: null, booting: false,
  nav: { toMenu() {}, enterRoom() {}, refreshMe: async () => null, logout() {} },
};

export function toast(t) {
  const el = $('#toast'); el.textContent = t; el.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => el.classList.remove('show'), 2200);
}
export function openDlg(id) { const d = $(id); if (!d.open) d.showModal(); }
export function closeAllDlg() { document.querySelectorAll('dialog[open]').forEach(d => d.close()); }

// サーバーの時計（ms のずれ：サーバー − 手元）。room_poll のたびに更新する
export const clock = { offset: 0, now: () => Date.now() + clock.offset };

export function localGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
export function localSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* プライベートモード */ } }

// カード：0..51、rank = c>>2（0='2'）、suit = c&3（0♠ 1♥ 2♦ 3♣）
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'], SUITS = ['♠', '♥', '♦', '♣'];
const SUIT_EN = ['spades', 'hearts', 'diamonds', 'clubs'];
export function cardHTML(c, opts = {}) {
  if (c === null || c === undefined || opts.back) return '<div class="card back" role="img" aria-label="Hidden card"></div>';
  const s = c & 3, r = c >> 2, red = s === 1 || s === 2;
  return `<div class="card${red ? ' red' : ''}${opts.dim ? ' dim' : ''}${opts.hit ? ' hit' : ''}" role="img" aria-label="${RANKS[r]} of ${SUIT_EN[s]}"><span class="rk">${RANKS[r]}</span><span class="st">${SUITS[s]}</span></div>`;
}
/** 文字のカード（履歴の一覧など小さく出すところ） */
export function cardText(c) {
  if (c == null) return '<span class="ct">?</span>';
  const s = c & 3, red = s === 1 || s === 2;
  return `<span class="ct${red ? ' red' : ''}">${RANKS[c >> 2]}${SUITS[s]}</span>`;
}
export const ordinal = n => n + (n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th');
/** pt の表示（+5 / −1 / ±0。小数は 1 桁まで） */
export function fmtPt(v) {
  if (v == null) return '–';
  if (v === 0) return '±0';
  const s = (Math.round(Math.abs(v) * 10) / 10).toFixed(1).replace(/\.0$/, '');
  return `${v > 0 ? '+' : '−'}${s}`;
}
/** bb の表示（小数第 1 位まで） */
export const fmtBb = (chips, bb) => { const v = Math.round((chips / (bb || 1)) * 10) / 10; return (v % 1 === 0 ? String(v) : v.toFixed(1)); };

// 2 つの要素の間をチップの数字が飛ぶ演出
export function fly(fromEl, toEl, label, cls, delay = 0, done) {
  if (REDUCE || !fromEl || !toEl || document.hidden) { done && done(); return; }
  const ra = fromEl.getBoundingClientRect(), rb = toEl.getBoundingClientRect();
  const el = document.createElement('div'); el.className = 'fly ' + cls; el.textContent = label; document.body.appendChild(el);
  const w = el.offsetWidth, h = el.offsetHeight, x0 = ra.left + ra.width / 2 - w / 2, y0 = ra.top + ra.height / 2 - h / 2,
    x1 = rb.left + rb.width / 2 - w / 2, y1 = rb.top + rb.height / 2 - h / 2, D = 650;
  const an = el.animate([
    { transform: `translate(${x0}px,${y0}px) scale(.8)`, opacity: 0 },
    { transform: `translate(${x0}px,${y0}px) scale(1)`, opacity: 1, offset: .15 },
    { transform: `translate(${x1}px,${y1}px) scale(1)`, opacity: 1, offset: .85 },
    { transform: `translate(${x1}px,${y1}px) scale(.7)`, opacity: 0 }], { duration: D, delay, easing: 'cubic-bezier(.3,.7,.2,1)', fill: 'both' });
  let ended = false;
  const end = () => { if (ended) return; ended = true; el.remove(); done && done(); };
  an.onfinish = end; setTimeout(end, D + delay + 150);
}

/** 招待 URL（部屋番号で開く） */
export const inviteUrl = code => `${location.origin}/?room=${code}`;
/** 招待 URL を共有（共有シートが無ければクリップボード） */
export async function shareInvite(code, kind) {
  const url = inviteUrl(code);
  const text = `PrivateMatch の${kind === 'free' ? '' : 'プライベート'}部屋に招待します（部屋番号 ${code}）`;
  if (navigator.share) { try { await navigator.share({ title: 'PrivateMatch', text, url }); return; } catch (e) { if (e && e.name === 'AbortError') return; } }
  await copyText(url);
}
export async function copyText(t) {
  try { await navigator.clipboard.writeText(t); toast('コピーしました'); }
  catch (e) {
    const ta = document.createElement('textarea'); ta.value = t; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast('コピーしました'); } catch (e2) { toast('コピーできませんでした'); }
    ta.remove();
  }
}
