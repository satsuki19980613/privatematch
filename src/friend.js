// FRIEND MATCH のスタッツとランキングの集計（純関数）。入力は RPC friend_stats の返り値（db/migrations/20261017000000_friend_by_seats.sql）：
//   { me, mode, season, seasons: ['2026-10'], members: [{ k, name }], agg: [{ s, k, p, n, pt, plus, first, place, dist, hands, vpip, pfr }], games: [{ k, at, p, place, pt }] }
//   p は卓の人数（2〜6）。順位（平均順位・1 位率・順位の分布）は人数の違う卓どうしでは比べられないので、人数を選んだときだけ出し、
//   すべての卓では人数ごとの表（placeRows）にする。pt は人数によらず公平（payoutsFor）なので、人数をまたいで足す
// 指標（Kagaribi Stat Hub と同じ定義。クラブマッチ以外のモードにも当てはまるよう、加点は「pt が + の順位」）：
//   平均 pt = 合計 pt ÷ 参加数、加点率 = pt > 0 の回数 ÷ 参加数、1 位率 = 1 位の回数 ÷ 参加数、平均順位 = 順位の平均、
//   生存ターン = ハンド数 ÷ VPIP(%) × 100 ÷ 参加数（src/history/stats.js の survivalTurns と同じ）
// シーズンは日本時間の暦月（'2026-10'）。モードをまたいで混ぜない（RPC がモードごとに返す）。
import { survivalTurns, ALL, SEATS } from './history/stats.js';

/** ALL = 通算（全シーズンの合計）・すべての人数。卓の人数の決まりは src/history/stats.js と同じ */
export { ALL, SEATS, seatsLabel, parseSeats } from './history/stats.js';
/** グラフで強調できる人数（色の数。src/style.css の --fs1〜--fs6） */
export const MAX_FOCUS = 6;
const JST_MS = 9 * 3_600_000;
const SEASON = /^\d{4}-\d{2}$/;

/** シーズンの表示（'2026-10' → '2026年10月'、通算は '通算'） */
export const seasonLabel = s => (SEASON.test(s) ? `${+s.slice(0, 4)}年${+s.slice(5)}月` : '通算');
/** グラフの軸に出す短い表示（'2026-10' → "26/10"） */
export const seasonShort = s => `${s.slice(2, 4)}/${+s.slice(5)}`;
/** 日本時間の日付（'2026-10-12'） */
export const dayOf = ms => new Date(ms + JST_MS).toISOString().slice(0, 10);
/** 日付の短い表示（'2026-10-12' → '10/12'） */
export const dayShort = d => `${+d.slice(5, 7)}/${+d.slice(8)}`;

const COUNTS = ['n', 'pt', 'plus', 'first', 'place', 'hands', 'vpip', 'pfr'];
const blank = () => ({ n: 0, pt: 0, plus: 0, first: 0, place: 0, hands: 0, vpip: 0, pfr: 0, dist: [0, 0, 0, 0, 0, 0] });
function addTo(sum, a) {
  for (const key of COUNTS) sum[key] += +a[key] || 0;
  sum.dist = sum.dist.map((c, i) => c + (+a.dist?.[i] || 0));
  return sum;
}
const ratio = (num, den) => (den ? num / den : null);
// pt は小数 2 桁まで（src/structure.js の payoutsFor）。足し上げた誤差を落として、同じ合計を同じ値にする
const round2 = v => Math.round(v * 100) / 100;

/** 集計の値から指標を出す。参加 0 なら率と平均は null */
export function metricsOf(a) {
  const pt = round2(a.pt);
  return {
    ...a, pt, avg: ratio(pt, a.n), plusRate: ratio(a.plus, a.n), firstRate: ratio(a.first, a.n), avgPlace: ratio(a.place, a.n),
    vpipRate: ratio(a.vpip, a.hands), pfrRate: ratio(a.pfr, a.hands), survival: survivalTurns(a.hands, { n: a.vpip, d: a.hands }, a.n),
  };
}

/** そのモードで打たれた卓の人数（小さい順） */
export const seatsOf = data => SEATS.filter(p => (data.agg ?? []).some(a => +a.p === p));
const inSeats = (x, seats) => seats === ALL || +x.p === seats;

/** メンバーごとの行（season = シーズン | ALL、seats = 卓の人数 | ALL）。=> [{ k, name, me, …指標 }]。そこに 1 試合も無い人は含めない */
export function memberRows(data, season = ALL, seats = ALL) {
  const sums = new Map();
  for (const a of data.agg ?? []) {
    if ((season !== ALL && a.s !== season) || !inSeats(a, seats)) continue;
    if (!sums.has(a.k)) sums.set(a.k, blank());
    addTo(sums.get(a.k), a);
  }
  return (data.members ?? []).filter(m => sums.has(m.k)).map(m => ({ k: m.k, name: m.name, me: m.k === data.me, ...metricsOf(sums.get(m.k)) }));
}

/**
 * その人の順位を卓の人数ごとに（season = シーズン | ALL）。=> [{ p, n, first, place, dist（1〜p 位の回数）, firstRate, avgPlace }]（人数の小さい順。打っていない人数は含めない）
 */
export function placeRows(data, k, season = ALL) {
  return seatsOf(data).flatMap(p => {
    const r = memberRows(data, season, p).find(x => x.k === k);
    return r ? [{ p, n: r.n, first: r.first, place: r.place, dist: r.dist.slice(0, p), firstRate: r.firstRate, avgPlace: r.avgPlace }] : [];
  });
}

/** 全員ぶんの合計と指標（生存ターンは、値のある人の平均）。players = 1 試合以上打った人数 */
export function totalOf(rows) {
  const t = metricsOf(rows.reduce(addTo, blank())), surv = rows.map(r => r.survival).filter(v => v != null);
  return { ...t, players: rows.length, survival: surv.length ? surv.reduce((a, b) => a + b, 0) / surv.length : null };
}

const byName = (a, b) => a.name.localeCompare(b.name, 'ja');
// ランキングの比べ方：合計 pt の多い順 → 平均 pt の高い順 → 参加の多い順。
// pt は人数によらず公平（payoutsFor）。順位そのものは少ない人数の卓ほど良く出るので、比べるのには使わない
const rankCmp = (a, b) => b.pt - a.pt || b.avg - a.avg || b.n - a.n;
/** ランキング（rank を足す。合計 pt・平均 pt・参加数がすべて同じなら同じ順位） */
export function ranking(rows) {
  const sorted = [...rows].sort((a, b) => rankCmp(a, b) || byName(a, b));
  let rank = 0;
  return sorted.map((r, i) => {
    if (i === 0 || rankCmp(sorted[i - 1], r) !== 0) rank = i + 1;
    return { ...r, rank };
  });
}

/** 表の列（並べ替えのキー）。lowBetter = 小さいほど良い、place = 順位の指標（人数を選んだときだけ） */
export const COLUMNS = [
  { key: 'pt', label: '合計' },
  { key: 'avg', label: '平均' },
  { key: 'plusRate', label: '加点率' },
  { key: 'firstRate', label: '1位率', place: true },
  { key: 'avgPlace', label: '平均順位', lowBetter: true, place: true },
  { key: 'n', label: '参加' },
  { key: 'survival', label: '生存T' },
];
/** その人数で出す列（すべての卓では順位の列を出さない） */
export const columnsFor = seats => COLUMNS.filter(c => seats !== ALL || !c.place);
/** 並べ替え（key = 'name' か COLUMNS のキー。desc = 良い順。値の無い人は最後） */
export function sortRows(rows, key, desc = true) {
  if (key === 'name') { const sign = desc ? 1 : -1; return [...rows].sort((a, b) => sign * byName(a, b)); }
  const flip = COLUMNS.find(c => c.key === key)?.lowBetter ? !desc : desc;
  return [...rows].sort((a, b) => {
    if (a[key] == null || b[key] == null) return Number(a[key] == null) - Number(b[key] == null) || byName(a, b);
    return (flip ? b[key] - a[key] : a[key] - b[key]) || byName(a, b);
  });
}

/**
 * シーズン内の累積 pt（seats = 卓の人数 | ALL）。days = 試合のあった日（日本時間・古い順）、series = k → その日までの合計、
 * avg = メンバー平均（その日までの全員の合計 ÷ そのシーズンに 1 試合以上打った人数）
 */
export function cumulative(allGames, seats = ALL) {
  const games = allGames.filter(g => inSeats(g, seats)), days = [...new Set(games.map(g => dayOf(g.at)))].sort((a, b) => a.localeCompare(b));
  const at = new Map(days.map((d, i) => [d, i])), perDay = new Map();
  for (const g of games) {
    if (!perDay.has(g.k)) perDay.set(g.k, new Array(days.length).fill(0));
    perDay.get(g.k)[at.get(dayOf(g.at))] += +g.pt || 0;
  }
  return { days, ...accumulate(perDay, days.length) };
}
// k → 区切りごとの値（null は 0）を足し上げ、全員の平均も出す
function accumulate(per, len) {
  const series = new Map();
  for (const [k, v] of per) {
    let sum = 0;
    series.set(k, v.map(x => { sum += x ?? 0; return sum; }));
  }
  const avg = Array.from({ length: len }, (_, i) => [...series.values()].reduce((a, v) => a + v[i], 0) / series.size);
  return { series, avg };
}
/** 通算の累積 pt（シーズンごとの合計を足し上げる）。=> { seasons, series, avg }（形は cumulative と同じ。1 試合も無い人は含めない） */
export function cumulativeSeasons(data, seats = ALL) {
  const t = trend(data, 'pt', seats), played = new Map([...t.series].filter(([, v]) => v.some(x => x != null)));
  return { seasons: t.seasons, ...accumulate(played, t.seasons.length) };
}

/** シーズン推移で選べる指標（place = 順位の指標。人数を選んだときだけ） */
export const TREND_METRICS = [
  { key: 'pt', label: '合計ポイント', unit: 'pt' },
  { key: 'avg', label: '平均ポイント', unit: 'pt' },
  { key: 'plusRate', label: '加点率', unit: '%' },
  { key: 'firstRate', label: '1位率', unit: '%', place: true },
  { key: 'avgPlace', label: '平均順位', unit: '位', place: true },
  { key: 'survival', label: '生存ターン', unit: 'ターン' },
];
/** その人数で選べる指標 */
export const trendMetricsFor = seats => TREND_METRICS.filter(m => seats !== ALL || !m.place);
const isRate = key => key === 'plusRate' || key === 'firstRate';
/**
 * シーズンごとの指標（seats = 卓の人数 | ALL）。series = k → シーズンごとの値（参加の無いシーズンは null。率は %）、
 * avg = そのシーズンに値のある人の平均（誰にも無ければ null）
 */
export function trend(data, key, seats = ALL) {
  const seasons = data.seasons ?? [], series = new Map((data.members ?? []).map(m => [m.k, seasons.map(() => null)]));
  seasons.forEach((s, i) => {
    for (const r of memberRows(data, s, seats)) {
      if (r[key] != null) series.get(r.k)[i] = isRate(key) ? r[key] * 100 : r[key];
    }
  });
  const avg = seasons.map((_, i) => {
    const vs = [...series.values()].map(v => v[i]).filter(v => v != null);
    return vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : null;
  });
  return { seasons, series, avg };
}

/* ---------- グラフで強調する人と、その色（slot 0〜5）。色は選んだときに空いている最小の slot で、外すまで変えない（順位で塗り替えない） ---------- */
export function toggleFocus(focus, k) {
  if (focus.some(f => f.k === k)) return focus.filter(f => f.k !== k);
  if (focus.length >= MAX_FOCUS) return [...focus];
  const used = new Set(focus.map(f => f.slot));
  let slot = 0;
  while (used.has(slot)) slot++;
  return [...focus, { k, slot }];
}
export const slotOf = (focus, k) => focus.find(f => f.k === k)?.slot ?? null;
/** 端末に覚えた値を読み直す（壊れた行・同じ色の重複は捨てる） */
export function parseFocus(raw) {
  let v = null;
  try { v = JSON.parse(raw); } catch { /* 壊れていれば空 */ }
  const out = [], slots = new Set();
  for (const e of Array.isArray(v) ? v : []) {
    const ok = typeof e?.k === 'string' && e.k.length <= 64 && Number.isInteger(e.slot) && e.slot >= 0 && e.slot < MAX_FOCUS;
    if (!ok || slots.has(e.slot) || out.some(f => f.k === e.k)) continue;
    slots.add(e.slot); out.push({ k: e.k, slot: e.slot });
  }
  return out;
}

/* ---------- 表示 ---------- */
/** 率（0〜1）→ '45.0%'。null は '–' */
export const fmtRate = v => (v == null ? '–' : `${(v * 100).toFixed(1)}%`);
/** 数値 → 小数 digits 桁。null は '–' */
export const fmtNum = (v, digits = 2) => (v == null ? '–' : v.toFixed(digits));
