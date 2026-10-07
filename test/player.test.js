// 卓のプレイヤーのモーダルと STATS の集計（src/history/stats.js の byMode / playerStats / survivalTurns）と、メモ（src/history/notes.js）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { byMode, latestMode, nameKey, playerStats, survivalTurns, handStats, seatIn, gameHandStats, mergeStats } from '../src/history/stats.js';

// localStorage の代役（notes.js は最初に使うときに読む）
const mem = new Map();
globalThis.localStorage = { getItem: k => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: k => mem.delete(k) };
const notes = await import('../src/history/notes.js');

test('生存ターン = ハンド数 ÷ VPIP(%) × 100 ÷ 試合数', () => {
  assert.equal(survivalTurns(400, { n: 100, d: 400 }, 10), 160);   // 400 ÷ 25 × 100 ÷ 10
  assert.ok(Math.abs(survivalTurns(90, { n: 30, d: 90 }, 3) - 90) < 1e-9);   // 90 ÷ 33.3… × 100 ÷ 3
  assert.equal(survivalTurns(50, { n: 0, d: 50 }, 2), null);        // VPIP 0
  assert.equal(survivalTurns(0, { n: 0, d: 0 }, 0), null);
});

// 3 人のハンド：seat が raise（VPIP・PFR）、または fold
const base = { ante: 0, sb: 50, bb: 100, btn: 0, won: [0, 0, 0] };
const raise = (roomId, handNo, seat, stacks) => ({ ...base, roomId, handNo, startStacks: stacks, sbSeat: 0, bbSeat: 1, actions: [{ seat, kind: 'raise', betTo: 300, put: 300, street: 0 }] });
const fold = (roomId, handNo, seat, stacks) => ({ ...base, roomId, handNo, startStacks: stacks, sbSeat: 0, bbSeat: 1, actions: [{ seat, kind: 'fold', betTo: 0, put: 0, street: 0 }] });
const game = (roomId, mode, names, seat, endedAt) => ({ roomId, config: { players: names.length, mode }, names, seat, place: 1, pt: 1, status: 'finished', endedAt });

test('playerStats：名前（大文字小文字を無視）で席を引き、配られていないハンドと 1 ハンドも無い試合は数えない', () => {
  const S3 = [1000, 1000, 1000];
  const games = [
    game('a', 'club', ['Me', 'Kenta', 'Yui'], 0, 1),      // Kenta は席 1
    game('b', 'club', ['Kenta', 'Me', 'Yui'], 1, 2),      // Kenta は席 0
    game('c', 'club', ['Me', 'Yui', 'Sora'], 0, 3),       // Kenta は居ない
    game('d', 'club', ['Me', 'Kenta', 'Yui'], 0, 4),      // Kenta は最初から 0（配られていない）
  ];
  const hands = {
    a: [raise('a', 1, 1, S3), fold('a', 2, 1, S3), raise('a', 3, 0, S3)],
    b: [raise('b', 1, 0, S3), fold('b', 2, 0, S3)],
    c: [raise('c', 1, 0, S3)],
    d: [fold('d', 1, 0, [1000, 0, 1000])],
  };
  const k = playerStats(games, id => hands[id], 'kenta');
  assert.equal(k.games, 2);           // d は配られたハンドが無いので数えない
  assert.equal(k.hands, 5);           // a 3 + b 2
  assert.deepEqual(k.vpip, { n: 2, d: 5 }); assert.deepEqual(k.pfr, { n: 2, d: 5 });
  assert.equal(k.survival, 5 / 40 * 100 / 2);
  const me = playerStats(games, id => hands[id]);   // 自分 = 各試合の g.seat
  assert.equal(me.games, 4); assert.equal(me.hands, 3 + 2 + 1 + 1);
  assert.deepEqual(me.vpip, { n: 2, d: 7 });       // a#3, c#1
  assert.deepEqual(playerStats(games, id => hands[id], 'Nobody'), { ...handStats([], () => 0), games: 0, survival: null });
  assert.equal(playerStats(games, () => undefined, 'Kenta').games, 0);   // ハンドの記録が無い試合
});

test('相手を名前で引くとき、自分の席は除く（自分の昔の名前を今は別の人が使っている）', () => {
  const S2 = [1000, 1000, 0];
  const games = [game('a', 'club', ['Kenta', 'Yui'], 0, 1), game('b', 'club', ['Me', 'Kenta'], 0, 2)];   // a は自分が Kenta だった頃
  const hands = { a: [raise('a', 1, 0, S2)], b: [fold('b', 1, 1, S2)] };
  assert.equal(seatIn(games[0], 'Kenta'), -1); assert.equal(seatIn(games[0], null), 0);
  const k = playerStats(games, id => hands[id], 'Kenta');
  assert.deepEqual([k.games, k.hands, k.vpip.n], [1, 1, 0]);
});

test('mergeStats：試合ごとの集計を足すと、まとめて数えたのと同じ', () => {
  const S3 = [1000, 1000, 1000];
  const hs = { a: [raise('a', 1, 1, S3), fold('a', 2, 1, S3)], b: [raise('b', 1, 1, S3)], c: [] };
  const games = ['a', 'b', 'c'].map((id, i) => game(id, 'club', ['x', 'Me', 'y'], 1, i));
  const merged = mergeStats(games.map(g => gameHandStats(hs[g.roomId], g.seat)));
  assert.deepEqual(merged, playerStats(games, id => hs[id]));
  assert.deepEqual([merged.games, merged.hands, merged.vpip], [2, 3, { n: 2, d: 3 }]);
  assert.equal(gameHandStats([], 0), null); assert.equal(gameHandStats(undefined, 0), null);
});

test('byMode / latestMode：モードで分ける・既定は最後に終わった試合のモード', () => {
  assert.equal(latestMode([{ ...game('z', 'nope', ['x'], 0, 1) }], ['club', 'rank-4']), 'club');   // 知らないモード（読み込んだ細工した行）
  assert.equal(latestMode([{ ...game('z', 'club', ['x'], 0, 1), config: {} }], ['club']), 'club');
  const gs = [game('a', 'club', ['x'], 0, 5), game('b', 'rank-4', ['x'], 0, 9), game('c', 'club', ['x'], 0, 7), { ...game('d', 'legend-avg', ['x'], 0, 20), status: 'cancelled', place: null }];
  assert.deepEqual(byMode(gs, 'club').map(g => g.roomId), ['a', 'c']);
  assert.deepEqual(byMode(gs, 'rank-5'), []);
  assert.equal(latestMode(gs), 'rank-4');   // 中止の試合は数えない
  assert.equal(latestMode([]), 'club');
  assert.equal(nameKey('  Kenta '), 'kenta'); assert.equal(nameKey('KENTA'), 'kenta');
});

test('メモ：印とメモを保存し、空にすると消える。名前は大文字小文字を無視', () => {
  assert.deepEqual(notes.noteOf('Kenta'), { mark: 0, text: '' });
  notes.setNote('Kenta', { mark: 3 });
  assert.equal(notes.markOf('kenta'), 3);
  notes.setNote('KENTA', { text: 'リバーで\nブラフ\u0000' });
  assert.deepEqual({ ...notes.noteOf('Kenta'), at: 0 }, { name: 'KENTA', mark: 3, text: 'リバーで\nブラフ', at: 0 });
  assert.ok(JSON.parse(mem.get('pm-notes')).kenta);
  notes.setNote('Kenta', { mark: 0, text: '  ' });
  assert.equal(notes.markOf('Kenta'), 0);
  assert.equal(JSON.parse(mem.get('pm-notes')).kenta, undefined);
  notes.setNote('Hana', { text: 'あ'.repeat(500) });
  assert.equal(Array.from(notes.noteOf('Hana').text).length, notes.NOTE_MAX);
});

test('メモの読み込み：壊れた行は捨て、同じ人は新しい方を残す。変わったら知らせる', () => {
  let calls = 0; const off = notes.onNotes(() => calls++);
  notes.setNote('Yui', { mark: 2, text: 'old' });
  const at = notes.noteOf('Yui').at;
  const data = JSON.parse(`{
    "a": { "name": "Yui", "mark": 5, "text": "new", "at": ${at + 1} },
    "b": { "name": "Sora", "mark": 9, "text": "" },
    "c": { "name": "Riku", "mark": 1.5, "text": "ok", "at": 1 },
    "d": "broken", "e": null, "f": { "name": "", "mark": 1 },
    "__proto__": { "name": "Taro", "mark": 1, "polluted": true }
  }`);
  const n = notes.importNotes(data);
  assert.equal(n, 3);   // Yui（新しい）・Riku（印は整数でないので無し、メモは残す）・__proto__ キーの行（名前から付け直す）
  assert.equal(notes.noteOf('Yui').text, 'new'); assert.equal(notes.markOf('Yui'), 5);
  assert.deepEqual([notes.markOf('Riku'), notes.noteOf('Riku').text], [0, 'ok']);
  assert.equal(notes.markOf('Sora'), 0);    // 印が範囲外で中身が空 → 捨てる
  assert.equal(notes.markOf('Taro'), 1);
  assert.equal(({}).polluted, undefined);   // プロトタイプを汚さない
  assert.equal(notes.importNotes({ a: { name: 'Yui', mark: 1, text: 'older', at: 0 } }), 0);   // 古い方は上書きしない
  assert.equal(notes.noteOf('Yui').text, 'new');
  assert.ok(calls >= 2); off();
  assert.equal(notes.importNotes('x'), 0); assert.equal(notes.importNotes([1, 2]), 0); assert.equal(notes.importNotes(null), 0);
});

test('メモ：constructor / __proto__ という名前でも普通に扱う・中身が同じなら時刻を変えない・読み込みの上限と未来の時刻', () => {
  assert.deepEqual(notes.noteOf('constructor'), { mark: 0, text: '' });
  notes.setNote('constructor', { mark: 1, text: 'a' });
  notes.setNote('__proto__', { mark: 2 });
  assert.deepEqual([notes.markOf('constructor'), notes.noteOf('constructor').text, notes.markOf('__proto__')], [1, 'a', 2]);
  const saved = JSON.parse(mem.get('pm-notes'));
  assert.ok(Object.hasOwn(saved, 'constructor') && Object.hasOwn(saved, '__proto__'));
  let calls = 0; const off = notes.onNotes(() => calls++);
  const at = notes.noteOf('constructor').at;
  notes.setNote('constructor', { text: 'a' }); notes.setNote('constructor', { mark: 1 });
  assert.equal(calls, 0); assert.equal(notes.noteOf('constructor').at, at);
  off();
  // 未来の時刻は今に寄せる（以後の読み込みで置き換えられなくならない）
  notes.importNotes({ a: { name: 'Future', mark: 1, text: '', at: 1e300 } });
  assert.ok(notes.noteOf('Future').at <= Date.now());
  // 上限
  const big = {}; for (let i = 0; i < notes.NOTES_MAX + 50; i++) big['k' + i] = { name: 'P' + i, mark: 1, text: '', at: i };
  notes.importNotes(big);
  assert.ok(Object.keys(JSON.parse(mem.get('pm-notes'))).length <= notes.NOTES_MAX);
});
