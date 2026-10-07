// ベットサイズの設定と候補（src/betsize.js）：場面の見分け、額の計算、保存されたものの正規化。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newTable, act, legalActions, viewFor } from '../src/engine.js';
import { DEFAULT_CONFIG } from '../src/structure.js';
import { normalizeSizes, makeSize, sceneOf, sizeTo, quickSizes, stepChips, defaultSizes, MAX_ITEMS } from '../src/betsize.js';

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const table = n => newTable({ config: { ...DEFAULT_CONFIG, players: n, startBb: 100 }, names: Array.from({ length: n }, (_, i) => 'p' + i), now: 0, rnd: rng(3), button: 0 });
const at = st => { const v = viewFor(st, st.hand.toAct); return [legalActions(v, v.seat), v.hand]; };

test('プリフロップ：まだレイズが無ければ open（BB の倍数）、レイズを受けたら vsRaise（x は直前のレイズ額の倍）', () => {
  const st = table(3), bb = st.hand.bb;
  let [l, h] = at(st);
  assert.equal(sceneOf(l, h), 'open');
  assert.equal(sizeTo('2.5bb', l, h), 2.5 * bb);
  act(st, st.hand.toAct, { type: 'raise', to: 3 * bb }, 1);
  [l, h] = at(st);
  assert.equal(sceneOf(l, h), 'vsRaise');
  assert.equal(sizeTo('3x', l, h), 9 * bb);
  assert.equal(sizeTo('10bb', l, h), 10 * bb);
});

test('ポストフロップ：ベットはポットの %、ベットを受けたら x は直前のベットの倍・% はコール後のポットの割合を足す', () => {
  const st = table(2), bb = st.hand.bb;
  act(st, st.hand.toAct, { type: 'call' }, 1);
  act(st, st.hand.toAct, { type: 'check' }, 2);
  let [l, h] = at(st);
  assert.equal(h.street, 1);
  assert.equal(sceneOf(l, h), 'bet');
  assert.equal(sizeTo('50%', l, h), Math.round(l.pot / 2));
  act(st, st.hand.toAct, { type: 'raise', to: 2 * bb }, 3);
  [l, h] = at(st);
  assert.equal(sceneOf(l, h), 'vsBet');
  assert.equal(sizeTo('3x', l, h), 6 * bb);
  assert.equal(sizeTo('100%', l, h), 2 * bb + l.pot + l.toCall);
});

test('シートの候補：Min が先頭、Min と All-in の間だけ・同じ額は 1 つ・額の順。All-in は含めない', () => {
  const st = table(3), bb = st.hand.bb, [l, h] = at(st);
  const q = quickSizes(l, h, { ...defaultSizes(), open: ['2bb', '3bb', '3bb', '500bb', '1bb', '2.5bb'] });
  assert.deepEqual(q.map(x => x[0]), ['Min', '2.5bb', '3bb']);   // 2bb = Min と同じ額、1bb は Min 未満、500bb はスタック超え
  assert.equal(q[0][1], l.minTo);
  assert.ok(q.every(([, x]) => x < l.maxTo));
  for (let i = 1; i < q.length; i++) assert.ok(q[i][1] > q[i - 1][1]);
  assert.equal(stepChips({ step: 0.5 }, bb), bb / 2);
  assert.equal(stepChips({ step: 0.1 }, 2), 1);
});

test('正規化：壊れた値・単位違い・範囲外・重複は捨て、並べ替え、15 個まで。無ければ既定値', () => {
  assert.deepEqual(normalizeSizes(null), defaultSizes());
  assert.deepEqual(normalizeSizes('junk'), defaultSizes());
  const n = normalizeSizes({ step: 3, open: ['3bb', '2x', 'abc', '2bb', '3bb', '0.5bb'], vsBet: ['50%', '3x', '1x', '2x'] });
  assert.equal(n.step, defaultSizes().step);
  assert.deepEqual(n.open, ['2bb', '3bb']);
  assert.deepEqual(n.vsBet, ['2x', '3x', '50%']);
  assert.equal(normalizeSizes({ bet: Array.from({ length: 30 }, (_, i) => (i + 1) * 10 + '%') }).bet.length, MAX_ITEMS);
  assert.equal(makeSize('vsRaise', '2.555', 'x'), '2.56x');
  assert.equal(makeSize('bet', '33.4', '%'), '33%');
  assert.equal(makeSize('open', '3', 'x'), null);
  assert.equal(makeSize('vsRaise', '1', 'x'), null);
});
