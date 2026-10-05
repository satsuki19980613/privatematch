// 成績の集計（pocket-ICM の packages/app/src/sng/stats.ts と同じ定義）。入力は端末に保存した試合（store の games）。すべて純関数。
import { netOfRecord } from './hand.js';

export const PERIODS = [
  { key: 'last100', label: '直近100' },
  { key: 'last500', label: '直近500' },
  { key: 'last1k', label: '直近1000' },
  { key: 'all', label: '全期間' },
];

/** 集計の対象（最後まで打った試合）を endedAt の昇順で */
export const finishedGames = games => games.filter(g => g.status === 'finished' && g.place != null).sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));

/** 期間で絞る（入力も出力も昇順） */
export function filterByPeriod(recs, period) {
  switch (period) {
    case 'last100': return recs.slice(-100);
    case 'last500': return recs.slice(-500);
    case 'last1k': return recs.slice(-1000);
    default: return recs.slice();
  }
}

/** 累計 pt の時系列（x = 1 始まりの試合数） */
export function cumulativePt(results) {
  let sum = 0;
  return results.map((r, i) => { sum += r.pt ?? 0; return { x: i + 1, y: sum }; });
}

/** 直近 n 試合の順位（古い → 新しい） */
export const recentPlaces = (results, n = 10) => results.slice(-n).map(r => r.place);

/** 成績の集計 */
export function summarize(results) {
  const n = results.length;
  let placeSum = 0, firstN = 0, cashN = 0, totalPt = 0, maxPlayers = 0;
  const placeDist = [0, 0, 0, 0, 0, 0];
  for (const r of results) {
    placeSum += r.place;
    if (r.place === 1) firstN++;
    if ((r.pt ?? 0) > 0) cashN++;
    totalPt += r.pt ?? 0;
    if (r.place >= 1 && r.place <= 6) placeDist[r.place - 1]++;
    maxPlayers = Math.max(maxPlayers, r.config ? r.config.players : 0);
  }
  return {
    games: n, avgPlace: n ? placeSum / n : 0, firstRate: { n: firstN, d: n }, cashRate: { n: cashN, d: n },
    totalPt, placeDist, maxPlayers, firstPlayedAt: n ? results[0].endedAt : null, lastPlayedAt: n ? results[n - 1].endedAt : null,
  };
}
/** 比率の表示（小数 1 桁の %。分母 0 は –） */
export const pctLabel = r => (r.d ? ((r.n / r.d) * 100).toFixed(1) : '–');

/** ハンドの集計（VPIP / PFR / 勝ったハンド / 収支 bb）。hands はその人の視点の記録（hole あり） */
export function handStats(hands, seatOf) {
  let n = 0, vpip = 0, pfr = 0, won = 0, netBb = 0;
  for (const h of hands) {
    const s = seatOf(h);
    if (s == null || !(h.startStacks[s] > 0)) continue;
    n++;
    const pre = h.actions.filter(a => a.seat === s && a.street === 0 && !a.auto);
    if (pre.some(a => a.kind === 'call' || a.kind === 'bet' || a.kind === 'raise' || (a.kind === 'allin' && a.put > 0))) vpip++;
    if (pre.some(a => a.kind === 'bet' || a.kind === 'raise' || (a.kind === 'allin' && a.betTo > (h.bb || 0)))) pfr++;
    const net = netOfRecord(h, s);
    if (net > 0) won++;
    netBb += net / (h.bb || 1);
  }
  return { hands: n, vpip: { n: vpip, d: n }, pfr: { n: pfr, d: n }, won: { n: won, d: n }, netBb };
}

/** 縦軸の目盛り（きりのよい値） */
export function niceTicks(min, max, count = 5) {
  const span = max - min || 1, raw = span / Math.max(1, count - 1), mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map(k => k * mag).find(s => s >= raw) || 10 * mag;
  const out = []; for (let v = Math.floor(min / step) * step; v < max + step - 1e-9; v += step) out.push(Math.round(v * 1000) / 1000);
  return out;
}
