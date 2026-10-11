// 卓の中央の演出 GIF（PRIVATE MATCH）。卓に入ったら全席の GIF を 1 回の API でまとめて引いて先に読み込み（prepare）、
// ショーダウンの演出の最後（勝負が決まって一間おいたところ）に勝者の分を出す（play → hide。時間は structure.js の FX、呼ぶのは table.js）。
// 読み込みが終わっていなければ出さない（卓の進行は GIF を待たない）。メディアは KLIPY から直接読み、返った URL をそのまま使う（保存しない）。
import { lookup } from '../klipy.js';
import { FX } from '../structure.js';
import { esc, REDUCE, EASE } from './util.js';

const pool = new Map();   // slug → { el: <video> | <img> | null, w, h }
let want = '', cur = null;

const ready = el => !!el && (el.tagName === 'VIDEO' ? el.readyState >= 2 : el.complete && el.naturalWidth > 0);

/** 席ごとの slug（null は無し）。同じ顔ぶれなら何もしない */
export function prepare(fx) {
  const slugs = [...new Set((fx || []).filter(Boolean))], k = slugs.join(',');
  if (k === want) return;
  want = k;
  const todo = slugs.filter(s => !pool.has(s));
  if (!todo.length) return;
  todo.forEach(s => pool.set(s, { el: null, w: 0, h: 0 }));
  lookup(todo).then(m => {
    for (const [s, it] of m) { const p = pool.get(s); if (p && !p.el) load(p, it.full); }
  }).catch(() => {
    // 届かない・回数の上限：ポーリングのたびに呼び直さず、30 秒あけてから
    todo.forEach(s => { const p = pool.get(s); if (p && !p.el) pool.delete(s); });
    setTimeout(() => { if (want === k) want = ''; }, 30_000);
  });
}
function load(p, m) {
  p.w = m.w; p.h = m.h;
  if (m.video) {
    const v = document.createElement('video');
    v.muted = true; v.defaultMuted = true; v.loop = true; v.playsInline = true; v.preload = 'auto';
    v.setAttribute('muted', ''); v.setAttribute('playsinline', '');
    v.addEventListener('loadedmetadata', () => { p.w = v.videoWidth || p.w; p.h = v.videoHeight || p.h; });
    v.src = m.url; v.load();
    p.el = v;
  } else {
    const img = new Image(); img.decoding = 'async'; img.alt = '';
    img.onload = () => { p.w = img.naturalWidth || p.w; p.h = img.naturalHeight || p.h; };
    img.src = m.url;
    p.el = img;
  }
  p.el.className = 'fx-m';
}

/** host（#table）の中央に slug の GIF を出す。name = 勝った人、mine = 自分。読み込めていなければ false（出さない） */
export function play(host, slug, name, mine) {
  const p = pool.get(slug);
  if (!host || !p || !ready(p.el)) return false;
  hide(0);
  const wrap = document.createElement('div');
  wrap.className = 'fx-show'; wrap.setAttribute('aria-hidden', 'true');
  wrap.innerHTML = `<div class="fx-box"></div><b class="fx-name ${mine ? 'y' : 'c'}">${esc(name || '')}</b>`;
  // 卓の幅の 64%（440px まで）・高さの 52% に収まる大きさ（縦横比は GIF のまま）
  const rc = host.getBoundingClientRect(), r = rc.width > 0 && rc.height > 0 ? rc : { width: 480, height: 600 }, ar = p.w && p.h ? p.w / p.h : 4 / 3;
  let w = Math.min(r.width * 0.64, 440), h = w / ar;
  if (h > r.height * 0.52) { h = r.height * 0.52; w = h * ar; }
  const box = wrap.firstChild; box.style.width = Math.round(w) + 'px'; box.style.height = Math.round(h) + 'px';
  box.appendChild(p.el);
  host.appendChild(wrap);
  if (p.el.tagName === 'VIDEO') { try { p.el.currentTime = 0; } catch (e) { /* まだ */ } p.el.play().catch(() => {}); }
  if (!REDUCE && !document.hidden) {
    wrap.animate([{ opacity: 0 }, { opacity: 1 }], { duration: FX.in, easing: EASE, fill: 'backwards' });
    box.animate([{ transform: 'translateY(10px) scale(.9)' }, { transform: 'none' }], { duration: FX.in + 80, easing: EASE, fill: 'backwards' });
  }
  cur = wrap;
  return true;
}
/** 出している GIF を消す（ms = 消える長さ。0 はすぐ） */
export function hide(ms = FX.out) {
  const w = cur; cur = null;
  if (!w) return;
  const done = () => { const m = w.querySelector('video'); if (m) { m.pause(); } w.remove(); };
  if (!ms || REDUCE || document.hidden) return done();
  const an = w.animate([{ opacity: 1 }, { opacity: 0 }], { duration: ms, easing: EASE, fill: 'forwards' });
  w.firstChild.animate([{ transform: 'none' }, { transform: 'scale(1.04)' }], { duration: ms, easing: EASE, fill: 'forwards' });
  an.onfinish = done; setTimeout(done, ms + 120);
}
/** 卓を出るとき：消して、読み込んだものも手放す */
export function clear() {
  hide(0);
  for (const p of pool.values()) if (p.el?.tagName === 'VIDEO') { p.el.removeAttribute('src'); p.el.load(); }
  pool.clear(); want = '';
}
