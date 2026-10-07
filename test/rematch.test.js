// 終局後の再戦（rules.js の stayRoom / rematchRoom / rematchLeader と leave）、ショーダウンの演出の時間（engine の runFrom と次のハンドまでの時間）、
// 演出で出す勝率（src/equity.js）の単体テスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRoom, joinRoom, leaveRoom, applyRequest, tickRoom, viewsOf, stayRoom, rematchRoom, rematchLeader, rematchOpen, MoveError } from '../server/game/rules.js';
import { createHandler } from '../server/game/handler.js';
import { newTable, act, legalActions } from '../src/engine.js';
import { DEFAULT_CONFIG, BASE_BB, BETWEEN_HANDS_MS, REMATCH_MS, REMATCH_HOST_WAIT_MS, RUNOUT, runoutMs } from '../src/structure.js';
import { equities, pctOf, bestFive } from '../src/equity.js';

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const U = i => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const C = s => '23456789TJQKA'.indexOf(s[0]) * 4 + 'shdc'.indexOf(s[1]);

/** 3 人の部屋を開始して、手番の人が全員オールイン/コールで最後まで打ち切る（終局させる） */
function finishedRoom(kind = 'private') {
  let r = createRoom({ id: 'r1', code: '111111', kind, uid: U(1), name: 'A', config: { ...DEFAULT_CONFIG, players: 3, startBb: 50 }, now: 0 });
  r = joinRoom(r, U(2), 'B', 1, rng(7)); r = joinRoom(r, U(3), 'C', 2, rng(7));
  let now = 10;
  for (let guard = 0; guard < 500 && r.status === 'running'; guard++) {
    const st = r.state, h = st.hand;
    if (h.phase === 'settled') { now = Math.max(now, st.nextAt); ({ room: r } = applyTick(r, now)); continue; }
    const seat = h.toAct, L = legalActions(st, seat);
    ({ room: r } = applyRequest(r, r.members[seat], { op: 'act', ver: r.ver, move: L.maxTo != null ? { type: 'allin' } : { type: 'call' } }, ++now));
  }
  assert.equal(r.status, 'finished');
  return r;
}
const applyTick = (r, now) => tickRoom(r, r.members[0], now);
const seatOf = (r, uid) => r.members.indexOf(uid);

/* ---------------- 再戦 ---------------- */
test('再戦：終局後に席に残った人がビューに出て、作成者が残った人だけで同じ設定の新しい部屋を始める', () => {
  let r = finishedRoom();
  const end = r.state.endedAt, host = seatOf(r, U(1));
  assert.ok(rematchOpen(r, end));
  let v = viewsOf(r)[0].rematch;
  assert.deepEqual(v.stay, []); assert.equal(v.host, host); assert.equal(v.next, null); assert.equal(v.closesAt, end + REMATCH_MS);
  // 席に残る（2 回押しても 1 回分）
  r = stayRoom(r, U(2), end + 1).room;
  const ver = r.ver;
  assert.equal(stayRoom(r, U(2), end + 2).room.ver, ver);
  assert.deepEqual(viewsOf(r)[1].rematch.stay, [seatOf(r, U(2))]);
  // 作成者でない人は始められない（作成者がまだ 1 分以内）
  assert.throws(() => rematchRoom(r, U(2), { id: 'r2', code: '222222', names: new Map() }, end + 3, rng(1)), e => e.code === 'not_host');
  // 作成者が始める（押した人も残ったことになる）。3 人目は残っていないので 2 人
  const names = new Map([[U(1), 'A2'], [U(2), 'B2']]);
  const out = rematchRoom(r, U(1), { id: 'r2', code: '222222', names }, end + 4, rng(2));
  assert.equal(out.next.status, 'running'); assert.equal(out.next.started, true);
  assert.deepEqual([...out.next.members].sort(), [U(1), U(2)]);
  assert.equal(out.next.config.players, 2); assert.equal(out.next.config.startBb, 50); assert.equal(out.next.kind, 'private');
  assert.equal(out.next.host, U(1));
  assert.deepEqual([...out.next.names].sort(), ['A2', 'B2']);   // 今の表示名
  assert.deepEqual(out.room.rematch.next, { id: 'r2', code: '222222' });
  assert.ok(out.room.rematch.stay.includes(host));
  assert.ok(out.room.ver > r.ver);
  assert.equal(rematchOpen(out.room, end + 5), false);
  assert.throws(() => rematchRoom(out.room, U(1), { id: 'r3', code: '333333', names }, end + 6, rng(3)), e => e.code === 'room_closed');
  assert.throws(() => stayRoom(out.room, U(3), end + 6), e => e.code === 'room_closed');
});

test('再戦：残ったのが 1 人なら始められない。ほかの部屋に居る人は除く', () => {
  let r = finishedRoom();
  const end = r.state.endedAt, names = new Map();
  assert.throws(() => rematchRoom(r, U(1), { id: 'x', code: '000002', names }, end + 1, rng(1)), e => e.code === 'not_enough');
  r = stayRoom(r, U(2), end + 1).room; r = stayRoom(r, U(3), end + 2).room;
  const out = rematchRoom(r, U(1), { id: 'x', code: '000002', names, busy: new Set([U(3)]) }, end + 3, rng(1));
  assert.deepEqual([...out.next.members].sort(), [U(1), U(2)]);
  assert.throws(() => rematchRoom(r, U(1), { id: 'x', code: '000002', names, busy: new Set([U(2), U(3)]) }, end + 3, rng(1)), e => e.code === 'not_enough');
});

test('再戦：作成者が Menu へ去るか 1 分たったら、先に残った人が始める。受付は 15 分', () => {
  let r = finishedRoom();
  const end = r.state.endedAt, names = new Map();
  r = stayRoom(r, U(3), end + 1).room; r = stayRoom(r, U(2), end + 2).room;
  const s2 = seatOf(r, U(2)), s3 = seatOf(r, U(3)), host = seatOf(r, U(1));
  const rm = () => viewsOf(r)[0].rematch;
  assert.equal(rematchLeader(rm(), end, end + 3), host);
  assert.equal(rematchLeader(rm(), end, end + REMATCH_HOST_WAIT_MS), s3);   // 1 分たった：先に残った人
  // 作成者が Menu へ（leave）→ すぐに移る。2 回去っても ver は 1 回分
  const gone = leaveRoom(r, U(1), end + 4).room;
  assert.equal(leaveRoom(gone, U(1), end + 5).room.ver, gone.ver);
  assert.deepEqual(viewsOf(gone)[0].rematch.gone, [host]);
  assert.equal(rematchLeader(viewsOf(gone)[0].rematch, end, end + 5), s3);
  assert.throws(() => rematchRoom(gone, U(2), { id: 'y', code: '000003', names }, end + 6, rng(1)), e => e.code === 'not_host');
  const out = rematchRoom(gone, U(3), { id: 'y', code: '000003', names }, end + 6, rng(1));
  assert.deepEqual([...out.next.members].sort(), [U(2), U(3)]);
  assert.equal(out.next.host, U(3));
  // 作成者が残ってから去れば、残った人の一覧からも外れる
  let r2 = stayRoom(r, U(1), end + 7).room;
  assert.equal(rematchLeader(viewsOf(r2)[0].rematch, end, end + REMATCH_HOST_WAIT_MS * 3), host);
  r2 = leaveRoom(r2, U(1), end + 8).room;
  assert.ok(!viewsOf(r2)[0].rematch.stay.includes(host));
  // 受付の期限
  assert.throws(() => stayRoom(r, U(1), end + REMATCH_MS), e => e.code === 'room_closed');
  assert.throws(() => rematchRoom(r, U(1), { id: 'z', code: '000004', names }, end + REMATCH_MS, rng(1)), e => e.code === 'room_closed');
});

test('再戦：途中で退出した（left）人は残れず、作成者でも再戦を始める役にならない。進行中の飛んだ人の Menu は去った扱い', () => {
  let r = createRoom({ id: 'r1', code: '111111', kind: 'free', uid: U(1), name: 'A', config: { ...DEFAULT_CONFIG, players: 3, startBb: 50 }, now: 0 });
  r = joinRoom(r, U(2), 'B', 1, rng(7)); r = joinRoom(r, U(3), 'C', 2, rng(7));
  r = leaveRoom(r, U(1), 5).room;                       // 作成者が途中で退出
  assert.equal(r.state.players[seatOf(r, U(1))].status, 'left');
  assert.equal(r.status, 'running');
  assert.equal(viewsOf(r)[0].rematch, null);              // 終局前はビューに出ない
  r = leaveRoom(r, U(2), 6).room;                       // 残り 1 人 → 終局
  assert.equal(r.status, 'finished');
  const end = r.state.endedAt;
  assert.throws(() => stayRoom(r, U(1), end + 1), e => e.code === 'room_closed');
  const rm = viewsOf(r)[0].rematch;
  assert.ok(rm.gone.includes(seatOf(r, U(1))) && rm.gone.includes(seatOf(r, U(2))));
  r = stayRoom(r, U(3), end + 1).room;
  assert.equal(rematchLeader(viewsOf(r)[0].rematch, end, end + 2), seatOf(r, U(3)));
  // 進行中の部屋で飛んだ人が Menu へ：エンジンは変えずに去った扱いだけ
  let g = finishedRoomWithOut();
  const before = structuredClone(g.state);
  g = leaveRoom(g, g.out, 99).room;
  assert.deepEqual(g.state, before);
  assert.deepEqual(g.rematch.gone, [seatOf(g, g.out)]);
});
function finishedRoomWithOut() {
  // 4 人で、誰かが飛んでまだ続いているところまで進める（先に動く 2 人だけがオールイン、ほかはフォールド）
  for (let seed = 1; seed < 50; seed++) {
    let r = createRoom({ id: 'q', code: '444444', kind: 'private', uid: U(1), name: 'A', config: { ...DEFAULT_CONFIG, players: 4, startBb: 50 }, now: 0 });
    for (let i = 2; i <= 4; i++) r = joinRoom(r, U(i), 'P' + i, i, rng(seed));
    let now = 10;
    for (let guard = 0; guard < 500 && r.status === 'running'; guard++) {
      const st = r.state, h = st.hand;
      const out = st.players.findIndex(p => p.status === 'out');
      if (out >= 0) return { ...r, out: r.members[out] };
      if (h.phase === 'settled') { now = Math.max(now, st.nextAt); ({ room: r } = applyTick(r, now)); continue; }
      const seat = h.toAct, L = legalActions(st, seat), first = h.actions.filter(a => a.street === 0).length < 2 + (h.sbSeat != null) + 1;
      const move = h.allIn.filter(Boolean).length < 2 && L.maxTo != null ? { type: 'allin' } : h.allIn.some(Boolean) && L.canFold && !first ? { type: 'fold' } : L.canFold ? { type: 'call' } : { type: 'check' };
      ({ room: r } = applyRequest(r, r.members[seat], { op: 'act', ver: r.ver, move }, ++now));
    }
  }
  throw new Error('no bust');
}

test('HTTP：stay / rematch を振り分け、新しいエラーは 409', async () => {
  const calls = [];
  const h = createHandler({
    allowedOrigins: [], verifyToken: async () => U(1),
    stay: async (uid, room) => { calls.push(['stay', uid, room]); return { ok: 1 }; },
    rematch: async (uid, room) => { calls.push(['rematch', uid, room]); throw new MoveError('not_enough'); },
  });
  const R = '11111111-2222-4333-8444-555555555555';
  const post = body => h(new Request('https://x/', { method: 'POST', headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
  assert.equal((await post({ op: 'stay', room: R })).status, 200);
  const res = await post({ op: 'rematch', room: R });
  assert.equal(res.status, 409); assert.equal((await res.json()).error, 'not_enough');
  assert.equal((await post({ op: 'stay' })).status, 422);
  assert.deepEqual(calls, [['stay', U(1), R], ['rematch', U(1), R]]);
});

/* ---------------- ショーダウンの演出の時間 ---------------- */
const cfgHU = { ...DEFAULT_CONFIG, players: 2, startBb: 50 };
test('runFrom：プリフロップのオールインは 0、フロップは 3、普通のショーダウンは 5、フォールドは null。次のハンドはその分だけ遅い', () => {
  // プリフロップ：オールイン → コール
  let st = newTable({ config: cfgHU, names: ['a', 'b'], now: 0, rnd: rng(1), button: 0 });
  act(st, st.hand.toAct, { type: 'allin' }, 10); act(st, st.hand.toAct, { type: 'call' }, 20);
  assert.equal(st.hand.phase, 'settled'); assert.equal(st.hand.runFrom, 0); assert.equal(st.hand.board.length, 5);
  if (st.status === 'running') assert.equal(st.nextAt, 20 + BETWEEN_HANDS_MS + runoutMs(0));
  // フロップでオールイン
  st = newTable({ config: cfgHU, names: ['a', 'b'], now: 0, rnd: rng(2), button: 0 });
  act(st, st.hand.toAct, { type: 'call' }, 1); act(st, st.hand.toAct, { type: 'check' }, 2);
  assert.equal(st.hand.street, 1);
  act(st, st.hand.toAct, { type: 'allin' }, 3); act(st, st.hand.toAct, { type: 'call' }, 4);
  assert.equal(st.hand.runFrom, 3);
  // 最後までチェック
  st = newTable({ config: cfgHU, names: ['a', 'b'], now: 0, rnd: rng(3), button: 0 });
  act(st, st.hand.toAct, { type: 'call' }, 1);
  for (let t = 2; st.hand.phase === 'betting'; t++) act(st, st.hand.toAct, { type: 'check' }, t);
  assert.equal(st.hand.runFrom, 5); assert.ok(st.hand.shown);
  assert.equal(st.nextAt, st.hand.endedAt + BETWEEN_HANDS_MS + runoutMs(5));
  // フォールド
  st = newTable({ config: cfgHU, names: ['a', 'b'], now: 0, rnd: rng(4), button: 0 });
  act(st, st.hand.toAct, { type: 'fold' }, 7);
  assert.equal(st.hand.runFrom, null); assert.equal(st.nextAt, 7 + BETWEEN_HANDS_MS);
  // ブラインドだけでオールイン（配った時点で精算）
  st = newTable({ config: cfgHU, names: ['a', 'b'], now: 0, rnd: rng(5), button: 0, stacks: [50 * BASE_BB, 40] });
  assert.equal(st.hand.phase, 'settled'); assert.equal(st.hand.runFrom, 0);
});

test('runoutMs：ストリートごとに足し、プリフロップのオールインで 9〜12 秒', () => {
  const R = RUNOUT;
  assert.equal(runoutMs(null), 0);
  assert.equal(runoutMs(5), R.gather + R.show + R.latency);
  assert.equal(runoutMs(4), R.gather + R.reveal + R.river + R.latency);
  assert.equal(runoutMs(3), runoutMs(4) + R.street);
  assert.equal(runoutMs(0), runoutMs(3) + R.flop + R.preflop);
  assert.ok(runoutMs(0) >= 9000 && runoutMs(0) <= 12000);
  assert.ok(R.street >= 1000, '1 秒以下だと何が起きたか分からない');
});

/* ---------------- 勝率 ---------------- */
test('勝率：残り 2 枚以下は全通り、それより多ければ決まった種で同じ値。合計は 1', () => {
  const aa = [C('As'), C('Ah')], kk = [C('Ks'), C('Kh')];
  const pre = equities([aa, kk], [], { samples: 40000, seed: 9 });
  assert.ok(Math.abs(pre[0] - 0.826) < 0.012, `AA vs KK ${pre[0]}`);
  assert.deepEqual(equities([aa, kk], [], { samples: 5000, seed: 3 }), equities([aa, kk], [], { samples: 5000, seed: 3 }));
  // ターン：K を引くしかない（残り 44 枚に K は 2 枚）
  const turn = equities([aa, null, kk], [C('2c'), C('7d'), C('9h'), C('Jc')]);
  assert.equal(turn[1], 0);
  assert.ok(Math.abs(turn[2] - 2 / 44) < 1e-9);
  assert.ok(Math.abs(turn[0] + turn[2] - 1) < 1e-9);
  // リバーまで：決着、引き分けは等分
  assert.deepEqual(equities([aa, kk], [C('2c'), C('7d'), C('9h'), C('Jc'), C('3s')]), [1, 0]);
  const chop = equities([[C('2s'), C('3h')], [C('2d'), C('3c')]], [C('Ac'), C('Kd'), C('Qh'), C('Js'), C('Ts')]);
  assert.deepEqual(chop, [0.5, 0.5]);
});

test('pctOf：0 と 100 は本当にそうなときだけ', () => {
  assert.equal(pctOf(0), 0); assert.equal(pctOf(1), 100);
  assert.equal(pctOf(0.001), 1); assert.equal(pctOf(0.999), 99); assert.equal(pctOf(0.5), 50);
});

test('bestFive：役を作る 5 枚', () => {
  const five = bestFive([C('As'), C('Ah'), C('2c'), C('7d'), C('Kd'), C('Ad'), C('Ac')]);
  assert.equal(five.length, 5);
  assert.deepEqual(five.filter(c => (c >> 2) === 12).length, 4);
  assert.ok(five.includes(C('Kd')));
  const flush = bestFive([C('2h'), C('9h'), C('Kh'), C('4h'), C('7h'), C('Ac'), C('As')]);
  assert.deepEqual([...flush].sort((a, b) => a - b), [C('2h'), C('4h'), C('7h'), C('9h'), C('Kh')].sort((a, b) => a - b));
});
