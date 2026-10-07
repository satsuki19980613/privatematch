// 卓の遷移の見せ方（src/pace.js）：本物のエンジンで作ったビューの組で、種類・順番・時間を確かめる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newTable, act, tick, legalActions, viewFor } from '../src/engine.js';
import { DEFAULT_CONFIG, BASE_BB } from '../src/structure.js';
import { PACE, plan, transition, closingBets, nextToApply } from '../src/pace.js';

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const cfg = n => ({ ...DEFAULT_CONFIG, players: n, startBb: 50 });
const names = n => Array.from({ length: n }, (_, i) => 'p' + i);
const V = (st, seat = 0) => viewFor(st, seat);

test('研究に基づく間：1 拍は attentional blink（〜500ms）を越え、動きは 200〜400ms、出来事から押せるまで 1 秒以内', () => {
  assert.ok(PACE.beat >= 500 && PACE.beat <= 650);
  for (const k of ['pop', 'show', 'flip', 'controlsIn', 'sheetIn', 'sheetOut']) assert.ok(PACE[k] >= 180 && PACE[k] <= 400, k);
  // 配る・チップが動く・フロップは、遊んで速すぎるという声で 1.8 倍（もとは gather 340・deal 200/80・チップ 650・フロップ 260/110）
  for (const [k, was] of [['gather', 340], ['deal', 200], ['dealStagger', 80], ['chip', 650], ['flopFlip', 260], ['flopStagger', 110]]) assert.equal(PACE[k], Math.round(was * 1.8), k);
  assert.ok(PACE.win >= PACE.chip, 'フォールドで終わったら、チップが届くまで次を待つ');
  assert.ok(PACE.sheetIn > PACE.sheetOut, '出る方を長く');
  assert.ok(PACE.lock >= 350 && PACE.lock <= 500);
  assert.ok(PACE.beat + PACE.lock <= 1000, '相手のアクションから自分が押せるまで 1 秒以内');
  assert.ok(PACE.flipStagger >= 100, '1 枚ずつ認識できる刻み');
  assert.ok(PACE.deal + 11 * PACE.dealStagger <= 2000, '6 人に配っても 2 秒以内');
});

test('action：相手が 1 人動いた → そのチップを出し、1 拍おいて手番を移す', () => {
  const st = newTable({ config: cfg(3), names: names(3), now: 0, rnd: rng(1), button: 0 });
  const a = V(st), s = st.hand.toAct;
  act(st, s, { type: 'raise', to: 3 * st.hand.bb }, 10);
  const b = V(st), p = plan(a, b);
  assert.equal(p.kind, 'action');
  assert.equal(p.steps.length, 1);
  assert.equal(p.steps[0].at, 0); assert.equal(p.steps[0].bets[s], 3 * st.hand.bb); assert.equal(p.steps[0].shown, a.hand.actions.length + 1);
  assert.deepEqual(p.steps[0].adj, Array(3).fill(0));
  assert.equal(p.turnAt, PACE.beat); assert.equal(p.hold, PACE.beat);
  assert.equal(p.veil, false); assert.equal(p.board, null);
});

test('action：2 人が続けて動いたビューは 1 拍ずつ。途中のベットとスタックの差分は正しい', () => {
  const st = newTable({ config: cfg(4), names: names(4), now: 0, rnd: rng(2), button: 0 });
  const a = V(st), s1 = st.hand.toAct;
  act(st, s1, { type: 'raise', to: 3 * st.hand.bb }, 10);
  const s2 = st.hand.toAct;
  act(st, s2, { type: 'raise', to: 8 * st.hand.bb }, 20);
  const b = V(st), p = plan(a, b);
  assert.equal(p.kind, 'action');
  assert.deepEqual(p.steps.map(x => x.at), [0, PACE.beat]);
  assert.equal(p.steps[0].bets[s1], 3 * st.hand.bb); assert.equal(p.steps[0].bets[s2], a.hand.streetBet[s2]);
  assert.equal(p.steps[0].adj[s2], 8 * st.hand.bb - a.hand.streetBet[s2], '2 人目のベットはまだスタックに残して見せる');
  assert.deepEqual(p.steps[1].bets, b.hand.streetBet);
  assert.deepEqual(p.steps[1].adj, Array(4).fill(0));
  assert.equal(p.turnAt, 2 * PACE.beat);
});

test('street：コールで街が閉じる → 最後のチップを見せて、集めて、一呼吸おいてフロップを 1 枚ずつ', () => {
  const st = newTable({ config: cfg(2), names: names(2), now: 0, rnd: rng(3), button: 0 });
  const a = V(st);
  act(st, st.hand.toAct, { type: 'call' }, 10); act(st, st.hand.toAct, { type: 'check' }, 20);
  const b = V(st), p = plan(a, b);
  assert.equal(p.kind, 'street');
  assert.equal(p.steps.length, 2);
  assert.deepEqual(p.steps[1].bets, [st.hand.bb, st.hand.bb]);
  assert.deepEqual(closingBets(a.hand, b.hand), [st.hand.bb, st.hand.bb]);
  assert.equal(p.board, 0);
  const base = PACE.beat + PACE.pop;
  assert.equal(p.gatherAt, base + PACE.show);
  assert.equal(p.revealAt, p.gatherAt + PACE.gather + PACE.gap);
  assert.equal(p.end, p.revealAt + PACE.flopFlip + 2 * PACE.flopStagger);   // フロップは 1.8 倍ゆっくり
  assert.equal(p.turnAt, p.end);
  assert.ok(p.hold >= p.revealAt + PACE.beat);
  // 1 アクションで閉じたときは 2.5 秒以内に次へ
  const st2 = newTable({ config: cfg(2), names: names(2), now: 0, rnd: rng(3), button: 0 });
  act(st2, st2.hand.toAct, { type: 'call' }, 10);
  const c = V(st2); act(st2, st2.hand.toAct, { type: 'check' }, 20);
  const q = plan(c, V(st2));
  assert.equal(q.kind, 'street'); assert.ok(q.turnAt <= 2500, `${q.turnAt}`);   // フロップを 1.8 倍ゆっくりにしても 2.5 秒以内
});

test('win：フォールドで終わる → 結果は集め終わるまで伏せる', () => {
  const st = newTable({ config: cfg(3), names: names(3), now: 0, rnd: rng(4), button: 0 });
  const a = V(st);
  act(st, st.hand.toAct, { type: 'fold' }, 10); act(st, st.hand.toAct, { type: 'fold' }, 20);
  const p = plan(a, V(st));
  assert.equal(p.kind, 'win'); assert.equal(p.veil, true);
  assert.equal(p.steps.length, 2);
  assert.ok(p.gatherAt < p.revealAt);
  assert.equal(p.hold, p.revealAt + PACE.win);
});

test('showdown：オールインとコール → 最後のチップを見せてから演出', () => {
  const st = newTable({ config: cfg(2), names: names(2), now: 0, rnd: rng(5), button: 0 });
  const a = V(st);
  act(st, st.hand.toAct, { type: 'allin' }, 10);
  const b = V(st);
  act(st, st.hand.toAct, { type: 'call' }, 20);
  const c = V(st), p = plan(b, c);
  assert.equal(p.kind, 'showdown'); assert.equal(p.veil, true);
  assert.equal(p.runoutAt, PACE.pop + PACE.show);
  assert.equal(p.gatherAt, null);
  assert.equal(p.steps.length, 1); assert.equal(p.steps[0].bets[c.hand.actions.at(-1).seat], c.hand.actions.at(-1).betTo);
  assert.equal(plan(a, c).steps.length, 2, '2 手まとめて来ても 1 拍ずつ');
});

test('deal：新しいハンドは配り終えてから手番。ブラインドだけでオールインなら配ってからショーダウン', () => {
  const st = newTable({ config: cfg(3), names: names(3), now: 0, rnd: rng(6), button: 0 });
  const a = V(st);
  act(st, st.hand.toAct, { type: 'fold' }, 10); act(st, st.hand.toAct, { type: 'fold' }, 20);
  const b = V(st);
  tick(st, st.nextAt);
  const p = plan(b, V(st));
  assert.equal(p.kind, 'deal');
  assert.equal(p.turnAt, PACE.deal + 5 * PACE.dealStagger);
  assert.equal(plan(a, V(st)).kind, 'deal');
  const hu = newTable({ config: cfg(2), names: names(2), now: 0, rnd: rng(7), button: 0, stacks: [50 * BASE_BB, 30] });
  const prev = { ...V(hu), hand: { ...V(hu).hand, handNo: 0, phase: 'settled' } };
  const q = plan(prev, V(hu));
  assert.equal(q.kind, 'deal-showdown'); assert.equal(q.runoutAt, q.turnAt); assert.equal(q.veil, true); assert.equal(q.board, 0);
});

test('none / init：同じ状態・離席・初めて・席が違う', () => {
  const st = newTable({ config: cfg(3), names: names(3), now: 0, rnd: rng(8), button: 0 });
  const a = V(st);
  assert.equal(plan(a, V(st)).kind, 'none');
  assert.equal(plan(null, a).kind, 'init');
  assert.equal(transition(a, V(st, 1)).kind, 'init');
  assert.equal(plan(a, a).hold, 0);
});

test('どの遷移も順番が崩れない（ランダムに 300 ハンド打って、続くビューの組すべて）', () => {
  let count = 0;
  const kinds = new Set();
  for (let seed = 1; seed <= 12; seed++) {
    const n = 2 + (seed % 5), r = rng(seed);
    const st = newTable({ config: cfg(n), names: names(n), now: 0, rnd: r, button: 0 });
    let now = 10, prev = V(st, 0);
    for (let g = 0; g < 4000 && st.status === 'running' && count < 300 * 12; g++) {
      const h = st.hand;
      if (h.phase === 'settled') { now = Math.max(now, st.nextAt); tick(st, now); }
      else {
        const L = legalActions(st), x = r();
        const mv = x < .2 && L.canFold ? { type: 'fold' } : x < .3 && L.minTo != null ? { type: 'raise', to: L.minTo } : x < .34 && L.maxTo != null ? { type: 'allin' } : L.canCheck ? { type: 'check' } : { type: 'call' };
        act(st, h.toAct, mv, ++now);
      }
      // 席 0 から見て、毎回のビューと、ときどき 2〜3 手まとめたビュー
      const cur = V(st, 0);
      if (r() < .7 || cur.hand.handNo !== prev.hand.handNo) {
        const p = plan(prev, cur);
        kinds.add(p.kind); count++;
        const ctx = `seed ${seed} hand ${cur.hand.handNo} ${p.kind}`;
        p.steps.forEach((s, i) => { assert.equal(s.at, i * PACE.beat, ctx); assert.ok(s.adj.every(x => x >= 0), ctx); });
        if (p.gatherAt != null) assert.ok(p.gatherAt >= (p.steps.length ? p.steps.at(-1).at : 0), ctx);
        if (p.revealAt != null) assert.ok(p.revealAt > p.gatherAt, ctx);
        assert.ok(p.end <= p.hold || p.kind.includes('showdown'), ctx);
        assert.ok(p.turnAt <= p.hold || p.kind.includes('showdown'), ctx);
        if (p.kind === 'action') assert.ok(p.turnAt <= p.steps.length * PACE.beat, ctx);
        if (p.kind === 'street' || p.kind === 'win') {
          const last = p.steps.at(-1);
          if (last) assert.deepEqual(last.bets, closingBets(prev.hand, cur.hand), ctx);
          assert.ok(p.board <= cur.hand.board.length, ctx);
        }
        if (['street', 'win', 'showdown'].includes(p.kind)) assert.ok(p.steps.length || p.bets0, ctx);
        prev = cur;
      }
    }
  }
  for (const k of ['action', 'street', 'win', 'showdown', 'deal']) assert.ok(kinds.has(k), `${k} を通った`);
});

test('nextToApply：前の遷移が終わるまで待ち、3 秒以上遅れたら最新へ飛ぶ', () => {
  const q = [{ v: 1, at: 1000 }, { v: 2, at: 1100 }];
  assert.deepEqual(nextToApply([], 0, 0), { take: null, skip: 0, wait: 0 });
  assert.deepEqual(nextToApply(q, 1500, 1200), { take: null, skip: 0, wait: 300 });
  assert.equal(nextToApply(q, 1500, 1500).take.v, 1);
  const late = nextToApply(q, 99999, 1000 + PACE.maxLag);
  assert.equal(late.take.v, 2); assert.equal(late.skip, 1); assert.equal(late.late, true);
});
