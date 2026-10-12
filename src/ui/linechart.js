// 折れ線グラフ（強調した人の線 + メンバー平均の破線）。FRIEND MATCH のスタッツで使う。
//   chart = { labels: [横軸], series: [{ name, slot（色 0〜5）, values: [数値 | null] }], avg: [数値 | null] | null,
//             fmt: 値の表示, tick: 目盛りの表示（無ければ fmt）, zero: 縦軸に 0 を必ず含める, aria: 読み上げの名前, empty: データが無いときの文 }
// 値が null の所は線を切る。点が少ないとき（12 個まで）は点の印も描く。色は系列（人）に付き、順位では塗り替えない（.s1〜.s6）。
// グラフを押す・なぞると、その位置の縦線と全系列の値を上に出す。
import { niceTicks } from '../history/stats.js';
import { esc } from './util.js';

const W = 360, H = 190, PL = 42, PR = 10, PT = 10, PB = 22, PW = W - PL - PR, PH = H - PT - PB;
const MARKER_MAX = 12;
const linesOf = c => [...c.series, ...(c.avg ? [{ avg: true, name: '平均', values: c.avg }] : [])];

function geometry(c) {
  const n = c.labels.length, vals = linesOf(c).flatMap(l => l.values).filter(v => v != null);
  let min = Infinity, max = -Infinity;
  for (const v of vals) { min = Math.min(min, v); max = Math.max(max, v); }
  if (c.zero || !vals.length) { min = Math.min(min, 0); max = Math.max(max, 0); }
  if (max - min < 1e-9) { max += 1; min -= 1; }
  const ticks = niceTicks(min, max), lo = Math.min(min, ticks[0]), hi = Math.max(max, ticks.at(-1));
  return { n, ticks, x: i => PL + (n <= 1 ? PW / 2 : (i / (n - 1)) * PW), y: v => PT + ((hi - v) / (hi - lo)) * PH };
}
// 値のある点をつなぐ（null で切る）
function pathOf(values, g) {
  let d = '', pen = false;
  values.forEach((v, i) => {
    if (v == null) { pen = false; return; }
    d += `${pen ? 'L' : 'M'}${g.x(i).toFixed(1)} ${g.y(v).toFixed(1)}`;
    pen = true;
  });
  return d;
}
const clsOf = l => (l.avg ? 'lc-avg' : `lc-s s${l.slot + 1}`);
function lineSVG(l, g) {
  const dots = g.n <= MARKER_MAX && !l.avg
    ? l.values.map((v, i) => (v == null ? '' : `<circle class="lc-dot ${clsOf(l)}" cx="${g.x(i).toFixed(1)}" cy="${g.y(v).toFixed(1)}" r="4"/>`)).join('') : '';
  return `<path class="lc-line ${clsOf(l)}" d="${pathOf(l.values, g)}"/>${dots}`;
}
// 横軸の名前は多くて 5 つ（最初・最後と、その間を等間隔に）
function xLabels(c, g) {
  const count = Math.min(5, g.n), out = [];
  for (let k = 0; k < count; k++) {
    const i = Math.round((k * (g.n - 1)) / Math.max(1, count - 1));
    let anchor = 'middle';
    if (g.n > 1 && k === 0) anchor = 'start';
    else if (g.n > 1 && k === count - 1) anchor = 'end';
    out.push(`<text class="hc-xlbl" x="${g.x(i).toFixed(1)}" y="${H - 6}" text-anchor="${anchor}">${esc(c.labels[i])}</text>`);
  }
  return out.join('');
}

export function lineChartHTML(c) {
  const g = geometry(c), tick = c.tick ?? c.fmt, has = linesOf(c).some(l => l.values.some(v => v != null));
  const grid = g.ticks.map(t => `<line class="hc-grid${t === 0 ? ' zero' : ''}" x1="${PL}" x2="${W - PR}" y1="${g.y(t).toFixed(1)}" y2="${g.y(t).toFixed(1)}"/>
    <text class="hc-ylbl" x="${PL - 5}" y="${(g.y(t) + 3).toFixed(1)}">${esc(tick(t))}</text>`).join('');
  return `<div class="hc lc"><div class="lc-read" data-read></div>
    <svg class="hc-svg" data-svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(c.aria)}">
      ${grid}${has ? xLabels(c, g) : ''}
      ${has ? linesOf(c).reverse().map(l => lineSVG(l, g)).join('') : `<text class="hc-empty" x="${W / 2}" y="${H / 2}" text-anchor="middle">${esc(c.empty ?? 'NO DATA')}</text>`}
      <g data-cur></g>
    </svg></div>`;
}

/** lineChartHTML を入れた要素 root に、なぞったときの表示を付ける */
export function bindLineChart(root, c) {
  const svg = root.querySelector('[data-svg]'), cur = root.querySelector('[data-cur]'), read = root.querySelector('[data-read]');
  if (!svg) return;
  const g = geometry(c), lines = linesOf(c);
  const clear = () => { cur.innerHTML = ''; read.innerHTML = ''; };
  const move = e => {
    if (!g.n) return;
    const r = svg.getBoundingClientRect(), xr = ((e.clientX - r.left) / r.width) * W;
    const i = Math.max(0, Math.min(g.n - 1, Math.round(g.n <= 1 ? 0 : ((xr - PL) / PW) * (g.n - 1))));
    const at = lines.filter(l => l.values[i] != null);
    cur.innerHTML = `<line class="hc-cursor" x1="${g.x(i)}" x2="${g.x(i)}" y1="${PT}" y2="${H - PB}"/>` +
      at.map(l => `<circle class="lc-dot lc-on ${clsOf(l)}" cx="${g.x(i)}" cy="${g.y(l.values[i])}" r="4"/>`).join('');
    read.innerHTML = `<b>${esc(c.labels[i])}</b>` + at.map(l => `<span class="lc-read-v ${clsOf(l)}"><i></i>${esc(l.name)} ${esc(c.fmt(l.values[i]))}</span>`).join('');
  };
  svg.onpointermove = move; svg.onpointerdown = move; svg.onpointerleave = clear;
}
