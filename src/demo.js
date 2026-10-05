// デモ（https://…/?demo）：ログインもサーバーも使わずに全画面を見る。STATS と HAND HISTORY にはサンプルの記録を入れる。
// 記録は本物とは別の IndexedDB（privatematch-demo。history/store.js）に入るので、本当の成績には混ざらない。
// サンプルは本物のエンジンで打った試合（だいたいチェック/コール、ときどきレイズ・オールイン）。?demo=reset で作り直す。
import { newTable, legalActions, act, tick, dueAt, handRecord } from './engine.js';
import { PLAYER_COUNTS, START_BBS, SPEEDS, MODE_IDS, payoutsFor } from './structure.js';
import * as store from './history/store.js';

const GAMES = 120;
const ME = 'Satsuki';
const NAMES = ['Mika', 'Kenta', 'Yui', 'Sora', 'Riku', 'Hana', 'Daichi', 'Emi', 'Taro', 'Nana'];
const pick = (a, r) => a[Math.floor(r() * a.length)];

// 種から決まる乱数（作り直しても同じサンプルになる）
function mulberry(seed) {
  return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function move(st, seat, r, style) {
  const L = legalActions(st, seat), x = r(), stack = st.players[seat].stack;
  if (L.canFold && L.callPut > stack * 0.4 && x < 0.6) return { type: 'fold' };
  if (L.canFold && x < style.fold) return { type: 'fold' };
  if (L.minTo != null && x > 1 - style.raise) return x > 0.985 ? { type: 'allin' } : { type: 'raise', to: Math.min(L.maxTo, L.minTo + Math.floor(r() * 3) * st.hand.bb) };
  return L.canCheck ? { type: 'check' } : { type: 'call' };
}

/** 1 試合を最後まで打って、端末に保存する形（store の games / hands）にする */
function playGame(i, startAt, r) {
  const players = pick(PLAYER_COUNTS, r);
  const config = { players, startBb: pick(START_BBS, r), speed: pick(SPEEDS, r), mode: pick(MODE_IDS, r) };
  const seat = Math.floor(r() * players);
  const others = NAMES.slice().sort(() => r() - 0.5);
  const names = Array.from({ length: players }, (_, s) => (s === seat ? ME : others.pop()));
  const styles = names.map(() => ({ fold: 0.05 + r() * 0.2, raise: 0.08 + r() * 0.2 }));
  let now = startAt;
  const st = newTable({ config, names, now, rnd: r });
  const roomId = `demo-${String(i).padStart(4, '0')}`, hands = [];
  for (let guard = 0; guard < 20000 && st.status === 'running'; guard++) {
    const h = st.hand;
    if (h && h.phase === 'betting' && h.toAct != null) {
      now += 2000 + Math.floor(r() * 6000);
      act(st, h.toAct, move(st, h.toAct, r, styles[h.toAct]), now);
    } else {
      now = Math.max(now, dueAt(st) ?? now);
      tick(st, now);
    }
    const prev = hands[hands.length - 1];
    const rec = handRecord(st);
    if (rec && (!prev || prev.handNo !== rec.rec.handNo)) hands.push({ ...rec.rec, hole: rec.holes[seat], roomId });
  }
  const me = st.players[seat];
  const game = {
    roomId, code: String(100000 + Math.floor(r() * 900000)), kind: r() < 0.6 ? 'private' : 'free', config, seat, names,
    players: st.players.map((p, s) => ({ name: names[s], place: p.place, pt: p.pt })),
    place: me.place, pt: me.pt ?? payoutsFor(config)[me.place - 1] ?? 0, status: st.status, startedAt: startAt, endedAt: st.endedAt ?? now, hands: hands.length,
  };
  return { game, hands, endedAt: game.endedAt };
}

/** デモの記録が空なら（または ?demo=reset なら）サンプルを入れる */
export async function seed() {
  const reset = new URLSearchParams(location.search).get('demo') === 'reset';
  if (!reset && (await store.allGames()).length) return;
  if (reset) await store.clearAll();
  const r = mulberry(20261005);
  let t = Date.now() - 90 * 86400_000;
  for (let i = 0; i < GAMES; i++) {
    const { game, hands, endedAt } = playGame(i, t, r);
    await store.putHands(game.roomId, hands);
    await store.putGame(game);
    t = endedAt + Math.floor((90 * 86400_000) / GAMES * (0.3 + r()));
  }
  // 途中で中止になった試合も 1 つ
  await store.putGame({ roomId: 'demo-cancel', code: '424242', kind: 'free', config: { players: 4, startBb: 100, speed: 'normal', mode: 'club' }, seat: 0,
    names: [ME, 'Mika', 'Kenta', 'Yui'], players: [ME, 'Mika', 'Kenta', 'Yui'].map(name => ({ name, place: null, pt: null })), place: null, pt: null,
    status: 'cancelled', startedAt: t, endedAt: t + 600_000, hands: 0 });
}
