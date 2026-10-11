// ベットサイズの設定（端末ごと）と、ベットのシートに出す候補の計算。ルールではない（額の候補を作るだけ。合法かは legalActions）。
// 候補は '2.5bb' / '3x' / '33%' の文字列で持つ。場面は 4 つ：
//   open    プリフロップでまだレイズが無い（BB の何倍まで）
//   vsRaise プリフロップでレイズを受けた（x = 直前のレイズ額の何倍まで、bb = BB の何倍まで）
//   bet     ポストフロップでまだベットが無い（% = ポットの何 %）
//   vsBet   ポストフロップでベット/レイズを受けた（x = 直前のベット額の何倍まで、% = コールした後のポットの何 % を足すか）
export const STEPS = [0.1, 0.2, 0.5, 1, 2, 5];   // スライダーの刻み（BB）
export const MAX_ITEMS = 15;
export const SCENES = ['open', 'vsRaise', 'bet', 'vsBet'];
export const UNITS = { open: ['bb'], vsRaise: ['x', 'bb'], bet: ['%'], vsBet: ['x', '%'] };
const LIMIT = { bb: [1, 1000], x: [1.1, 100], '%': [1, 1000] };

export const DEFAULT_SIZES = Object.freeze({
  step: 0.5,
  open: ['2bb', '2.5bb', '3bb'],
  vsRaise: ['2x', '2.5x', '3x'],
  bet: ['33%', '50%', '67%', '100%'],
  vsBet: ['2x', '2.5x', '3x', '4x'],
});
export const defaultSizes = () => structuredClone(DEFAULT_SIZES);

/** '2.5x' → { v: 2.5, u: 'x' }（形が違えば null） */
export function parseSize(s) {
  const m = /^(\d+(?:\.\d+)?)(bb|x|%)$/.exec(String(s));
  return m ? { v: +m[1], u: m[2] } : null;
}
/** 数と単位から候補を作る（範囲外・単位違いは null）。bb と x は小数 2 桁、% は整数 */
export function makeSize(scene, v, u) {
  if (!UNITS[scene]?.includes(u)) return null;
  const n = u === '%' ? Math.round(+v) : Math.round(+v * 100) / 100;
  if (!Number.isFinite(n) || n < LIMIT[u][0] || n > LIMIT[u][1]) return null;
  return n + u;
}
/** 単位の順（UNITS の並び）→ 値の小さい順 */
export function sortSizes(scene, list) {
  const ord = UNITS[scene];
  return list.slice().sort((a, b) => { const p = parseSize(a), q = parseSize(b); return ord.indexOf(p.u) - ord.indexOf(q.u) || p.v - q.v; });
}
/** 保存されていたもの（壊れていてもよい）→ 正しい設定。足りないところは既定値 */
export function normalizeSizes(raw) {
  const d = defaultSizes(), out = { step: STEPS.includes(raw?.step) ? raw.step : d.step };
  for (const sc of SCENES) {
    const src = raw && Array.isArray(raw[sc]) ? raw[sc] : d[sc], seen = new Set();
    const ok = [];
    for (const s of src) { const p = parseSize(s), n = p && makeSize(sc, p.v, p.u); if (n && !seen.has(n)) { seen.add(n); ok.push(n); } }
    out[sc] = sortSizes(sc, ok).slice(0, MAX_ITEMS);
  }
  return out;
}

/** いまの場面。l = legalActions、h = ビューの hand */
export const sceneOf = (l, h) => h.street === 0 ? (l.streetLastBetTo > h.bb ? 'vsRaise' : 'open') : (l.aggression === 'bet' ? 'bet' : 'vsBet');

/** 候補 1 つの「〜まで」の額（チップ） */
export function sizeTo(size, l, h) {
  const p = parseSize(size); if (!p) return null;
  const last = l.streetLastBetTo;
  if (p.u === 'bb') return Math.round(p.v * h.bb);
  if (p.u === 'x') return Math.round(p.v * Math.max(last, h.bb));
  // %：ベットはポットの割合。レイズはコールした後のポット（pot + toCall）の割合を、直前のベットに足す
  return last + Math.round(p.v / 100 * (l.pot + l.toCall));
}

/** シートの候補 [[ラベル, 額]]：Min と、設定の中で Min と All-in の間に入るもの（同じ額は 1 つ）。All-in は含めない */
export function quickSizes(l, h, sizes) {
  const lo = l.minTo, hi = l.maxTo, list = [['Min', lo]];
  for (const s of (sizes[sceneOf(l, h)] || [])) {
    const x = sizeTo(s, l, h);
    if (x > lo && x < hi && !list.some(q => q[1] === x)) list.push([s, x]);
  }
  return list.sort((a, b) => a[1] - b[1]);
}

/** スライダーの刻み（チップ）。最低 1 */
export const stepChips = (sizes, bb) => Math.max(1, Math.round(sizes.step * bb));
