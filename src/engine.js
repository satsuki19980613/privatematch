// PrivateMatch のルールエンジン：2〜6 人の No-Limit Hold'em SIT & GO（ポーカーチェイスと同じ進行）。
// 仕様は docs/ARCHITECTURE.md §3（元は pocket-ICM の docs/SNG_DESIGN.md §1）。ブラウザ（?fake）とサーバー（Neon Function）で共有する。
// 状態 `st` は JSON にできる plain object。乱数はすべて状態の中の鍵（st.seed, st.ctr）から作る ChaCha20 の列なので、
// 同じシードなら同じ配札になり、保存した状態から続きを再現できる。
// 関数は `st` をその場で書き換えて返す。違法な呼び出しは EngineError を投げ、そのとき `st` は変わらない。
import {
  blindsAt, nextLevel, levelMsOf, payoutsFor, normalizeConfig, BASE_BB,
  ACTION_MS, TIME_BANK_MS, AUTO_TO_SITOUT, BETWEEN_HANDS_MS, PAUSED_EXPIRES_MS, runoutMs, FX_MS,
} from './structure.js';

export const RANKCH = '23456789TJQKA';
export const SUITCH = ['♠', '♥', '♦', '♣'];
export const SUITEN = ['s', 'h', 'd', 'c'];
/** カードは整数 0..51。rank = c >> 2（0='2' … 12='A'）、suit = c & 3（0♠ 1♥ 2♦ 3♣） */
export const cardStr = c => RANKCH[c >> 2] + SUITCH[c & 3];

export class EngineError extends Error {
  constructor(code, message) { super(message || code); this.name = 'EngineError'; this.code = code; }
}

/* ---------------- 役の評価（ビット演算。表を持たない） ---------------- */
// score = category << 20 | 4bit × 5 のランク（0='2' … 12='A'。ホイールは 5 ハイ = 3）。大きいほど強い。
// category: 0 High Card, 1 Pair, 2 Two Pair, 3 Three of a Kind, 4 Straight, 5 Flush, 6 Full House, 7 Four of a Kind, 8 Straight Flush.
const hb = m => 31 - Math.clz32(m);
function take(m, n) { let v = 0; for (let i = 0; i < n; i++) { const h = hb(m); v = (v << 4) | h; m ^= 1 << h; } return v; }
function straightTop(m) {
  const x = (m << 1) | (m >> 12);
  const t = x & (x >> 1) & (x >> 2) & (x >> 3) & (x >> 4);
  return t ? hb(t) + 3 : -1;
}
export function eval7(cards) {
  let s0 = 0, s1 = 0, s2 = 0, s3 = 0, n0 = 0, n1 = 0, n2 = 0, n3 = 0, one = 0, two = 0, three = 0, four = 0;
  for (let i = 0; i < cards.length; i++) {
    const c = cards[i], b = 1 << (c >> 2);
    switch (c & 3) { case 0: s0 |= b; n0++; break; case 1: s1 |= b; n1++; break; case 2: s2 |= b; n2++; break; default: s3 |= b; n3++; }
    four |= three & b; three |= two & b; two |= one & b; one |= b;
  }
  const fm = n0 >= 5 ? s0 : n1 >= 5 ? s1 : n2 >= 5 ? s2 : n3 >= 5 ? s3 : 0;
  if (fm) { const t = straightTop(fm); if (t >= 0) return (8 << 20) | (t << 16); }
  if (four) { const q = hb(four); return (7 << 20) | (q << 16) | (hb(one & ~(1 << q)) << 12); }
  if (three) {
    const t = hb(three), rest = two & ~(1 << t);
    if (rest) return (6 << 20) | (t << 16) | (hb(rest) << 12);
  }
  if (fm) return (5 << 20) | take(fm, 5);
  const st = straightTop(one);
  if (st >= 0) return (4 << 20) | (st << 16);
  if (three) { const t = hb(three); return (3 << 20) | (t << 16) | (take(one & ~(1 << t), 2) << 8); }
  if (two) {
    const p1 = hb(two), r = two ^ (1 << p1);
    if (r) { const p2 = hb(r); return (2 << 20) | (p1 << 16) | (p2 << 12) | (hb(one & ~(1 << p1) & ~(1 << p2)) << 8); }
    return (1 << 20) | (p1 << 16) | (take(one & ~(1 << p1), 3) << 4);
  }
  return take(one, 5);
}
const HAND_NAMES = ['High Card', 'Pair', 'Two Pair', 'Three of a Kind', 'Straight', 'Flush', 'Full House', 'Four of a Kind', 'Straight Flush'];
export function handName(score) {
  const c = score >>> 20;
  if (c === 8 && ((score >>> 16) & 15) === 12) return 'Royal Flush';
  return HAND_NAMES[c];
}

/* ---------------- 乱数：ChaCha20 の鍵ストリーム（鍵 = st.seed 8 語、ブロックカウンタ = st.ctr） ---------------- */
const rotl = (x, n) => (x << n) | (x >>> (32 - n));
function qr(x, a, b, c, d) {
  x[a] = (x[a] + x[b]) | 0; x[d] = rotl(x[d] ^ x[a], 16);
  x[c] = (x[c] + x[d]) | 0; x[b] = rotl(x[b] ^ x[c], 12);
  x[a] = (x[a] + x[b]) | 0; x[d] = rotl(x[d] ^ x[a], 8);
  x[c] = (x[c] + x[d]) | 0; x[b] = rotl(x[b] ^ x[c], 7);
}
function chachaBlock(inp) {
  const x = Int32Array.from(inp);
  for (let i = 0; i < 10; i++) {
    qr(x, 0, 4, 8, 12); qr(x, 1, 5, 9, 13); qr(x, 2, 6, 10, 14); qr(x, 3, 7, 11, 15);
    qr(x, 0, 5, 10, 15); qr(x, 1, 6, 11, 12); qr(x, 2, 7, 8, 13); qr(x, 3, 4, 9, 14);
  }
  const out = new Uint32Array(16);
  for (let i = 0; i < 16; i++) out[i] = (x[i] + inp[i]) >>> 0;
  return out;
}
function stream(st) {
  const s = new Uint32Array(16);
  s[0] = 0x61707865; s[1] = 0x3320646e; s[2] = 0x79622d32; s[3] = 0x6b206574;
  for (let i = 0; i < 8; i++) s[4 + i] = st.seed[i];
  let blk = st.ctr, buf = null, i = 16;
  const next = () => {
    if (i === 16) { s[12] = blk >>> 0; s[13] = Math.floor(blk / 4294967296); buf = chachaBlock(s); blk++; i = 0; }
    return buf[i++];
  };
  return {
    below(n) { const lim = 4294967296 - (4294967296 % n); let w; do { w = next(); } while (w >= lim); return w % n; },
    done() { st.ctr = blk; },
  };
}
function freshDeck(st) {
  const s = stream(st), d = Array.from({ length: 52 }, (_, i) => i);
  for (let i = 51; i > 0; i--) { const j = s.below(i + 1); const t = d[i]; d[i] = d[j]; d[j] = t; }
  s.done();
  return d;
}

/* ---------------- 補助 ---------------- */
const seatsOf = st => Array.from({ length: st.n }, (_, i) => i);
const isLive = p => p.status !== 'out';
/** sitout / left の席は手番が来た瞬間に自動処理する（タイマー無し） */
const autoPlays = p => p.status === 'sitout' || p.status === 'left';
function nextLive(st, from) {
  for (let i = 1; i <= st.n; i++) { const s = (((from + i) % st.n) + st.n) % st.n; if (isLive(st.players[s])) return s; }
  throw new Error('nextLive: no live seat');
}
function nextActable(h, from) {
  const n = h.folded.length;
  for (let i = 1; i <= n; i++) { const s = (((from + i) % n) + n) % n; if (!h.folded[s] && !h.allIn[s]) return s; }
  return null;
}
const sum = a => a.reduce((x, y) => x + y, 0);
const bump = st => { st.ver++; return st; };

/* ---------------- 作成 ---------------- */
// opts: { config, names: [n 人], now, rnd?: () => [0,1)（シード用。無ければ crypto）, button?: 初回のボタン席（テスト用）,
//         stacks?: 開始スタック（テスト用。省略時は全員 startBb × BASE_BB）, fx?: [n 人]（席ごとの演出 GIF の slug か null。PRIVATE MATCH だけ） }
export function newTable({ config, names, now, rnd, button, stacks, fx }) {
  const cfg = normalizeConfig(config);
  if (!cfg) throw new Error('newTable: bad config');
  const n = cfg.players;
  if (!Array.isArray(names) || names.length !== n) throw new Error('newTable: names');
  const seed = [];
  if (rnd) for (let i = 0; i < 8; i++) seed.push(Math.floor(rnd() * 4294967296) >>> 0);
  else seed.push(...globalThis.crypto.getRandomValues(new Uint32Array(8)));
  const start = stacks ? stacks.slice() : Array(n).fill(cfg.startBb * BASE_BB);
  const st = {
    ver: 0, config: cfg, n, names: names.slice(), startedAt: now, levelStartAt: now,
    players: start.map(stack => ({ stack, status: 'active', timeBankMs: TIME_BANK_MS, autoCount: 0, place: null, pt: null })),
    handNo: 0, prevSbPos: null, prevBbSeat: null, seed, ctr: 0,
    hand: null, nextAt: null, status: 'running', pausedAt: null, endedAt: null, winner: null,
    fx: Array.isArray(fx) && fx.length === n && fx.some(x => typeof x === 'string') ? fx.map(x => (typeof x === 'string' ? x : null)) : null,
  };
  let b = button;
  if (b == null) { const s = stream(st); b = s.below(n); s.done(); }
  dealHand(st, now, b);
  return st;
}

/* ---------------- ボタン（デッドボタン） ---------------- */
// bb = nextLive(前の bb) ／ sb = 前の bb（飛んでいれば dead = SB 無し）／ btn = 前の SB の位置（飛んでいても席番号で数える）。
// 生存 2 人（HU）なら btn = sb（SB がボタン・プリフロップ先手・ポストフロップ後手）。
function positions(st, forcedBtn) {
  const live = seatsOf(st).filter(s => isLive(st.players[s]));
  if (live.length === 2) {
    if (forcedBtn != null) { const sb = forcedBtn; return { btn: sb, sbSeat: sb, sbPos: sb, bbSeat: live.find(s => s !== sb) }; }
    const bb = nextLive(st, st.prevBbSeat ?? -1), sb = live.find(s => s !== bb);
    return { btn: sb, sbSeat: sb, sbPos: sb, bbSeat: bb };
  }
  if (forcedBtn != null) { const sb = nextLive(st, forcedBtn); return { btn: forcedBtn, sbSeat: sb, sbPos: sb, bbSeat: nextLive(st, sb) }; }
  const bb = nextLive(st, st.prevBbSeat), sbPos = st.prevBbSeat;
  return { btn: st.prevSbPos, sbSeat: isLive(st.players[sbPos]) ? sbPos : null, sbPos, bbSeat: bb };
}

/* ---------------- 配る ---------------- */
function dealHand(st, now, forcedBtn) {
  const n = st.n, P = st.players;
  const pos = positions(st, forcedBtn);
  // レベルは前のハンドのレベルから。levelStartAt が無いのは以前の（開始からの経過時間で上がった）部屋
  const cur = st.hand ? st.hand.level : 1;
  const lv = nextLevel(st.config, cur, st.levelStartAt ?? st.startedAt + (cur - 1) * levelMsOf(st.config), now);
  const level = lv.level; st.levelStartAt = lv.levelStartAt;
  const { sb, bb, ante } = blindsAt(st.config.speed, level);
  const deck = freshDeck(st);
  const live = seatsOf(st).map(s => isLive(P[s]));
  const h = {
    handNo: st.handNo + 1, level, sb, bb, ante, btn: pos.btn, sbSeat: pos.sbSeat, bbSeat: pos.bbSeat,
    street: 0, deck, hole: Array(n).fill(null), board: [],
    startStacks: seatsOf(st).map(s => (live[s] ? P[s].stack : 0)),
    commits: Array(n).fill(0), streetBet: Array(n).fill(0),
    folded: live.map(x => !x), allIn: Array(n).fill(false),
    toAct: null, streetLastBetTo: 0, lastBetSize: bb, actions: [],
    turnStart: null, deadline: null, phase: 'betting',
    won: null, shown: null, names: null, eliminated: [], pots: null, runFrom: null, startedAt: now, endedAt: null,
  };
  st.hand = h; st.handNo = h.handNo; st.prevSbPos = pos.sbPos; st.prevBbSeat = pos.bbSeat; st.nextAt = null;
  const put = (s, amt) => { const pay = Math.min(amt, P[s].stack); P[s].stack -= pay; h.commits[s] += pay; return pay; };
  // アンティ（全員）→ ブラインドの順に min(stack, 額)。足りなければその時点でオールイン
  if (ante > 0) for (let s = 0; s < n; s++) if (live[s]) put(s, ante);
  if (pos.sbSeat !== null) h.streetBet[pos.sbSeat] = put(pos.sbSeat, sb);
  h.streetBet[pos.bbSeat] = put(pos.bbSeat, bb);
  for (let s = 0; s < n; s++) if (live[s] && P[s].stack === 0) h.allIn[s] = true;
  // 手札はボタンの次の席から
  for (let k = 1; k <= n; k++) { const s = (pos.btn + k) % n; if (live[s]) h.hole[s] = [deck.pop(), deck.pop()]; }
  // コールすべき額は BB 満額（BB がショートでオールインでも）。ただし動ける人が 1 人だけなら出ている最高額に合わせれば足りる
  const actable = seatsOf(st).filter(s => live[s] && !h.allIn[s]).length;
  h.streetLastBetTo = Math.max(...h.streetBet, actable >= 2 ? bb : 0);
  const first = nextActable(h, pos.bbSeat);
  if (first === null || shouldCloseStreet(h)) advanceStreets(st, now);
  else setTurn(st, first, now);
}

function setTurn(st, seat, now) {
  const h = st.hand;
  h.toAct = seat; h.turnStart = now; h.deadline = now + ACTION_MS + st.players[seat].timeBankMs;
}

/* ---------------- ストリートの進行 ---------------- */
// その席がこのストリートで最後に出した「〜まで」。まだ動いていなければ null
function lastBetToOf(h, s) {
  let v = null;
  for (const a of h.actions) if (a.street === h.street && a.seat === s) v = a.betTo;
  return v;
}
function isStreetComplete(h) {
  for (let s = 0; s < h.folded.length; s++) {
    if (h.folded[s] || h.allIn[s]) continue;
    const v = lastBetToOf(h, s);
    if (v === null || v !== h.streetLastBetTo) return false;
  }
  return true;
}
// 賭けられる相手がいない（動ける席が 1 人以下）なら、その人が他の席の額に追いついている限りストリートを閉じる
// （相手がショートのオールインなら、それ以上コールを求めない）
function shouldCloseStreet(h) {
  if (isStreetComplete(h)) return true;
  const act = []; for (let s = 0; s < h.folded.length; s++) if (!h.folded[s] && !h.allIn[s]) act.push(s);
  if (act.length === 0) return true;
  if (act.length > 1) return false;
  const me = act[0];
  let mx = 0; for (let s = 0; s < h.folded.length; s++) if (s !== me && !h.folded[s]) mx = Math.max(mx, h.streetBet[s]);
  return h.streetBet[me] >= mx;
}
const BOARD_COUNT = [0, 3, 4, 5];
function advanceStreets(st, now) {
  const h = st.hand;
  if (h.folded.filter(f => !f).length <= 1) return settle(st, now);
  // 動ける席が 1 人以下：ここで手札を表にして残りのボードを配る（画面はこの枚数からランアウトを見せる）
  if (h.runFrom == null && h.folded.filter((f, s) => !f && !h.allIn[s]).length <= 1) h.runFrom = h.board.length;
  while (shouldCloseStreet(h) && h.street < 3) {
    h.street++;
    while (h.board.length < BOARD_COUNT[h.street]) h.board.push(h.deck.pop());
    h.streetBet = h.streetBet.map(() => 0); h.streetLastBetTo = 0; h.lastBetSize = h.bb;
  }
  if (shouldCloseStreet(h)) return settle(st, now);
  const first = nextActable(h, h.btn);
  if (first === null) return settle(st, now);
  setTurn(st, first, now);
}

/* ---------------- 合法手 ---------------- */
// 画面のボタン出し分けとサーバーの検証で同じ関数を使う。山札を使わないのでビューにも使える。
// => null（その席の手番でない）| { seat, canFold, canCheck, toCall, callPut, minTo, maxTo, aggression, pot, streetLastBetTo }
//    minTo/maxTo はベット/レイズの「〜まで」（できなければ null）。maxTo = 自分のオールイン額。
export function legalActions(st, seat = st.hand && st.hand.toAct) {
  const h = st.hand;
  if (!h || st.status !== 'running' || h.phase !== 'betting' || seat == null || h.toAct !== seat) return null;
  const stack = st.players[seat].stack;
  if (h.folded[seat] || h.allIn[seat] || stack <= 0) return null;
  const my = h.streetBet[seat], toCall = Math.max(0, h.streetLastBetTo - my);
  const callPut = toCall > 0 ? Math.min(toCall, stack) : null;
  const rest = stack - (callPut ?? 0);
  let minTo = null, maxTo = null, aggression = null;
  // 相手が全員オールインならレイズしても意味がないので出さない
  const opp = h.folded.some((f, s) => s !== seat && !f && !h.allIn[s]);
  // すでに動いた席は、その後にフルレイズが入っていなければレイズできない（最小レイズ未満のオールインでは再開しない）
  const last = lastBetToOf(h, seat), reopened = last === null || h.streetLastBetTo - last >= Math.max(h.lastBetSize, h.bb);
  if (rest > 0 && opp && reopened) {
    const minInc = Math.min(Math.max(h.lastBetSize, h.bb), rest);
    minTo = h.streetLastBetTo + minInc; maxTo = h.streetLastBetTo + rest;
    aggression = h.streetLastBetTo > 0 ? 'raise' : 'bet';
  }
  return { seat, canFold: toCall > 0, canCheck: toCall === 0, toCall, callPut, minTo, maxTo, aggression, pot: sum(h.commits), streetLastBetTo: h.streetLastBetTo };
}

/* ---------------- アクション ---------------- */
// move: { type: 'fold' | 'check' | 'call' | 'raise' | 'allin', to?: 整数 }。raise は bet も兼ねる（to = そのストリートの「〜まで」）
function resolve(st, seat, move) {
  const L = legalActions(st, seat), h = st.hand;
  const bad = m => new EngineError('illegal', m);
  if (!L) throw new EngineError('not_your_turn');
  const type = move && move.type, my = h.streetBet[seat], stack = st.players[seat].stack;
  if (type === 'fold') { if (!L.canFold) throw bad('cannot fold'); return { kind: 'fold', betTo: h.streetLastBetTo, put: 0 }; }
  if (type === 'check') { if (!L.canCheck) throw bad('cannot check'); return { kind: 'check', betTo: h.streetLastBetTo, put: 0 }; }
  if (type === 'call') {
    if (L.callPut === null) throw bad('nothing to call');
    return { kind: L.callPut >= stack ? 'allin' : 'call', betTo: my + L.callPut, put: L.callPut };
  }
  if (type === 'allin') {
    if (L.maxTo !== null) return { kind: 'allin', betTo: L.maxTo, put: L.maxTo - my };
    // レイズできないときの allin はコール扱い（全額が入るときだけ kind を 'allin' にする）
    if (L.callPut !== null) return { kind: L.callPut >= stack ? 'allin' : 'call', betTo: my + L.callPut, put: L.callPut };
    throw bad('cannot go all-in');
  }
  if (type === 'raise') {
    const to = move.to;
    if (L.minTo === null) throw bad('cannot raise');
    if (!Number.isInteger(to) || to < L.minTo || to > L.maxTo) throw bad('raise out of range');
    return { kind: to >= L.maxTo ? 'allin' : L.aggression, betTo: to, put: to - my };
  }
  throw bad('unknown move');
}
function applyResolved(st, seat, r, auto, now) {
  const h = st.hand, p = st.players[seat];
  p.stack -= r.put; h.commits[seat] += r.put;
  if (r.kind !== 'fold' && r.kind !== 'check') h.streetBet[seat] = r.betTo;
  if (r.kind === 'fold') h.folded[seat] = true;
  if (p.stack === 0 && !h.folded[seat]) h.allIn[seat] = true;
  if (r.betTo > h.streetLastBetTo) {
    const inc = r.betTo - h.streetLastBetTo;
    // オールインが最小レイズに満たなければレイズ権は再開しない（lastBetSize を更新しない）
    if (r.kind !== 'allin' || inc >= Math.max(h.lastBetSize, h.bb)) h.lastBetSize = inc;
    h.streetLastBetTo = r.betTo;
  }
  h.actions.push({ seat, kind: r.kind, betTo: r.betTo, put: r.put, auto, street: h.street });
  if (h.folded.filter(f => !f).length <= 1) return settle(st, now);
  if (shouldCloseStreet(h)) return advanceStreets(st, now);
  const next = nextActable(h, seat);
  if (next === null) return settle(st, now);
  setTurn(st, next, now);
}
// sitout / left の席に手番が来ている間、チェックできればチェック、できなければフォールドで消化する
function runAutoTurns(st, now) {
  for (let guard = 0; guard < 500; guard++) {
    const h = st.hand;
    if (st.status !== 'running' || !h || h.phase !== 'betting' || h.toAct == null || !autoPlays(st.players[h.toAct])) return;
    const s = h.toAct, L = legalActions(st, s);
    applyResolved(st, s, resolve(st, s, { type: L.canCheck ? 'check' : 'fold' }), true, now);
  }
}

/** 手番の席の手動アクション。違法なら EngineError（'not_your_turn' | 'illegal' | 'game_over'） */
export function act(st, seat, move, now) {
  if (st.status !== 'running') throw new EngineError('game_over');
  const r = resolve(st, seat, move);
  const p = st.players[seat], h = st.hand;
  p.timeBankMs = Math.max(0, p.timeBankMs - Math.max(0, now - h.turnStart - ACTION_MS));
  p.autoCount = 0;
  applyResolved(st, seat, r, false, now);
  runAutoTurns(st, now);
  return bump(st);
}

/* ---------------- 時間で進むもの ---------------- */
/** いま何か進めるべきことがあるか（時間切れ・次のハンド・一時停止の期限）。tick を呼ぶ目安 */
export function dueAt(st) {
  if (st.status === 'paused') return st.pausedAt + PAUSED_EXPIRES_MS;
  if (st.status !== 'running' || !st.hand) return null;
  if (st.hand.phase === 'settled') return st.nextAt;
  return st.hand.deadline;
}
/** 期限を過ぎたものを 1 つ進める。何も無ければ EngineError('not_yet')。
 *  - 手番の時間切れ → チェックできればチェック、それ以外はフォールド（auto）。2 回連続で sitout
 *  - ハンド間の待ちが終わった → 次のハンド（生存者が全員 sitout なら一時停止）
 *  - 一時停止が 10 分続いた → 中止（cancelled） */
export function tick(st, now) {
  if (st.status === 'finished' || st.status === 'cancelled') throw new EngineError('game_over');
  const at = dueAt(st);
  if (at == null || now < at) throw new EngineError('not_yet');
  if (st.status === 'paused') { st.status = 'cancelled'; st.endedAt = now; return bump(st); }
  const h = st.hand;
  if (h.phase === 'settled') { nextHandOrPause(st, now); return bump(st); }
  const s = h.toAct, p = st.players[s], L = legalActions(st, s);
  p.timeBankMs = 0; p.autoCount++;
  if (p.autoCount >= AUTO_TO_SITOUT && p.status === 'active') p.status = 'sitout';
  applyResolved(st, s, resolve(st, s, { type: L.canCheck ? 'check' : 'fold' }), true, now);
  runAutoTurns(st, now);
  return bump(st);
}
function nextHandOrPause(st, now) {
  const survivors = st.players.filter(p => p.status === 'active' || p.status === 'sitout');
  if (survivors.every(p => p.status === 'sitout')) { st.status = 'paused'; st.pausedAt = now; st.nextAt = null; return; }
  dealHand(st, now);
  runAutoTurns(st, now);
}

/* ---------------- 離席・復帰・退出 ---------------- */
/** 自分で離席する（手番が来たら即自動処理）。手番中なら今すぐ処理する */
export function sitout(st, seat, now) {
  const p = st.players[seat];
  if (st.status !== 'running' && st.status !== 'paused') throw new EngineError('game_over');
  if (!p || p.status !== 'active') throw new EngineError('illegal');
  p.status = 'sitout';
  runAutoTurns(st, now);
  return bump(st);
}
/** 離席から戻る。一時停止中ならその場で次のハンドを配る */
export function sitin(st, seat, now) {
  const p = st.players[seat];
  if (st.status !== 'running' && st.status !== 'paused') throw new EngineError('game_over');
  if (!p || p.status !== 'sitout') throw new EngineError('illegal');
  p.status = 'active'; p.autoCount = 0;
  if (st.status === 'paused') { st.status = 'running'; st.pausedAt = null; nextHandOrPause(st, now); }
  return bump(st);
}
/** 進行中に部屋を出る（left）。sitout と同じく自動で消化され、戻れない。
 *  自分以外の生存者が全員 left になったら、残った 1 人の勝ちで即終了（left の席は残りの順位をスタックの多い順に） */
export function leave(st, seat, now) {
  const p = st.players[seat];
  if (st.status !== 'running' && st.status !== 'paused') throw new EngineError('game_over');
  if (!p || p.status === 'out' || p.status === 'left') throw new EngineError('illegal');
  p.status = 'left';
  if (stillPlaying(st).length <= 1) { finishWithoutOpponents(st, now); return bump(st); }
  runAutoTurns(st, now);
  return bump(st);
}
const stillPlaying = st => seatsOf(st).filter(s => st.players[s].status === 'active' || st.players[s].status === 'sitout');
/** 退出していない生存者が 1 人以下になったら終了する。生存者が 1 位、退出した席は（進行中のハンドの拠出を戻した）スタックの多い順に残りの順位 */
function finishWithoutOpponents(st, now) {
  const still = stillPlaying(st), h = st.hand, inHand = h && h.phase === 'betting';
  const chips = seatsOf(st).map(s => st.players[s].stack + (inHand ? h.commits[s] : 0));   // 返却前に確定する（返却後に足すと二重計上になる）
  if (inHand) { for (const s of seatsOf(st)) st.players[s].stack = chips[s]; st.hand = null; }
  const pay = payoutsFor(st.config), used = new Set(st.players.map(x => x.place).filter(x => x != null));
  const open = []; for (let pl = 1; pl <= st.n; pl++) if (!used.has(pl)) open.push(pl);
  const rest = seatsOf(st).filter(s => st.players[s].place == null)
    .sort((a, b) => (still.includes(b) - still.includes(a)) || chips[b] - chips[a] || a - b);
  rest.forEach((s, i) => { st.players[s].place = open[i]; st.players[s].pt = pay[open[i] - 1] ?? 0; });
  st.winner = rest[0]; st.status = 'finished'; st.endedAt = now; st.nextAt = null;
}

/* ---------------- 精算 ---------------- */
function settle(st, now) {
  const h = st.hand, n = st.n, P = st.players;
  const contenders = seatsOf(st).filter(s => !h.folded[s]);
  const won = Array(n).fill(0);
  let pots = [];
  if (contenders.length === 1) {
    won[contenders[0]] = sum(h.commits);
    pots = [{ amount: sum(h.commits), eligible: contenders.slice(), winners: contenders.slice() }];
  } else {
    // 拠出額のレイヤごとにポットを作る（コールされなかった超過分は本人だけが対象のポット＝返却）
    const score = Array(n).fill(-1);
    for (const s of contenders) score[s] = eval7([...h.hole[s], ...h.board]);
    const levels = [...new Set(h.commits.filter(c => c > 0))].sort((a, b) => a - b);
    let prev = 0;
    const order = Array.from({ length: n }, (_, k) => (h.btn + 1 + k) % n);   // 端数はボタンの次の席から
    // 拠出額のレイヤを作り、対象者が同じ隣接レイヤは 1 つのサイドポットに束ねてから配る（端数はポットごとに 1 回）
    const layers = [];
    for (const lvl of levels) {
      let amount = 0; for (let s = 0; s < n; s++) amount += Math.min(h.commits[s], lvl) - Math.min(h.commits[s], prev);
      let eligible = contenders.filter(s => h.commits[s] >= lvl);
      if (!eligible.length) eligible = contenders.slice();
      const last = layers[layers.length - 1];
      if (last && last.eligible.join() === eligible.join()) last.amount += amount;
      else layers.push({ amount, eligible });
      prev = lvl;
    }
    for (const { amount, eligible } of layers) {
      const best = Math.max(...eligible.map(s => score[s]));
      const winners = eligible.filter(s => score[s] === best);
      const share = Math.floor(amount / winners.length); let rem = amount - share * winners.length;
      for (const s of order) if (winners.includes(s)) { won[s] += share + (rem > 0 ? 1 : 0); if (rem > 0) rem--; }
      pots.push({ amount, eligible, winners });
    }
    h.shown = h.hole.map((c, s) => (contenders.includes(s) ? c.slice() : null));
    if (h.runFrom == null) h.runFrom = h.board.length;
    h.names = h.hole.map((c, s) => (contenders.includes(s) ? handName(score[s]) : null));
  }
  for (let s = 0; s < n; s++) P[s].stack += won[s];
  h.won = won; h.pots = pots; h.phase = 'settled'; h.toAct = null; h.turnStart = null; h.deadline = null; h.endedAt = now;
  // 脱落：同じハンドで複数人が飛んだらハンド開始時スタックの多い方が上位（同じなら席番号の若い方）
  const aliveBefore = seatsOf(st).filter(s => isLive(P[s]));
  const busted = aliveBefore.filter(s => P[s].stack === 0).sort((a, b) => h.startStacks[b] - h.startStacks[a] || a - b);
  const pay = payoutsFor(st.config);
  busted.forEach((s, i) => {
    const place = aliveBefore.length - busted.length + 1 + i;
    P[s].status = 'out'; P[s].place = place; P[s].pt = pay[place - 1] ?? 0;
    h.eliminated.push({ seat: s, place });
  });
  const left = seatsOf(st).filter(s => isLive(P[s]));
  if (left.length <= 1) {
    const w = left[0];
    P[w].place = 1; P[w].pt = pay[0];
    st.winner = w; st.status = 'finished'; st.endedAt = now; st.nextAt = null;
    return;
  }
  // 退出していない生存者が 1 人になったら、残りの退出者を待たずに終了（一時停止 → 中止になるのを防ぐ）
  if (stillPlaying(st).length <= 1) return finishWithoutOpponents(st, now);
  st.nextAt = now + BETWEEN_HANDS_MS + runoutMs(h.runFrom) + (fxSeat(h, st.fx) != null ? FX_MS : 0);
}

/**
 * 演出 GIF を出す席（structure.js の FX）：ショーダウンで精算したハンドで、取り分（won − 拠出）がいちばん多い 1 人。
 * その人が GIF を設定していない・同じ取り分が並んだ（チョップ）・フォールドで終わった・fx が無い（FREE MATCH）なら null。
 * h = 精算済みのハンド（ビューの hand でもよい）、fx = 席ごとの slug | null
 */
export function fxSeat(h, fx) {
  if (!fx || !h || h.phase !== 'settled' || !h.shown || h.runFrom == null || !h.won) return null;
  let best = 0, seat = null, tie = false;
  h.won.forEach((w, s) => {
    const g = w - h.commits[s];
    if (g > best) { best = g; seat = s; tie = false; } else if (g > 0 && g === best) tie = true;
  });
  return seat != null && !tie && fx[seat] ? seat : null;
}

/* ---------------- 記録とビュー ---------------- */
/** 精算済みのハンドの記録（ハンド履歴として各自の端末に保存する形）。holes は全員分なのでサーバーだけが持つ */
export function handRecord(st) {
  const h = st.hand;
  if (!h || h.phase !== 'settled') return null;
  return {
    rec: {
      handNo: h.handNo, playedAt: h.startedAt, endedAt: h.endedAt, level: h.level, sb: h.sb, bb: h.bb, ante: h.ante,
      btn: h.btn, sbSeat: h.sbSeat, bbSeat: h.bbSeat, startStacks: h.startStacks.slice(),
      shown: h.shown ? h.shown.map(c => (c ? c.slice() : null)) : Array(st.n).fill(null),
      names: h.names ? h.names.slice() : Array(st.n).fill(null),
      board: h.board.slice(), actions: h.actions.map(a => ({ ...a })), won: h.won.slice(), pots: structuredClone(h.pots),
      eliminated: h.eliminated.map(e => ({ ...e })),
    },
    holes: h.hole.map(c => (c ? c.slice() : null)),
  };
}

/** その席に見せてよい状態：山札・乱数の鍵を消し、他席の手札は（ショーダウンで公開されたもの以外）null。seat null は観戦（誰の手札も見えない） */
export function viewFor(st, seat) {
  const { seed, ctr, hand, ...rest } = st;
  const v = structuredClone(rest);
  v.seat = seat ?? null;
  if (hand) {
    const { deck, hole, ...h } = hand;
    v.hand = structuredClone(h);
    v.hand.hole = hole.map((c, s) => (c && (s === seat || (hand.shown && hand.shown[s])) ? c.slice() : null));
  } else v.hand = null;
  return v;
}

/** 不変条件の確認（テスト用）：チップの合計は常に n × 開始スタック */
export function totalChips(st) {
  return sum(st.players.map(p => p.stack)) + (st.hand && st.hand.phase === 'betting' ? sum(st.hand.commits) : 0);
}
