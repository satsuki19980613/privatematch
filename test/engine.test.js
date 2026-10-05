import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  newTable, act, tick, sitout, sitin, leave, legalActions, viewFor, handRecord, totalChips, eval7, handName, dueAt, EngineError,
} from '../src/engine.js';
import { DEFAULT_CONFIG, BASE_BB, payoutsFor, ACTION_MS, TIME_BANK_MS, BETWEEN_HANDS_MS, PAUSED_EXPIRES_MS, blindsAt, nextLevel, LEVEL_MS } from '../src/structure.js';

// 再現できる乱数（mulberry32）
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const cfg = (o = {}) => ({ ...DEFAULT_CONFIG, ...o });
const names = n => Array.from({ length: n }, (_, i) => 'P' + i);
const C = s => { const r = '23456789TJQKA'.indexOf(s[0]), u = 'shdc'.indexOf(s[1]); return r * 4 + u; };

test('役の評価', () => {
  const sc = s => eval7(s.split(' ').map(C));
  assert.equal(handName(sc('Ah Kh Qh Jh Th 2c 3d')), 'Royal Flush');
  assert.equal(handName(sc('As 2d 3c 4h 5s 9d 9c')), 'Straight');
  assert.ok(sc('As Ad Kc Kh 2s 3d 4c') > sc('As Ad Qc Qh Js Td 4c'));
  assert.ok(sc('5s 5d 5c 2h 2s 3d 4c') > sc('As Ks Qs Js 9s 3d 4c') === true);
});

test('6人：アンティ・ブラインド・最初の手番', () => {
  const st = newTable({ config: cfg({ players: 6 }), names: names(6), now: 0, rnd: rng(1), button: 0 });
  const h = st.hand, { sb, bb, ante } = blindsAt('normal', 1);
  assert.equal(h.btn, 0); assert.equal(h.sbSeat, 1); assert.equal(h.bbSeat, 2);
  assert.deepEqual(h.commits, [ante, ante + sb, ante + bb, ante, ante, ante]);
  assert.deepEqual(h.streetBet, [0, sb, bb, 0, 0, 0]);
  assert.equal(h.toAct, 3);
  assert.equal(st.players[3].stack, 100 * BASE_BB - ante);
  assert.equal(h.deadline, ACTION_MS + TIME_BANK_MS);
  const L = legalActions(st);
  assert.equal(L.toCall, bb); assert.equal(L.minTo, 2 * bb); assert.equal(L.maxTo, 100 * BASE_BB - ante);
  assert.equal(totalChips(st), 6 * 100 * BASE_BB);
});

test('全員フォールドで BB の勝ち・次のハンドはデッドボタン規則で進む', () => {
  const st = newTable({ config: cfg({ players: 4 }), names: names(4), now: 0, rnd: rng(2), button: 0 });
  act(st, 3, { type: 'fold' }, 10); act(st, 0, { type: 'fold' }, 20); act(st, 1, { type: 'fold' }, 30);
  assert.equal(st.hand.phase, 'settled');
  assert.equal(st.hand.won[2], 4 * 50 + 100 + 200);
  assert.equal(st.nextAt, 30 + BETWEEN_HANDS_MS);
  assert.throws(() => tick(st, 31), e => e.code === 'not_yet');
  tick(st, 30 + BETWEEN_HANDS_MS);
  assert.equal(st.hand.handNo, 2);
  assert.equal(st.hand.btn, 1); assert.equal(st.hand.sbSeat, 2); assert.equal(st.hand.bbSeat, 3);
});

test('ヘッズアップ：ボタンが SB でプリフロップ先手、ポストフロップ後手', () => {
  const st = newTable({ config: cfg({ players: 2 }), names: names(2), now: 0, rnd: rng(3), button: 1 });
  assert.equal(st.hand.btn, 1); assert.equal(st.hand.sbSeat, 1); assert.equal(st.hand.bbSeat, 0);
  assert.equal(st.hand.toAct, 1);
  act(st, 1, { type: 'call' }, 1); act(st, 0, { type: 'check' }, 2);
  assert.equal(st.hand.street, 1); assert.equal(st.hand.board.length, 3);
  assert.equal(st.hand.toAct, 0);
});

test('サイドポット：3人オールイン', () => {
  const st = newTable({ config: cfg({ players: 3 }), names: names(3), now: 0, rnd: rng(4), button: 0, stacks: [5000, 10000, 20000] });
  // btn 0, sb 1, bb 2。0 → 1 → 2 の順にオールイン/コール
  act(st, 0, { type: 'allin' }, 1); act(st, 1, { type: 'allin' }, 2); act(st, 2, { type: 'call' }, 3);
  const h = st.hand;
  assert.equal(h.phase, 'settled'); assert.equal(h.board.length, 5);
  assert.equal(h.pots.length, 2);                     // 5000×3 / 5000×2（seat2 の超過は返却されて won に入る）
  assert.equal(h.pots[0].amount, 15000); assert.equal(h.pots[1].amount, 10000);
  assert.equal(totalChips(st), 35000);
  assert.ok(h.shown.every(x => x));                   // 全員表向き
});

test('最小レイズ未満のオールインはレイズ権を再開しない', () => {
  const st = newTable({ config: cfg({ players: 3 }), names: names(3), now: 0, rnd: rng(5), button: 0, stacks: [20000, 20000, 1500] });
  // btn0 sb1 bb2(1500 から ante50 + bb200)。0 が 1000 にレイズ、1 フォールド、2 オールイン 1450（+450 < 800）
  act(st, 0, { type: 'raise', to: 1000 }, 1); act(st, 1, { type: 'fold' }, 2); act(st, 2, { type: 'allin' }, 3);
  const L = legalActions(st, 0);
  assert.equal(L.minTo, null); assert.equal(L.callPut, 450);
});

test('時間切れ：自動でチェック/フォールド、2回で sitout、全員 sitout で一時停止、10分で中止', () => {
  const st = newTable({ config: cfg({ players: 2 }), names: names(2), now: 0, rnd: rng(6), button: 0 });
  assert.throws(() => tick(st, 1000), e => e.code === 'not_yet');
  tick(st, dueAt(st));                                // seat0 (SB) がフォールド扱い
  assert.equal(st.players[0].autoCount, 1); assert.equal(st.players[0].timeBankMs, 0);
  let t = st.nextAt; tick(st, t);
  // 2ハンド目：seat1 が SB。seat1 も時間切れ
  tick(st, dueAt(st)); t = st.nextAt; tick(st, t);
  // 3ハンド目：seat0 が SB で2回目の時間切れ → sitout
  tick(st, dueAt(st));
  assert.equal(st.players[0].status, 'sitout');
  sitout(st, 1, st.hand.endedAt);                     // seat1 も自分で離席
  tick(st, st.nextAt);
  assert.equal(st.status, 'paused');
  assert.throws(() => tick(st, st.pausedAt + 1000), e => e.code === 'not_yet');
  sitin(st, 1, st.pausedAt + 2000);
  assert.equal(st.status, 'running'); assert.equal(st.hand.phase, 'betting');
  sitout(st, 1, st.pausedAt + 3000);
  // seat0・seat1 とも sitout なのでハンドは自動で進み、次のハンドで一時停止 → 期限で中止
  tick(st, st.nextAt);
  assert.equal(st.status, 'paused');
  tick(st, st.pausedAt + PAUSED_EXPIRES_MS);
  assert.equal(st.status, 'cancelled');
});

test('退出：残り1人になったら即終了し、退出した席はスタック順', () => {
  const st = newTable({ config: cfg({ players: 3, mode: 'club' }), names: names(3), now: 0, rnd: rng(7), button: 0 });
  leave(st, 1, 5);
  assert.equal(st.players[1].status, 'left'); assert.equal(st.status, 'running');
  leave(st, 2, 6);
  assert.equal(st.status, 'finished'); assert.equal(st.winner, 0);
  assert.equal(st.players[0].place, 1); assert.equal(st.players[0].pt, 5);
  assert.deepEqual(st.players.map(p => p.place).sort(), [1, 2, 3]);
});

test('ビューは他人の手札と山札を見せない', () => {
  const st = newTable({ config: cfg({ players: 3 }), names: names(3), now: 0, rnd: rng(8), button: 0 });
  const v = viewFor(st, 1);
  assert.equal(v.seed, undefined); assert.equal(v.hand.deck, undefined);
  assert.ok(v.hand.hole[1]); assert.equal(v.hand.hole[0], null); assert.equal(v.hand.hole[2], null);
  assert.deepEqual(legalActions(v), legalActions(st));
});

test('レベルは 3 分で上がり、次のハンドから適用。タイマーはそのハンドから数え直す', () => {
  const c = cfg();
  assert.equal(LEVEL_MS, 180000);
  assert.deepEqual(nextLevel(c, 1, 0, 179999), { level: 1, levelStartAt: 0 });
  assert.deepEqual(nextLevel(c, 1, 0, 200000), { level: 2, levelStartAt: 200000 });   // 20 秒遅れて上がっても次は 200000 から 3 分
  assert.deepEqual(nextLevel(c, 2, 200000, 379999), { level: 2, levelStartAt: 200000 });
  assert.deepEqual(nextLevel(c, 1, 0, 1e12), { level: 2, levelStartAt: 1e12 });      // 長く止まっていても 1 つずつ
  assert.deepEqual(nextLevel(c, 16, 0, 1e12), { level: 16, levelStartAt: 0 });       // 表の最後で止まる
  assert.deepEqual(nextLevel(cfg({ levelMin: 5 }), 1, 0, 299999), { level: 1, levelStartAt: 0 });   // 以前の部屋は選んだ分数のまま
  assert.deepEqual(nextLevel(cfg({ levelMin: 5 }), 1, 0, 300000), { level: 2, levelStartAt: 300000 });
});

// ランダムに打って、不変条件（チップの保存・順位・pt）を確かめる
function randomGame(n, seed, opts = {}) {
  const r = rng(seed), config = cfg({ players: n, startBb: [50, 75, 100, 150][seed % 4], speed: ['normal', 'slow', 'veryslow'][seed % 3], mode: ['club', 'rank-4', 'legend-avg'][seed % 3] });
  const st = newTable({ config, names: names(n), now: 0, rnd: r });
  const total = n * config.startBb * BASE_BB;
  let now = 0, steps = 0, hands = 0, lastHand = 0;
  while (st.status === 'running' || st.status === 'paused') {
    if (++steps > 20000) throw new Error('too long');
    now += 1000 + Math.floor(r() * 30000);
    if (st.status === 'paused') { if (r() < 0.5) sitin(st, st.players.findIndex(p => p.status === 'sitout'), now); else tick(st, dueAt(st)); continue; }
    const h = st.hand;
    if (h.phase === 'settled') {
      if (h.handNo !== lastHand) { lastHand = h.handNo; hands++; assert.ok(handRecord(st)); assert.equal(h.won.reduce((a, b) => a + b, 0), h.commits.reduce((a, b) => a + b, 0)); }
      tick(st, Math.max(now, st.nextAt)); continue;
    }
    const s = h.toAct, L = legalActions(st, s), x = r();
    if (opts.chaos && x < 0.02) { const any = st.players.findIndex(p => p.status === 'active' || p.status === 'sitout'); if (any >= 0) leave(st, any, now); continue; }
    if (opts.chaos && x < 0.05) { tick(st, Math.max(now, h.deadline)); continue; }
    if (opts.chaos && x < 0.06) { const sa = st.players.findIndex(p => p.status === 'sitout'); if (sa >= 0) sitin(st, sa, now); continue; }
    let move;
    if (x < 0.15 && L.canFold) move = { type: 'fold' };
    else if (x < 0.55) move = L.canCheck ? { type: 'check' } : { type: 'call' };
    else if (x < 0.9 && L.minTo != null) move = { type: 'raise', to: L.minTo + Math.floor(r() * (L.maxTo - L.minTo + 1)) };
    else move = { type: 'allin' };
    act(st, s, move, now);
    assert.equal(totalChips(st), total, `chips at step ${steps}`);
  }
  return { st, hands };
}

test('ランダム対局：チップの保存・順位・pt（2〜6人）', () => {
  for (let n = 2; n <= 6; n++) for (let seed = 1; seed <= 12; seed++) {
    const { st } = randomGame(n, seed * 31 + n);
    assert.equal(st.status, 'finished');
    const places = st.players.map(p => p.place).sort((a, b) => a - b);
    assert.deepEqual(places, Array.from({ length: n }, (_, i) => i + 1));
    const pay = payoutsFor(st.config);
    for (const p of st.players) assert.equal(p.pt, pay[p.place - 1]);
    assert.equal(st.players[st.winner].place, 1);
  }
});

test('ランダム対局（時間切れ・退出・離席あり）でも壊れない', () => {
  for (let n = 2; n <= 6; n++) for (let seed = 1; seed <= 15; seed++) {
    const { st } = randomGame(n, seed * 17 + n * 3, { chaos: true });
    assert.ok(['finished', 'cancelled'].includes(st.status));
    if (st.status === 'finished') assert.deepEqual(st.players.map(p => p.place).sort((a, b) => a - b), Array.from({ length: n }, (_, i) => i + 1));
  }
});

test('違法な操作は EngineError で状態を変えない', () => {
  const st = newTable({ config: cfg({ players: 3 }), names: names(3), now: 0, rnd: rng(9), button: 0 });
  const before = JSON.stringify(st);
  assert.throws(() => act(st, 1, { type: 'fold' }, 1), EngineError);
  assert.throws(() => act(st, 0, { type: 'check' }, 1), EngineError);
  assert.throws(() => act(st, 0, { type: 'raise', to: 201 }, 1), EngineError);
  assert.equal(JSON.stringify(st), before);
});
