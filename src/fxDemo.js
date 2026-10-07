// ?fake / ?demo の演出 GIF の見本（KLIPY のキー無しで設定画面と卓の演出を確かめる）。自作の動く SVG で、外部の素材は使わない。
// src/klipy.js の useDemo に渡す形：search(q, page, per) → { items, next }、lookup(slugs) → [item]。
// item = { slug, title, thumb, full }（thumb / full = { url, video: false, w, h }）
const W = 320, H = 240;
const YOU = '#336B87', CPU = '#FE7A47', INK = '#0D0F13', PAPER = '#F7F8FA';
const svg = (bg, body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="${bg}"/>${body}</svg>`;
const T = 'font-family="Inter Tight,Helvetica Neue,Arial,sans-serif" font-weight="800" text-anchor="middle"';
const spin = (cx, cy, dur, from = 0, to = 360) => `<animateTransform attributeName="transform" type="rotate" from="${from} ${cx} ${cy}" to="${to} ${cx} ${cy}" dur="${dur}s" repeatCount="indefinite"/>`;
const bob = (dy, dur) => `<animateTransform attributeName="transform" type="translate" values="0 0;0 ${dy};0 0" dur="${dur}s" repeatCount="indefinite" calcMode="spline" keySplines=".4 0 .6 1;.4 0 .6 1"/>`;
const card = (x, y, rank, suit, red, k) => `<g><animateTransform attributeName="transform" type="rotate" values="${k ? 8 : -8} ${x + 36} ${y + 100};${k ? -4 : 4} ${x + 36} ${y + 100};${k ? 8 : -8} ${x + 36} ${y + 100}" dur="1.6s" repeatCount="indefinite"/>
  <rect x="${x}" y="${y}" width="72" height="100" fill="${PAPER}" stroke="${INK}" stroke-opacity=".2"/>
  <text x="${x + 36}" y="${y + 52}" ${T} font-size="36" fill="${red ? '#C8243F' : INK}">${rank}</text><text x="${x + 36}" y="${y + 86}" ${T} font-size="26" fill="${red ? '#C8243F' : INK}">${suit}</text></g>`;
const burst = (cx, cy, color, delay) => `<g transform="translate(${cx} ${cy})">${Array.from({ length: 10 }, (_, i) => {
  const a = (i / 10) * Math.PI * 2, x = Math.cos(a) * 56, y = Math.sin(a) * 56;
  return `<circle r="5" fill="${color}"><animate attributeName="cx" values="0;${x.toFixed(1)}" dur="1.4s" begin="${delay}s" repeatCount="indefinite"/><animate attributeName="cy" values="0;${y.toFixed(1)}" dur="1.4s" begin="${delay}s" repeatCount="indefinite"/><animate attributeName="opacity" values="1;1;0" dur="1.4s" begin="${delay}s" repeatCount="indefinite"/></circle>`;
}).join('')}</g>`;
const rain = color => Array.from({ length: 14 }, (_, i) => {
  const x = 12 + i * 22, d = (1.2 + (i % 4) * 0.25).toFixed(2), b = ((i * 0.37) % 1.2).toFixed(2);
  return `<rect x="${x}" y="-20" width="12" height="12" fill="${color}" transform="rotate(45 ${x + 6} -14)"><animate attributeName="y" values="-20;${H + 20}" dur="${d}s" begin="-${b}s" repeatCount="indefinite"/></rect>`;
}).join('');

const ART = [
  ['demo-crown', 'Crown 王冠 win', svg(YOU, `${rain('rgba(255,255,255,.18)')}<g>${bob(-12, 1.1)}<path d="M100 170 L112 92 L140 128 L160 80 L180 128 L208 92 L220 170 Z" fill="#FFD36B" stroke="${INK}" stroke-width="4" stroke-linejoin="miter"/><rect x="100" y="170" width="120" height="18" fill="#FFD36B" stroke="${INK}" stroke-width="4"/><circle cx="160" cy="150" r="9" fill="${CPU}"/></g>`)],
  ['demo-ship-it', 'Ship it all-in オールイン', svg(CPU, `<g>${bob(-8, .7)}<text x="160" y="140" ${T} font-size="64" fill="${PAPER}" letter-spacing="2">SHIP IT</text></g><rect y="168" height="10" fill="${INK}" width="0"><animate attributeName="width" values="0;${W};${W}" keyTimes="0;.6;1" dur="1.2s" repeatCount="indefinite"/></rect>`)],
  ['demo-aces', 'Pocket aces エース', svg('#15171C', `${card(86, 70, 'A', '♠', false, 0)}${card(162, 70, 'A', '♥', true, 1)}`)],
  ['demo-fireworks', 'Fireworks 花火 celebrate', svg('#0B0C0F', `${burst(100, 100, CPU, 0)}${burst(220, 90, '#7DB4CF', .45)}${burst(160, 160, '#FFD36B', .9)}`)],
  ['demo-gg', 'GG good game', svg(PAPER, `<text x="160" y="160" ${T} font-size="120" fill="${YOU}"><animate attributeName="font-size" values="110;132;110" dur=".9s" repeatCount="indefinite"/>GG</text>`)],
  ['demo-chips', 'Chips チップ stack', svg(YOU, Array.from({ length: 6 }, (_, i) => `<g><animateTransform attributeName="transform" type="translate" values="0 ${60 + i * 10};0 0;0 0" keyTimes="0;.4;1" dur="1.8s" begin="${(i * 0.12).toFixed(2)}s" repeatCount="indefinite"/><ellipse cx="160" cy="${190 - i * 18}" rx="56" ry="14" fill="${i % 2 ? PAPER : CPU}" stroke="${INK}" stroke-width="3"/></g>`).join(''))],
  ['demo-nice-hand', 'Nice hand ナイス', svg(INK, `${rain('rgba(254,122,71,.5)')}<text x="160" y="132" ${T} font-size="48" fill="${PAPER}">NICE HAND<animate attributeName="opacity" values=".3;1;1;.3" dur="1.6s" repeatCount="indefinite"/></text>`)],
  ['demo-spade', 'Spade スペード spin', svg(CPU, `<g>${spin(160, 120, 1.6)}<text x="160" y="160" ${T} font-size="140" fill="${INK}">♠</text></g>`)],
];
const ITEMS = ART.map(([slug, title, s]) => {
  const m = { url: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(s), video: false, w: W, h: H };
  return { slug, title, thumb: m, full: m };
});
export const DEMO_SLUGS = ITEMS.map(x => x.slug);

export const demo = {
  search(q, page, per) {
    const k = String(q || '').trim().toLowerCase();
    const all = k ? ITEMS.filter(x => x.title.toLowerCase().includes(k) || x.slug.includes(k)) : ITEMS;
    const from = (page - 1) * per;
    return Promise.resolve({ items: all.slice(from, from + per), next: from + per < all.length });
  },
  lookup: slugs => ITEMS.filter(x => slugs.includes(x.slug)),
};
