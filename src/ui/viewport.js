// The app frame always matches the area the player can actually see.
// - Height: the visual viewport (100dvh is only the CSS fallback; some Android builds report it including the system bars).
// - Bottom inset: Chrome on Android (135+) draws edge-to-edge under the navigation bar. env(safe-area-inset-bottom) is
//   dynamic and can read 0 there, so the CSS takes the larger of it and env(safe-area-max-inset-bottom). When both still
//   read 0 although the page is clearly edge-to-edge (the top inset is non-zero) on Android, reserve the height of the
//   3-button navigation bar so the action dock is never hidden behind it.
// - Software keyboard (the table chat): when the visible height changes because the keyboard opens or closes, the frame
//   height (--app-h), the card size (--cw, from table.js's fit) and the keyboard progress (--kbp, header/padding) glide
//   together in one animation; the target card size is measured first at the final height with the final classes.
//   When the visible area is too small for a usable table, the table fades out (--kbm) and only the composer and the
//   latest bubbles stay. iOS: the page is kept at scroll 0 and the frame follows the visual viewport's offsetTop.
const ANDROID_NAV_PX = 48;
const KB_PX = 100;          // a drop of the visible height larger than this while the chat input has focus = keyboard
const DUR = 340;
const root = document.documentElement;
const REDUCE = matchMedia('(prefers-reduced-motion: reduce)').matches;

// table.js / chat.js register these
const H = { measure: null, focused: () => false, done: null, laneSave: null, laneLoad: null };
/** measure(): runs the table fit for the current layout and returns { cw, tableH } (or null when no table is shown) */
export function viewportHooks(h) { Object.assign(H, h); }

function probeInsets() {
  const p = document.createElement('div');
  p.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;' +
    'padding-top:env(safe-area-inset-top,0px);padding-bottom:max(env(safe-area-inset-bottom,0px),env(safe-area-max-inset-bottom,0px))';
  document.body.appendChild(p);
  const cs = getComputedStyle(p), top = parseFloat(cs.paddingTop) || 0, bottom = parseFloat(cs.paddingBottom) || 0;
  p.remove();
  return { top, bottom };
}
const visible = () => { const vv = window.visualViewport; return Math.round(vv ? vv.height * (vv.scale || 1) : window.innerHeight); };

// current values (what is on screen) and the running animation
const cur = { h: 0, kbp: 0, kbm: 0 };
let anim = null, baseW = 0, baseH = 0, lastW = 0, preKbCw = 0, t0h = 0;
export const gliding = () => !!anim;
// the layout before the keyboard: card size, the table's height (kept while it is scaled) and the header padding (the kb rules
// interpolate from it). Taken when the chat input is about to get focus, i.e. before the keyboard changes anything.
let snap = false;
export function snapshot() {
  if (document.body.classList.contains('kb') || anim) return;
  preKbCw = cwNow();
  t0h = document.getElementById('table')?.clientHeight || 0;
  const top = document.querySelector('.top');
  if (top) { const cs = getComputedStyle(top); root.style.setProperty('--tp0', cs.paddingTop); root.style.setProperty('--tb0', cs.paddingBottom); }
  snap = true;
}
const stage = () => document.getElementById('stage');
const cwNow = () => parseFloat(stage()?.style.getPropertyValue('--cw')) || 0;
const lane = () => document.getElementById('chatLane');   // its width is decided by the fit too (chat.js fitsLane)
const lwNow = () => { const l = lane(); return l ? [parseFloat(l.style.width) || 0, parseFloat(l.style.getPropertyValue('--lane-dy')) || 0] : null; };

function setVars(h, cw, kbp, kbm, lw) {
  const l = lw && lw[0] ? lane() : null;
  if (l) { l.style.width = Math.round(lw[0] * 10) / 10 + 'px'; l.style.setProperty('--lane-dy', Math.round(lw[1] * 10) / 10 + 'px'); }
  cur.h = h; cur.kbp = kbp; cur.kbm = kbm;
  root.style.setProperty('--app-h', Math.round(h * 100) / 100 + 'px');
  root.style.setProperty('--kbp', String(Math.round(kbp * 1000) / 1000));
  root.style.setProperty('--kbm', String(Math.round(kbm * 1000) / 1000));
  if (cw) stage()?.style.setProperty('--cw', Math.round(cw * 100) / 100 + 'px');
}
const ease = p => { // cubic-bezier(.2,.8,.2,1)
  let lo = 0, hi = 1, t = p;
  for (let i = 0; i < 14; i++) { t = (lo + hi) / 2; const x = 3 * .2 * t * (1 - t) ** 2 + 3 * .2 * t * t * (1 - t) + t ** 3; if (x < p) lo = t; else hi = t; }
  return 3 * .8 * t * (1 - t) ** 2 + 3 * 1 * t * t * (1 - t) + t ** 3;
};

function glide(h1, kb) {
  const b = document.body;
  const from = { h: cur.h, cw: cwNow(), kbp: cur.kbp, kbm: cur.kbm, lw: lwNow() };
  if (anim) cancelAnimationFrame(anim.raf);
  if (kb && !b.classList.contains('kb') && !snap) snapshot();
  snap = false;
  b.classList.toggle('kb', kb || from.kbp > 0);
  b.classList.remove('kbmin');
  // 1) the final state, measured synchronously (nothing is painted in between)
  setVars(h1, 0, kb ? 1 : 0, 0);
  let to = { h: h1, cw: from.cw, kbp: kb ? 1 : 0, kbm: 0, lw: from.lw };
  const ls = H.laneSave && H.laneSave();
  const m = H.measure && H.measure();
  if (m) {
    to.cw = m.cw; to.lw = lwNow();
    // too small for a usable table (landscape phones, short screens): keep the cards, fade the table out
    if (kb && t0h && (m.tableH < 170 || m.cw < Math.max(22, (preKbCw || m.cw) * .5))) {
      to.cw = preKbCw || from.cw; to.kbm = 1; to.lw = from.lw;
      H.laneLoad && H.laneLoad(ls);
      // scale so that the table ends just above the lane (which moves to the bottom of the table's area)
      stage()?.style.setProperty('--cw', to.cw + 'px');   // the lane's height follows the card size
      const ln = lane(), lh = ln && !ln.hidden ? ln.offsetHeight : 0;
      root.style.setProperty('--t0h', t0h + 'px');
      root.style.setProperty('--ts1', String(Math.max(.15, Math.min(1, (m.tableH - lh - 8) / t0h))));
    }
  }
  if (to.kbm || from.kbm) b.classList.add('kbmin');   // the table is (or was) faded: table.js does not fit it until this ends
  // 2) back to where we are, then animate everything together
  setVars(from.h, from.cw, from.kbp, from.kbm, from.lw);
  if (REDUCE || !from.h) { finish(to); return; }
  const t0 = performance.now();
  const step = now => {
    const p = Math.min(1, (now - t0) / (DUR * ((import.meta.env && import.meta.env.DEV && window.__glideSlow) || 1))), e = ease(p);
    setVars(from.h + (to.h - from.h) * e, from.cw + (to.cw - from.cw) * e, from.kbp + (to.kbp - from.kbp) * e, from.kbm + (to.kbm - from.kbm) * e,
      from.lw && to.lw && from.lw[0] && to.lw[0] ? [0, 1].map(i => from.lw[i] + (to.lw[i] - from.lw[i]) * e) : null);
    if (p < 1) anim.raf = requestAnimationFrame(step);
    else finish(to);
  };
  anim = { raf: requestAnimationFrame(step), to };
}
function finish(to) {
  anim = null;
  setVars(to.h, to.cw, to.kbp, to.kbm, to.lw);
  if (!to.kbp) document.body.classList.remove('kb');
  if (!to.kbm) document.body.classList.remove('kbmin');
  H.done && H.done();
}

function apply() {
  const h = visible(); if (!(h > 0)) return;
  const w = window.innerWidth;
  const { top, bottom } = probeInsets();
  const edgeToEdge = /Android/i.test(navigator.userAgent) && top > 0 && bottom === 0;
  root.style.setProperty('--sab-fb', edgeToEdge ? ANDROID_NAV_PX + 'px' : '0px');
  follow();
  if (w !== baseW) { baseW = w; baseH = h; }
  const focused = H.focused();
  if (!focused) baseH = Math.max(baseH, h);
  const kb = focused && baseH - h > KB_PX;
  const wasKb = document.body.classList.contains('kb');
  const inGame = document.body.dataset.screen === 'game';
  if (anim && anim.to.h === h && !!anim.to.kbp === kb) return;   // already heading there
  if (inGame && cur.h && w === lastW && (kb || wasKb) && H.measure) { lastW = w; glide(h, kb); return; }
  lastW = w;
  if (anim) { cancelAnimationFrame(anim.raf); anim = null; }
  document.body.classList.remove('kb', 'kbmin');
  setVars(h, 0, 0, 0);
  if (anim === null && H.done && (wasKb || cur.kbm)) H.done();
}
// iOS: focusing an input scrolls the page / pans the visual viewport. Keep the page at 0 and pin the frame to what is visible.
function follow() {
  const vv = window.visualViewport;
  if (window.scrollY || window.scrollX) window.scrollTo(0, 0);
  const app = document.querySelector('.app'); if (!app) return;
  const off = vv ? Math.max(0, Math.round(vv.offsetTop)) : 0;
  app.style.translate = off ? `0 ${off}px` : '';
}

let t = 0;
const later = () => { clearTimeout(t); t = setTimeout(apply, 50); };
// keyboard-related changes are handled at once (before the next paint) so the frame never shows a stale height
const now = () => { clearTimeout(t); apply(); };
apply();
addEventListener('resize', () => (H.focused() || document.body.classList.contains('kb') ? now() : later()));
addEventListener('orientationchange', later);
addEventListener('scroll', () => { if (window.scrollY || window.scrollX) window.scrollTo(0, 0); }, { passive: true });
if (window.visualViewport) {
  visualViewport.addEventListener('resize', () => (H.focused() || document.body.classList.contains('kb') ? now() : later()));
  visualViewport.addEventListener('scroll', follow);
}
/** the chat input lost focus: if no resize follows (keyboard already gone / hardware keyboard), settle anyway */
export function settleSoon() { setTimeout(() => { if (!H.focused()) apply(); }, 650); }
