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
// - Predicted glide (expectKeyboard): a phone reports the keyboard's height only once it is (nearly) up, so the table used to
//   shrink after the keyboard had already covered the dock — two separate moves. The keyboard's height is remembered per screen
//   size (localStorage pm-kbh), and from the second time on the glide starts together with the keyboard when the chat input
//   opens (and the glide back starts when it closes). Heights reported while the keyboard is still moving toward where the glide
//   is already heading are not followed; once it has settled, the real height wins.
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
  const cs = getComputedStyle(p), top = Number.parseFloat(cs.paddingTop) || 0, bottom = Number.parseFloat(cs.paddingBottom) || 0;
  p.remove();
  return { top, bottom };
}
// what the browser shows (a real keyboard included); visible() also takes off the demo keyboard (below)
const real = () => { const vv = window.visualViewport; return Math.round(vv ? vv.height * (vv.scale || 1) : window.innerHeight); };
const visible = () => real() - simPx();

// current values (what is on screen) and the running animation
const cur = { h: 0, kbp: 0, kbm: 0 };
let anim = null, baseW = 0, baseH = 0, lastW = 0, preKbCw = 0, t0h = 0;
// the predicted glide (expectKeyboard): { up, h, until }
const PRED_MS = 1100;
let pred = null, predT = 0;
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
const cwNow = () => Number.parseFloat(stage()?.style.getPropertyValue('--cw')) || 0;
const lane = () => document.getElementById('chatLane');   // its width is decided by the fit too (chat.js fitsLane)
const lwNow = () => { const l = lane(); return l ? [Number.parseFloat(l.style.width) || 0, Number.parseFloat(l.style.getPropertyValue('--lane-dy')) || 0] : null; };

function setVars(h, cw, kbp, kbm, lw) {
  const l = lw?.[0] ? lane() : null;
  if (l) { l.style.width = Math.round(lw[0] * 10) / 10 + 'px'; l.style.setProperty('--lane-dy', Math.round(lw[1] * 10) / 10 + 'px'); }
  cur.h = h; cur.kbp = kbp; cur.kbm = kbm;
  root.style.setProperty('--app-h', Math.round(h * 100) / 100 + 'px');
  root.style.setProperty('--kbp', String(Math.round(kbp * 1000) / 1000));
  root.style.setProperty('--kbm', String(Math.round(kbm * 1000) / 1000));
  if (cw) stage()?.style.setProperty('--cw', Math.round(cw * 100) / 100 + 'px');
  if (sim.el) simTrack(h);
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
  const ls = H.laneSave?.();
  const m = H.measure?.();
  if (m) {
    to.cw = m.cw; to.lw = lwNow();
    // too small for a usable table (landscape phones, short screens): keep the cards, fade the table out
    if (kb && t0h && (m.tableH < 170 || m.cw < Math.max(22, (preKbCw || m.cw) * .5))) {
      to.cw = preKbCw || from.cw; to.kbm = 1; to.lw = from.lw;
      H.laneLoad?.(ls);
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
    const p = Math.min(1, (now - t0) / (DUR * ((import.meta.env?.DEV && window.__glideSlow) || 1))), e = ease(p);
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
  H.done?.();
}

function apply() {
  const r = real(); if (!(r > 0)) return;
  if (pred && performance.now() >= pred.until) pred = null;
  const w = window.innerWidth;
  const { top, bottom } = probeInsets();
  const edgeToEdge = /Android/i.test(navigator.userAgent) && top > 0 && bottom === 0;
  root.style.setProperty('--sab-fb', edgeToEdge ? ANDROID_NAV_PX + 'px' : '0px');
  follow();
  const focused = H.focused();
  // the width changed (rotation): the height without the keyboard is the layout viewport's (the keyboard does not shrink it)
  const turned = !!baseW && w !== baseW;
  if (w !== baseW) { baseW = w; baseH = focused ? Math.max(r, window.innerHeight) : r; }
  if (!focused) baseH = Math.max(baseH, r);
  // the demo keyboard is up only while the input has focus, and gives way when a real keyboard turns up after all
  if (sim.on && (!focused || (!sim.forced && baseH - r > KB_PX))) { if (focused) { sim.real = true; } sim.on = false; }
  const h = visible(); simShow();
  const kb = focused && baseH - h > KB_PX;
  const wasKb = document.body.classList.contains('kb');
  const inGame = document.body.dataset.screen === 'game';
  // the keyboard is still on its way to where the predicted glide is heading: keep going
  if (pred && !turned && w === lastW && (pred.up ? focused && h > pred.h : !focused && h < pred.h)) return;
  if (kb && !sim.on && !turned && w === lastW) remember(baseH - h);
  if (anim?.to.h === h && !!anim.to.kbp === kb) return;   // already heading there
  if (inGame && cur.h && w === lastW && (kb || wasKb) && H.measure) {
    lastW = w;
    if (!anim && kb && wasKb && Math.abs(cur.h - h) < .5) return;   // already there
    glide(h, kb); return;
  }
  // turned with the keyboard up: lay the table out for the new orientation without the keyboard first, then glide down to it
  if (inGame && turned && kb && H.measure) {
    if (anim) { cancelAnimationFrame(anim.raf); anim = null; }
    lastW = w;
    document.body.classList.remove('kb', 'kbmin');
    setVars(baseH, 0, 0, 0); cur.kbm = 0;
    H.measure(); snap = false; snapshot();
    glide(h, true);
    return;
  }
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

// Demo keyboard: a PC browser (also its devtools phone view, which looks like a phone in every other way) has no software
// keyboard, so ?demo could not show how the table shrinks for one. When the chat input gets focus there and the visible height
// has not dropped by a keyboard within SIM_WAIT ms, a stand-in board rises from the bottom and visible() loses its height, so
// the glide above runs exactly as for a real keyboard. Its top edge is the frame's bottom edge in every frame of the glide. Once a page is known to have no keyboard the board comes at once.
// ?kb=sim: always and at once (also outside ?demo, for development). ?kb=off: never. Never wider than 900px (a PC screen).
const SIM_WAIT = 550, SIM_MAXW = 900;
const kbq = new URLSearchParams(location.search).get('kb');
const sim = { el: null, on: false, px: 0, forced: kbq === 'sim', none: kbq === 'sim', real: false, t: 0 };
function simPx() {
  if (!sim.on) return 0;
  const w = window.innerWidth, h = window.innerHeight;
  if (w > SIM_MAXW) return 0;
  return Math.round(w > h ? h * .5 : Math.min(h * .4, 300));   // iPhone: 260–300px upright, about half the height sideways
}
const KEYS = [['→', 1], ['あ'], ['か'], ['さ'], ['⌫', 1], ['↺', 1], ['た'], ['な'], ['は'], ['空白', 1], ['ABC', 1], ['ま'], ['や'], ['ら'], ['改行', 2],
  ['☺', 1], ['小ﾞﾟ'], ['わ'], ['、。?!']];
const GLOBE = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/></svg>';
const MIC = '<svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/></svg>';
function simEl() {
  if (sim.el) return sim.el;
  const el = sim.el = document.createElement('div');
  el.className = 'simkb'; el.setAttribute('aria-hidden', 'true');
  el.innerHTML = '<div class="skb-bar"></div><div class="skb-keys">' +
    KEYS.map(([k, f]) => `<i class="skb-k${f ? ' fn' : ''}${f === 2 ? ' tall' : ''}">${k}</i>`).join('') + '</div><div class="skb-home">' + GLOBE + MIC + '</div>';
  document.body.appendChild(el);
  // pressing it changes nothing: the input keeps focus and the chat's "tap outside closes" never sees it
  const block = e => {
    if (!el.contains(e.target)) return;
    e.preventDefault(); e.stopPropagation();
    const k = e.type === 'pointerdown' && e.target.closest('.skb-k');
    if (k) { k.classList.add('hit'); setTimeout(() => k.classList.remove('hit'), 140); }
  };
  addEventListener('pointerdown', block, true); addEventListener('mousedown', block, true);   // before chat.js's document listener
  el.addEventListener('touchstart', block, { passive: false });
  return el;
}
function simShow() {
  const px = simPx();
  if (!px && !sim.el) return;
  const el = simEl();
  if (px) { sim.px = px; el.style.height = px + 'px'; el.classList.toggle('land', window.innerWidth > window.innerHeight); }
}
// the board's top follows the frame's bottom (setVars): it rises and falls with --app-h, never ahead of it or behind it
function simTrack(h) {
  const el = sim.el, px = sim.px, y = Math.max(0, Math.min(px, Math.round((px - (real() - h)) * 10) / 10));
  el.style.transform = `translateY(${y}px)`;
  el.style.visibility = y >= px ? 'hidden' : 'visible';
}
const simAllowed = () => kbq !== 'off' && !sim.real && (sim.forced || document.body.classList.contains('demo')) && window.innerWidth <= SIM_MAXW;
function simUp() { if (H.focused() && !sim.on) { snapshot(); sim.on = true; now(); } }
document.addEventListener('focusin', () => {
  clearTimeout(sim.t);
  if (!H.focused() || sim.on || !simAllowed()) return;
  if (sim.none) { simUp(); return; }
  sim.t = setTimeout(() => {
    if (!H.focused() || sim.on || !simAllowed()) return;
    if (baseH - real() > KB_PX) { sim.real = true; return; }   // a real keyboard: leave it alone from now on
    sim.none = true; simUp();
  }, SIM_WAIT);
});
// the input lost focus (Esc, send on a phone, a tap outside): the board goes down with the glide back
document.addEventListener('focusout', () => { if (sim.on) setTimeout(() => { if (sim.on && !H.focused()) now(); }, 0); });

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
// the keyboard's height per screen size (the width and the height without the keyboard)
const kbKey = () => baseW + 'x' + baseH;
function kbMem() { try { return JSON.parse(localStorage.getItem('pm-kbh') || '{}') || {}; } catch (e) { return {}; } }
function remember(px) {
  if (!(px > KB_PX && px < baseH * .8)) return;
  const m = kbMem(), k = kbKey(); if (m[k] === px) return;
  m[k] = px;
  try { localStorage.setItem('pm-kbh', JSON.stringify(m)); } catch (e) { /* private mode */ }
}
/** the chat input opens (up) / closes: start the glide now instead of when the phone reports the keyboard (see the top) */
export function expectKeyboard(up) {
  const b = document.body;
  if (b.dataset.screen !== 'game' || !H.measure || !cur.h || sim.on || simAllowed() || window.innerWidth !== lastW || !matchMedia('(pointer:coarse)').matches) return;
  let h;
  if (up) {
    if (b.classList.contains('kb') || anim) return;
    const px = kbMem()[kbKey()]; if (!px) return;   // the first time: wait for the keyboard as before
    h = baseH - px;
  } else {
    if (!b.classList.contains('kb')) return;
    h = baseH;
  }
  pred = { up, h, until: performance.now() + PRED_MS };
  clearTimeout(predT); predT = setTimeout(() => { pred = null; apply(); }, PRED_MS + 20);   // then the real height wins (or no keyboard came)
  glide(h, up);
}
/** the chat input lost focus: if no resize follows (keyboard already gone / hardware keyboard), settle anyway */
export function settleSoon() { setTimeout(() => { if (!H.focused()) apply(); }, 650); }

