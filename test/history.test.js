import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newTable, act, tick, legalActions, handRecord } from '../src/engine.js';
import { DEFAULT_CONFIG } from '../src/structure.js';
import { forcedOf, committedOf, netOfRecord, positionsOf, streetPots } from '../src/history/hand.js';
import { summarize, cumulativePt, filterByPeriod, finishedGames, handStats, niceTicks } from '../src/history/stats.js';

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

test('ハンドの記録から拠出額・収支・ポットを復元できる（エンジンの値と一致）', () => {
  for (let n = 2; n <= 6; n++) for (let seed = 1; seed <= 8; seed++) {
    const r = rng(seed * 7 + n), st = newTable({ config: { ...DEFAULT_CONFIG, players: n }, names: Array(n).fill('x'), now: 0, rnd: r });
    let now = 0, checked = 0;
    while (st.status === 'running' && checked < 40) {
      now += 1000;
      const h = st.hand;
      if (h.phase === 'settled') {
        const rec = handRecord(st).rec;
        for (let s = 0; s < n; s++) {
          assert.equal(committedOf(rec, s), h.commits[s], `commit seat ${s}`);
          assert.equal(netOfRecord(rec, s), rec.won[s] - h.commits[s]);
        }
        const pos = positionsOf(rec);
        assert.equal(pos[rec.bbSeat], 'BB');
        assert.equal(pos.filter(Boolean).length, rec.startStacks.filter(x => x > 0).length);
        assert.ok(streetPots(rec).every((p, i, a) => i === 0 || p >= a[i - 1]));
        assert.equal(forcedOf(rec).reduce((a, b) => a + b, 0) <= rec.won.reduce((a, b) => a + b, 0), true);
        checked++;
        tick(st, Math.max(now, st.nextAt)); continue;
      }
      const L = legalActions(st), x = r();
      act(st, h.toAct, x < 0.3 && L.canFold ? { type: 'fold' } : x < 0.8 || L.minTo == null ? (L.canCheck ? { type: 'check' } : { type: 'call' }) : { type: 'raise', to: L.minTo }, now);
    }
  }
});

test('成績の集計', () => {
  const g = (place, pt, endedAt, status = 'finished') => ({ place, pt, endedAt, status, config: { players: 6 } });
  const games = finishedGames([g(2, 3, 3), g(1, 5, 1), g(6, -1, 2), g(null, null, 4, 'cancelled')]);
  assert.deepEqual(games.map(x => x.endedAt), [1, 2, 3]);
  const s = summarize(games);
  assert.equal(s.games, 3); assert.equal(s.totalPt, 7); assert.equal(s.avgPlace, 3);
  assert.deepEqual(s.firstRate, { n: 1, d: 3 }); assert.deepEqual(s.cashRate, { n: 2, d: 3 });
  assert.deepEqual(s.placeDist, [1, 1, 0, 0, 0, 1]);
  assert.deepEqual(cumulativePt(games).map(p => p.y), [5, 4, 7]);
  assert.equal(filterByPeriod(Array(150).fill(0), 'last100').length, 100);
  const t = niceTicks(-3, 7);
  assert.ok(t[0] <= -3 && t[t.length - 1] >= 7 && t.includes(0));
});

test('VPIP / PFR', () => {
  const base = { startStacks: [1000, 1000], won: [0, 0], ante: 0, sb: 50, bb: 100, sbSeat: 0, bbSeat: 1, btn: 0 };
  const hs = [
    { ...base, won: [400, 0], actions: [{ seat: 0, kind: 'raise', betTo: 300, put: 250, street: 0 }, { seat: 1, kind: 'fold', put: 0, street: 0 }] },
    { ...base, won: [0, 200], actions: [{ seat: 0, kind: 'fold', put: 0, street: 0 }] },
  ];
  const st = handStats(hs, () => 0);
  assert.deepEqual(st.vpip, { n: 1, d: 2 }); assert.deepEqual(st.pfr, { n: 1, d: 2 }); assert.deepEqual(st.won, { n: 1, d: 2 });
});
