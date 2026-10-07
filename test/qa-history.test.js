// QA: 端末の記録（src/history/*）の検証。node:test。IndexedDB の最小の代役とサーバー（room_hands / room_poll / me の SQL と同じ振る舞い）を
// この中に持ち、本物の engine.js / rules.js で打った試合を sync.js / store.js / stats.js / hand.js に通す。
// `{ todo }` 付きのテストは「現状は失敗する既知の不具合」（失敗しても全体は通る。直ったら todo を外す）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRoom, joinRoom, leaveRoom, applyRequest, tickRoom, viewsOf } from '../server/game/rules.js';
import { newTable, act, tick, legalActions, handRecord, dueAt } from '../src/engine.js';
import { DEFAULT_CONFIG } from '../src/structure.js';
import { forcedOf, committedOf, netOfRecord, positionsOf, streetPots } from '../src/history/hand.js';
import { summarize, cumulativePt, filterByPeriod, finishedGames, handStats, recentPlaces, pctLabel, niceTicks } from '../src/history/stats.js';

/* ------------------------------------------------------------------ 共通 */
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const ME = '00000000-0000-4000-8000-000000000001';
const botUid = i => `00000000-0000-4000-8000-${String(100 + i).padStart(12, '0')}`;
const DAY = 86400000;

/* ------------------------------------------------------------------ IndexedDB の最小の代役（store.js が使う範囲だけ） */
const kenc = k => JSON.stringify(k);
const shim = { dbs: new Map(), failWrite: null };
const later = f => setTimeout(f, 0);
class Store {
  constructor(def, tx) { this.def = def; this.tx = tx; }
  req(fn) {
    const tx = this.tx, r = { result: undefined, error: null }; tx.pending++;
    later(() => { try { r.result = fn(); r.onsuccess && r.onsuccess(); } catch (e) { r.error = e; tx.abort(e); } tx.pending--; tx.check(); });
    return r;
  }
  put(v) {
    const key = Array.isArray(this.def.keyPath) ? this.def.keyPath.map(p => v[p]) : v[this.def.keyPath];
    if (key === undefined || (Array.isArray(key) && key.includes(undefined))) throw new Error('DataError');
    const c = structuredClone(v);
    return this.req(() => { this.def.rows.set(kenc(key), { key, v: c }); return key; });
  }
  get(key) { return this.req(() => { const r = this.def.rows.get(kenc(key)); return r ? structuredClone(r.v) : undefined; }); }
  getAll() { return this.req(() => [...this.def.rows.values()].map(r => structuredClone(r.v))); }
  index(name) {
    const kp = this.def.indexes[name], rows = key => [...this.def.rows.values()].filter(r => kenc(r.v[kp]) === kenc(key));
    return { getAll: key => this.req(() => rows(key).map(r => structuredClone(r.v))), getAllKeys: key => this.req(() => rows(key).map(r => structuredClone(r.key))) };
  }
  createIndex(name, kp) { this.def.indexes[name] = kp; }
}
globalThis.indexedDB = {
  open(name) {
    const rq = { result: null, error: null };
    later(() => {
      let d = shim.dbs.get(name), fresh = !d;
      if (!d) { d = { stores: new Map() }; shim.dbs.set(name, d); }
      rq.result = {
        objectStoreNames: { contains: n => d.stores.has(n) },
        createObjectStore(n, { keyPath }) { const def = { keyPath, rows: new Map(), indexes: {} }; d.stores.set(n, def); return new Store(def, { pending: 0, abort() {}, check() {} }); },
        transaction(names, mode) {
          const tx = {
            pending: 0, done: false, oncomplete: null, onabort: null, onerror: null, error: null,
            abort(e) { if (!tx.done) { tx.done = true; tx.error = e; tx.onabort && tx.onabort(); } },
            check() { if (!tx.done && tx.pending === 0) { tx.done = true; tx.oncomplete && tx.oncomplete(); } },
            objectStore: n => new Store(d.stores.get(n), tx),
          };
          later(() => tx.check());
          if (mode === 'readwrite' && shim.failWrite && shim.failWrite([].concat(names))) later(() => tx.abort(new Error('QuotaExceededError')));
          return tx;
        },
      };
      if (fresh) rq.onupgradeneeded && rq.onupgradeneeded();
      rq.onsuccess && rq.onsuccess();
    });
    return rq;
  },
};
const clearDevice = () => { for (const d of shim.dbs.values()) for (const s of d.stores.values()) s.rows.clear(); };
globalThis.matchMedia = () => ({ matches: false });
const { app } = await import('../src/ui/util.js');
const store = await import('../src/history/store.js');
const sync = await import('../src/history/sync.js');

/* ------------------------------------------------------------------ サーバー（db/migrations の RPC と同じ振る舞い。時計は仮想） */
function makeServer() {
  const S = { rooms: new Map(), now: 1_000_000_000_000, calls: [], failIf: null, seq: 0 };
  const err = code => Object.assign(new Error(code), { code, status: 409 });
  S.create = ({ n = 2, cfg = {}, seatOfMe = null } = {}) => {
    const id = `room-${++S.seq}`;
    let room = createRoom({ id, code: String(100000 + S.seq), kind: 'private', uid: ME, name: 'Me', config: { ...DEFAULT_CONFIG, ...cfg, players: n }, now: S.now });
    for (let i = 1; i < n; i++) room = joinRoom(room, botUid(i), `Bot${i}`, S.now, rng(S.seq * 31 + i));
    S.rooms.set(id, { room, hands: [] });
    return id;
  };
  const save = (R, out) => { R.room = out.room; if (out.record) R.hands.push(out.record); };
  S.R = id => S.rooms.get(id);
  S.seat = id => S.R(id).room.members.indexOf(ME);
  S.st = id => S.R(id).room.state;
  S.live = id => ['running', 'paused'].includes(S.R(id).room.status);
  /** 1 手進める。policy(view, seat, L) => move。=> 進めたか */
  S.step = (id, policy) => {
    const R = S.R(id), room = R.room; S.now += 500;
    if (!['running', 'paused'].includes(room.status)) return false;
    const st = room.state, h = st.hand;
    if (st.status === 'running' && h && h.phase === 'betting') {
      const seat = h.toAct, uid = room.members[seat], view = viewsOf(room)[seat], L = legalActions(view, seat);
      save(R, applyRequest(room, uid, { op: 'act', ver: room.ver, move: policy(view, seat, L, uid) }, S.now));
      return true;
    }
    const at = dueAt(st); if (at == null) return false;
    S.now = Math.max(S.now, at);
    save(R, tickRoom(room, room.members[0], S.now));
    return true;
  };
  S.playHand = (id, policy) => { const no = S.R(id).hands.length; while (S.live(id) && S.R(id).hands.length === no) if (!S.step(id, policy)) break; };
  S.playToEnd = (id, policy, max = 20000) => { let i = 0; while (S.live(id) && i++ < max) if (!S.step(id, policy)) break; return S.R(id).room.state; };
  S.leave = id => save(S.R(id), leaveRoom(S.R(id).room, ME, S.now));
  S.purge = id => S.rooms.delete(id);
  S.rpc = async (name, args = {}) => {
    S.calls.push({ name, args });
    if (S.failIf && S.failIf(name, args, S.calls.length)) throw new Error('network');
    switch (name) {
      case 'me': return structuredClone({ nickname: 'Me', room: null, recent: [...S.rooms.values()].filter(R => R.room.started && R.room.members.includes(ME) && R.room.startedAt > S.now - 3 * DAY).map(R => ({ id: R.room.id, endedAt: R.room.state.endedAt })) });
      case 'room_poll': {
        const R = S.rooms.get(args.p_room), pos = R ? R.room.members.indexOf(ME) : -1; if (pos < 0) throw err('not_found');
        return structuredClone({ ver: R.room.ver, now: S.now, view: R.room.ver > (args.p_ver ?? -1) ? { ...viewsOf(R.room)[R.room.started ? pos : 0], status: R.room.status } : null });
      }
      case 'room_hands': {
        const R = S.rooms.get(args.p_room), pos = R && R.room.started ? R.room.members.indexOf(ME) : -1; if (pos < 0) throw err('not_found');
        return structuredClone(R.hands.filter(h => h.rec.handNo > (args.p_after ?? 0)).slice(0, 200).map(h => ({ ...h.rec, hole: h.holes[pos] })));
      }
    }
    throw err('not_found');
  };
  return S;
}
const callPolicy = (v, s, L) => (L.canCheck ? { type: 'check' } : { type: 'call' });
const foldPolicy = (v, s, L) => (L.canCheck ? { type: 'check' } : { type: 'fold' });
const shoveAll = () => ({ type: 'allin' });
const mixPolicy = r => (v, s, L) => { const x = r(); if (L.canFold && x < 0.15) return { type: 'fold' }; if (x < 0.35) return { type: 'allin' }; if (x < 0.5 && L.minTo != null) return { type: 'raise', to: Math.min(L.maxTo, L.minTo + Math.floor(r() * 3) * v.hand.bb) }; return L.canCheck ? { type: 'check' } : { type: 'call' }; };

let S;
function fresh() { S = makeServer(); clearDevice(); app.net = { rpc: S.rpc }; sync_reset(); }
const sync_reset = () => { /* sync.js の chains は完了すると自動で消える */ };

/* ================================================================== 1. 同期 */
test('同期: 毎ハンド同期しながら 2 人戦を最後まで打つ → ハンドは欠け・重複なし、試合は正しい中身で 1 件', async () => {
  fresh();
  const id = S.create({ n: 2 }), r = rng(11), pol = mixPolicy(r);
  let ended = false;
  while (S.live(id)) {
    S.playHand(id, pol);
    ended = !S.live(id);
    await sync.syncRoom(id, ended ? viewsOf(S.R(id).room)[S.seat(id)] && { ...viewsOf(S.R(id).room)[S.seat(id)], status: S.R(id).room.status } : null);
  }
  const st = S.st(id), seat = S.seat(id);
  assert.equal(st.status, 'finished');
  const games = await store.allGames();
  assert.equal(games.length, 1);
  const g = games[0], hands = await store.handsOf(id);
  assert.deepEqual(hands.map(h => h.handNo), S.R(id).hands.map(h => h.rec.handNo));
  assert.equal(new Set(hands.map(h => h.handNo)).size, hands.length);
  assert.equal(g.hands, hands.length);
  assert.equal(g.status, 'finished'); assert.equal(g.place, st.players[seat].place); assert.equal(g.pt, st.players[seat].pt);
  assert.equal(g.seat, seat); assert.equal(g.code, S.R(id).room.code); assert.deepEqual(g.config, S.R(id).room.config);
  assert.equal(g.endedAt, st.endedAt); assert.equal(g.startedAt, st.startedAt);
  assert.deepEqual(g.players.map(p => p.place), st.players.map(p => p.place)); assert.deepEqual(g.players.map(p => p.pt), st.players.map(p => p.pt));
  assert.deepEqual(g.names, S.R(id).room.names);
  // 保存した手札は自分の分だけ（相手の手札は shown 以外に無い）
  for (const h of hands) { assert.ok(Array.isArray(h.hole) || h.hole === null); assert.equal(h.deck, undefined); }
  // 差分取得：2 回目以降の p_after は保存済みの最後のハンド番号
  const afters = S.calls.filter(c => c.name === 'room_hands').map(c => c.args.p_after);
  assert.equal(afters[0], 0); assert.ok(afters.every((a, i) => i === 0 || a >= afters[i - 1]));
});

test('同期: 冪等（何度同期しても同じ。ハンドは増えず、試合は 1 件）', async () => {
  fresh();
  const id = S.create({ n: 3 }); S.playToEnd(id, mixPolicy(rng(5)));
  await sync.syncRoom(id); const a = JSON.stringify(await store.handsOf(id));
  await sync.syncRoom(id); await sync.syncRoom(id);
  assert.equal(JSON.stringify(await store.handsOf(id)), a); assert.equal((await store.allGames()).length, 1);
  // 2 回目以降はハンドを 1 件も運ばない
  assert.deepEqual(S.calls.filter(c => c.name === 'room_hands').slice(-2).map(c => c.args.p_after), Array(2).fill((await store.handsOf(id)).at(-1).handNo));
});

test('同期: 並行に呼んでも直列（同じ部屋の同期が重ならない）', async () => {
  fresh();
  const id = S.create({ n: 2 }); S.playToEnd(id, callPolicy);
  const rs = await Promise.all([sync.syncRoom(id), sync.syncRoom(id), sync.syncRoom(id)]);
  assert.deepEqual(rs, [true, true, true]);
  assert.equal((await store.handsOf(id)).length, S.R(id).hands.length);
});

test('同期: 200 件を超えるハンド数でもページングで全部写る（250 ハンド）', async () => {
  fresh();
  const id = S.create({ n: 2, cfg: { startBb: 150, speed: 'veryslow' } });
  // 全員フォールドで 250 ハンド回す（SB が毎回降りる。スタックはほぼ動かない）
  let guard = 0; while (S.live(id) && S.R(id).hands.length < 250 && guard++ < 1e5) S.step(id, foldPolicy);
  assert.ok(S.R(id).hands.length >= 250, 'hands=' + S.R(id).hands.length);
  const total = S.R(id).hands.length;
  assert.equal(await sync.syncRoom(id), true);
  const hs = await store.handsOf(id);
  assert.equal(hs.length, total);
  assert.deepEqual(hs.map(h => h.handNo), Array.from({ length: total }, (_, i) => i + 1));
  assert.deepEqual(S.calls.filter(c => c.name === 'room_hands').map(c => c.args.p_after), [0, 200]);
  assert.equal((await store.getGame(id)).hands, total);
});

test('同期: ちょうど 200 件のとき（次の 1 回は空で終わる）', async () => {
  fresh();
  const id = S.create({ n: 2, cfg: { startBb: 150, speed: 'veryslow' } });
  while (S.live(id) && S.R(id).hands.length < 200) S.step(id, foldPolicy);
  assert.equal(S.R(id).hands.length, 200);
  await sync.syncRoom(id);
  assert.equal((await store.handsOf(id)).length, 200);
});

test('同期: 途中（再読み込み相当）→ 続き。新しい分だけ取る', async () => {
  fresh();
  const id = S.create({ n: 3 }), pol = mixPolicy(rng(21));
  for (let i = 0; i < 3; i++) S.playHand(id, callPolicy);
  await sync.syncRoom(id);
  const g1 = await store.getGame(id); assert.equal(g1.status, 'running'); assert.equal(g1.hands, 3);
  S.calls.length = 0;
  S.playToEnd(id, pol);
  // 「タブを閉じている間に終わった」→ 起動時の同期（me().recent）
  const prof = await S.rpc('me'); S.calls.length = 0;
  await sync.syncRecent(prof.recent);
  const g2 = await store.getGame(id);
  assert.equal(g2.status, 'finished'); assert.equal(g2.place, S.st(id).players[S.seat(id)].place);
  assert.equal(S.calls.find(c => c.name === 'room_hands').args.p_after, 3);
  assert.equal((await store.handsOf(id)).length, S.R(id).hands.length);
  // もう一度起動しても何もしない（終わった試合は飛ばす）
  S.calls.length = 0; await sync.syncRecent(prof.recent); assert.equal(S.calls.length, 0);
});

test('同期: サーバーが部屋を消した後（3 日経過）。投げず false、端末の記録はそのまま', async () => {
  fresh();
  const id = S.create({ n: 2 }), pol = callPolicy;
  S.playHand(id, pol); await sync.syncRoom(id);
  S.purge(id);
  assert.equal(await sync.syncRoom(id), false);
  await sync.syncRecent([{ id }]);   // 投げない
  assert.equal((await store.handsOf(id)).length, 1); assert.equal((await store.getGame(id)).status, 'running');
});

test('同期: 終局を端末が一度も見ないまま 3 日で消えた試合は、端末には「途中」のまま残る（仕様どおり。統計には数えられない）', async () => {
  fresh();
  const id = S.create({ n: 2 }); S.playHand(id, callPolicy); await sync.syncRoom(id);
  S.playToEnd(id, callPolicy); S.purge(id);
  await sync.syncRecent([{ id }]);
  assert.equal((await store.getGame(id)).status, 'running');
  assert.equal(finishedGames(await store.allGames()).length, 0);
});

test('同期: ネットワークエラー（room_hands の 2 ページ目で失敗）→ 部分的に保存、試合は未保存、再試行で欠け・重複なし', async () => {
  fresh();
  const id = S.create({ n: 2, cfg: { startBb: 150, speed: 'veryslow' } });
  while (S.live(id) && S.R(id).hands.length < 230) S.step(id, foldPolicy);
  let n = 0; S.failIf = (name) => name === 'room_hands' && ++n === 2;
  assert.equal(await sync.syncRoom(id), false);
  assert.equal((await store.handsOf(id)).length, 200);
  assert.equal(await store.getGame(id), null);          // 試合の記録は無い（ハンドだけある）
  S.failIf = null; assert.equal(await sync.syncRoom(id), true);
  const hs = await store.handsOf(id);
  assert.deepEqual(hs.map(h => h.handNo), Array.from({ length: S.R(id).hands.length }, (_, i) => i + 1));
  assert.equal((await store.getGame(id)).hands, hs.length);
});

test('同期: room_poll の失敗 / IndexedDB の書き込み失敗でも投げない', async () => {
  fresh();
  const id = S.create({ n: 2 }); S.playHand(id, callPolicy);
  S.failIf = name => name === 'room_poll'; assert.equal(await sync.syncRoom(id), false); S.failIf = null;
  shim.failWrite = () => true; assert.equal(await sync.syncRoom(id), false); shim.failWrite = null;
  assert.equal(await sync.syncRoom(id), true); assert.equal((await store.handsOf(id)).length, 1);
});

test('同期: 退出（left）— 試合は「途中」で保存され、あとで終わると順位が入る', async () => {
  fresh();
  const id = S.create({ n: 3 }), pol = mixPolicy(rng(9));
  S.playHand(id, callPolicy); S.playHand(id, callPolicy);
  S.leave(id);
  assert.equal(S.st(id).players[S.seat(id)].status, 'left');
  await sync.syncRoom(id);
  let g = await store.getGame(id); assert.equal(g.status, 'running'); assert.equal(g.place, null);
  assert.equal(finishedGames(await store.allGames()).length, 0);
  S.playToEnd(id, pol);
  await sync.syncRecent((await S.rpc('me')).recent);
  g = await store.getGame(id); assert.equal(g.status, 'finished'); assert.equal(g.place, S.st(id).players[S.seat(id)].place);
  assert.equal(g.pt, S.st(id).players[S.seat(id)].pt);
});

test('同期: 全員で退出して即終了（途中のハンドは記録されない）', async () => {
  fresh();
  const id = S.create({ n: 2 });
  S.playHand(id, callPolicy);
  S.leave(id);      // 2 人戦で 1 人が抜けると相手の勝ち
  assert.equal(S.st(id).status, 'finished');
  await sync.syncRoom(id);
  const g = await store.getGame(id); assert.equal(g.status, 'finished'); assert.equal(g.place, 2);
  assert.equal(g.hands, (await store.handsOf(id)).length);
});

test('同期: 途中で飛んだ（out）— 順位と pt が確定した時点で統計に入る', async () => {
  // 3 人戦で自分が先に飛ぶまで打つ
  fresh();
  let id, tries = 0;
  do {
    id = S.create({ n: 3 }); const pol = mixPolicy(rng(100 + tries));
    while (S.live(id) && S.st(id).players[S.seat(id)].status !== 'out') S.step(id, pol);
  } while (S.st(id).status === 'finished' && tries++ < 50);
  assert.equal(S.st(id).status, 'running', '自分が 3 位で飛んだ時点ではまだ続いている試合が作れた');
  await sync.syncRoom(id);
  const g = await store.getGame(id);
  assert.equal(g.place, 3); assert.equal(g.status, 'running'); assert.notEqual(g.pt, null);
  assert.equal(finishedGames(await store.allGames()).length, 1);
});

test('同期: 中止（cancelled）— place なしで保存、統計には数えない、起動時に再同期しない', async () => {
  fresh();
  const id = S.create({ n: 2 });
  S.playHand(id, callPolicy);
  // 全員 sitout → 一時停止 → 10 分で中止
  const R = S.R(id);
  for (const uid of R.room.members) { const out = applyRequest(R.room, uid, { op: 'sitout' }, S.now); R.room = out.room; if (out.record) R.hands.push(out.record); }
  while (R.room.status === 'running') { if (!S.step(id, callPolicy)) break; }
  assert.equal(R.room.status, 'paused');
  S.now += 11 * 60000; R.room = tickRoom(R.room, ME, S.now).room;
  assert.equal(R.room.status, 'cancelled');
  await sync.syncRoom(id);
  const g = await store.getGame(id);
  assert.equal(g.status, 'cancelled'); assert.equal(g.place, null); assert.equal(g.pt, null);
  assert.equal(finishedGames([g]).length, 0);
  S.calls.length = 0; await sync.syncRecent([{ id }]); assert.equal(S.calls.length, 0);
});

test('同期: 待機室だけの部屋（開始前）は何も保存しない', async () => {
  fresh();
  const id = 'w1'; let room = createRoom({ id, code: '999999', kind: 'private', uid: ME, name: 'Me', config: { ...DEFAULT_CONFIG, players: 3 }, now: S.now });
  S.rooms.set(id, { room, hands: [] });
  await sync.syncRoom(id);          // ロビーのビューは無視する
  assert.equal((await store.allGames()).length, 0);
});

/* ================================================================== 2. 成績の集計 */
const G = (place, pt, endedAt, players = 6, status = 'finished') => ({ roomId: 'r' + endedAt, place, pt, endedAt, status, config: { players } });
function brute(list) {
  const n = list.length, places = list.map(g => g.place), pts = list.map(g => g.pt);
  return {
    games: n, avgPlace: n ? places.reduce((a, b) => a + b, 0) / n : 0, first: places.filter(p => p === 1).length, cash: pts.filter(p => p > 0).length,
    total: pts.reduce((a, b) => a + b, 0), dist: [1, 2, 3, 4, 5, 6].map(k => places.filter(p => p === k).length),
  };
}
test('集計: 0 試合 / 1 試合', () => {
  const s0 = summarize([]);
  assert.deepEqual([s0.games, s0.avgPlace, s0.totalPt, s0.firstPlayedAt, s0.lastPlayedAt], [0, 0, 0, null, null]);
  assert.equal(pctLabel(s0.firstRate), '–'); assert.equal(pctLabel(s0.cashRate), '–');
  assert.deepEqual(cumulativePt([]), []); assert.deepEqual(recentPlaces([]), []); assert.deepEqual(filterByPeriod([], 'last100'), []);
  const s1 = summarize([G(3, 2, 5)]);
  assert.equal(s1.avgPlace, 3); assert.equal(pctLabel(s1.firstRate), '0.0'); assert.equal(pctLabel(s1.cashRate), '100.0'); assert.equal(s1.totalPt, 2);
  assert.deepEqual(cumulativePt([G(3, 2, 5)]), [{ x: 1, y: 2 }]);
});

test('集計: ランダムなデータを独立計算（総当たり）と突き合わせ。人数混在・期間フィルタ・中止の除外', () => {
  const r = rng(77);
  for (let round = 0; round < 40; round++) {
    const N = Math.floor(r() * 1300), raw = [];
    for (let i = 0; i < N; i++) {
      const players = 2 + Math.floor(r() * 5), cancelled = r() < 0.1, pl = 1 + Math.floor(r() * players);
      const pay = [5, 3, 2, 1, 0, -1];
      raw.push({ roomId: 'g' + i, place: cancelled ? null : pl, pt: cancelled ? null : pay[pl - 1], endedAt: Math.floor(r() * 1e9), status: cancelled ? 'cancelled' : 'finished', config: { players } });
    }
    const fin = finishedGames(raw);
    assert.equal(fin.length, raw.filter(g => g.status === 'finished').length);
    for (let i = 1; i < fin.length; i++) assert.ok(fin[i - 1].endedAt <= fin[i].endedAt);
    for (const [key, k] of [['last100', 100], ['last500', 500], ['last1k', 1000], ['all', Infinity]]) {
      const pick = filterByPeriod(fin, key), exp = fin.slice(Math.max(0, fin.length - k));
      assert.deepEqual(pick, exp);
      const s = summarize(pick), b = brute(exp);
      assert.equal(s.games, b.games); assert.ok(Math.abs(s.avgPlace - b.avgPlace) < 1e-9);
      assert.deepEqual(s.firstRate, { n: b.first, d: b.games }); assert.deepEqual(s.cashRate, { n: b.cash, d: b.games });
      assert.equal(s.totalPt, b.total); assert.deepEqual(s.placeDist, b.dist);
      assert.equal(s.maxPlayers, exp.reduce((m, g) => Math.max(m, g.config.players), 0));
      const cum = cumulativePt(pick); let acc = 0;
      cum.forEach((p, i) => { acc += exp[i].pt; assert.deepEqual(p, { x: i + 1, y: acc }); });
      if (cum.length) assert.equal(cum.at(-1).y, b.total);
    }
    assert.deepEqual(recentPlaces(fin, 10), fin.slice(-10).map(g => g.place));
  }
});

test('集計: 同じ endedAt の並びは入力順で安定（Array.sort は安定）', () => {
  const a = [G(1, 5, 7), G(2, 3, 7), G(3, 2, 7)].map((g, i) => ({ ...g, roomId: 'x' + i }));
  assert.deepEqual(finishedGames(a).map(g => g.roomId), ['x0', 'x1', 'x2']);
});

test('集計: pctLabel / niceTicks', () => {
  assert.equal(pctLabel({ n: 1, d: 3 }), '33.3'); assert.equal(pctLabel({ n: 2, d: 3 }), '66.7'); assert.equal(pctLabel({ n: 0, d: 0 }), '–');
  for (const [min, max] of [[-1, 1], [0, 1], [-3, 7], [-50, 400], [0, 0.4], [-0.25, 0.5], [0, 12345], [-1000, 30]]) {
    const t = niceTicks(min, max); assert.ok(t.length >= 2 && t.length <= 12, JSON.stringify([min, max, t]));
    assert.ok(t[0] <= min && t.at(-1) >= max, JSON.stringify([min, max, t])); assert.ok(t.every(Number.isFinite));
    for (let i = 1; i < t.length; i++) assert.ok(t[i] > t[i - 1]);
  }
});

/* ================================================================== 3. VPIP / PFR */
const base2 = { startStacks: [20000, 20000], won: [0, 0], ante: 0, sb: 100, bb: 200, sbSeat: 0, bbSeat: 1, btn: 0 };
const H = (actions, extra = {}) => ({ ...base2, actions, ...extra });
test('VPIP/PFR: 基本（コール・レイズ・フォールド・チェック・auto は数えない）', () => {
  const hs = [
    H([{ seat: 0, kind: 'call', betTo: 200, put: 100, street: 0 }, { seat: 1, kind: 'check', betTo: 200, put: 0, street: 0 }]),       // limp: VPIP のみ
    H([{ seat: 0, kind: 'raise', betTo: 600, put: 500, street: 0 }, { seat: 1, kind: 'fold', betTo: 600, put: 0, street: 0 }]),       // VPIP+PFR
    H([{ seat: 0, kind: 'fold', betTo: 200, put: 0, street: 0 }]),                                                                    // どちらも無し
    H([{ seat: 0, kind: 'fold', betTo: 200, put: 0, street: 0, auto: true }]),
    H([{ seat: 0, kind: 'call', betTo: 200, put: 100, street: 0, auto: true }]),                                                      // auto は数えない
  ];
  const s = handStats(hs, () => 0);
  assert.deepEqual(s.vpip, { n: 2, d: 5 }); assert.deepEqual(s.pfr, { n: 1, d: 5 });
});
test('VPIP/PFR: BB のチェックは VPIP ではない / 相手のハンド・参加していない席は数えない', () => {
  const hs = [H([{ seat: 0, kind: 'fold', betTo: 200, put: 0, street: 0 }]), H([{ seat: 0, kind: 'raise', betTo: 600, put: 500, street: 0 }, { seat: 1, kind: 'call', betTo: 600, put: 400, street: 0 }])];
  const s = handStats(hs, () => 1);
  assert.deepEqual(s.vpip, { n: 1, d: 2 }); assert.deepEqual(s.pfr, { n: 0, d: 2 });
  assert.equal(handStats([{ ...base2, startStacks: [0, 20000], actions: [] }], () => 0).hands, 0);
});
test('VPIP/PFR: 相手のレイズにオールインで「コール」した場合は PFR に数えない', () => {
  // SB(seat0) が 600 までレイズ → BB(seat1) は残り 400（合計 400 < 600）で全額コール
  const h = { ...base2, startStacks: [20000, 400], actions: [{ seat: 0, kind: 'raise', betTo: 600, put: 500, street: 0 }, { seat: 1, kind: 'allin', betTo: 400, put: 200, street: 0 }] };
  const s = handStats([h], () => 1);
  assert.deepEqual(s.vpip, { n: 1, d: 1 }); assert.deepEqual(s.pfr, { n: 0, d: 1 });
});
test('VPIP/PFR: 本物のエンジンの記録でもコールオールインを PFR に数えない（ランダムに探索）', () => {
  let bad = 0;
  for (let seed = 1; seed <= 60; seed++) {
    const r = rng(seed), st = newTable({ config: { ...DEFAULT_CONFIG, players: 3 }, names: ['a', 'b', 'c'], now: 0, rnd: r });
    let now = 0, guard = 0;
    while (st.status === 'running' && guard++ < 400) {
      now += 1000; const h = st.hand;
      if (h.phase === 'settled') {
        const rec = handRecord(st).rec;
        for (let s = 0; s < 3; s++) {
          // 独立定義：プリフロップで自分の betTo が、それまでの最高 betTo（無ければ BB）を超えたら raise
          let top = rec.bb, isRaise = false;
          for (const a of rec.actions.filter(a => a.street === 0)) { if (a.kind !== 'fold' && a.kind !== 'check') { if (a.seat === s && !a.auto && a.betTo > top) isRaise = true; top = Math.max(top, a.betTo); } }
          const got = handStats([rec], () => s).pfr.n;
          if (!rec.actions.some(a => a.seat === s && a.street === 0 && !a.auto)) continue;
          if (got !== (isRaise ? 1 : 0)) bad++;
        }
        tick(st, Math.max(now, st.nextAt)); continue;
      }
      const L = legalActions(st), x = r();
      act(st, h.toAct, x < 0.2 && L.canFold ? { type: 'fold' } : x < 0.6 ? { type: 'allin' } : L.canCheck ? { type: 'check' } : { type: 'call' }, now);
    }
  }
  assert.equal(bad, 0, `PFR の誤判定 ${bad} 件`);
});

/* ================================================================== 4. ハンドの記録（hand.js）の不変条件：エンジンの本物の記録 */
test('ハンド記録: 2〜6 人・全レベル・オールイン多めで、拠出・収支・ポット・ポジション・勝者が整合', () => {
  let hands = 0, multiAllin = 0, sidePots = 0, withAnte = 0;
  for (let n = 2; n <= 6; n++) for (let seed = 1; seed <= 60; seed++) {
    const r = rng(seed * 101 + n), cfg = { ...DEFAULT_CONFIG, players: n, startBb: [50, 75, 100, 150][seed % 4], speed: ['normal', 'slow', 'veryslow'][seed % 3] };
    const st = newTable({ config: cfg, names: Array.from({ length: n }, (_, i) => 'p' + i), now: 0, rnd: r });
    let now = 0, guard = 0;
    while (st.status === 'running' && guard++ < 3000) {
      now += 20000;     // 時間をどんどん進めてレベルとアンティを上げる
      const h = st.hand;
      if (h.phase === 'settled') {
        const { rec, holes } = handRecord(st); hands++;
        const commits = h.commits, tot = commits.reduce((a, b) => a + b, 0);
        if (rec.ante > 0) withAnte++;
        assert.equal(rec.won.reduce((a, b) => a + b, 0), tot, 'won 合計 = 拠出合計');
        for (let s = 0; s < n; s++) { assert.equal(committedOf(rec, s), commits[s], `拠出 seat${s} hand${rec.handNo} n${n}`); assert.equal(netOfRecord(rec, s), rec.won[s] - commits[s]); }
        assert.equal(Array.from({ length: n }, (_, s) => netOfRecord(rec, s)).reduce((a, b) => a + b, 0), 0, '収支の合計は 0');
        // ポット：金額の合計 = 拠出合計、勝者は eligible の部分集合、勝ち分の合計 = ポット
        assert.equal(rec.pots.reduce((a, p) => a + p.amount, 0), tot);
        const wonFromPots = Array(n).fill(0);
        for (const p of rec.pots) { assert.ok(p.winners.length >= 1); assert.ok(p.winners.every(w => p.eligible.includes(w))); assert.ok(p.amount > 0); }
        if (rec.pots.length > 1) sidePots++;
        // ストリートごとのポット：単調、最終ストリート開始時 + そのストリートの拠出 = 拠出合計
        const sp = streetPots(rec); assert.equal(sp.length, 4);
        for (let i = 1; i < 4; i++) assert.ok(sp[i] >= sp[i - 1]);
        const lastSt = Math.max(0, ...rec.actions.map(a => a.street));
        assert.equal(sp[lastSt] + rec.actions.filter(a => a.street === lastSt).reduce((x, a) => x + a.put, 0), tot, 'ストリートのポットの帳尻');
        // 金額・名前に undefined / NaN が無い
        const dump = JSON.stringify(rec); assert.ok(!/NaN|undefined/.test(dump));
        for (const a of rec.actions) { assert.ok(Number.isFinite(a.put) && a.put >= 0); assert.ok(Number.isFinite(a.betTo)); assert.ok(a.seat >= 0 && a.seat < n); assert.ok(['fold', 'check', 'call', 'bet', 'raise', 'allin'].includes(a.kind), a.kind); }
        // ポジション：参加者ぜんいんに一意の名前、BB は BB
        const pos = positionsOf(rec), live = rec.startStacks.filter(x => x > 0).length;
        assert.equal(pos[rec.bbSeat], 'BB'); assert.equal(pos.filter(Boolean).length, live); assert.equal(new Set(pos.filter(Boolean)).size, live);
        if (live === 2) assert.deepEqual([pos[rec.sbSeat], pos[rec.bbSeat]], ['SB', 'BB']);
        if (rec.sbSeat != null && live >= 3) assert.equal(pos[rec.sbSeat], 'SB');
        // 手札：ショーダウンでは contender の手札が shown と一致、自分の hole は全員分ある
        for (let s = 0; s < n; s++) if (rec.shown[s]) assert.deepEqual(rec.shown[s], holes[s]);
        const aiSeats = new Set(rec.actions.filter(a => a.kind === 'allin').map(a => a.seat)); if (aiSeats.size >= 2) multiAllin++;
        for (const e of rec.eliminated) assert.ok(e.place >= 1 && e.place <= n);
        tick(st, Math.max(now, st.nextAt)); continue;
      }
      const L = legalActions(st), x = r();
      act(st, h.toAct, x < 0.15 && L.canFold ? { type: 'fold' } : x < 0.55 ? { type: 'allin' } : x < 0.65 && L.minTo != null ? { type: 'raise', to: L.minTo } : L.canCheck ? { type: 'check' } : { type: 'call' }, now);
    }
  }
  assert.ok(hands > 300 && multiAllin > 20 && sidePots > 10 && withAnte > 100, JSON.stringify({ hands, multiAllin, sidePots, withAnte }));
});

test('ハンド記録: 開始スタックが 0 の席（脱落済み）が混ざる 6 人戦でも forcedOf / committedOf / positionsOf が整合', () => {
  let sawDead = 0, sawDeadSb = 0;
  for (let seed = 1; seed <= 80; seed++) {
    const r = rng(seed * 9973), cfg = { ...DEFAULT_CONFIG, players: 6, startBb: 75 };
    const st = newTable({ config: cfg, names: ['a', 'b', 'c', 'd', 'e', 'f'], now: 0, rnd: r });
    let now = 0, guard = 0;
    while (st.status === 'running' && guard++ < 3000) {
      now += 20000; const h = st.hand;
      if (h.phase === 'settled') {
        const { rec } = handRecord(st);
        if (rec.startStacks.some(x => x === 0)) sawDead++;
        if (rec.sbSeat == null) sawDeadSb++;
        for (let s = 0; s < 6; s++) assert.equal(committedOf(rec, s), h.commits[s]);
        assert.equal(forcedOf(rec).filter((x, s) => rec.startStacks[s] === 0 && x > 0).length, 0);
        const pos = positionsOf(rec), live = rec.startStacks.filter(x => x > 0).length;
        assert.equal(pos.filter(Boolean).length, live); assert.equal(new Set(pos.filter(Boolean)).size, live); assert.equal(pos[rec.bbSeat], 'BB');
        tick(st, Math.max(now, st.nextAt)); continue;
      }
      const L = legalActions(st), x = r();
      act(st, h.toAct, x < 0.2 && L.canFold ? { type: 'fold' } : x < 0.3 ? { type: 'allin' } : L.canCheck ? { type: 'check' } : { type: 'call' }, now);
    }
  }
  assert.ok(sawDead > 20 && sawDeadSb > 0, JSON.stringify({ sawDead, sawDeadSb }));
});

/* ================================================================== 5. EXPORT / IMPORT */
const sampleGame = (id, over = {}) => ({ roomId: id, code: '123456', kind: 'private', config: { ...DEFAULT_CONFIG, players: 2 }, seat: 0, names: ['Me', 'Bot'], players: [{ name: 'Me', place: 1, pt: 5 }, { name: 'Bot', place: 2, pt: 3 }], place: 1, pt: 5, status: 'finished', startedAt: 1, endedAt: 2, hands: 1, ...over });
const sampleHand = (id, no) => ({ roomId: id, handNo: no, level: 1, sb: 100, bb: 200, ante: 50, btn: 0, sbSeat: 0, bbSeat: 1, startStacks: [15000, 15000], shown: [null, null], names: [null, null], board: [], actions: [], won: [0, 0], pots: [], eliminated: [], hole: [1, 2] });

test('EXPORT/IMPORT: 往復で同じ中身。2 回読み込んでも増えない', async () => {
  fresh();
  const id = S.create({ n: 3 }); S.playToEnd(id, mixPolicy(rng(3))); await sync.syncRoom(id);
  const a = await store.exportAll();
  assert.equal(a.app, 'privatematch'); assert.equal(a.games.length, 1);
  const json = JSON.parse(JSON.stringify(a));
  clearDevice();
  assert.equal(await store.importAll(json), 1);
  const b = await store.exportAll();
  assert.deepEqual(b.games, a.games); assert.deepEqual(b.hands.sort((x, y) => x.handNo - y.handNo), a.hands.sort((x, y) => x.handNo - y.handNo));
  await store.importAll(json); await store.importAll(json);
  const c = await store.exportAll(); assert.equal(c.games.length, 1); assert.equal(c.hands.length, a.hands.length);
});

test('IMPORT: 形式が違うものは拒否（何も書かない）', async () => {
  fresh();
  for (const bad of [null, 1, 'x', [], {}, { app: 'x', games: [], hands: [] }, { app: 'privatematch', games: {}, hands: [] }, { app: 'privatematch', games: [], hands: null }])
    await assert.rejects(() => store.importAll(bad), /format/);
  assert.equal((await store.allGames()).length, 0);
});

test('IMPORT: 型の違う行は読み飛ばす（roomId が文字列でない / handNo が整数でない）', async () => {
  fresh();
  await store.importAll({ app: 'privatematch', games: [sampleGame('ok'), null, 5, { roomId: 7 }, { roomId: {} }, { nope: 1 }], hands: [sampleHand('ok', 1), sampleHand('ok', 1.5), { roomId: 'ok', handNo: '2' }, { roomId: 3, handNo: 1 }, null, 'x'] });
  assert.deepEqual((await store.allGames()).map(g => g.roomId), ['ok']); assert.deepEqual((await store.handsOf('ok')).map(h => h.handNo), [1]);
});

test('IMPORT: __proto__ / constructor キーを含んでもプロトタイプ汚染しない', async () => {
  fresh();
  const evil = JSON.parse('{"app":"privatematch","games":[{"roomId":"p","__proto__":{"polluted":1},"constructor":{"prototype":{"polluted2":1}}}],"hands":[{"roomId":"p","handNo":1,"__proto__":{"polluted3":1}}]}');
  await store.importAll(evil);
  assert.equal({}.polluted, undefined); assert.equal({}.polluted2, undefined); assert.equal({}.polluted3, undefined);
  // 形の壊れた行は読み込まない（validGame）。読み込まれた場合もプロトタイプは普通のまま
  const g = await store.getGame('p'); if (g) { assert.equal(Object.getPrototypeOf(g), Object.prototype); assert.equal(g.polluted, undefined); }
});

test('IMPORT: 古い書き出しを読み込んでも、端末にある新しい（終了済みの）試合を「途中」に戻さない', async () => {
  fresh();
  await store.putGame(sampleGame('g1', { status: 'finished', place: 1, hands: 30 }));
  await store.importAll({ app: 'privatematch', games: [sampleGame('g1', { status: 'running', place: null, pt: null, hands: 10 })], hands: [] });
  const g = await store.getGame('g1'); assert.equal(g.status, 'finished'); assert.equal(g.hands, 30);
});

test('IMPORT: 中身の型が壊れた試合（players が配列でない / config が無い / place が文字列）は保存されない、または画面を壊さない', async () => {
  fresh();
  await store.importAll({ app: 'privatematch', games: [{ roomId: 'bad1' }, { roomId: 'bad2', players: 'x', config: 1 }, { roomId: 'bad3', status: 'finished', place: '1', pt: '5', endedAt: 1 }], hands: [] });
  const games = await store.allGames();
  // 受け入れた行はすべて、画面が前提にしている形（players 配列・config オブジェクト・place/pt は数値）であること
  for (const g of games) { assert.ok(Array.isArray(g.players), g.roomId + ' players'); assert.equal(typeof g.config, 'object'); if (g.status === 'finished') { assert.equal(typeof g.place, 'number'); assert.equal(typeof g.pt, 'number'); } }
});

test('IMPORT: finished で place が文字列の行が混ざると集計が文字列連結になる（検証が無い証拠）', () => {
  const s = summarize([{ place: '2', pt: '3', config: { players: 6 } }, { place: 1, pt: 5, config: { players: 6 } }]);
  assert.equal(typeof s.avgPlace, 'number');
  // 現状: placeSum = 0 + '2' + 1 = '021' → avgPlace = 10.5
  assert.notEqual(s.avgPlace, 10.5, '文字列の place がそのまま足されている');
});

test('IMPORT: 大量（20000 試合 / 100000 ハンド）でも完了する', async () => {
  fresh();
  const games = Array.from({ length: 20000 }, (_, i) => sampleGame('big' + i));
  const hands = Array.from({ length: 100000 }, (_, i) => sampleHand('big' + (i % 20000), 1 + Math.floor(i / 20000)));
  const t0 = Date.now(); assert.equal(await store.importAll({ app: 'privatematch', games, hands }), 20000);
  assert.ok(Date.now() - t0 < 30000); assert.equal((await store.allGames()).length, 20000);
});

/* ================================================================== プレイヤーのスタッツ（ゲームモードごと。卓のプレイヤーのモーダル・STATS） */
test('プレイヤー: 端末に写した試合から、モードごとに自分と相手（名前で引く・席は試合ごとに違う）の VPIP / PFR / 生存ターンを数える', async () => {
  const { byMode, playerStats, survivalTurns } = await import('../src/history/stats.js');
  fresh();
  const r = rng(77), ids = [];
  // club 3 試合・rank-4 2 試合。席は開始時にシャッフルされる
  for (const [mode, n] of [['club', 3], ['club', 4], ['rank-4', 3], ['club', 2], ['rank-4', 4]]) {
    const id = S.create({ n, cfg: { mode } }); ids.push(id);
    S.playToEnd(id, mixPolicy(r));
    assert.equal(await sync.syncRoom(id), true);
  }
  const games = await store.allGames(), hands = await store.handsByRoom();
  assert.equal(hands.size, ids.length);
  for (const id of ids) assert.deepEqual(hands.get(id).map(h => h.handNo), S.R(id).hands.map(h => h.rec.handNo));
  for (const mode of ['club', 'rank-4']) {
    const gs = byMode(finishedGames(games), mode);
    assert.ok(gs.length >= 2 && gs.every(g => g.config.mode === mode));
    for (const who of [null, 'Bot1', 'bot1', 'Bot3']) {
      const st = playerStats(gs, id => hands.get(id), who);
      // 期待値：サーバーの記録を、その人の席で直接数える
      let n = 0, played = 0; const seatOf = new Map();
      for (const g of gs) {
        const seat = who == null ? S.seat(g.roomId) : S.R(g.roomId).room.names.findIndex(x => x.toLowerCase() === who.toLowerCase());
        if (seat < 0) continue;
        const recs = S.R(g.roomId).hands.map(h => h.rec).filter(h => h.startStacks[seat] > 0);
        if (recs.length) played++;
        for (const h of recs) { seatOf.set(h, seat); n++; }
      }
      const exp = handStats([...seatOf.keys()], h => seatOf.get(h));
      assert.equal(st.hands, n, `${mode} ${who} hands`);
      assert.equal(st.games, played, `${mode} ${who} games`);
      assert.deepEqual(st.vpip, exp.vpip); assert.deepEqual(st.pfr, exp.pfr);
      assert.equal(st.survival, survivalTurns(n, exp.vpip, played));
      if (st.survival != null) assert.ok(Math.abs(st.survival - n / (exp.vpip.n / exp.vpip.d * 100) * 100 / played) < 1e-9);
    }
  }
  // モードを混ぜない：club と rank-4 の和 = 全体。遊んでいないモードは 0
  const all = finishedGames(games), self = m => playerStats(byMode(all, m), id => hands.get(id)).hands;
  assert.equal(self('club') + self('rank-4'), playerStats(all, id => hands.get(id)).hands);
  assert.equal(playerStats(byMode(all, 'legend-avg'), id => hands.get(id)).games, 0);
});
