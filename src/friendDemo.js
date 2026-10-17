// デモ（?demo）と開発中の ?fake で見せる、FRIEND MATCH のスタッツとランキングの見本（src/fakeNet.js が読む）。
// aggregate は RPC friend_stats（db/migrations/20261012000000_friend.sql）と同じ形を同じ数え方で作る（テストで DB の返り値と突き合わせる）。
import { MODE_IDS, payoutsFor } from './structure.js';
import { dayOf } from './friend.js';
import { seeded } from './rnd.js';

const DAY_MS = 86_400_000;
/** シーズン（日本時間の暦月。'2026-10'） */
export const seasonAt = ms => dayOf(ms).slice(0, 7);
/** 見本での識別子（名前から。本物は uid のハッシュ） */
export const demoKey = name => 'k-' + String(name).toLowerCase();

/** 結果の行 [{ k, name, mode, at, p（卓の人数）, place, pt, hands, vpip, pfr }] から、RPC friend_stats と同じ返り値を作る */
export function aggregate(rows, { me, mode, season = null }) {
  const mine = rows.filter(r => r.mode === mode);
  const seasons = [...new Set(mine.map(r => seasonAt(r.at)))].sort((a, b) => a.localeCompare(b));
  const picked = seasons.includes(season) ? season : seasons.at(-1) ?? null;
  const names = new Map(mine.map(r => [r.k, r.name])), agg = new Map();
  for (const r of mine) {
    const s = seasonAt(r.at), key = `${s}|${r.k}|${r.p}`;
    if (!agg.has(key)) agg.set(key, { s, k: r.k, p: r.p, n: 0, pt: 0, plus: 0, first: 0, place: 0, dist: [0, 0, 0, 0, 0, 0], hands: 0, vpip: 0, pfr: 0 });
    const a = agg.get(key);
    a.n++; a.pt += r.pt; a.plus += Number(r.pt > 0); a.first += Number(r.place === 1); a.place += r.place;
    a.dist[r.place - 1]++; a.hands += r.hands; a.vpip += r.vpip; a.pfr += r.pfr;
  }
  return {
    me, mode, season: picked, seasons,
    members: [...names].map(([k, name]) => ({ k, name })).sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase())),
    agg: [...agg.values()].map(a => ({ ...a, pt: Math.round(a.pt * 100) / 100 })),   // pt は小数 2 桁（DB の numeric の合計と同じ値にする）
    games: mine.filter(r => seasonAt(r.at) === picked).sort((a, b) => a.at - b.at || a.place - b.place).map(r => ({ k: r.k, at: r.at, p: r.p, place: r.place, pt: r.pt })),
  };
}

const NAMES = ['Mika', 'Kenta', 'Yui', 'Sora', 'Riku', 'Hana', 'Daichi', 'Emi', 'Taro', 'Nana', 'Akira'];
const GAMES = 320, SPAN_DAYS = 100;
// 卓の人数（4〜6 人が多く、2・3 人も混ざる）
const SEATS = [2, 3, 4, 4, 5, 5, 6, 6];
// よく遊ばれるモードほど多く（クラブが半分）
const MODE_WEIGHTS = MODE_IDS.map(m => (m === 'club' ? 6 : 1));
function pickMode(x) {
  let rest = x * MODE_WEIGHTS.reduce((a, b) => a + b, 0);
  return MODE_IDS.find((_, i) => { rest -= MODE_WEIGHTS[i]; return rest < 0; }) ?? 'club';
}
/** 見本の結果（me = 自分の名前。now から 100 日前までの 320 試合。種から決まるので、読み込み直しても同じ並び） */
export function sampleRows(me, now = Date.now()) {
  const r = seeded(20261012), rows = [], names = [me, ...NAMES];
  const skill = names.map(() => r()), loose = names.map(() => 0.16 + r() * 0.2);
  for (let i = 0; i < GAMES; i++) {
    const at = now - Math.floor((1 - i / GAMES) * SPAN_DAYS * DAY_MS + r() * DAY_MS), mode = pickMode(r()), players = SEATS[Math.floor(r() * SEATS.length)];
    // 自分は 6 割の試合に出る。ほかは強さに少しの運を足した順に並べて、上から順位を付ける
    const others = names.map((_, s) => s).slice(1).map(s => [r(), s]).sort((a, b) => a[0] - b[0]).map(x => x[1]);
    const seats = (r() < 0.6 ? [0, ...others] : others).slice(0, players);
    const order = seats.map(s => [skill[s] * 0.5 + r(), s]).sort((a, b) => b[0] - a[0]).map(x => x[1]);
    const pay = payoutsFor({ mode, players: order.length });
    order.forEach((s, p) => {
      const hands = Math.round((18 + r() * 40) * (1 - p / (players * 1.6))), vpip = Math.round(hands * loose[s]);
      rows.push({ k: demoKey(s === 0 ? 'me' : names[s]), name: names[s], mode, at, p: players, place: p + 1, pt: pay[p], hands, vpip, pfr: Math.round(vpip * 0.6) });
    });
  }
  return rows;
}
