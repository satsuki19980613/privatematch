// The app frame always matches the area the player can actually see.
// - Height: the visual viewport (100dvh is only the CSS fallback; some Android builds report it including the system bars).
// - Bottom inset: Chrome on Android (135+) draws edge-to-edge under the navigation bar. env(safe-area-inset-bottom) is
//   dynamic and can read 0 there, so the CSS takes the larger of it and env(safe-area-max-inset-bottom). When both still
//   read 0 although the page is clearly edge-to-edge (the top inset is non-zero) on Android, reserve the height of the
//   3-button navigation bar so the action dock is never hidden behind it.
const ANDROID_NAV_PX = 48;
const root = document.documentElement;

function probeInsets() {
  const p = document.createElement('div');
  p.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;' +
    'padding-top:env(safe-area-inset-top,0px);padding-bottom:max(env(safe-area-inset-bottom,0px),env(safe-area-max-inset-bottom,0px))';
  document.body.appendChild(p);
  const cs = getComputedStyle(p), top = parseFloat(cs.paddingTop) || 0, bottom = parseFloat(cs.paddingBottom) || 0;
  p.remove();
  return { top, bottom };
}

function apply() {
  const vv = window.visualViewport;
  const h = vv ? vv.height * (vv.scale || 1) : window.innerHeight;
  if (h > 0) root.style.setProperty('--app-h', Math.round(h) + 'px');
  const { top, bottom } = probeInsets();
  const edgeToEdge = /Android/i.test(navigator.userAgent) && top > 0 && bottom === 0;
  root.style.setProperty('--sab-fb', edgeToEdge ? ANDROID_NAV_PX + 'px' : '0px');
}

let t = 0;
const later = () => { clearTimeout(t); t = setTimeout(apply, 50) };
apply();
addEventListener('resize', later);
addEventListener('orientationchange', later);
if (window.visualViewport) visualViewport.addEventListener('resize', later);
