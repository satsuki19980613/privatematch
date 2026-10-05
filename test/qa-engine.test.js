// QA：ルールエンジン（src/engine.js）の敵対的テスト。
//  - 役の評価を独立した総当たりの参照実装と突き合わせる
//  - 手組みのシナリオ（ベッティング規則・サイドポット・端数・デッドボタン・複数脱落・時間・退出・ビュー）
//  - ランダム対局のファザー（不変条件・参照実装との照合・act と legalActions の一致・ビューの漏れ・決定性）
// `{ todo: ... }` が付いたテストは既知の不具合（修正されるまで失敗する）。失敗しても suite は落ちない。
// 重いファズは `QA_SCALE=20 node --test test/qa-engine.test.js` のように倍率を掛けて回す。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  newTable, act, tick, sitout, sitin, leave, legalActions, viewFor, handRecord, totalChips, eval7, handName, dueAt, EngineError,
} from '../src/engine.js';
import {
  DEFAULT_CONFIG, BASE_BB, payoutsFor, ACTION_MS, TIME_BANK_MS, BETWEEN_HANDS_MS, PAUSED_EXPIRES_MS, blindsAt, nextLevel, normalizeConfig,
  PLAYER_COUNTS, START_BBS, SPEEDS, MODE_IDS,
} from '../src/structure.js';
import { createRoom, joinRoom, applyRequest, tickRoom, viewsOf, leaveRoom } from '../server/game/rules.js';

const SCALE = Number(process.env.QA_SCALE || 1);

/* ======================= 共通の道具 ======================= */
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const cfg = (o = {}) => ({ ...DEFAULT_CONFIG, ...o });
const names = n => Array.from({ length: n }, (_, i) => 'P' + i);
const C = s => { const r = '23456789TJQKA'.indexOf(s[0]), u = 'shdc'.indexOf(s[1]); return r * 4 + u; };
const CS = s => s.split(' ').filter(Boolean).map(C);
const pick = (r, a) => a[Math.floor(r() * a.length)];
const sum = a => a.reduce((x, y) => x + y, 0);
const J = x => JSON.stringify(x);
const throwsCode = (fn, code) => assert.throws(fn, e => e instanceof EngineError && (code ? e.code === code : true), `expected EngineError ${code || ''}`);

/* ======================= 参照実装：役の評価（5 枚の全組み合わせの最大） ======================= */
const P13 = [1, 13, 169, 2197, 28561];
function rank5(cards) {
  const rs = cards.map(c => c >> 2), ss = cards.map(c => c & 3);
  const cnt = new Array(13).fill(0); for (const r of rs) cnt[r]++;
  const groups = []; for (let r = 12; r >= 0; r--) if (cnt[r]) groups.push([cnt[r], r]);
  groups.sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  const flush = ss.every(s => s === ss[0]);
  let straightHigh = -1;
  if (groups.length === 5) {
    const mx = groups[0][1], mn = groups[4][1];
    if (mx - mn === 4) straightHigh = mx;
    else if (mx === 12 && groups[1][1] === 3 && mn === 0) straightHigh = 3;   // A-2-3-4-5
  }
  let cat, tb;
  if (straightHigh >= 0 && flush) { cat = 8; tb = [straightHigh]; }
  else if (groups[0][0] === 4) { cat = 7; tb = groups.map(g => g[1]); }
  else if (groups[0][0] === 3 && groups[1][0] === 2) { cat = 6; tb = groups.map(g => g[1]); }
  else if (flush) { cat = 5; tb = groups.map(g => g[1]); }
  else if (straightHigh >= 0) { cat = 4; tb = [straightHigh]; }
  else if (groups[0][0] === 3) { cat = 3; tb = groups.map(g => g[1]); }
  else if (groups[0][0] === 2 && groups[1][0] === 2) { cat = 2; tb = groups.map(g => g[1]); }
  else if (groups[0][0] === 2) { cat = 1; tb = groups.map(g => g[1]); }
  else { cat = 0; tb = groups.map(g => g[1]); }
  let key = cat * 371293;
  for (let i = 0; i < tb.length; i++) key += tb[i] * P13[4 - i];
  return key;
}
const COMBOS7 = (() => { const out = []; for (let a = 0; a < 7; a++) for (let b = a + 1; b < 7; b++) out.push([0, 1, 2, 3, 4, 5, 6].filter(i => i !== a && i !== b)); return out; })();
function refEval(cards) {
  let best = -1;
  for (const c of COMBOS7) { const k = rank5([cards[c[0]], cards[c[1]], cards[c[2]], cards[c[3]], cards[c[4]]]); if (k > best) best = k; }
  return best;
}
function randomCards(r, k, pool) {
  const d = pool ? pool.slice() : Array.from({ length: 52 }, (_, i) => i);
  for (let i = 0; i < k; i++) { const j = i + Math.floor(r() * (d.length - i)); const t = d[i]; d[i] = d[j]; d[j] = t; }
  return d.slice(0, k);
}

/* ======================= 1. 役の評価 ======================= */
test('eval7：参照実装（5 枚総当たり）と 20 万手 + 偏らせた 10 万手で同値・同順序', () => {
  const r = rng(12345);
  const toRef = new Map(), toEng = new Map();
  let prevE = null, prevR = null, pairs = 0;
  const N = 200000 * Math.max(1, SCALE >= 5 ? 5 : 1);
  const one = cards => {
    const e = eval7(cards), k = refEval(cards);
    if (toRef.has(e)) assert.equal(toRef.get(e), k, `eval7 score ${e} maps to two ref keys (cards ${cards})`); else toRef.set(e, k);
    if (toEng.has(k)) assert.equal(toEng.get(k), e, `ref key ${k} maps to two eval7 scores (cards ${cards})`); else toEng.set(k, e);
    if (prevE !== null) { pairs++; assert.equal(Math.sign(e - prevE), Math.sign(k - prevR), `order mismatch ${cards} vs previous`); }
    prevE = e; prevR = k;
    assert.equal(e >>> 20, Math.floor(k / 371293), `category mismatch ${cards}`);
  };
  for (let i = 0; i < N; i++) one(randomCards(r, 7));
  // 偏らせる：2 スート・狭いランク帯から引いてフラッシュ・ストレート・フルハウス・クアッズを増やす
  const cats = new Array(9).fill(0);
  for (let i = 0; i < 100000; i++) {
    const suits = Math.random() < 2 ? [Math.floor(r() * 4), Math.floor(r() * 4)] : [];
    const lo = Math.floor(r() * 9), width = 5 + Math.floor(r() * 5);
    const pool = []; for (let c = 0; c < 52; c++) { const rk = c >> 2; const inBand = rk >= lo && rk < lo + width || (rk === 12 && lo === 0); if (inBand && (r() < 0.5 ? suits.includes(c & 3) : true)) pool.push(c); }
    if (pool.length < 7) continue;
    const cards = randomCards(r, 7, pool); one(cards); cats[eval7(cards) >>> 20]++;
  }
  assert.ok(cats[8] > 50 && cats[7] > 50 && cats[6] > 500 && cats[5] > 500 && cats[4] > 500, 'biased generator should hit rare categories: ' + cats);
  assert.ok(pairs > 290000);
});

test('eval7：手組みの境界（ホイール・6 枚フラッシュ・2 組のスリーカード・3 ペアのキッカー）', () => {
  const sc = s => eval7(CS(s));
  assert.ok(sc('As 2d 3c 4h 5s 9d 9c') < sc('2s 3d 4c 5h 6s Kd Kc'), 'wheel < six-high straight');
  assert.equal(handName(sc('Ah 2h 3h 4h 5h 9d 9c')), 'Straight Flush');
  assert.equal(sc('Ah 2h 3h 4h 5h Ad 9c') >>> 20, 8);
  assert.ok(sc('Ah 2h 3h 4h 5h 6h 9c') > sc('Ah 2h 3h 4h 5h 9d 9c'), '6-high SF beats wheel SF');
  assert.equal(handName(sc('Kh Qh Jh Th 9h 3c 3d')), 'Straight Flush');
  assert.equal(handName(sc('Ks Kd Kh Qs Qd Qh 2c')), 'Full House');
  assert.ok(sc('Ks Kd Kh Qs Qd Qh 2c') > sc('Ks Kd Kh Js Jd Jh 2c'));
  assert.ok(sc('As Ad Kc Kh 6s 6d 2c') > sc('As Ad Kc Kh 5s 3d 2c'), 'three pairs: 3rd pair rank is a kicker candidate');
  assert.equal(sc('As Ad Kc Kh 3s 3d Qc'), sc('As Ad Kc Kh 3s 2d Qc'), 'three pairs: best kicker is the lone Q, not the 3rd pair');
  assert.ok(sc('As Ad Ac Ah Ks Kd Kc') > sc('2s 2d 2c 2h 3s 3d 3c'), 'AAAA beats 2222');
  assert.equal(sc('2s 2d 2c 2h 3s 3d 3c') >>> 20, 7);
  assert.ok(sc('2s 2d 2c 2h 9s 8d 7c') < sc('2s 2d 2c 2h As 8d 7c'), 'quads kicker');
  // 同じ役・同じキッカーなら等しい（スートは無関係）
  assert.equal(sc('As Kd 9c 7h 4s 3d 2c'), sc('Ah Kc 9d 7s 4d 3c 2h'));
});

/* ======================= 参照実装：ポットの精算 ======================= */
// 別の組み立て（最小の拠出から順に剥がす）。端数はボタンの次の席から。
function refSettle(h) {
  const n = h.commits.length, rem = h.commits.slice(), won = Array(n).fill(0);
  const contenders = []; for (let s = 0; s < n; s++) if (!h.folded[s]) contenders.push(s);
  if (contenders.length === 1) { won[contenders[0]] = sum(h.commits); return won; }
  const key = {}; for (const s of contenders) key[s] = refEval([...h.hole[s], ...h.board]);
  const order = []; for (let k = 1; k <= n; k++) order.push((h.btn + k) % n);
  for (;;) {
    const live = contenders.filter(s => rem[s] > 0);
    if (!live.length) break;
    const m = Math.min(...live.map(s => rem[s]));
    let amount = 0; for (let s = 0; s < n; s++) { const t = Math.min(rem[s], m); amount += t; rem[s] -= t; }
    const best = Math.max(...live.map(s => key[s]));
    const w = live.filter(s => key[s] === best);
    const share = Math.floor(amount / w.length); let odd = amount - share * w.length;
    for (const s of order) if (w.includes(s)) { won[s] += share; if (odd > 0) { won[s]++; odd--; } }
  }
  assert.equal(sum(rem), 0, 'dead money above every contender');
  return won;
}


/** 精算が参照実装と一致するか。既知の不具合 BUG-4（端数をレイヤごとに配る）による数チップのずれだけは許し、件数を返す */
function compareSettle(h, ctx) {
  const refWon = refSettle(h);
  if (J(refWon) === J(h.won)) return 0;
  assert.ok(h.pots.some(p => p.winners.length > 1), `settle mismatch without a split pot: ${ctx} ${J(h.won)} vs ${J(refWon)}`);
  assert.ok(h.won.every((w, i) => Math.abs(w - refWon[i]) <= h.pots.length + 3), `settle mismatch bigger than odd chips: ${ctx}`);
  assert.equal(sum(h.won), sum(refWon));
  return 1;
}

/* ======================= 手組みシナリオ用の補助 ======================= */
const L1 = blindsAt('normal', 1);   // sb 100 / bb 200 / ante 50
const START = 100 * BASE_BB;
function table(n, o = {}) {
  return newTable({ config: cfg({ players: n, ...(o.config || {}) }), names: names(n), now: o.now ?? 0, rnd: rng(o.seed ?? 1), button: o.button ?? 0, stacks: o.stacks });
}
const mv = m => (typeof m === 'string' ? { type: m } : m);
/** [seat, move][] を順に打つ（時刻は 1ms ずつ進める） */
function play(st, script, t = 1) { for (const [s, m] of script) act(st, s, mv(m), t++); return t; }
/** 手札とボード（5 枚）を固定する。いま配られている手札・山札を作り直す。省略した席は余りの札で埋める */
function rig(st, holes, boardStr) {
  const h = st.hand, board = CS(boardStr);
  assert.equal(h.board.length, 0, 'rig before the flop');
  const used = new Set(board);
  for (const s of Object.keys(holes)) { const c = CS(holes[s]); h.hole[s] = c; c.forEach(x => { assert.ok(!used.has(x), 'dup card in rig'); used.add(x); }); }
  const free = []; for (let c = 0; c < 52; c++) if (!used.has(c)) free.push(c);
  for (let s = 0; s < st.n; s++) if (h.hole[s] && !holes[s]) { h.hole[s] = [free.pop(), free.pop()]; }
  h.deck = [...free, board[4], board[3], board[2], board[1], board[0]];
}
const BOARD_DRY = '3c 8d Js 5h 9c';
const BOARD_ROYAL = 'Ah Kh Qh Jh Th';   // 全員がボードで引き分け（誰もこれ以上にならない）

/* ======================= 2. ベッティング規則 ======================= */
test('最小レイズ：直前の上乗せ幅（最低 BB）。再レイズ後は幅が更新される', () => {
  const st = table(4);   // btn0 sb1 bb2 utg3
  assert.equal(legalActions(st).minTo, 400);
  act(st, 3, { type: 'raise', to: 600 }, 1);                       // 幅 400
  assert.equal(legalActions(st).minTo, 1000);
  act(st, 0, { type: 'raise', to: 1000 }, 2);                      // 幅 400
  assert.equal(legalActions(st).minTo, 1400);
  act(st, 1, { type: 'raise', to: 3000 }, 3);                      // 幅 2000
  const L = legalActions(st);   // seat 2 (BB)
  assert.equal(L.seat, 2); assert.equal(L.toCall, 2800); assert.equal(L.minTo, 5000);
  throwsCode(() => act(st, 2, { type: 'raise', to: 4999 }, 4), 'illegal');
  act(st, 2, { type: 'raise', to: 5000 }, 4);
  // 3: 600 に対して 5000 までコール、さらに再レイズも可能（幅 2000 → 7000）
  const L3 = legalActions(st, 3);
  assert.equal(L3.toCall, 4400); assert.equal(L3.minTo, 7000);
});

test('最小ベット（ポストフロップ）は BB、ベット幅が次の最小レイズ幅になる', () => {
  const st = table(3);
  play(st, [[0, 'call'], [1, 'call'], [2, 'check']]);
  assert.equal(st.hand.street, 1);
  let L = legalActions(st);   // seat 1
  assert.equal(L.seat, 1); assert.equal(L.aggression, 'bet'); assert.equal(L.minTo, 200);
  act(st, 1, { type: 'raise', to: 700 }, 10);
  L = legalActions(st); assert.equal(L.seat, 2); assert.equal(L.aggression, 'raise'); assert.equal(L.minTo, 1400);
});

test('不完全なオールイン（最小レイズ未満）は動いた席のレイズ権を再開しない／フルレイズなら再開する', () => {
  // btn0 の手持ちを調整して、フロップでのオールイン額を変える
  for (const [allin, reopens] of [[600, false], [799, false], [800, true], [1000, true]]) {
    const st = table(3, { stacks: [50 + 200 + allin, START, START] });
    play(st, [[0, 'call'], [1, 'call'], [2, 'check']]);                 // フロップ：1 → 2 → 0
    act(st, 1, { type: 'raise', to: 400 }, 20);                          // 幅 400
    act(st, 2, { type: 'call' }, 21);
    assert.equal(st.players[0].stack, allin);
    act(st, 0, { type: 'allin' }, 22);
    const L1_ = legalActions(st, 1);
    assert.equal(L1_.seat, 1); assert.equal(L1_.toCall, allin - 400);
    assert.equal(L1_.minTo !== null, reopens, `allin ${allin}`);
    if (reopens) { assert.equal(L1_.minTo, allin + (allin - 400)); }
    else throwsCode(() => act(st, 1, { type: 'raise', to: allin + 400 }, 23), 'illegal');
    act(st, 1, { type: 'call' }, 23);
    // seat 2 も同様（フルレイズなら再び動ける）
    const L2_ = legalActions(st, 2);
    assert.equal(L2_.seat, 2); assert.equal(L2_.minTo !== null, reopens);
  }
});

test('不完全なオールインでも、まだ動いていない席はレイズできる（最小レイズ幅は据え置き）', () => {
  const st = table(3, { stacks: [START, 50 + 200 + 100, START] });   // seat1 (SB) はフロップで 100（< BB）しか残らない
  play(st, [[0, 'call'], [1, 'call'], [2, 'check']]);
  assert.equal(st.hand.toAct, 1); assert.equal(st.players[1].stack, 100);
  act(st, 1, { type: 'allin' }, 10);                                   // 100 のベット（不完全）
  let L = legalActions(st);
  assert.equal(L.seat, 2); assert.equal(L.toCall, 100); assert.equal(L.minTo, 300); assert.equal(L.aggression, 'raise');
  act(st, 2, { type: 'raise', to: 300 }, 11);                          // 幅 200（= BB）
  L = legalActions(st); assert.equal(L.seat, 0); assert.equal(L.minTo, 500);
});

test('BB のオプション：リンプ回しの後、BB はチェックでもレイズでもでき、それまでストリートは閉じない', () => {
  const st = table(3);
  act(st, 0, { type: 'call' }, 1); act(st, 1, { type: 'call' }, 2);
  assert.equal(st.hand.street, 0);
  const L = legalActions(st);
  assert.equal(L.seat, 2); assert.equal(L.canCheck, true); assert.equal(L.toCall, 0); assert.equal(L.minTo, 400); assert.equal(L.maxTo, START - 50);
  const st2 = structuredClone(st);
  act(st, 2, { type: 'check' }, 3); assert.equal(st.hand.street, 1);
  act(st2, 2, { type: 'raise', to: 400 }, 3); assert.equal(st2.hand.street, 0); assert.equal(st2.hand.toAct, 0);
  assert.equal(legalActions(st2).minTo, 600);
});

test('ヘッズアップ：ボタン = SB はプリフロップ先手・ポストフロップ後手。次のハンドでボタンが入れ替わる', () => {
  for (const btn of [0, 1]) {
    const st = table(2, { button: btn });
    const h = st.hand;
    assert.equal(h.btn, btn); assert.equal(h.sbSeat, btn); assert.equal(h.bbSeat, 1 - btn); assert.equal(h.toAct, btn);
    assert.deepEqual(h.commits.map(x => x), btn === 0 ? [50 + 100, 50 + 200] : [50 + 200, 50 + 100]);
    act(st, btn, { type: 'call' }, 1); act(st, 1 - btn, { type: 'check' }, 2);
    assert.equal(st.hand.toAct, 1 - btn, 'postflop BB first');
    act(st, 1 - btn, { type: 'check' }, 3); assert.equal(st.hand.toAct, btn);
    act(st, btn, { type: 'check' }, 4); assert.equal(st.hand.street, 2); assert.equal(st.hand.toAct, 1 - btn);
    act(st, 1 - btn, { type: 'raise', to: 400 }, 5); act(st, btn, { type: 'fold' }, 6);
    assert.equal(st.hand.phase, 'settled');
    tick(st, st.nextAt);
    assert.equal(st.hand.btn, 1 - btn); assert.equal(st.hand.sbSeat, 1 - btn); assert.equal(st.hand.toAct, 1 - btn);
  }
});

test('チェック回し：全員チェックでストリートが進み、リバーまで行ってショーダウン', () => {
  const st = table(4);
  play(st, [[3, 'call'], [0, 'call'], [1, 'call'], [2, 'check']]);
  let t = 100;
  for (let street = 1; street <= 3; street++) {
    assert.equal(st.hand.street, street); assert.equal(st.hand.board.length, 2 + street);
    assert.equal(st.hand.toAct, 1);
    for (const s of [1, 2, 3, 0]) { assert.equal(st.hand.toAct, s); assert.equal(legalActions(st).canCheck, true); act(st, s, { type: 'check' }, t++); }
  }
  assert.equal(st.hand.phase, 'settled'); assert.equal(st.hand.board.length, 5);
  assert.equal(sum(st.hand.won), 4 * 250);
});

test('アンティは全員が払う。ショートスタックはアンティ → ブラインドの順にオールインで払う', () => {
  // seat1 (SB) が 120：アンティ 50 + SB 70 でオールイン
  let st = table(3, { stacks: [START, 120, START] });
  assert.deepEqual(st.hand.commits, [50, 120, 250]); assert.equal(st.hand.allIn[1], true);
  assert.equal(st.hand.streetBet[1], 70); assert.equal(st.hand.toAct, 0);
  assert.equal(legalActions(st).toCall, 200);
  assert.equal(totalChips(st), START * 2 + 120);
  // アンティにも満たない（40）：アンティだけでオールイン、ブラインドは 0
  st = table(3, { stacks: [START, 40, START] });
  assert.deepEqual(st.hand.commits, [50, 40, 250]); assert.equal(st.hand.allIn[1], true); assert.equal(st.hand.streetBet[1], 0);
  // アンティちょうど（50）：ブラインド 0 でオールイン
  st = table(3, { stacks: [START, 50, START] });
  assert.equal(st.hand.allIn[1], true); assert.equal(st.hand.commits[1], 50);
  // 全員アンティで尽きる → 手番なしでボードが配られ精算される
  st = table(3, { stacks: [30, 40, 50] });
  assert.equal(st.hand.phase, 'settled'); assert.equal(st.hand.board.length, 5);
  assert.equal(sum(st.hand.won), 120);
});

test('ショート BB のとき UTG がコールすべき額は BB 満額（200）', () => {
  const st = table(3, { stacks: [START, START, 50 + 130] });   // btn0 sb1 bb2(短い)
  assert.equal(st.hand.streetBet[2], 130);
  assert.equal(legalActions(st).toCall, 200);
});

test('ヘッズアップで BB がショート：SB は BB の額まで合わせれば良い（それ以上を求めない）', () => {
  const st = table(2, { button: 0, stacks: [START, 50 + 130] });   // seat0 = SB(btn), seat1 = BB 130 all-in
  const L = legalActions(st);
  assert.equal(L.seat, 0); assert.equal(L.toCall, 30); assert.equal(L.maxTo, null); assert.equal(L.minTo, null);   // 相手は all-in 済みなのでレイズ不可
  act(st, 0, { type: 'call' }, 1);
  assert.equal(st.hand.phase, 'settled'); assert.equal(totalChips(st), START + 180);
});

test('フォールドした人のチップはポットに残る／コールされない超過分は返る', () => {
  const st = table(3, { stacks: [START, START, 1000] });   // btn0, sb1, bb2(1000)
  rig(st, { 0: 'As Ah', 1: '7d 2c', 2: 'Ks Kh' }, BOARD_DRY);
  act(st, 0, { type: 'raise', to: 3000 }, 1); act(st, 1, { type: 'fold' }, 2); act(st, 2, { type: 'call' }, 3);
  const h = st.hand;
  assert.equal(h.phase, 'settled');
  // commits: 0 = 3050, 1 = 150 (folded), 2 = 1000 → pots: 3×... seat0 wins everything; 超過 2050 は本人へ返却
  assert.deepEqual(h.commits, [3050, 150, 1000]);
  assert.deepEqual(h.won, [4200, 0, 0]);
  assert.equal(h.pots.at(-1).amount, 2050); assert.deepEqual(h.pots.at(-1).eligible, [0]); assert.deepEqual(h.pots.map(p => p.amount), [450 + 1700, 2050]);   // 超過分は本人だけが対象
  assert.equal(totalChips(st), START * 2 + 1000);
});

/* ======================= 3. サイドポット・端数 ======================= */
test('サイドポット：4 人オールイン、勝者の順が席順と逆でもレイヤごとに配分される', () => {
  const stacks = [1000, 2000, 3000, 4000];
  // 強さ：seat0 > seat1 > seat2 > seat3
  let st = table(4, { stacks, button: 0 });   // utg = seat3
  rig(st, { 0: 'As Ah', 1: 'Ks Kh', 2: 'Qs Qh', 3: '7d 2c' }, BOARD_DRY);
  play(st, [[3, 'allin'], [0, 'call'], [1, 'allin'], [2, 'allin']]);   // seat1 (SB), seat2 (BB)
  assert.equal(st.hand.phase, 'settled');
  assert.deepEqual(st.hand.won, [4000, 3000, 2000, 1000]);
  assert.deepEqual(st.players.map(p => p.stack), [4000, 3000, 2000, 1000]);
  assert.equal(st.hand.pots.length, 4);
  assert.deepEqual(st.hand.pots.map(p => p.amount), [4000, 3000, 2000, 1000]);
  // 逆順：seat3 が最強 → 全部取る
  st = table(4, { stacks, button: 0 });
  rig(st, { 0: '7d 2c', 1: 'Qs Qh', 2: 'Ks Kh', 3: 'As Ah' }, BOARD_DRY);
  play(st, [[3, 'allin'], [0, 'call'], [1, 'allin'], [2, 'allin']]);
  assert.deepEqual(st.hand.won, [0, 0, 0, 10000]);
  assert.deepEqual(st.hand.eliminated.map(e => [e.seat, e.place]), [[2, 2], [1, 3], [0, 4]]);   // 開始スタックの多い順に上位
});

test('サイドポット：6 人・別々の額のオールイン（ランダム配札）で参照のポット計算と一致', () => {
  const r = rng(77);
  for (let iter = 0; iter < 150 * SCALE; iter++) {
    const n = 3 + Math.floor(r() * 4);
    const stacks = Array.from({ length: n }, () => 600 + Math.floor(r() * 30000));
    const st = table(n, { stacks, button: Math.floor(r() * n), seed: iter + 1 });
    let guard = 0;
    while (st.hand.phase === 'betting' && guard++ < 50) act(st, st.hand.toAct, r() < 0.15 && legalActions(st).canFold ? { type: 'fold' } : { type: 'allin' }, guard);
    assert.equal(st.hand.phase, 'settled');
    compareSettle(st.hand, `iter ${iter}`);
    assert.equal(sum(st.hand.won), sum(st.hand.commits));
    assert.equal(sum(st.hand.pots.map(p => p.amount)), sum(st.hand.commits));
    assert.equal(totalChips(st), sum(stacks));
  }
});

test('端数のチップはボタンの次の席から（ダミー札の引き分け・フォールド者のデッドマネー込み）', () => {
  // btn0 sb1 bb2 utg3：3 が 601 にレイズ、0 が all-in 2001、1 フォールド、2 コール all-in、3 フォールド
  const mk = (button) => {
    const st = table(4, { stacks: [2051, START, 2051, START], button });
    return st;
  };
  const st = mk(0);
  rig(st, { 0: '2c 3c', 2: '2d 3d', 1: '4c 5c', 3: '6c 7c' }, BOARD_ROYAL);
  play(st, [[3, { type: 'raise', to: 601 }], [0, 'allin'], [1, 'fold'], [2, 'call'], [3, 'fold']]);
  const h = st.hand;
  assert.equal(h.phase, 'settled');
  assert.deepEqual(h.commits, [2051, 150, 2051, 651]);
  // 150 層：600 → 300/300、651 層：1503 → 751/752（端数は btn+1 = 1, 2, 3, 0 の順で seat2 が先）、2051 層：2800 → 1400/1400
  assert.deepEqual(h.won, [300 + 751 + 1400, 0, 300 + 752 + 1400, 0]);
  assert.equal(totalChips(st), 2051 * 2 + START * 2);
});

test('端数のチップ：3 人・同じ手が 2 人、短いスタックのデッドマネーが奇数', () => {
  // A=seat0(1000) B=seat1(133, SB で 83 を all-in) C=seat2(1000)。A と C が同じ強さ、B は負け
  for (const button of [0, 1, 2]) {
    const st = table(3, { stacks: [1000, 133, 1000], button });
    rig(st, { 0: 'As Ad', 1: '3s 5h', 2: 'Ah Ac' }, '2c 7d 9h Js 4d');
    let guard = 0; while (st.hand.phase === 'betting' && guard++ < 10) act(st, st.hand.toAct, { type: 'allin' }, guard);
    assert.deepEqual(st.hand.won, refSettle(st.hand));
    assert.equal(totalChips(st), 2133);
  }
  // button 0 のとき：B の 133 層（399）は A, C に 199 ずつ、端数は btn の次（seat1 は敗者）→ seat2 が先
  const st = table(3, { stacks: [1000, 133, 1000], button: 0 });
  rig(st, { 0: 'As Ad', 1: '3s 5h', 2: 'Ah Ac' }, '2c 7d 9h Js 4d');
  play(st, [[0, 'allin'], [2, 'call']]);
  assert.equal(st.hand.phase, 'settled');
  assert.deepEqual(st.hand.won, [199 + 867, 0, 200 + 867]);
});

test('全員引き分け・スタックがすべて違う all-in：各レイヤを残った人で等分（返却を含む）', () => {
  const st = table(4, { stacks: [1000, 1001, 1002, 1003], button: 2 });   // btn2, sb3, bb0, utg1
  rig(st, { 0: '2c 3c', 1: '2d 3d', 2: '2s 3s', 3: '4c 5c' }, BOARD_ROYAL);
  let g = 0; while (st.hand.phase === 'betting' && g++ < 10) act(st, st.hand.toAct, { type: 'allin' }, g);
  assert.deepEqual(st.hand.won, refSettle(st.hand));
  assert.equal(sum(st.hand.won), 4006);
  // 全員同点：各層を残った人で等分、端数は 3,0,1,2 の順
  // レイヤ：1000×4 → 1000 ずつ、1001 層は 3 人で 1 枚ずつ、1002 層は 2 人で 1 枚ずつ、1003 層は seat3 に返却
  assert.deepEqual(st.hand.won, [1000, 1001, 1002, 1003]);
});

test('端数のチップはサイドポットごと（同じ対象者のレイヤは 1 つのポット）に配る', () => {
  // 5 人：seat0, seat1 = 1000 の all-in（同じ手）、seat2・seat3 = 151 でフォールド、seat4 = 300 でフォールド（最後にフォールドして精算）
  const st = table(5, { stacks: [START, START, START, START, START], button: 0 });
  rig(st, { 0: '2c 3c', 1: '2d 3d', 2: '4c 5c', 3: '6c 7c', 4: '8c 9c' }, BOARD_ROYAL);
  const h = st.hand;
  Object.assign(h, { street: 3, board: CS(BOARD_ROYAL), deck: h.deck.slice(0, h.deck.length - 5), commits: [1000, 1000, 151, 151, 300], folded: [false, false, true, true, false], allIn: [true, true, false, false, false], streetBet: [400, 400, 0, 0, 0], streetLastBetTo: 400, toAct: 4, turnStart: 0, deadline: 45000, startStacks: [1000, 1000, 151, 151, 300] });
  st.players.forEach((p, i) => { p.stack = [0, 0, 0, 0, 0][i]; });
  st.players[4].stack = 5000; st.players[2].stack = 0;
  act(st, 4, { type: 'fold' }, 1);
  assert.equal(st.hand.phase, 'settled');
  assert.deepEqual(h.won, refSettle(h));
  assert.deepEqual(h.won, [1301, 1301, 0, 0, 0]);   // 総額 2602 を 2 人で割る
});

test('ショーダウンは全員表向き（all-in ランアウト含む）。フォールド勝ちは見せない', () => {
  const st = table(3);
  act(st, 0, { type: 'fold' }, 1); act(st, 1, { type: 'fold' }, 2);
  assert.equal(st.hand.shown, null);
  const st2 = table(3, { stacks: [3000, 3000, 3000] });
  let g = 0; while (st2.hand.phase === 'betting' && g++ < 10) act(st2, st2.hand.toAct, { type: 'allin' }, g);
  assert.ok(st2.hand.shown.every(x => x && x.length === 2));
  assert.ok(st2.hand.names.every(x => typeof x === 'string'));
});

/* ======================= 4. デッドボタン・複数脱落 ======================= */
test('複数人が同じハンドで脱落：開始スタックの多い方が上位', () => {
  const st = table(4, { stacks: [2000, 3000, 5000, 20000], button: 0 });
  rig(st, { 0: '7d 2c', 1: 'Qs Qh', 2: 'Ks Kh', 3: 'As Ah' }, BOARD_DRY);
  play(st, [[3, 'allin'], [0, 'call'], [1, 'call'], [2, 'call']]);
  assert.equal(st.status, 'finished'); assert.equal(st.winner, 3);
  assert.deepEqual(st.players.map(p => p.place), [4, 3, 2, 1]);
  assert.deepEqual(st.players.map(p => p.pt), payoutsFor(st.config).slice(0, 4).reverse());
  assert.deepEqual(st.hand.eliminated.map(e => e.seat), [2, 1, 0]);
});

test('2 人脱落で残り 3 人：places は alive − busted + 1 から', () => {
  const st = table(5, { stacks: [2000, 3000, 20000, 20000, 20000], button: 0 });   // sb1 bb2 utg3 4 0
  rig(st, { 0: '7d 2c', 1: '8s 2h', 2: 'Ks Kh', 3: 'As Ah', 4: 'Qs Qh' }, BOARD_DRY);
  play(st, [[3, { type: 'raise', to: 3000 }], [4, 'fold'], [0, 'call'], [1, 'call'], [2, 'fold']]);
  assert.equal(st.hand.phase, 'settled');
  assert.deepEqual(st.players.map(p => p.status), ['out', 'out', 'active', 'active', 'active']);
  assert.deepEqual(st.players.map(p => p.place), [5, 4, null, null, null]);   // seat1 (3000) の方が上位 4
  assert.equal(st.status, 'running');
});

test('デッドボタン：SB が脱落 → ボタンは空席に残り、SB は無し／BB が脱落 → 次は SB 無し', () => {
  // 5 人 btn0 sb1 bb2 utg3 4。seat1 は 300、seat3 は 300（hand1 で ante のみ → 250）
  const st = table(5, { stacks: [START, 300, START, 300, START], button: 0 });
  rig(st, { 0: 'As Ah', 1: '7d 2c', 2: 'Ks Kh', 3: 'Qd Qc', 4: '9d 9s' }, BOARD_DRY);
  play(st, [[3, 'fold'], [4, 'fold'], [0, 'fold'], [1, 'allin'], [2, 'call']]);
  assert.equal(st.hand.phase, 'settled'); assert.equal(st.players[1].status, 'out'); assert.equal(st.players[1].place, 5);
  tick(st, st.nextAt);
  let h = st.hand;   // live 0 2 3 4：bb = next(2) = 3, sb = 2, btn = 前の SB の位置 = seat1（空席）
  assert.equal(h.handNo, 2); assert.equal(h.btn, 1); assert.equal(h.sbSeat, 2); assert.equal(h.bbSeat, 3); assert.equal(h.toAct, 4);
  assert.equal(h.hole[1], null); assert.equal(h.folded[1], true);
  // seat3 (BB, 250 → 50 残り) が all-in で脱落
  rig(st, { 0: '7d 2c', 2: '8s 2h', 3: 'Qd Qc', 4: 'As Ah' }, BOARD_DRY);
  play(st, [[4, { type: 'raise', to: 1000 }], [0, 'fold'], [2, 'fold']]);   // seat3 (BB) はブラインドで all-in 済み
  assert.equal(st.hand.phase, 'settled'); assert.equal(st.players[3].status, 'out'); assert.equal(st.players[3].place, 4);
  tick(st, st.nextAt);
  h = st.hand;   // live 0 2 4：bb = next(3) = 4, 前の bb(3) は空席なので SB 無し、btn = 前の SB の位置 = seat2
  assert.equal(h.handNo, 3); assert.equal(h.bbSeat, 4); assert.equal(h.sbSeat, null); assert.equal(h.btn, 2);
  assert.equal(h.commits[3], 0); assert.equal(h.streetBet.filter(x => x > 0).length, 1);
  assert.equal(h.toAct, 0);
  // hand 4：bb = next(4) = 0, sb = 4, btn = 前の SB の位置 = 3（空席）
  act(st, 0, { type: 'fold' }, 1e6); act(st, 2, { type: 'fold' }, 1e6 + 1);
  tick(st, st.nextAt);
  h = st.hand; assert.equal(h.btn, 3); assert.equal(h.sbSeat, 4); assert.equal(h.bbSeat, 0);
  assert.equal(h.toAct, 2);
});

test('3 人 → ヘッズアップ：ボタン = SB、前の BB の次の席が BB', () => {
  const st = table(3, { stacks: [START, 300, START], button: 0 });   // sb1(300) bb2 utg0
  rig(st, { 0: 'As Ah', 1: '7d 2c', 2: 'Ks Kh' }, BOARD_DRY);
  play(st, [[0, 'fold'], [1, 'allin'], [2, 'call']]);
  assert.equal(st.players[1].status, 'out');
  tick(st, st.nextAt);
  const h = st.hand;   // live 0, 2: bb = next(2) = 0, sb = 2 = btn
  assert.equal(h.bbSeat, 0); assert.equal(h.sbSeat, 2); assert.equal(h.btn, 2); assert.equal(h.toAct, 2);
});

/* ======================= 5. 時間 ======================= */
test('15 秒の持ち時間とタイムバンク 30 秒（1 試合・補充なし）', () => {
  const st = table(3);
  const h = st.hand;
  assert.equal(h.turnStart, 0); assert.equal(h.deadline, 45000);
  act(st, 0, { type: 'call' }, 20000);                          // 5 秒ぶんバンクを使う
  assert.equal(st.players[0].timeBankMs, 25000);
  assert.equal(st.hand.turnStart, 20000); assert.equal(st.hand.deadline, 20000 + 15000 + 30000);
  act(st, 1, { type: 'call' }, 20000 + 14999);                  // 15 秒以内ならバンクは減らない
  assert.equal(st.players[1].timeBankMs, 30000);
  act(st, 2, { type: 'check' }, 34999 + 1000);
  // フロップ：seat1 から。タイムアウトでバンクは 0 → 次からは 15 秒だけ
  const t = dueAt(st); assert.equal(st.hand.toAct, 1);
  throwsCode(() => tick(st, t - 1), 'not_yet');
  tick(st, t);
  assert.equal(st.players[1].timeBankMs, 0); assert.equal(st.players[1].autoCount, 1);
  assert.equal(st.hand.actions.at(-1).auto, true); assert.equal(st.hand.actions.at(-1).kind, 'check');   // チェックできるのでチェック
  assert.equal(st.hand.deadline, t + 45000, 'seat 2 still has the full bank');
});

test('自動処理 2 回連続で sitout。手動のアクションで連続回数は戻る。sitin で復帰、leave は戻れない', () => {
  const st = table(3);
  tick(st, dueAt(st));                                   // seat 0 fold (UTG, 要コール)
  assert.equal(st.hand.actions.at(-1).kind, 'fold'); assert.equal(st.players[0].autoCount, 1);
  act(st, 1, { type: 'fold' }, st.hand.turnStart + 1);   // SB フォールド → BB の勝ち
  assert.equal(st.hand.phase, 'settled');
  tick(st, st.nextAt);                                   // hand2: btn1 sb2 bb0, utg=1
  act(st, 1, { type: 'call' }, st.hand.turnStart + 10);
  assert.equal(st.players[1].autoCount, 0);
  tick(st, dueAt(st));                                   // seat 2 (SB)
  assert.equal(st.players[2].autoCount, 1);
  while (st.hand.phase === 'betting') tick(st, dueAt(st));
  assert.equal(st.players[0].status, 'sitout'); assert.equal(st.players[0].autoCount >= 2, true);
  // sitout の席は手番が来た瞬間に自動処理（タイマー待ちなし）
  tick(st, st.nextAt);
  assert.ok(st.hand.phase !== 'betting' || st.hand.toAct !== 0);
  sitin(st, 0, st.hand.startedAt + 5);
  assert.equal(st.players[0].status, 'active'); assert.equal(st.players[0].autoCount, 0);
  throwsCode(() => sitin(st, 0, 1e7), 'illegal');
  leave(st, 0, st.hand.startedAt + 6);
  assert.equal(st.players[0].status, 'left');
  throwsCode(() => sitin(st, 0, 1e7), 'illegal'); throwsCode(() => sitout(st, 0, 1e7), 'illegal'); throwsCode(() => leave(st, 0, 1e7), 'illegal');
});

test('自動処理の連続回数：間に手動のアクションが入れば 0 に戻り、sitout にならない', () => {
  const st = table(2, { button: 0 });
  tick(st, dueAt(st));                                    // hand1：seat0 (SB) が時間切れ → フォールド
  assert.equal(st.players[0].autoCount, 1);
  tick(st, st.nextAt);                                    // hand2：seat1 が SB
  act(st, 1, { type: 'fold' }, st.hand.turnStart + 1);
  tick(st, st.nextAt);                                    // hand3：seat0 が SB
  assert.equal(st.hand.toAct, 0);
  act(st, 0, { type: 'call' }, st.hand.turnStart + 1);
  assert.equal(st.players[0].autoCount, 0); assert.equal(st.players[0].status, 'active');
  act(st, 1, { type: 'check' }, st.hand.turnStart + 2);
  tick(st, dueAt(st));                                    // フロップ：seat1 が時間切れ（1 回目）→ チェック
  assert.equal(st.players[1].autoCount, 1); assert.equal(st.players[1].status, 'active');
});

test('一時停止：生存者が全員 sitout ならハンド間で停止、sitin で再開、10 分ちょうどで中止', () => {
  const st = table(3);
  sitout(st, 0, 1); sitout(st, 1, 2); sitout(st, 2, 3);          // 全員離席 → いまのハンドは自動で消化される
  assert.equal(st.hand.phase, 'settled');
  throwsCode(() => tick(st, st.nextAt - 1), 'not_yet');
  tick(st, st.nextAt);
  assert.equal(st.status, 'paused'); const p0 = st.pausedAt;
  assert.equal(dueAt(st), p0 + PAUSED_EXPIRES_MS);
  throwsCode(() => act(st, 0, { type: 'check' }, p0 + 1), 'game_over');
  const c = structuredClone(st);
  throwsCode(() => tick(c, p0 + PAUSED_EXPIRES_MS - 1), 'not_yet');
  tick(c, p0 + PAUSED_EXPIRES_MS); assert.equal(c.status, 'cancelled'); assert.equal(c.endedAt, p0 + PAUSED_EXPIRES_MS);
  throwsCode(() => tick(c, 1e12), 'game_over'); throwsCode(() => sitin(c, 0, 1e12), 'game_over');
  assert.equal(totalChips(c), 3 * START);
  sitin(st, 2, p0 + 5000);
  assert.equal(st.status, 'running'); assert.equal(st.hand.handNo, 2); assert.equal(st.pausedAt, null);
  assert.equal(st.hand.startedAt, p0 + 5000);
});

test('ハンド間は 3 秒、レベルは 3 分たった後の次のハンドから上がり、タイマーはそこから数え直す', () => {
  const st = table(2);
  assert.equal(st.hand.level, 1);
  act(st, 0, { type: 'fold' }, 179000);
  assert.equal(st.hand.endedAt, 179000); assert.equal(st.nextAt, 179000 + BETWEEN_HANDS_MS);
  throwsCode(() => tick(st, 181999), 'not_yet');
  tick(st, 182000);   // 182000 ≥ 180000 → レベル 2
  assert.equal(st.hand.level, 2); assert.equal(st.hand.bb, 280); assert.equal(st.hand.ante, 70); assert.equal(st.hand.sb, 140);
  assert.equal(st.levelStartAt, 182000); assert.equal(viewFor(st, 0).levelStartAt, 182000);
  // 逆：ハンド中にレベル境界をまたいでもそのハンドのブラインドは変わらない
  act(st, st.hand.toAct, { type: 'call' }, 190000);
  assert.equal(st.hand.level, 2);
  // 次のレベルは 182000 から 3 分（開始からの 6 分ではない）
  for (let t = 190001; st.hand.phase === 'betting'; t++) act(st, st.hand.toAct, { type: legalActions(st, st.hand.toAct).canCheck ? 'check' : 'call' }, t);
  tick(st, 361999); assert.equal(st.hand.level, 2);                 // 361999 − 182000 < 3 分
  act(st, st.hand.toAct, { type: 'fold' }, 362000);
  tick(st, 365000); assert.equal(st.hand.level, 3); assert.equal(st.levelStartAt, 365000);
  const c = table(2);
  act(c, 0, { type: 'fold' }, 176999);
  tick(c, 179999); assert.equal(c.hand.level, 1);
  // 表の最後（veryslow は 59）で止まる
  let x = { level: 1, levelStartAt: 1000 };
  for (let i = 1; i <= 100; i++) x = nextLevel(cfg({ speed: 'veryslow' }), x.level, x.levelStartAt, 1000 + i * 180000);
  assert.equal(x.level, 59);
});

test('設定：上昇間隔は選べない（levelMin は捨てる）、初期チップは 10000/15000/20000/30000 枚', () => {
  assert.deepEqual(START_BBS.map(b => b * BASE_BB), [10000, 15000, 20000, 30000]);
  assert.deepEqual(normalizeConfig({ ...DEFAULT_CONFIG, levelMin: 4 }), DEFAULT_CONFIG);
  assert.equal(normalizeConfig({ ...DEFAULT_CONFIG, startBb: 200 }), null);
  assert.equal(totalChips(table(3, { config: { startBb: 50 } })), 3 * 10000);
});

test('以前の部屋（levelMin あり・levelStartAt なし）は開始からの時間で続きを数える', () => {
  const st = table(2);
  st.config = { ...st.config, levelMin: 5 }; delete st.levelStartAt;
  act(st, 0, { type: 'fold' }, 299000);
  tick(st, 299000 + BETWEEN_HANDS_MS);   // 302000 ≥ 300000 → 2
  assert.equal(st.hand.level, 2); assert.equal(st.levelStartAt, 302000);
});

/* ======================= 6. 退出 ======================= */
test('退出：進行中は left（自動消化）、残り 1 人で終了、残りの席はスタック順', () => {
  const st = table(4, { stacks: [10000, 30000, 20000, 25000], button: 0 });
  // 手番の席が退出 → 即自動処理（要コールなのでフォールド）
  const s0 = st.hand.toAct; leave(st, s0, 1);
  assert.equal(st.hand.folded[s0], true); assert.notEqual(st.hand.toAct, s0);
  assert.equal(totalChips(st), 85000);
});

test('退出で終了：ハンド途中でも退出した席の順位は（返却後の）実スタック順', () => {
  // seat0=40000(生き残り) seat1=30000(SB) seat2=29000(BB) seat3=25000(UTG が 10000 にレイズ)
  const st = table(4, { stacks: [40000, 30000, 29000, 25000], button: 0 });
  act(st, 3, { type: 'raise', to: 10000 }, 1);
  leave(st, 1, 2); leave(st, 2, 3);
  assert.equal(st.status, 'running');
  leave(st, 3, 4);
  assert.equal(st.status, 'finished'); assert.equal(st.winner, 0);
  assert.deepEqual(st.players.map(p => p.stack), [40000, 30000, 29000, 25000]);
  assert.deepEqual(st.players.map(p => p.place), [1, 2, 3, 4]);
});

test('退出者を除いた生存者が脱落で 1 人になったら、その人の勝ちで終了する', () => {
  const st = table(3, { stacks: [START, START, 3000], button: 0 });
  leave(st, 1, 1);                                  // seat1 は退出（以降は自動でフォールド/チェック）
  assert.equal(st.status, 'running');
  rig(st, { 0: 'As Ah', 1: '7d 2c', 2: 'Ks Kh' }, BOARD_DRY);
  // seat0 (UTG) が 3000 までレイズ、seat1 (SB) は left で自動フォールド、seat2 (BB) がコールして負ける
  play(st, [[0, { type: 'raise', to: 3000 }], [2, 'call']], 2);
  assert.equal(st.players[2].status, 'out');
  assert.equal(st.status, 'finished', 'only seat0 is a non-left survivor');
  assert.equal(st.winner, 0);
});

test('退出で終了：ハンド間・一時停止中でも place は一意で pt は payoutsFor 通り', () => {
  const st = table(3, { stacks: [10000, 30000, 20000] });
  act(st, 0, { type: 'fold' }, 1); act(st, 1, { type: 'fold' }, 2);
  assert.equal(st.hand.phase, 'settled');
  leave(st, 0, 3); leave(st, 1, 4);
  assert.equal(st.status, 'finished'); assert.equal(st.winner, 2);
  assert.deepEqual([...st.players.map(p => p.place)].sort(), [1, 2, 3]);
  const pay = payoutsFor(st.config); for (const p of st.players) assert.equal(p.pt, pay[p.place - 1]);
  throwsCode(() => tick(st, 1e9), 'game_over'); throwsCode(() => act(st, 2, { type: 'check' }, 1e9), 'game_over');
});

/* ======================= 7. ビュー・記録の漏れ ======================= */
function checkView(st, seat) {
  const v = viewFor(st, seat), s = J(v);
  for (const k of ['seed', 'ctr', 'deck']) assert.ok(!(k in v) && !(v.hand && k in v.hand), `view has ${k}`);
  assert.ok(!/"seed"|"ctr"|"deck"/.test(s), 'serialized view mentions seed/ctr/deck');
  if (v.hand) {
    const h = st.hand;
    v.hand.hole.forEach((c, s2) => {
      const shown = h.shown && h.shown[s2];
      if (s2 === seat || shown) assert.deepEqual(c, h.hole[s2]);
      else assert.equal(c, null, `seat ${seat} sees hole of ${s2}`);
    });
    if (h.phase === 'betting') assert.equal(h.shown, null);
    // 手札以外のどこにも他席の手札の組が出てこない（actions 等は札を持たない）
    assert.ok(!('hole' in v.hand) || Array.isArray(v.hand.hole));
    assert.deepEqual(v.hand.board, h.board);
  }
  if (v.hand && st.hand.toAct !== null) assert.deepEqual(legalActions(v, st.hand.toAct), legalActions(st), 'legalActions on a view');
  // ビューは独立したコピー（書き換えても st に影響しない）
  if (v.hand) { v.hand.board.push(99); v.players[0].stack = -1; assert.ok(!st.hand.board.includes(99)); assert.notEqual(st.players[0].stack, -1); }
  return v;
}

test('viewFor：山札・鍵・他席の手札を出さない（ショーダウンの公開分のみ）。観戦（seat null）は誰の手札も見えない', () => {
  const st = table(4, { seed: 5 });
  for (let seat = -1; seat < 5; seat++) checkView(st, seat === -1 ? null : seat);
  // 観戦
  assert.ok(viewFor(st, null).hand.hole.every(c => c === null));
  // フォールド勝ちでは公開されない
  play(st, [[3, 'fold'], [0, 'fold'], [1, 'fold']]);
  for (let seat = 0; seat < 4; seat++) { const v = checkView(st, seat); assert.equal(v.hand.hole.filter(Boolean).length, v.hand.hole[seat] ? 1 : 0); }
  // ショーダウン：contenders だけ公開
  tick(st, st.nextAt);
  play(st, [[st.hand.toAct, { type: 'allin' }]], 10);
  const st2 = table(4, { seed: 6 });
  let g = 0; while (st2.hand.phase === 'betting' && g++ < 20) act(st2, st2.hand.toAct, st2.hand.toAct === 3 ? { type: 'allin' } : legalActions(st2).canFold ? { type: 'fold' } : { type: 'check' }, g);
  for (let seat = 0; seat < 4; seat++) checkView(st2, seat);
  const hr = handRecord(st2);
  assert.ok(hr); assert.equal(hr.holes.filter(Boolean).length, 4);
  assert.ok(!('hole' in hr.rec) && !('deck' in hr.rec));
  hr.rec.shown.forEach((c, s) => { if (!st2.hand.shown || st2.hand.folded[s]) assert.equal(c, null); else assert.deepEqual(c, st2.hand.hole[s]); });
});

test('部屋のビュー（viewsOf）：席ごとに自分の手札だけ。直列化にも山札・鍵が含まれない', () => {
  const r0 = rng(3);
  let room = createRoom({ id: 'r', code: '000000', kind: 'private', uid: 'u0', name: 'A', config: cfg({ players: 3 }), now: 0 });
  room = joinRoom(room, 'u1', 'B', 1, r0); room = joinRoom(room, 'u2', 'C', 2, r0);
  assert.equal(room.status, 'running');
  const check = rm => viewsOf(rm).forEach((v, seat) => {
    assert.equal(v.seat, seat); const s = J(v);
    assert.ok(!/"seed"|"ctr"|"deck"/.test(s));
    v.hand && v.hand.hole.forEach((c, i) => { if (i !== seat && !(v.hand.shown && v.hand.shown[i])) assert.equal(c, null); });
  });
  check(room);
  let t = 10;
  for (let i = 0; i < 40 && room.status === 'running'; i++) {
    const st = room.state, h = st.hand;
    if (h.phase === 'settled') { ({ room } = tickRoom(room, 'u0', Math.max(t, st.nextAt))); t = st.nextAt + 1; check(room); continue; }
    const uid = room.members[h.toAct];
    ({ room } = applyRequest(room, uid, { op: 'act', ver: room.ver, move: { type: 'allin' } }, t++)); check(room);
  }
});

/* ======================= 8. ファザー ======================= */
// 手番の席の「いま打てる手」の独立した導出（action ログからの再生）
function refLegal(st) {
  const h = st.hand, s = h.toAct, n = st.n;
  const my = Array(n).fill(0), lastTo = Array(n).fill(null);
  let bet = 0, minRaise = h.bb;
  if (h.street === 0) {
    const ante = q => Math.min(h.ante, h.startStacks[q]);
    if (h.sbSeat !== null) my[h.sbSeat] = Math.min(h.sb, h.startStacks[h.sbSeat] - ante(h.sbSeat));
    my[h.bbSeat] = Math.min(h.bb, h.startStacks[h.bbSeat] - ante(h.bbSeat));
    // コールすべき額は BB 満額（配った時点で動ける人が 2 人以上のとき。BB がショートでも）
    let actable = 0; for (let q = 0; q < n; q++) if (h.startStacks[q] > 0 && h.startStacks[q] - ante(q) - my[q] > 0) actable++;
    bet = Math.max(...my, actable >= 2 ? h.bb : 0);
  }
  for (const a of h.actions) {
    if (a.street !== h.street) continue;
    if (a.kind === 'fold' || a.kind === 'check') { lastTo[a.seat] = bet; continue; }
    my[a.seat] = a.betTo;
    if (a.betTo > bet) { const inc = a.betTo - bet; if (inc >= minRaise) minRaise = inc; bet = a.betTo; }
    lastTo[a.seat] = a.betTo;
  }
  const stack = st.players[s].stack, toCall = Math.max(0, bet - my[s]), callPut = toCall > 0 ? Math.min(toCall, stack) : null, rest = stack - (callPut ?? 0);
  let opp = false; for (let q = 0; q < n; q++) if (q !== s && !h.folded[q] && !h.allIn[q]) opp = true;
  const reopened = lastTo[s] === null || bet - lastTo[s] >= minRaise;
  const exp = { seat: s, canFold: toCall > 0, canCheck: toCall === 0, toCall, callPut, minTo: null, maxTo: null, aggression: null, pot: sum(h.commits), streetLastBetTo: bet };
  if (rest > 0 && opp && reopened) { exp.minTo = bet + Math.min(minRaise, rest); exp.maxTo = bet + rest; exp.aggression = bet > 0 ? 'raise' : 'bet'; }
  return { exp, my, lastTo, bet };
}

/** ストリートが閉じた直後の確認：各席のそのストリートの最終額を action ログから再構成する */
function checkStreetClosed(st, hand, street) {
  const n = st.n, my = Array(n).fill(0), acted = Array(n).fill(false), allIn = Array(n).fill(false);
  // その時点の fold / all-in は、そのストリート以前の action と開始時スタックから再構成
  const fb = Array(n).fill(false);
  for (let s = 0; s < n; s++) fb[s] = !hand.hole[s];   // 脱落済み
  const put = Array(n).fill(0);
  if (true) {
    const ante = q => Math.min(hand.ante, hand.startStacks[q]);
    for (let s = 0; s < n; s++) if (hand.hole[s]) put[s] += ante(s);
    if (hand.sbSeat !== null) put[hand.sbSeat] += Math.min(hand.sb, hand.startStacks[hand.sbSeat] - ante(hand.sbSeat));
    put[hand.bbSeat] += Math.min(hand.bb, hand.startStacks[hand.bbSeat] - Math.min(hand.ante, hand.startStacks[hand.bbSeat]));
    for (let s = 0; s < n; s++) if (hand.hole[s] && put[s] >= hand.startStacks[s]) allIn[s] = true;
  }
  if (street === 0) {
    const ante = q => Math.min(hand.ante, hand.startStacks[q]);
    if (hand.sbSeat !== null) my[hand.sbSeat] = Math.min(hand.sb, hand.startStacks[hand.sbSeat] - ante(hand.sbSeat));
    my[hand.bbSeat] = Math.min(hand.bb, hand.startStacks[hand.bbSeat] - ante(hand.bbSeat));
  }
  for (const a of hand.actions) {
    if (a.street > street) break;
    if (a.kind === 'fold') fb[a.seat] = true;
    if (a.kind === 'allin') allIn[a.seat] = true;
    if (a.street === street) { acted[a.seat] = true; if (a.kind !== 'fold' && a.kind !== 'check') my[a.seat] = a.betTo; }
  }
  const alive = []; for (let s = 0; s < n; s++) if (!fb[s]) alive.push(s);
  const actable = alive.filter(s => !allIn[s]);
  const mx = Math.max(0, ...alive.map(s => my[s]));
  if (actable.length >= 2) for (const s of actable) { assert.ok(acted[s], `street ${street} closed but seat ${s} never acted`); assert.equal(my[s], mx, `street ${street} closed but seat ${s} has not matched`); }
  else if (actable.length === 1) assert.ok(my[actable[0]] >= Math.max(0, ...alive.filter(s => s !== actable[0]).map(s => my[s])), 'lone actable seat has not matched');
}

function checkInvariants(st, total, ctx) {
  assert.equal(totalChips(st), total, `chips ${ctx}`);
  for (const p of st.players) { assert.ok(Number.isInteger(p.stack) && p.stack >= 0, `stack ${ctx}`); assert.ok(p.timeBankMs >= 0 && p.timeBankMs <= TIME_BANK_MS); }
  const h = st.hand;
  if (st.status === 'finished') {
    assert.equal(st.players.filter(p => p.status !== 'out').length >= 1, true);
    assert.equal(sum(st.players.map(p => p.stack)), total, `finished chips ${ctx}`);
    const places = st.players.map(p => p.place).sort((a, b) => a - b);
    assert.deepEqual(places, Array.from({ length: st.n }, (_, i) => i + 1), `places ${ctx}`);
    const pay = payoutsFor(st.config);
    st.players.forEach(p => assert.equal(p.pt, pay[p.place - 1], `pt ${ctx}`));
    assert.equal(st.players[st.winner].place, 1);
    assert.equal(st.players.filter(p => p.place === 1).length, 1);
    assert.equal(st.nextAt, null);
    assert.equal(legalActions(st), null);
  }
  for (let s = 0; s < st.n; s++) {
    const p = st.players[s];
    if (p.status === 'out') { assert.equal(p.stack, 0); assert.ok(p.place >= 2 && p.place <= st.n); }
    else if (st.status !== 'finished') { assert.equal(p.place, null); assert.ok(p.stack > 0 || (h && h.phase === 'betting'), `live seat ${s} with 0 chips between hands ${ctx}`); }
  }
  if (!h) return;
  const dealt = []; for (let s = 0; s < st.n; s++) if (h.hole[s]) dealt.push(...h.hole[s]);
  const all = [...dealt, ...h.board, ...h.deck];
  assert.equal(new Set(all).size, all.length, `duplicate card ${ctx}`);
  assert.equal(all.length, 52, `cards ${ctx}`);
  assert.ok(all.every(c => Number.isInteger(c) && c >= 0 && c < 52));
  assert.equal(h.board.length, [0, 3, 4, 5][h.street] , `board vs street ${ctx}`);
  if (h.phase === 'betting') {
    for (let s = 0; s < st.n; s++) assert.equal(st.players[s].stack + h.commits[s], h.startStacks[s], `seat ${s} stack+commit=start ${ctx}`);
    assert.ok(h.toAct !== null && !h.folded[h.toAct] && !h.allIn[h.toAct] && st.players[h.toAct].stack > 0);
    assert.ok(st.players[h.toAct].status === 'active' || st.status !== 'running', `auto seat left to act ${ctx}`);
    assert.equal(h.deadline, h.turnStart + ACTION_MS + st.players[h.toAct].timeBankMs);
    assert.equal(h.won, null);
    for (let s = 0; s < st.n; s++) assert.equal(h.allIn[s], st.players[s].stack === 0 && !h.folded[s]);
    assert.ok(h.folded.filter(f => !f).length >= 2);
  } else if (h.phase === 'settled') {
    assert.equal(sum(h.won), sum(h.commits)); assert.equal(sum(h.pots.map(p => p.amount)), sum(h.commits));
    for (const pot of h.pots) { assert.ok(pot.winners.every(w => pot.eligible.includes(w))); assert.ok(pot.amount > 0); }
    for (let s = 0; s < st.n; s++) if (h.folded[s]) assert.equal(h.won[s] >= 0, true);
    if (st.status === 'running') assert.equal(st.nextAt, h.endedAt + BETWEEN_HANDS_MS);
  }
}

/** act の受理・拒否が legalActions と一致するか（現在の手番の席に対して境界値を総当たり） */
function checkAgreement(st, now, stats) {
  const h = st.hand, s = h.toAct, L = legalActions(st);
  assert.ok(L && L.seat === s);
  const R = refLegal(st);
  assert.deepEqual({ ...L }, R.exp, 'legalActions vs independent replay');
  const cands = [{ type: 'fold' }, { type: 'check' }, { type: 'call' }, { type: 'allin' }, { type: 'bogus' }, {}, null, undefined];
  const tos = [-1, 0, 1, 199, 200, 1.5, NaN, Infinity, '400', null, undefined];
  if (L.minTo !== null) tos.push(L.minTo - 1, L.minTo, L.minTo + 1, L.maxTo - 1, L.maxTo, L.maxTo + 1, (L.minTo + L.maxTo) >> 1);
  else tos.push(L.streetLastBetTo + 200, L.streetLastBetTo + 1);
  for (const to of tos) cands.push({ type: 'raise', to });
  cands.push({ type: 'raise' });
  const stack = st.players[s].stack;
  for (const m of cands) {
    const before = J(st), c = structuredClone(st);
    let expect;
    const t = m && m.type;
    if (t === 'fold') expect = L.canFold; else if (t === 'check') expect = L.canCheck; else if (t === 'call') expect = L.callPut !== null;
    else if (t === 'allin') expect = L.maxTo !== null || L.callPut !== null;
    else if (t === 'raise') expect = L.minTo !== null && Number.isInteger(m.to) && m.to >= L.minTo && m.to <= L.maxTo;
    else expect = false;
    let ok = true;
    try { act(c, s, m, now); } catch (e) { ok = false; assert.ok(e instanceof EngineError && e.code === 'illegal', `unexpected error ${e && e.code} ${e && e.message} for ${J(m)}`); }
    assert.equal(ok, expect, `act(${J(m)}) accepted=${ok} legal=${expect} L=${J(L)}`);
    assert.equal(J(st), before, 'st mutated by a probe on a clone');
    if (ok) {
      assert.equal(totalChips(c), totalChips(st));
      const a = c.hand.actions[st.hand.actions.length];
      assert.equal(a.seat, s);
      if (t === 'raise') { assert.equal(a.betTo, m.to); assert.equal(a.put, m.to - R.my[s]); assert.ok(a.kind === 'allin' ? m.to === L.maxTo : m.to < L.maxTo); }
      if (t === 'call') assert.equal(a.put, L.callPut);
      if (t === 'allin') { if (c.players[s].stack !== 0) stats.fakeAllin++; }
      if (c.hand.handNo === h.handNo && c.hand.phase === 'betting') assert.equal(a.put + c.players[s].stack, stack, 'put accounting');
    } else {
      for (const wrongSeat of [-1, s === 0 ? 1 : 0, 99, '0', null]) {
        if (wrongSeat === s) continue;
        const cc = structuredClone(st);
        throwsCode(() => act(cc, wrongSeat, { type: L.canCheck ? 'check' : 'call' }, now), 'not_your_turn');
      }
    }
  }
  // 手番でない席の legalActions は null
  for (let q = 0; q < st.n; q++) if (q !== s) assert.equal(legalActions(st, q), null);
}

function fuzzGame(seed, o = {}) {
  const r = rng(seed * 7919 + 13), rr = rng(seed + 424242);
  const n = o.n ?? pick(r, PLAYER_COUNTS);
  const config = cfg({ players: n, startBb: pick(r, START_BBS), speed: pick(r, SPEEDS), mode: pick(r, MODE_IDS) });
  const uneven = r() < 0.3;
  const stacks = uneven ? Array.from({ length: n }, () => 300 + Math.floor(r() * 40) * 123) : undefined;
  const total = uneven ? sum(stacks) : n * config.startBb * BASE_BB;
  let now = Math.floor(r() * 1e6);
  let st = newTable({ config, names: names(n), now, rnd: r, stacks });
  const stats = { steps: 0, hands: 0, allin: 0, ties: 0, multiBust: 0, fakeAllin: 0, timeouts: 0, probes: 0, oddMismatch: 0, leaveOrder: 0 };
  // 打ち方のクセ（ゲームごと）。profile 0 = 荒い（all-in 多め）、1 = 受け身で長い、2 = 中庸（サイズ付き）、3 = 離席・時間切れ・退出が多い
  const profile = o.profile ?? seed % 4;
  const sty = [
    { fold: r() * 0.25, aggr: r() * 0.6, shove: r() * 0.35, chaos: 0, dt: 1 },
    { fold: 0.12 + r() * 0.1, aggr: 0.08 + r() * 0.12, shove: r() * 0.01, chaos: 0, dt: 6, tame: true },
    { fold: 0.1 + r() * 0.15, aggr: 0.2 + r() * 0.25, shove: r() * 0.04, chaos: 0, dt: 3, tame: true },
    { fold: 0.15 + r() * 0.15, aggr: 0.1 + r() * 0.2, shove: r() * 0.05, chaos: 0.05 + r() * 0.08, dt: 4 },
  ][profile];
  sty.chaos = o.chaos ?? sty.chaos; sty.agree = o.agree ?? 0.08;
  let prevLv = null, prevHandNo = 0, dealNow = now, prevBb = null, prevSbPos = null, prevBtn = null;
  const checkDeal = () => {
    const h = st.hand;
    stats.hands++;
    assert.equal(h.startedAt, dealNow);
    const nl = prevLv ? nextLevel(config, prevLv.level, prevLv.levelStartAt, dealNow) : { level: 1, levelStartAt: dealNow };
    assert.equal(st.levelStartAt, nl.levelStartAt, 'levelStartAt'); prevLv = nl;
    const lv = blindsAt(config.speed, nl.level);
    assert.deepEqual([h.level, h.sb, h.bb, h.ante], [lv.level, lv.sb, lv.bb, lv.ante], 'blinds at deal');
    const live = []; for (let s = 0; s < n; s++) if (h.hole[s]) live.push(s);   // 配られた席（同じ操作の中で精算されて脱落していてもよい）
    const nextLive = f => { for (let i = 1; i <= n; i++) { const s = (f + i) % n; if (live.includes(s)) return s; } };
    if (prevBb !== null) {
      assert.equal(h.bbSeat, nextLive(prevBb), 'bb = next live after previous bb');
      if (live.length === 2) { assert.equal(h.btn, h.sbSeat); assert.notEqual(h.sbSeat, h.bbSeat); }
      else {
        assert.equal(h.sbSeat, live.includes(prevBb) ? prevBb : null, `dead small blind: hand ${h.handNo} live=${live} prevBb=${prevBb} prevSbPos=${prevSbPos} btn=${h.btn} sb=${h.sbSeat} bb=${h.bbSeat}`);
        assert.equal(h.btn, prevSbPos, 'button = previous SB position');
      }
    }
    const sbPos = live.length === 2 ? h.sbSeat : (prevBb === null ? nextLive(h.btn) : prevBb);
    prevBb = h.bbSeat; prevSbPos = sbPos; prevBtn = h.btn;
    // 各席の拠出：アンティ → ブラインド
    for (let s = 0; s < n; s++) {
      if (!live.includes(s)) { assert.equal(h.commits[s], 0); continue; }
      const a = Math.min(h.ante, h.startStacks[s]);
      let exp = a; if (s === h.sbSeat) exp += Math.min(h.sb, h.startStacks[s] - a); if (s === h.bbSeat) exp += Math.min(h.bb, h.startStacks[s] - a);
      assert.equal(h.commits[s], exp, `posts seat ${s}`);
    }
    // 手札はライブな席だけ、ボタンの次から 2 枚ずつ
    for (let s = 0; s < n; s++) assert.equal(!!h.hole[s], live.includes(s));
    // 最初の手番：BB の次の動ける席（HU もそのルールでボタン = SB）
    if (h.phase === 'betting') {
      let f = null; for (let i = 1; i <= n && f === null; i++) { const s = (h.bbSeat + i) % n; if (!h.folded[s] && !h.allIn[s]) f = s; }
      assert.equal(h.toAct, f, 'first to act preflop');
    }
  };
  const afterOp = (prev, kind) => {
    stats.steps++;
    checkInvariants(st, total, `seed ${seed} step ${stats.steps} ${kind}`);
    if (kind !== 'init') {
      assert.equal(st.ver, prev.ver + 1, 'ver bumps once per successful call');
      st.players.forEach((p, q) => {
        const b = prev.players[q];
        assert.ok(p.timeBankMs <= b.timeBankMs, 'time bank never refills');
        if (b.status === 'out') assert.equal(p.status, 'out');
        if (b.status === 'left') assert.ok(p.status === 'left' || p.status === 'out', 'left is permanent');
      });
    }
    const due = dueAt(st);
    if (st.status === 'paused') assert.equal(due, st.pausedAt + PAUSED_EXPIRES_MS);
    else if (st.status === 'running') assert.equal(due, st.hand.phase === 'settled' ? st.nextAt : st.hand.deadline);
    else assert.equal(due, null);
    if (st.hand && st.hand.handNo !== prevHandNo) { prevHandNo = st.hand.handNo; checkDeal(); }
    for (let seat = -1; seat < n; seat++) checkView(st, seat === -1 ? null : seat);
    const h = st.hand;
    if (h && prev.hand && h.handNo === prev.hand.handNo) {
      // ストリートが閉じた直後の確認
      if (h.street > prev.hand.street || (h.phase === 'settled' && prev.hand.phase === 'betting' && h.folded.filter(f => !f).length >= 2)) checkStreetClosed(st, h, prev.hand.street);
      // 手番が来た席には本当にやることがある（不要な手番を回さない）
      if (h.phase === 'betting' && h.street === prev.hand.street && kind === 'act') {
        const R = refLegal(st); const acted = R.lastTo[h.toAct] !== null;
        assert.ok(R.exp.toCall > 0 || !acted, `seat ${h.toAct} prompted although street was complete`);
      }
    }
    if (h && h.phase === 'settled' && !(prev.hand && prev.hand.handNo === h.handNo && prev.hand.phase === 'settled')) {
      // 精算の照合
      stats.oddMismatch += compareSettle(h, `seed ${seed} hand ${h.handNo}`);
      const contenders = h.folded.filter(f => !f).length;
      if (contenders >= 2) { stats.allin += h.allIn.filter(Boolean).length; if (h.pots.some(p => p.winners.length > 1)) stats.ties++; }
      const rec = handRecord(st); assert.ok(rec);
      for (let s = 0; s < n; s++) { if (h.shown && h.shown[s]) assert.deepEqual(rec.rec.shown[s], h.hole[s]); else assert.equal(rec.rec.shown[s], null); }
      assert.deepEqual(rec.holes.map(x => !!x), h.startStacks.map(x => x > 0));
      // 脱落の順位
      const aliveBefore = prev.players.map((p, s) => (p.status !== 'out' ? s : -1)).filter(s => s >= 0);
      const bust = aliveBefore.filter(s => st.players[s].stack === 0).sort((a, b) => h.startStacks[b] - h.startStacks[a] || a - b);
      if (bust.length > 1) stats.multiBust++;
      bust.forEach((s, i) => { assert.equal(st.players[s].status, 'out'); assert.equal(st.players[s].place, aliveBefore.length - bust.length + 1 + i, 'elimination place'); });
      assert.deepEqual(h.eliminated.map(e => e.seat), bust);
      const aliveAfter = aliveBefore.length - bust.length, stillAfter = st.players.filter(p => p.status === 'active' || p.status === 'sitout').length;
      if (aliveAfter <= 1) assert.equal(st.status, 'finished');
      else if (st.status === 'finished') assert.ok(stillAfter <= 1, 'finished while two non-left survivors remain');   // 退出者を除いて 1 人 → 終了（BUG-5 の修正後）
    }
  };
  const live = () => st.status === 'running' || st.status === 'paused';
  prevHandNo = 0; dealNow = now; afterOp({ hand: null, players: st.players }, 'init');
  const T0 = now;
  while (live()) {
    if (stats.steps > 40000) throw new Error(`seed ${seed}: game does not terminate`);
    const prev = structuredClone(st);
    if (o.roundtrip && rr() < 0.3) { st = JSON.parse(JSON.stringify(st)); }
    now += pick(r, [10, 500, 3000, 8000, 14000]) * sty.dt + Math.floor(r() * 2000);
    const x = r();
    if (st.status === 'paused') {
      if (x < 0.5) { const so = st.players.map((p, s) => (p.status === 'sitout' ? s : -1)).filter(s => s >= 0); const s = pick(r, so); dealNow = now; sitin(st, s, now); afterOp(prev, 'sitin'); }
      else { now = Math.max(now, dueAt(st)); if (r() < 0.5) { throwsCode(() => tick(structuredClone(st), st.pausedAt + PAUSED_EXPIRES_MS - 1), 'not_yet'); } tick(st, now); afterOp(prev, 'tick'); }
      continue;
    }
    const h = st.hand;
    if (h.phase === 'settled') {
      const c = structuredClone(st); if (st.nextAt - 1 > now) { /* まだ */ } throwsCode(() => tick(c, st.nextAt - 1), 'not_yet');
      now = Math.max(now, st.nextAt); dealNow = now; tick(st, now); afterOp(prev, 'tick'); continue;
    }
    if (sty.chaos && x < sty.chaos) {
      const y = r(), seats = [...Array(n).keys()];
      if (y < 0.45) { const c = seats.filter(s => st.players[s].status === 'active'); if (c.length) { sitout(st, pick(r, c), now); afterOp(prev, 'sitout'); continue; } }
      else if (y < 0.8) { const c = seats.filter(s => st.players[s].status === 'sitout'); if (c.length) { sitin(st, pick(r, c), now); afterOp(prev, 'sitin'); continue; } }
      else if (y < 0.9) { const c = seats.filter(s => st.players[s].status === 'active' || st.players[s].status === 'sitout'); if (c.length) {
        const who = pick(r, c); leave(st, who, now); afterOp(prev, 'leave');
        if (st.status === 'finished') {   // 退出で終了：生き残り → 実スタック（進行中のハンドの拠出は戻す）の多い順 → 席番号
          const still = prev.players.map((p, q) => (q !== who && (p.status === 'active' || p.status === 'sitout') ? q : -1)).filter(q => q >= 0);
          const inHand = prev.hand && prev.hand.phase === 'betting';
          const chips = q => prev.players[q].stack + (inHand ? prev.hand.commits[q] : 0);
          const open = []; for (let pl = 1; pl <= n; pl++) if (!prev.players.some(p => p.place === pl)) open.push(pl);
          const rest = [...Array(n).keys()].filter(q => prev.players[q].status !== 'out').sort((a, b) => (still.includes(b) - still.includes(a)) || chips(b) - chips(a) || a - b);
          const exp = Array(n).fill(null); prev.players.forEach((p, q) => { exp[q] = p.place; }); rest.forEach((q, i) => { exp[q] = open[i]; });
          if (J(exp) !== J(st.players.map(p => p.place))) { assert.ok(inHand, `leave-finish ranking mismatch with no hand in progress (seed ${seed})`); stats.leaveOrder++; }
        }
        continue;
      } }
      else { now = Math.max(now, h.deadline); dealNow = now; tick(st, now); stats.timeouts++; afterOp(prev, 'tick'); continue; }
    }
    if (r() < sty.agree) { checkAgreement(st, now, stats); stats.probes++; }
    if (r() < 0.02) { throwsCode(() => tick(structuredClone(st), h.deadline - 1), 'not_yet'); }
    const s = h.toAct, L = legalActions(st, s), y = r();
    let move;
    if (y < sty.fold && L.canFold) move = { type: 'fold' };
    else if (y < sty.fold + sty.shove) move = { type: 'allin' };
    else if (y < sty.fold + sty.shove + sty.aggr && L.minTo !== null) {
      const z = r(), span = L.maxTo - L.minTo, potTo = Math.min(L.maxTo, Math.max(L.minTo, L.streetLastBetTo + L.pot));
      move = { type: 'raise', to: z < 0.3 ? L.minTo : z < 0.4 && !sty.tame ? L.maxTo : z < 0.7 || sty.tame ? L.minTo + Math.floor(r() * (potTo - L.minTo + 1)) : L.minTo + Math.floor(r() * (span + 1)) };
    } else move = L.canCheck ? { type: 'check' } : { type: 'call' };
    if (r() < 0.04) { const c = structuredClone(st); const bad = pick(r, [{ type: 'raise', to: L.minTo !== null ? L.minTo - 1 : 1 }, { type: 'check' }, { type: 'fold' }]); try { act(c, s, bad, now); } catch (e) { assert.ok(e instanceof EngineError); assert.equal(J(c), J(st)); } }
    // 時間切れで遅れて打つ場合の時間計算
    const when = r() < 0.7 ? Math.min(now, h.deadline) : now;
    now = Math.max(when, h.turnStart); dealNow = now;
    act(st, s, move, now); afterOp(prev, 'act');
  }
  assert.ok(['finished', 'cancelled'].includes(st.status));
  if (st.status === 'cancelled') { assert.equal(totalChips(st), total); assert.ok(st.endedAt >= T0); }
  return { st, stats, total };
}

test('ファズ：ランダム全対局（2〜6 人・全設定・全合法手・時間切れ・離席・退出）で不変条件が保たれる', () => {
  const agg = { steps: 0, hands: 0, allin: 0, ties: 0, multiBust: 0, fakeAllin: 0, timeouts: 0, probes: 0, oddMismatch: 0, leaveOrder: 0, finished: 0, cancelled: 0 };
  const N = 140 * SCALE;
  const t0 = Date.now();
  for (let seed = 1; seed <= N; seed++) {
    const { st, stats } = fuzzGame(seed, { agree: 0.05 });
    for (const k of Object.keys(stats)) agg[k] += stats[k];
    agg[st.status]++;
  }
  console.log('# fuzz', J(agg), `${Date.now() - t0}ms`);
  assert.ok(agg.finished > N * 0.5 && agg.hands > N * 3);
});

test('ファズ：全員 all-in 多めの対局（人数ごと）で複数脱落・サイドポット・引き分けが起き、すべて参照と一致', () => {
  let multi = 0, ties = 0;
  for (let n = 2; n <= 6; n++) for (let seed = 1; seed <= 30 * SCALE; seed++) {
    const { st, stats } = fuzzGame(seed + 1000 * n, { n, chaos: 0, agree: 0.02, profile: seed % 3 });
    assert.equal(st.status, 'finished', `n=${n} seed=${seed}`);
    multi += stats.multiBust; ties += stats.ties;
  }
  assert.ok(multi > 0, 'multi-bust never exercised');
});

test('決定性：同じシードなら同じ対局。JSON に保存して読み戻しても続きが同一', () => {
  for (let seed = 1; seed <= 12; seed++) {
    const a = fuzzGame(seed, { chaos: 0.03 }), b = fuzzGame(seed, { chaos: 0.03 });
    assert.equal(J(a.st), J(b.st), `seed ${seed}`);
    const c = fuzzGame(seed, { chaos: 0.03, roundtrip: true });
    assert.equal(J(a.st), J(c.st), `roundtrip seed ${seed}`);
  }
  // 配札：同じ seed/ctr → 同じ山。違う seed → 違う山
  const mk = s => newTable({ config: cfg({ players: 6 }), names: names(6), now: 0, rnd: rng(s) });
  assert.equal(J(mk(1).hand.hole), J(mk(1).hand.hole)); assert.notEqual(J(mk(1).hand.hole), J(mk(2).hand.hole));
  const t = mk(3); const before = t.ctr; act(t, t.hand.toAct, { type: 'fold' }, 1);
  assert.equal(t.ctr, before, 'act does not consume randomness');
});

/* ======================= 乱数・配札（独立実装の ChaCha20 と照合） ======================= */
function refChachaBlock(key, ctr) {
  const inp = new Uint32Array(16); inp.set([0x61707865, 0x3320646e, 0x79622d32, 0x6b206574]); inp.set(key, 4); inp[12] = ctr >>> 0; inp[13] = Math.floor(ctr / 2 ** 32);
  const x = Uint32Array.from(inp), rot = (v, k) => ((v << k) | (v >>> (32 - k))) >>> 0;
  const qr = (a, b, c, d) => {
    x[a] = (x[a] + x[b]) >>> 0; x[d] = rot(x[d] ^ x[a], 16); x[c] = (x[c] + x[d]) >>> 0; x[b] = rot(x[b] ^ x[c], 12);
    x[a] = (x[a] + x[b]) >>> 0; x[d] = rot(x[d] ^ x[a], 8); x[c] = (x[c] + x[d]) >>> 0; x[b] = rot(x[b] ^ x[c], 7);
  };
  for (let i = 0; i < 10; i++) { qr(0, 4, 8, 12); qr(1, 5, 9, 13); qr(2, 6, 10, 14); qr(3, 7, 11, 15); qr(0, 5, 10, 15); qr(1, 6, 11, 12); qr(2, 7, 8, 13); qr(3, 4, 9, 14); }
  return x.map((v, i) => (v + inp[i]) >>> 0);
}
test('山札：ChaCha20 の鍵ストリーム（RFC 8439 のゼロ鍵ベクトルで検証した参照実装）から Fisher-Yates で作られる', () => {
  const b0 = refChachaBlock(new Uint32Array(8), 0);
  assert.equal(b0[0], 0xade0b876); assert.equal(b0[1], 0x903df1a0); assert.equal(b0[2], 0xe56a5d40);   // 76 b8 e0 ad a0 f1 3d 90 40 5d 6a e5 …
  for (const seed of [1, 2, 3, 99, 4242]) {
    const r = rng(seed), n = 2 + (seed % 5);
    const st = newTable({ config: cfg({ players: n }), names: names(n), now: 0, rnd: r, button: 0 });
    const key = Uint32Array.from(st.seed), startCtr = 0;
    let blk = startCtr, buf = null, i = 16;
    const next = () => { if (i === 16) { buf = refChachaBlock(key, blk++); i = 0; } return buf[i++]; };
    const below = m => { const lim = 2 ** 32 - (2 ** 32 % m); let w; do { w = next(); } while (w >= lim); return w % m; };
    const d = Array.from({ length: 52 }, (_, k) => k);
    for (let k = 51; k > 0; k--) { const j = below(k + 1); [d[k], d[j]] = [d[j], d[k]]; }
    const h = st.hand, popped = []; for (let k = 1; k <= n; k++) { const s = (h.btn + k) % n; popped.push(h.hole[s][0], h.hole[s][1]); }
    assert.deepEqual([...h.deck, ...popped.reverse()], d, `seed ${seed}`);
    assert.equal(st.ctr, blk, 'ctr advanced by the number of blocks consumed');
  }
  // seed 0 / button 未指定：最初の 1 語がボタン（n = 5 → 0xade0b876 % 5 = 4）
  const st = newTable({ config: cfg({ players: 5 }), names: names(5), now: 0, rnd: () => 0 });
  assert.equal(st.hand.btn, 0xade0b876 % 5);
});

test('山札の偏り：52 枚が一様に配られる（カイ二乗の粗いチェック）', () => {
  const cnt = new Array(52).fill(0); const r = rng(99);
  const N = 4000;
  for (let i = 0; i < N; i++) { const st = newTable({ config: cfg({ players: 6 }), names: names(6), now: 0, rnd: r }); for (const hc of st.hand.hole) for (const c of hc) cnt[c]++; }
  const exp = N * 12 / 52; const chi = sum(cnt.map(c => (c - exp) ** 2 / exp));
  assert.ok(chi < 51 + 5 * Math.sqrt(2 * 51), `chi2 ${chi}`);
});

test('act が 0 でも負でも小数でもない整数以外の to を受け付けない（型の穴）', () => {
  const st = table(3);
  const L = legalActions(st);
  for (const to of [L.minTo + 0.5, '600', null, undefined, NaN, Infinity, -Infinity, [600], { valueOf: () => 600 }, 1e21]) {
    const before = J(st);
    assert.throws(() => act(st, 0, { type: 'raise', to }, 1), EngineError, `to=${String(to)}`);
    assert.equal(J(st), before);
  }
  for (const m of [null, undefined, 'fold', 5, [], { type: 'FOLD' }, { type: 'allIn' }]) assert.throws(() => act(st, 0, m, 1), EngineError);
});

test('all-in：全額が入らないとき（レイズ権なし／相手が全員 all-in）に allin をコール以外として記録しない', () => {
  const st = table(2, { stacks: [START, 5000], button: 0 });   // seat0 = SB(btn)、seat1 = BB 5000
  act(st, 0, { type: 'raise', to: 5000 }, 1);                    // seat0 が 5000 まで → seat1 はコール all-in のみ…ではなく先に seat1 を確認
  const st2 = table(2, { stacks: [START, 5000], button: 1 });    // seat1 = SB(btn) 5000、seat0 = BB START
  act(st2, 1, { type: 'allin' }, 1);                              // seat1 all-in 5000 (betTo 4950)
  const L = legalActions(st2);                                    // seat0 は START あるが、相手が all-in なのでレイズ不可
  assert.equal(L.minTo, null);
  act(st2, 0, { type: 'allin' }, 2);                              // 実質コール
  const a = st2.hand.actions.at(-1);
  assert.ok(a.kind !== 'allin' || st2.players[0].stack === 0, `recorded kind=${a.kind} with stack ${st2.players[0].stack}`);
});

test('rules.js 経由でもエンジンの EngineError は illegal / not_your_turn に正規化される', () => {
  const r0 = rng(4);
  let room = createRoom({ id: 'r', code: '000001', kind: 'private', uid: 'u0', name: 'A', config: cfg({ players: 2 }), now: 0 });
  room = joinRoom(room, 'u1', 'B', 1, r0);
  const h = room.state.hand, turn = room.members[h.toAct], other = room.members[1 - h.toAct];
  assert.throws(() => applyRequest(room, other, { op: 'act', ver: room.ver, move: { type: 'fold' } }, 2), e => e.code === 'not_your_turn');
  assert.throws(() => applyRequest(room, turn, { op: 'act', ver: room.ver, move: { type: 'check' } }, 2), e => e.code === 'illegal');
  assert.throws(() => applyRequest(room, turn, { op: 'act', ver: room.ver - 1, move: { type: 'call' } }, 2), e => e.code === 'stale');
  assert.throws(() => applyRequest(room, turn, { op: 'act', ver: room.ver, move: { type: 'raise', to: 1.5 } }, 2), e => e.code === 'illegal');
  assert.throws(() => tickRoom(room, turn, 2), e => e.code === 'not_yet');
  const r2 = leaveRoom(room, turn, 3).room;
  assert.equal(r2.status, 'finished');
});
