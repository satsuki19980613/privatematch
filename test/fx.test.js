// 勝者の演出 GIF（PRIVATE MATCH）：slug の決まり（src/fx.js）、出す席と次のハンドまでの時間（engine.js の fxSeat）、
// 部屋での持ち運び（rules.js の create / join / 開始 / leave / stay / rematch）、HTTP の受け渡し（handler.js）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFx, pickMedia } from '../src/fx.js';
import { newTable, act, legalActions, fxSeat, viewFor } from '../src/engine.js';
import { DEFAULT_CONFIG, BETWEEN_HANDS_MS, FX, FX_MS, runoutMs } from '../src/structure.js';
import { createRoom, joinRoom, leaveRoom, applyRequest, tickRoom, viewsOf, stayRoom, rematchRoom, fxOf } from '../server/game/rules.js';
import { createHandler } from '../server/game/handler.js';

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const U = i => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;

test('normalizeFx：英数字・ハイフン・下線の slug だけ。それ以外は null', () => {
  for (const s of ['walter-blame-government-1', 'abc', 'A_b-9', 'demo-crown', 'x'.repeat(120)]) assert.equal(normalizeFx(s), s);
  for (const s of ['', '-abc', 'a b', 'a/b', 'a?x=1', 'https://x', 'x'.repeat(121), 'ａｂｃ', null, undefined, 3, {}, ['a']]) assert.equal(normalizeFx(s), null, String(s));
});

test('pickMedia：卓は軽い動画（md の mp4）を、一覧は小さい動く画像（sm の webp）を選ぶ。形式が直に並ぶ形・壊れた形も', () => {
  const m = (u, w = 100, h = 75) => ({ url: u, width: w, height: h });
  const file = { hd: { gif: m('hd.gif'), mp4: m('hd.mp4') }, md: { gif: m('md.gif'), webp: m('md.webp'), mp4: m('md.mp4', 320, 240) }, sm: { webp: m('sm.webp'), mp4: m('sm.mp4') }, xs: { jpg: m('xs.jpg') } };
  assert.deepEqual(pickMedia(file, 'full'), { url: 'md.mp4', video: true, w: 320, h: 240 });
  assert.deepEqual(pickMedia(file, 'thumb'), { url: 'sm.webp', video: false, w: 100, h: 75 });
  assert.equal(pickMedia({ hd: { gif: m('hd.gif') } }, 'full').url, 'hd.gif');   // 動画が無ければ画像
  assert.deepEqual(pickMedia({ webp: 'flat.webp' }, 'thumb'), { url: 'flat.webp', video: false, w: 0, h: 0 });
  for (const bad of [null, 'x', {}, { md: { mp4: { url: '' } } }, { md: { jpg: m('only.jpg') } }]) assert.equal(pickMedia(bad), null);
});

/* ---------------- 出す席と時間（engine） ---------------- */
const settled = (won, commits, extra = {}) => ({ phase: 'settled', shown: won.map(() => [0, 1]), runFrom: 5, won, commits, ...extra });
test('fxSeat：取り分（won − 拠出）がいちばん多い 1 人。GIF 無し・チョップ・フォールドで終わった・fx 無しは null', () => {
  const fx = ['a', 'b', null];
  assert.equal(fxSeat(settled([0, 3000, 0], [1000, 1000, 1000]), fx), 1);
  assert.equal(fxSeat(settled([0, 0, 3000], [1000, 1000, 1000]), fx), null);                 // 勝った人は GIF なし
  assert.equal(fxSeat(settled([1500, 1500, 0], [1000, 1000, 1000]), fx), null);              // チョップ
  assert.equal(fxSeat(settled([2600, 1400, 0], [1000, 1000, 1000]), fx), 0);                // メインとサイドを分けた：多い方
  assert.equal(fxSeat(settled([1200, 1800, 0], [1200, 1000, 800]), fx), 1);                 // コールされずに戻った分は取り分に入らない
  assert.equal(fxSeat(settled([0, 3000, 0], [1000, 1000, 1000], { shown: null, runFrom: null }), fx), null);   // フォールドで終わった
  assert.equal(fxSeat(settled([0, 3000, 0], [1000, 1000, 1000], { phase: 'betting' }), fx), null);
  assert.equal(fxSeat(settled([0, 3000, 0], [1000, 1000, 1000]), null), null);
  assert.equal(fxSeat(null, fx), null);
});

test('engine：勝者が GIF を設定しているショーダウンだけ、次のハンドを FX_MS 遅らせる（fx は状態とビューに入る）', () => {
  assert.equal(FX_MS, FX.in + FX.show + FX.out + FX.gap);
  const cfg = { ...DEFAULT_CONFIG, players: 2, startBb: 50 }, cfg3 = { ...DEFAULT_CONFIG, players: 3, startBb: 50 };
  const seen = { fx: 0, plain: 0 }, FXS = ['crown', null, 'gg'];
  // 3 人：先に動く人がオールイン、次がコール、残りは降りる（誰が勝っても試合は続く）
  for (let seed = 1; seed < 80 && (seen.fx < 2 || !seen.plain); seed++) {
    const st = newTable({ config: cfg3, names: ['a', 'b', 'c'], now: 0, rnd: rng(seed), button: 0, fx: FXS });
    assert.deepEqual(st.fx, FXS); assert.deepEqual(viewFor(st, 1).fx, FXS);
    const moves = [{ type: 'allin' }, { type: 'call' }, { type: 'fold' }];
    for (let i = 0, t = 10; st.hand.phase === 'betting'; i++, t += 10) act(st, st.hand.toAct, moves[Math.min(i, 2)], t);
    assert.equal(st.status, 'running');
    const h = st.hand, base = h.endedAt + BETWEEN_HANDS_MS + runoutMs(h.runFrom), fs = fxSeat(h, st.fx);
    assert.equal(st.nextAt, base + (fs != null ? FX_MS : 0));
    if (fs != null) { assert.ok(FXS[fs]); seen.fx++; } else seen.plain++;
  }
  assert.ok(seen.fx >= 2 && seen.plain, JSON.stringify(seen));
  // フォールドで終わったハンドは遅らせない
  const st = newTable({ config: cfg, names: ['a', 'b'], now: 0, rnd: rng(1), button: 0, fx: ['crown', 'gg'] });
  act(st, st.hand.toAct, { type: 'fold' }, 10);
  assert.equal(st.nextAt, 10 + BETWEEN_HANDS_MS);
  // fx が無い・形が違う・全員 null なら持たない
  for (const fx of [undefined, null, ['a'], [null, null], 'ab']) assert.equal(newTable({ config: cfg, names: ['a', 'b'], now: 0, rnd: rng(1), fx }).fx, null);
  assert.deepEqual(newTable({ config: cfg, names: ['a', 'b'], now: 0, rnd: rng(1), fx: [3, 'g'] }).fx, [null, 'g']);
});

/* ---------------- 部屋での持ち運び（rules） ---------------- */
const CFG3 = { ...DEFAULT_CONFIG, players: 3, startBb: 50 };
function room3(kind, fxs, seed = 7) {
  let r = createRoom({ id: 'r1', code: '111111', kind, uid: U(1), name: 'A', config: CFG3, now: 0, fx: fxs[0] });
  r = joinRoom(r, U(2), 'B', 1, rng(seed), fxs[1]); r = joinRoom(r, U(3), 'C', 2, rng(seed), fxs[2]);
  return r;
}
test('rules：PRIVATE MATCH は席ごとの GIF を開始時に席順へ並べ替えてエンジンへ。FREE MATCH・正しくない slug は null', () => {
  const want = new Map([[U(1), 'crown'], [U(2), null], [U(3), 'gg']]);
  for (let seed = 1; seed <= 6; seed++) {
    const r = room3('private', ['crown', 'bad slug!', 'gg'], seed);
    assert.equal(r.status, 'running');
    r.members.forEach((u, s) => { assert.equal(r.fx[s], want.get(u)); assert.equal(r.state.fx[s], want.get(u)); });
    viewsOf(r).forEach(v => assert.deepEqual(v.fx, r.fx));   // 全員のビューに全席の slug
  }
  const f = room3('free', ['crown', 'x', 'gg']);
  assert.deepEqual(f.fx, [null, null, null]); assert.equal(f.state.fx, null);
  viewsOf(f).forEach(v => assert.equal(v.fx, null));
  // 誰も設定していない PRIVATE MATCH はエンジンに持たせない
  assert.equal(room3('private', [null, undefined, '']).state.fx, null);
  // 以前の部屋（fx の欄が無い）
  assert.deepEqual(fxOf({ members: ['a', 'b'] }), [null, null]);
});

test('rules：待機中に抜けた人の GIF は消える（席と同じ順のまま）', () => {
  const CFG4 = { ...CFG3, players: 4 };
  let r = createRoom({ id: 'r1', code: '111111', kind: 'private', uid: U(1), name: 'A', config: CFG4, now: 0, fx: 'crown' });
  r = joinRoom(r, U(2), 'B', 1, rng(1), 'two'); r = joinRoom({ ...r, fx: undefined }, U(4), 'D', 1, rng(1), 'four');   // 以前の部屋に入っても長さはそろう
  assert.deepEqual(r.fx, [null, null, 'four']);
  r = createRoom({ id: 'r1', code: '111111', kind: 'private', uid: U(1), name: 'A', config: CFG3, now: 0, fx: 'crown' });
  r = joinRoom(r, U(2), 'B', 1, rng(1), 'two');
  ({ room: r } = leaveRoom(r, U(2), 5));
  assert.deepEqual(r.fx, ['crown']); assert.deepEqual(r.members, [U(1)]);
  r = joinRoom(r, U(3), 'C', 6, rng(1), 'three');
  assert.deepEqual(r.fx, ['crown', 'three']);
});

/** 部屋を最後まで打ち切る */
function finish(r) {
  let now = 10;
  for (let guard = 0; guard < 500 && r.status === 'running'; guard++) {
    const st = r.state, h = st.hand;
    if (h.phase === 'settled') { now = Math.max(now, st.nextAt); ({ room: r } = tickRoom(r, r.members[0], now)); continue; }
    const seat = h.toAct, L = legalActions(st, seat);
    ({ room: r } = applyRequest(r, r.members[seat], { op: 'act', ver: r.ver, move: L.maxTo != null ? { type: 'allin' } : { type: 'call' } }, ++now));
  }
  assert.equal(r.status, 'finished');
  return { r, now };
}
test('rules：席に残るときに GIF を変えられ、再戦は残った人の GIF（押した人は今の GIF）で始まる', () => {
  let { r, now } = finish(room3('private', ['crown', 'two', 'gg']));
  const host = U(1), s2 = r.members.indexOf(U(2)), s3 = r.members.indexOf(U(3));
  ({ room: r } = stayRoom(r, U(2), now + 1, 'changed'));
  assert.equal(r.fx[s2], 'changed');
  const ver = r.ver;
  ({ room: r } = stayRoom(r, U(2), now + 2, null));   // もう残っている：GIF だけ変える（ver は変えない）
  assert.equal(r.fx[s2], null); assert.equal(r.ver, ver);
  ({ room: r } = stayRoom(r, U(3), now + 3));          // fx を送らなければそのまま
  assert.equal(r.fx[s3], 'gg');
  const names = new Map([[U(1), 'A'], [U(2), 'B'], [U(3), 'C']]);
  const { next } = rematchRoom(r, host, { id: 'r2', code: '222222', names, fx: 'new-host' }, now + 4, rng(3));
  const byUid = new Map(next.members.map((u, s) => [u, next.fx[s]]));
  assert.deepEqual(Object.fromEntries(byUid), { [U(1)]: 'new-host', [U(2)]: null, [U(3)]: 'gg' });
  next.members.forEach((u, s) => assert.equal(next.state.fx[s], byUid.get(u)));
  // FREE MATCH の再戦は GIF なし
  let f = finish(room3('free', [null, null, null]));
  ({ room: f.r } = stayRoom(f.r, U(2), f.now + 1, 'sneaky'));
  assert.equal(f.r.fx[f.r.members.indexOf(U(2))], null);
  const nf = rematchRoom(f.r, U(1), { id: 'r3', code: '333333', names, fx: 'sneaky' }, f.now + 2, rng(3)).next;
  assert.deepEqual(nf.fx, [null, null]); assert.equal(nf.state.fx, null);
});

/* ---------------- HTTP ---------------- */
test('handler：create / join / stay / rematch の fx を確かめて渡す（無ければ undefined、正しくなければ null）', async () => {
  const calls = [];
  const rec = op => async (...a) => { calls.push([op, ...a]); return { ok: 1 }; };
  const h = createHandler({ allowedOrigins: [], verifyToken: async () => U(1), create: rec('create'), join: rec('join'), stay: rec('stay'), rematch: rec('rematch') });
  const R = '11111111-2222-4333-8444-555555555555';
  const post = body => h(new Request('https://x/', { method: 'POST', headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
  const cfg = { ...DEFAULT_CONFIG, players: 2 };
  for (const body of [
    { op: 'create', kind: 'private', config: cfg, fx: 'crown' }, { op: 'create', kind: 'free', config: cfg },
    { op: 'join', code: '123456', fx: '<script>' }, { op: 'stay', room: R, fx: null }, { op: 'rematch', room: R, fx: 'gg' },
  ]) assert.equal((await post(body)).status, 200);
  assert.deepEqual(calls, [
    ['create', U(1), 'private', cfg, 'crown'], ['create', U(1), 'free', cfg, undefined],
    ['join', U(1), '123456', null], ['stay', U(1), R, null], ['rematch', U(1), R, 'gg'],
  ]);
});
