// 卓のチャットの敵対的 QA（test/chat.test.js に無い観点）：src/chat.js の境界・性質テスト、postChat の網羅、handler の op chat、
// src/fakeNet.js（node に location / window のスタブを置いて import する）、TEST_DATABASE_URL があるときだけ動く DB の結合テスト。
// 実装は直さず、見つけた問題は報告に書く（このファイルは通る状態で置く）。
import { test, describe, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { CHAT_MAX_UNITS, CHAT_ROOM_MAX, chatUnits, clipChat, normalizeChat } from '../src/chat.js';
import { createRoom, joinRoom, leaveRoom, applyRequest, postChat, MoveError } from '../server/game/rules.js';
import { createHandler, STATUS, MAX_BODY } from '../server/game/handler.js';
import { makeDb } from '../server/game/db.js';
import { DEFAULT_CONFIG } from '../src/structure.js';
const nfcUnits = x => chatUnits(x.normalize('NFC')); // clipChat は NFC にしてから数える

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const U = i => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const ch = cp => String.fromCodePoint(cp);
const ZWJ = ch(0x200d), VS16 = ch(0xfe0f), ACUTE = ch(0x301), DAKUTEN = ch(0x3099);
const FAMILY = '👨' + ZWJ + '👩' + ZWJ + '👧';                 // 8
const FLAG = '🇯🇵';                                            // 4（地域指示記号 2 つ。1 つ 2）
const KEYCAP = '1' + VS16 + ch(0x20e3);                         // 3
const ENGLAND = '🏴' + [0x67, 0x62, 0x65, 0x6e, 0x67, 0x7f].map(c => ch(0xe0000 + c)).join('');   // タグ付きの旗（8）
const THUMB = '👍🏽';                                            // 4
const NFD_GA = 'か' + DAKUTEN;                                  // NFC では 'が'（2）。分解形は 4
const code = c => e => e instanceof MoveError && e.code === c;
const hex = s => [...s].map(c => c.codePointAt(0).toString(16));
const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const gr = s => Array.from(seg.segment(s), x => x.segment);

// 独立に書いた「消えているべき文字」（src/chat.js の正規表現のコピーではなく、契約の集合：制御文字・サロゲート・set_nickname と同じ見えない文字・ZWJ 以外のゼロ幅・方向制御）
const FORBIDDEN = /[\p{Cc}\p{Cs}\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200c\u200e\u200f\u2028-\u202f\u2060-\u206f\u2800\u3164\ufeff\uffa0\ufff9-\ufffc]/u;
const PICTO = /^\p{Extended_Pictographic}$/u;

// ランダム文字列の部品（書記素レベルの意地悪なもの）
const PIECES = ['a', 'Z', '9', ' ', '  ', '\n', '\t', ch(0x3000), ch(0xa0), 'あ', 'ア', 'ｱ', '漢', '𠮷', '한', 'ＡＢ', '。', '😀', '🃏', '❤', '❤' + VS16, '©', '™' + VS16, THUMB, FAMILY, '👩' + ZWJ + '❤' + VS16 + ZWJ + '👨',
  FLAG, '🇯', KEYCAP, ENGLAND, 'e' + ACUTE, 'e' + ACUTE + ch(0x323), NFD_GA, 'は' + ch(0x309a), DAKUTEN, ACUTE, VS16, ZWJ, ZWJ + ZWJ, ch(0x200b), ch(0x202e), ch(0xfeff), ch(0x2060), ch(0x115f),
  ch(0x1160), ch(0x3164), ch(0x2800), ch(0xad), ch(0x7), ch(0x0), ch(0x1b), ch(0x85), ch(0x7f), '\ud800', '\udc00', ch(0xe0067), ch(0x1f3fb), ch(0xfe0e), ch(0xfe00), '<b>', '&amp;', 'ö', 'ﬁ', 'Å', ch(0x212b)];
const randStr = (r, n) => { let s = ''; for (let i = r() * n | 0; i >= 0; i--) s += PIECES[r() * PIECES.length | 0]; return s; };
const randRaw = (r, n) => { let s = ''; for (let i = r() * n | 0; i >= 0; i--) { const x = r(); s += x < 0.5 ? String.fromCharCode(r() * 0x10000 | 0) : x < 0.8 ? String.fromCodePoint(0x10000 + (r() * 0x100000 | 0)) : String.fromCharCode(r() * 0x180 | 0); } return s; };

// ---------------- src/chat.js：境界 ----------------
test('chatUnits：国旗・キーキャップ・タグ付きの旗・孤立サロゲート・NFD の濁点（コードポイント単位で数える）', () => {
  assert.equal(chatUnits(FLAG), 4); assert.equal(chatUnits('🇯'), 2);
  assert.equal(chatUnits(KEYCAP), 3);                   // '1' + VS16 + U+20E3（記号は 1 なので全体で 3）
  assert.equal(chatUnits(ENGLAND), 8);                  // 🏴 2 + タグ 6（タグは 1 ずつ）
  assert.equal(chatUnits('\ud800'), 1); assert.equal(chatUnits('\udc00' + '\ud800'), 2);
  assert.equal(chatUnits(NFD_GA), 4); assert.equal(chatUnits('が'), 2);
  assert.equal(chatUnits(FAMILY), 8); assert.equal(chatUnits(FAMILY + ZWJ), 9);
  assert.equal(chatUnits(THUMB), 4);
  assert.equal(chatUnits(undefined), 0); assert.equal(chatUnits(12345), 5);   // String() で数える
});

describe('上限ちょうどと 1 超え（normalizeChat は通す / null、clipChat は切る）', () => {
  // [名前, ちょうど 40 の文字列, 1 超え（41 か 42）の文字列, clip の期待（41 側）]。上限は 80 なので、それぞれの前に「ちょうど 40」をもう 1 つ付けて使う
  const cases = ([
    ['半角', 'a'.repeat(40), 'a'.repeat(41), 'a'.repeat(40)],
    ['全角', 'あ'.repeat(20), 'あ'.repeat(21), 'あ'.repeat(20)],
    ['混在（半角 + 全角）', 'a'.repeat(2) + 'あ'.repeat(19), 'a'.repeat(3) + 'あ'.repeat(19), 'a'.repeat(3) + 'あ'.repeat(18)],
    ['絵文字', '😀'.repeat(20), '😀'.repeat(21), '😀'.repeat(20)],
    ['絵文字 + 半角（全角が入らない端数）', '😀'.repeat(19) + 'ab', '😀'.repeat(19) + 'abc', '😀'.repeat(19) + 'ab'],
    ['肌の色付き（4）', THUMB.repeat(10), THUMB.repeat(11), THUMB.repeat(10)],
    ['ZWJ 列（8）', FAMILY.repeat(5), FAMILY.repeat(5) + 'a', FAMILY.repeat(5)],
    ['国旗（4）', FLAG.repeat(10), FLAG.repeat(10) + 'a', FLAG.repeat(10)],
    ['結合文字（e + acute は NFC で 1）', ('e' + ACUTE).repeat(20), ('e' + ACUTE).repeat(21), null],
    ['異体字セレクタ（❤ + VS16 = 2）', ('❤' + VS16).repeat(20), ('❤' + VS16).repeat(20) + 'a', ('❤' + VS16).repeat(20)],
    ['キーキャップ（3）', KEYCAP.repeat(13) + 'a', KEYCAP.repeat(13) + 'ab', KEYCAP.repeat(13) + 'a'],
  ]).map(([n, at, over, clip]) => [n, at + at, at + over, clip == null ? null : at + clip]);
  for (const [name, at, over, clipOver] of cases) {
    test(name, () => {
      assert.equal(normalizeChat(at), at.normalize('NFC'), 'ちょうど');
      assert.equal(normalizeChat(over), over.normalize('NFC').length && chatUnits(over.normalize('NFC')) <= CHAT_MAX_UNITS ? over.normalize('NFC') : null, '1 超え');
      assert.equal(clipChat(at), at, 'clip：ちょうどは切らない');
      if (clipOver != null) assert.equal(clipChat(over), clipOver, 'clip：1 超え');
      // 切った結果はそのまま送れる（NFC で縮む分は送れる側に余裕がある）
      assert.ok(normalizeChat(clipChat(over)) !== null);
    });
  }
  test('41 / 42 になる文字列は null（切らない）', () => {
    assert.equal(normalizeChat('a'.repeat(79) + 'あ'), null);
    assert.equal(normalizeChat('a'.repeat(79) + '😀'), null);
    assert.equal(normalizeChat('a'.repeat(77) + FLAG), null);
    assert.equal(normalizeChat('a'.repeat(73) + FAMILY), null);
    assert.equal(normalizeChat('a'.repeat(72) + FAMILY), 'a'.repeat(72) + FAMILY);
    assert.equal(normalizeChat('a'.repeat(76) + FLAG), 'a'.repeat(76) + FLAG);
  });
  test('NFD の濁点：normalizeChat は NFC にしてから数える（20 個は通り 21 個は null）。clipChat も NFC で数える', () => {
    assert.equal(normalizeChat(NFD_GA.repeat(40)), 'が'.repeat(40));
    assert.equal(normalizeChat(NFD_GA.repeat(41)), null);
    const c = clipChat(NFD_GA.repeat(60));
    assert.equal(c, NFD_GA.repeat(40));                          // NFC の幅（2 ずつ）で 40 個（書記素の途中では切らない）
    assert.equal(normalizeChat(c), 'が'.repeat(40));             // そのまま送れる
  });
  test('消えるものは数えない：上限ちょうどの文のあとに見えない文字・空白をいくら付けても通る', () => {
    const t = 'あ'.repeat(40);
    assert.equal(normalizeChat(t + ch(0x200b).repeat(500) + ' \n\t'.repeat(10)), t);
    assert.equal(normalizeChat(' ' + t + ' '), t);
    assert.equal(normalizeChat('a'.repeat(80) + ZWJ), 'a'.repeat(80));
  });
  test('clipChat：書記素を壊さない（国旗・ZWJ 列・タグ付きの旗・キーキャップ・結合文字・肌の色）', () => {
    for (const unit of [FLAG, FAMILY, ENGLAND, KEYCAP, THUMB, 'e' + ACUTE + ch(0x323), NFD_GA, '👩' + ZWJ + '❤' + VS16 + ZWJ + '👨']) {
      for (let pad = 0; pad <= 8; pad++) {
        const s = 'a'.repeat(pad) + unit.repeat(24);
        const c = clipChat(s);
        assert.ok(nfcUnits(c) <= CHAT_MAX_UNITS, hex(unit).join(' '));
        assert.ok(s.startsWith(c));
        const rest = s.slice(c.length);
        assert.ok(c.length === 0 || rest === '' || gr(s).slice(0, gr(c).length).join('') === c, `書記素の途中で切れている pad=${pad} ${hex(unit).join(' ')}`);
        if (rest) assert.ok(nfcUnits(c) + nfcUnits(gr(rest)[0]) > CHAT_MAX_UNITS, '入る書記素をまだ捨てている');
      }
    }
    // 国旗の列：3 つ目の地域指示記号だけが余っても旗を割らない
    assert.equal(clipChat(FLAG.repeat(20) + '🇺'), FLAG.repeat(20));
  });
  test('clipChat：孤立サロゲートや制御文字を含んでも落ちない・上限を超えない（normalize で消える）', () => {
    for (const s of ['a'.repeat(79) + '\ud800' + 'b', '\udc00'.repeat(120), ch(0).repeat(100), '\ud83d' + 'a'.repeat(85)]) {
      const c = clipChat(s);
      assert.ok(chatUnits(c) <= CHAT_MAX_UNITS); assert.ok(s.startsWith(c));
    }
    assert.equal(normalizeChat('a'.repeat(79) + '\ud800' + 'b'), 'a'.repeat(79) + 'b');
  });
});

// ---------------- src/chat.js：性質テスト（seed 固定） ----------------
test('性質：clipChat は上限内・先頭一致・冪等・書記素境界・最大（2000 文字列）', () => {
  const r = rng(20261007);
  for (let i = 0; i < 2000; i++) {
    const s = i % 5 === 0 ? randRaw(r, 80) : randStr(r, 45);
    const c = clipChat(s);
    const label = JSON.stringify(hex(s));
    assert.ok(nfcUnits(c) <= CHAT_MAX_UNITS, 'units ' + label);
    assert.ok(s.startsWith(c), 'prefix ' + label);
    assert.equal(clipChat(c), c, '冪等 ' + label);
    if (nfcUnits(s) <= CHAT_MAX_UNITS) assert.equal(c, s, '上限内はそのまま ' + label);
    else {
      // 書記素の途中で切れていない（切れ目が s の書記素の境界にある）。最大：次の書記素を足すと超える
      const gs = gr(s); let n = 0, k = 0, acc = '';
      for (const g of gs) { if (acc.length >= c.length) break; acc += g; k++; n += nfcUnits(g); }
      assert.equal(acc, c, '書記素の境界 ' + label);
      assert.ok(nfcUnits(c) + nfcUnits(gs[k]) > CHAT_MAX_UNITS, '最大 ' + label);
    }
    // 切った結果は normalizeChat を通る（空になるときだけ null）。正規化は幅を増やさない
    // （例外：U+0958–095F・U+FB1D など「合成除外」の文字は NFC で 2 文字に分かれて幅が増える。下の専用テストで扱う）
    const n = normalizeChat(c);
    if (chatUnits(c.normalize('NFC')) <= CHAT_MAX_UNITS) {
      if (n === null) assert.ok(normalizeChat(c + 'x')?.endsWith('x'), '見た目が空でないのに null ' + label);
      else assert.ok(chatUnits(n) <= CHAT_MAX_UNITS, label);
    }
  }
});

test('性質：normalizeChat は冪等・NFC・制御文字/方向制御/ゼロ幅が残らない（ZWJ は絵文字の間だけ）（4000 文字列）', () => {
  const r = rng(77);
  let nonNull = 0;
  for (let i = 0; i < 4000; i++) {
    const s = i % 3 === 0 ? randRaw(r, 40) : randStr(r, 14);
    const n = normalizeChat(s);
    const label = JSON.stringify(hex(s));
    if (n === null) continue;
    nonNull++;
    assert.equal(normalizeChat(n), n, '冪等 ' + label);
    assert.equal(n, n.normalize('NFC'), 'NFC ' + label);
    assert.ok(!FORBIDDEN.test(n), `残ってはいけない文字 ${label} → ${JSON.stringify(hex(n))}`);
    assert.ok(!/[\t\n\v\f\r\u0085\u00a0 \u2000-\u200a\u2028\u2029\u202f\u205f　]/u.test(n), '空白類 ' + label);
    assert.ok(!/ {2}/.test(n) && n === n.trim(), '空白 ' + label);
    assert.ok(n.length > 0 && chatUnits(n) <= CHAT_MAX_UNITS, '長さ ' + label);
    assert.equal(n, n.toWellFormed(), '孤立サロゲート ' + label);
    const cps = [...n];
    cps.forEach((c, k) => {
      if (c !== ZWJ) return;
      const p = cps[k - 1], q = cps[k + 1];
      assert.ok(p && q && PICTO.test(q) && (PICTO.test(p) || p === VS16 || /^[\u{1F3FB}-\u{1F3FF}]$/u.test(p)), 'ZWJ が絵文字の間にない ' + label);
    });
  }
  assert.ok(nonNull > 1500, '非 null が少なすぎてテストにならない ' + nonNull);
});

test('性質：見えない文字は挿入しても結果を変えない（ASCII の文）', () => {
  const r = rng(5);
  const inv = [0x200b, 0x200c, 0x200e, 0x200f, 0x202a, 0x202e, 0x2060, 0x2066, 0xfeff, 0xad, 0x34f, 0x61c, 0x3164, 0x2800, 0x7, 0x1b, 0x7f, 0x9f].map(ch);
  for (let i = 0; i < 300; i++) {
    const words = Array.from({ length: 1 + (r() * 6 | 0) }, () => 'abcxyz019'.slice(r() * 5 | 0, 5 + (r() * 3 | 0)));
    const clean = words.join(' ');
    let dirty = '';
    for (const c of clean) dirty += c + (r() < 0.3 ? inv[r() * inv.length | 0] : '');
    assert.equal(normalizeChat(dirty), clean);
  }
});

test('性質：非文字列は必ず null（正規化は例外を投げない）', () => {
  for (const v of [undefined, null, 0, 1, NaN, true, false, {}, [], ['a'], { toString: () => 'a' }, Symbol('x'), 10n, () => 'a', new String('a')]) assert.equal(normalizeChat(v), null, String(typeof v));
  const r = rng(9);
  for (let i = 0; i < 200; i++) assert.doesNotThrow(() => normalizeChat(randRaw(r, 200)));
});

test('XSS 的な文字列は正規化で変えない（エスケープは表示側の責務）', () => {
  for (const s of ['<script>alert(1)</script>', '&amp; &lt;b&gt;', '"><img src=x onerror=alert(1)>', "' OR 1=1 --", '${7*7} {{7*7}}', '`x`', '\\u0000 \\n', 'javascript:alert(1)', '</textarea>', '&#x3c;', '%3Cscript%3E', 'a\\b', '<>&"\'/']) {
    assert.equal(normalizeChat(s), s, s);
    assert.equal(clipChat(s), s);
  }
  assert.equal(normalizeChat('<scr' + ch(0x200b) + 'ipt>'), '<script>');            // 見えない文字を挟んだ偽装は 1 つにつながる（表示側がエスケープする前提）
  assert.equal(normalizeChat('<  b  >'), '< b >');
  assert.equal(normalizeChat('<script>alert("' + 'x'.repeat(80) + '")</script>'), null);   // 上限は効く
});

// ---------------- rules.js の postChat ----------------
function deepFreeze(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; }
function started(kind, n = 3, seed = 7) {
  let r = createRoom({ id: 'r', code: '123456', kind, uid: U(1), name: 'A', config: { ...DEFAULT_CONFIG, players: n }, now: 0 });
  for (let i = 2; i <= n; i++) r = joinRoom(r, U(i), String.fromCharCode(64 + i), i, rng(seed));
  return r;
}

test('postChat：間隔の境界（ちょうど 1000ms は送れる・999ms は too_fast・lastAt が未来・0）', () => {
  const r = deepFreeze(started('private'));
  assert.equal(postChat(r, U(1), 'a', 4000, 5000).text, 'a');          // 1000
  assert.throws(() => postChat(r, U(1), 'a', 4001, 5000), code('too_fast'));   // 999
  assert.equal(postChat(r, U(1), 'a', 0, 1000).text, 'a');             // lastAt = 0 も「発言あり」
  assert.throws(() => postChat(r, U(1), 'a', 0, 999), code('too_fast'));
  assert.throws(() => postChat(r, U(1), 'a', 6000, 5000), code('too_fast'));   // 時計が戻った（lastAt が未来）
  assert.equal(postChat(r, U(1), 'a', undefined, 0).text, 'a');        // undefined は発言なし扱い
  assert.equal(postChat(r, U(1), 'a', null, 0).text, 'a');
  assert.equal(postChat(r, U(1), 'a', 4000.5, 5000.5).text, 'a');      // pg の float8
  assert.throws(() => postChat(r, U(1), 'a', 4000.6, 5000.5), code('too_fast'));
});

test('postChat：入口の検証（非メンバー・free・未開始・cancelled・終局後・text の型）と room を変えないこと', () => {
  const r = deepFreeze(started('private'));
  for (const uid of [U(9), 'x', '', undefined, null, 1, {}]) assert.throws(() => postChat(r, uid, 'hi', null, 10), code('not_found'), String(uid));
  assert.throws(() => postChat(deepFreeze(started('free')), U(1), 'hi', null, 10), code('chat_closed'));
  assert.throws(() => postChat(deepFreeze(started('free', 2)), U(1), 'hi', null, 10), code('chat_closed'));
  const waiting = createRoom({ id: 'w', code: '000001', kind: 'private', uid: U(1), name: 'A', config: { ...DEFAULT_CONFIG, players: 3 }, now: 0 });
  assert.throws(() => postChat(deepFreeze({ ...waiting }), U(1), 'hi', null, 10), code('chat_closed'));
  assert.throws(() => postChat({ ...waiting, status: 'cancelled' }, U(1), 'hi', null, 10), code('chat_closed'));      // 開始前に中止された部屋
  for (const t of [42, null, undefined, {}, [], ['hi'], true, 0, NaN, new String('hi'), Symbol.iterator.description]) {
    if (typeof t === 'string') continue;
    assert.throws(() => postChat(r, U(1), t, null, 10), code('malformed'), String(t));
  }
  // 終局後（finished / cancelled）・開始後に中止された部屋でも送れる。送れる状態では何も変えない
  const two = started('private', 2);
  const fin = deepFreeze(leaveRoom(two, U(1), 100).room);
  assert.equal(fin.status, 'finished');
  for (const st of ['finished', 'cancelled']) {
    const room = deepFreeze({ ...fin, status: st });
    for (const u of [U(1), U(2)]) assert.equal(postChat(room, u, 'gg', null, 200).text, 'gg', st);
    assert.throws(() => postChat(room, U(9), 'gg', null, 200), code('not_found'));
  }
  const snap = structuredClone(fin);
  postChat(fin, U(2), '  ok  ', 100, 5000);
  assert.deepEqual(fin, snap);
});

test('postChat：席は開始後の席順（members の添字）。left / out の席も席のまま送れる（現状の仕様）', () => {
  const r = started('private', 3);
  r.members.forEach((u, i) => assert.equal(postChat(r, u, 'hi', null, 10).seat, i));
  // 1 人退出（left）。ゲームは続く
  const l = leaveRoom(r, r.members[1], 100).room;
  assert.equal(l.status, 'running'); assert.equal(l.state.players[1].status, 'left');
  assert.deepEqual(postChat(l, r.members[1], 'bye', null, 200), { seat: 1, text: 'bye' });
  assert.deepEqual(postChat(l, r.members[0], 'hi', null, 200), { seat: 0, text: 'hi' });
  // sitout（離席）の席
  const live = l.state.hand ? l : r;
  const seat = live.state.hand?.toAct;
  if (seat != null && live.status === 'running') {
    const o = applyRequest(live, live.members[seat === 0 ? 2 : seat], { op: 'sitout' }, 300).room;
    assert.equal(postChat(o, o.members[2], 'x', null, 400).seat, 2);
  }
});

test('postChat：エラーの優先順位 not_found > chat_closed > malformed > too_fast', () => {
  const free = started('free'), priv = started('private');
  assert.throws(() => postChat(free, U(9), '', 5, 6), code('not_found'));
  assert.throws(() => postChat(free, U(1), '', 5, 6), code('chat_closed'));
  assert.throws(() => postChat(priv, U(1), '', 5, 6), code('malformed'));
  assert.throws(() => postChat(priv, U(1), 'a', 5, 6), code('too_fast'));
});

test('postChat：返す text は normalizeChat と同じ・上限ちょうどは通り 1 超えは malformed', () => {
  const r = started('private');
  const r1 = rng(31);
  for (let i = 0; i < 300; i++) {
    const s = randStr(r1, 12), n = normalizeChat(s);
    if (n === null) assert.throws(() => postChat(r, U(1), s, null, 10), code('malformed'));
    else assert.equal(postChat(r, U(1), s, null, 10).text, n);
  }
  assert.equal(postChat(r, U(1), 'a'.repeat(80), null, 10).text.length, 80);
  assert.throws(() => postChat(r, U(1), 'a'.repeat(81), null, 10), code('malformed'));
  assert.equal(postChat(r, U(1), '😀'.repeat(40), null, 10).text, '😀'.repeat(40));
  assert.throws(() => postChat(r, U(1), '😀'.repeat(41), null, 10), code('malformed'));
});

// ---------------- handler.js の op chat ----------------
describe('HTTP：op chat（handler）', () => {
  const calls = [];
  let behave = () => ({ now: 1, msg: { seq: 1, seat: 0, text: 'x', at: 1 } });
  const errors = [];
  const h = createHandler({
    allowedOrigins: ['https://app.example'],
    verifyToken: async t => { if (t === 'down') { const e = new Error('x'); e.unavailable = true; throw e; } return t === 'good' ? U(1) : null; },
    chat: async (...a) => { calls.push(a); return behave(...a); },
    logError: (...a) => errors.push(a),
  });
  const R = U(9);
  const req = (body, { token = 'good', method = 'POST', headers = {}, raw } = {}) => h(new Request('https://f/', {
    method, headers: { Authorization: `Bearer ${token}`, Origin: 'https://app.example', ...headers }, body: method === 'GET' ? undefined : raw ?? JSON.stringify(body),
  }));
  const bodyOfBytes = n => {                       // 本文がちょうど n バイトの op chat
    const base = JSON.stringify({ op: 'chat', room: R, text: '' }).length;
    return JSON.stringify({ op: 'chat', room: R, text: 'a'.repeat(n - base) });
  };
  const reset = () => { calls.length = 0; errors.length = 0; behave = () => ({ now: 1, msg: { seq: 1, seat: 0, text: 'x', at: 1 } }); };

  test('room が無い・UUID でない・text が文字列でない → 422 malformed で deps を呼ばない', async () => {
    reset();
    const bad = [{ op: 'chat' }, { op: 'chat', text: 'hi' }, { op: 'chat', room: null, text: 'hi' }, { op: 'chat', room: 123, text: 'hi' }, { op: 'chat', room: [R], text: 'hi' },
      { op: 'chat', room: R + '\n', text: 'hi' }, { op: 'chat', room: ' ' + R, text: 'hi' }, { op: 'chat', room: R.slice(1), text: 'hi' }, { op: 'chat', room: R.replace(/0/g, 'g'), text: 'hi' }, { op: 'chat', room: '', text: 'hi' },
      { op: 'chat', room: R, text: 123 }, { op: 'chat', room: R, text: 0 }, { op: 'chat', room: R, text: false }, { op: 'chat', room: R, text: {} }, { op: 'chat', room: R, text: { text: 'hi' } }, { op: 'chat', room: R, text: [] },
      { op: 'chat', room: R, text: null }, { op: 'chat', room: R }, { op: 'CHAT', room: R, text: 'hi' }, { op: 'chat ', room: R, text: 'hi' }];
    for (const b of bad) { const r = await req(b); assert.equal(r.status, 422, JSON.stringify(b)); assert.deepEqual(await r.json(), { error: 'malformed' }); }
    for (const raw of ['', 'not json', '[]', 'null', '"chat"', '123', 'true', '{', '\ud800']) assert.equal((await req(null, { raw })).status, 422, raw);
    assert.equal(calls.length, 0);
  });

  test('UUID は大文字でも通る・空 text や巨大でない長い text は deps に渡る（検証は postChat の責務）', async () => {
    reset();
    assert.equal((await req({ op: 'chat', room: R.toUpperCase(), text: 'hi' })).status, 200);
    assert.equal((await req({ op: 'chat', room: R, text: '' })).status, 200);
    assert.equal((await req({ op: 'chat', room: R, text: 'x'.repeat(1000) })).status, 200);
    assert.equal((await req({ op: 'chat', room: R, text: '\ud800\u0000' })).status, 200);    // 孤立サロゲートは JSON でも通り、deps（postChat）が消す
    assert.deepEqual(calls.map(c => c[0]), [U(1), U(1), U(1), U(1)]);
    assert.equal(calls[0][1], R.toUpperCase());
    assert.equal(calls[3][2], '\ud800\u0000');
  });

  test('本文の大きさ：ちょうど MAX_BODY バイトは通り、1 バイト超えは 422（text が巨大・全角・Content-Length 先読み）', async () => {
    reset();
    assert.equal(MAX_BODY, 4096);
    for (const n of [MAX_BODY - 1, MAX_BODY]) { const raw = bodyOfBytes(n); assert.equal(new TextEncoder().encode(raw).length, n); assert.equal((await req(null, { raw })).status, 200, String(n)); }
    for (const n of [MAX_BODY + 1, MAX_BODY * 4]) assert.equal((await req(null, { raw: bodyOfBytes(n) })).status, 422, String(n));
    assert.equal(calls.length, 2);
    // 全角は 3 バイト：1400 文字は 4200 バイトで超える。1300 文字は通る（上限 40 字を超える長さの判定は postChat）
    assert.equal((await req({ op: 'chat', room: R, text: 'あ'.repeat(1400) })).status, 422);
    assert.equal((await req({ op: 'chat', room: R, text: 'あ'.repeat(1300) })).status, 200);
    // 絵文字は 4 バイト、エスケープされた JSON（\uXXXX）は 6 バイトとして数える
    assert.equal((await req(null, { raw: JSON.stringify({ op: 'chat', room: R, text: '😀'.repeat(1100) }) })).status, 422);
    assert.equal((await req(null, { raw: `{"op":"chat","room":"${R}","text":"${'\\u3042'.repeat(700)}"}` })).status, 422);
    // Content-Length を偽っても超えていれば 422（本文は読まない）
    assert.equal((await req({ op: 'chat', room: R, text: 'hi' }, { headers: { 'Content-Length': String(MAX_BODY + 1) } })).status, 422);
  });

  test('deps.chat の MoveError → STATUS（全コード）と extra', async () => {
    reset();
    const want = { too_fast: 429, chat_closed: 409, chat_full: 409, not_found: 404, malformed: 422, busy: 409, stale: 409, no_profile: 403, room_closed: 409, illegal: 422, never_heard_of_it: 422 };
    for (const [c, s] of Object.entries(want)) {
      behave = () => { throw new MoveError(c); };
      const r = await req({ op: 'chat', room: R, text: 'hi' });
      assert.equal(r.status, s, c); assert.deepEqual(await r.json(), { error: c });
      assert.equal(r.headers.get('Cache-Control'), 'no-store');
    }
    behave = () => { throw new MoveError('too_fast', { retryAfter: 500 }); };
    const r = await req({ op: 'chat', room: R, text: 'hi' });
    assert.equal(r.status, 429); assert.deepEqual(await r.json(), { error: 'too_fast', retryAfter: 500 });
    assert.equal(STATUS.too_fast, 429); assert.equal(STATUS.chat_closed, 409); assert.equal(STATUS.chat_full, 409);
    assert.equal(errors.length, 0);
  });

  test('MoveError 以外の例外は 500 internal（メッセージを漏らさず logError に渡す）', async () => {
    reset();
    behave = () => { throw new Error('password=hunter2 at pg://secret'); };
    const r = await req({ op: 'chat', room: R, text: 'hi' });
    assert.equal(r.status, 500);
    const t = await r.text(); assert.deepEqual(JSON.parse(t), { error: 'internal' }); assert.ok(!/hunter2|secret/.test(t));
    assert.equal(errors.length, 1);
    behave = () => { throw 'string thrown'; };
    assert.equal((await req({ op: 'chat', room: R, text: 'hi' })).status, 500);
    behave = () => { throw Object.assign(new Error('x'), { code: 'too_fast' }); };      // MoveError ではない（instanceof で見る）
    assert.equal((await req({ op: 'chat', room: R, text: 'hi' })).status, 500);
  });

  test('認証・メソッド・CORS：トークン無し/不正 401、検証基盤の障害 503、GET 405、OPTIONS 204、許可外の Origin に ACAO を付けない', async () => {
    reset();
    const b = { op: 'chat', room: R, text: 'hi' };
    assert.equal((await req(b, { token: 'bad' })).status, 401);
    assert.equal((await req(b, { token: 'down' })).status, 503);
    assert.equal((await h(new Request('https://f/', { method: 'POST', headers: { Origin: 'https://app.example' }, body: JSON.stringify(b) }))).status, 401);
    assert.equal((await req(b, { method: 'GET' })).status, 405);
    assert.equal((await req(b, { method: 'OPTIONS' })).status, 204);
    const ev = await req(b, { headers: { Origin: 'https://evil.example' } });
    assert.equal(ev.status, 200); assert.equal(ev.headers.get('Access-Control-Allow-Origin'), null);
    assert.equal(calls.length, 1);
    assert.equal((await req(b, { token: 'good' })).headers.get('Access-Control-Allow-Origin'), 'https://app.example');
  });

  test('成功の本文はそのまま返す（正規化は deps の責務で handler は触らない）', async () => {
    reset();
    behave = (uid, room, text) => ({ now: 5, msg: { seq: 2, seat: 1, text, at: 5 } });
    const r = await req({ op: 'chat', room: R, text: '  <b>&amp;  ' });
    assert.deepEqual(await r.json(), { now: 5, msg: { seq: 2, seat: 1, text: '  <b>&amp;  ', at: 5 } });
  });
});

// ---------------- マイグレーション（静的） ----------------
test('マイグレーション（静的）：追加のみ・ver に触らない・room_poll は同じ引数・chat_seq は not null default 0・上限 200 件', () => {
  const dir = new URL('../db/migrations/', import.meta.url);
  const files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  // 追加のみ：チャットは初期化・修正の後ろ（後ろに再戦などが足されるのは良い）
  assert.ok(files.indexOf('20261007000000_chat.sql') > files.indexOf('20261006000000_hardening.sql'), 'チャットは初期化・修正の後ろ');
  const sql = readFileSync(new URL('20261007000000_chat.sql', dir), 'utf8');
  assert.match(sql, /add column chat_seq int not null default 0/);
  assert.match(sql, /create or replace function public\.room_poll\(p_room uuid, p_ver int\)/);
  assert.match(sql, /create or replace function public\.room_chat\(p_room uuid, p_after int\)/);
  assert.match(sql, /order by seq desc limit 200/);
  assert.match(sql, /security definer set search_path = ''/);
  assert.match(sql, /primary key \(room, seq\)/);
  assert.match(sql, /on delete cascade/);
  assert.doesNotMatch(sql.replace(/--.*$/gm, ''), /\bver\s*=|set ver|ver\s*\+/i, 'ver を更新しない');
  assert.doesNotMatch(sql, /drop (table|function|column)/i);
  assert.match(sql, /revoke all on table public\.room_chat from public, anonymous, authenticated/);
  assert.doesNotMatch(sql, /grant (select|insert|all)[^;]*room_chat\b[^;(]*to/i);
});

// ---------------- src/fakeNet.js（node に location / window を置いて import する） ----------------
describe('fakeNet：op chat → room_chat → room_poll.chat の整合（時計は Date だけモックする）', () => {
  let fk, F;                                  // fk = モジュール、F = window.__fake
  const T0 = Date.UTC(2026, 9, 7, 12, 0, 0);
  const cfg = n => ({ ...DEFAULT_CONFIG, players: n });
  const failsWith = async (p, c) => { try { await p; } catch (e) { assert.equal(e.code, c); if (e.data) assert.equal(e.data.error, c); return e; } assert.fail('失敗するはず：' + c); };
  const roomOf = id => F.rooms.get(id);
  // 自分（ME = U(1)）の 2 人卓を作って、Bot が入って開始するところまで進める
  async function startPrivate() {
    const c = await fk.game({ op: 'create', kind: 'private', config: cfg(2) });
    assert.equal(c.view.status, 'waiting');
    return c.room;
  }
  const bots = id => [...roomOf(id).bots];
  const seatOfMe = id => roomOf(id).room.members.indexOf(U(1));

  before(async () => {
    mock.timers.enable({ apis: ['Date'], now: T0 });
    globalThis.location = { search: '?wait=1000&idle' };
    globalThis.window = {};
    fk = await import('../src/fakeNet.js');
    F = globalThis.window.__fake;
    assert.ok(F?.rooms instanceof Map, 'window.__fake が公開されている');
  });
  after(() => { mock.timers.reset(); delete globalThis.location; delete globalThis.window; });

  test('待機中は chat_closed、開始後に送れる。seq・seat・at・正規化・自分の席。room_poll.chat と room_chat が一致する', async () => {
    const id = await startPrivate();
    await failsWith(fk.game({ op: 'chat', room: id, text: 'hi' }), 'chat_closed');
    assert.equal((await fk.rpc('room_poll', { p_room: id, p_ver: -1 })).chat, 0);
    assert.deepEqual(await fk.rpc('room_chat', { p_room: id, p_after: 0 }), []);
    mock.timers.tick(2100);                                  // Bot が入って開始（nextJoin = now + WAIT * 2）
    const p0 = await fk.rpc('room_poll', { p_room: id, p_ver: -1 });
    assert.equal(p0.view.status, 'running'); assert.equal(p0.chat, 0);
    const me = seatOfMe(id);
    const r1 = await fk.game({ op: 'chat', room: id, text: '  よろしく\n ね ' });
    assert.deepEqual(r1.msg, { seq: 1, seat: me, text: 'よろしく ね', at: Date.now() }); assert.equal(r1.now, Date.now());
    assert.equal((await fk.rpc('room_poll', { p_room: id, p_ver: p0.ver })).chat, 1);
    assert.equal((await fk.rpc('room_poll', { p_room: id, p_ver: p0.ver })).view, null, 'チャットで ver は上がらない');
    assert.deepEqual(await fk.rpc('room_chat', { p_room: id, p_after: 0 }), [r1.msg]);
    assert.deepEqual(await fk.rpc('room_chat', { p_room: id, p_after: 1 }), []);
    assert.deepEqual(await fk.rpc('room_chat', { p_room: id, p_after: -5 }), [r1.msg]);
    await fk.game({ op: 'leave', room: id });
  });

  test('間隔：999ms は too_fast（429 相当）、ちょうど 1000ms は送れる。別の席は待たなくてよい。too_fast は件数を増やさない', async () => {
    const id = await startPrivate();
    mock.timers.tick(2100);
    const a = await fk.game({ op: 'chat', room: id, text: 'a' });
    mock.timers.tick(999);
    const e = await failsWith(fk.game({ op: 'chat', room: id, text: 'b' }), 'too_fast'); assert.equal(e.status, 429);
    const n = roomOf(id).chat.length;
    mock.timers.tick(1);
    const b = await fk.game({ op: 'chat', room: id, text: 'b' });
    assert.equal(b.msg.seq, roomOf(id).chat.length); assert.ok(b.msg.seq > a.msg.seq); assert.equal(roomOf(id).chat.length, n + 1);
    const p = await fk.rpc('room_poll', { p_room: id, p_ver: 0 });
    assert.equal(p.chat, roomOf(id).chat.length);
    const log = await fk.rpc('room_chat', { p_room: id, p_after: 0 });
    assert.deepEqual(log.map(m => m.seq), log.map((m, i) => i + 1), 'seq は 1 から連番');
    assert.deepEqual(log.filter(m => m.seat === seatOfMe(id)).map(m => m.text), ['a', 'b']);
    await fk.game({ op: 'leave', room: id });
  });

  test('入力検証：text が文字列でない・空・上限超えは malformed、room 不明・非メンバーは not_found', async () => {
    const id = await startPrivate();
    mock.timers.tick(2100);
    for (const t of [123, null, undefined, {}, ['hi'], '', '   ', ch(0x200b), 'a'.repeat(81), 'あ'.repeat(41)]) await failsWith(fk.game({ op: 'chat', room: id, text: t }), 'malformed');
    assert.equal(roomOf(id).chatLast[seatOfMe(id)] ?? null, null, '失敗した発言は間隔を進めない');
    assert.equal((await fk.game({ op: 'chat', room: id, text: 'a'.repeat(80) })).msg.text.length, 80);
    await failsWith(fk.game({ op: 'chat', room: randomUUID(), text: 'hi' }), 'not_found');
    await failsWith(fk.rpc('room_chat', { p_room: randomUUID(), p_after: 0 }), 'not_found');
    await failsWith(fk.rpc('room_poll', { p_room: randomUUID(), p_ver: 0 }), 'not_found');
    const other = [...F.rooms.values()].find(R => R.room.kind === 'free' && !R.room.members.includes(U(1)));
    await failsWith(fk.game({ op: 'chat', room: other.room.id, text: 'hi' }), 'not_found');
    await failsWith(fk.rpc('room_chat', { p_room: other.room.id, p_after: 0 }), 'not_found');
    await fk.game({ op: 'leave', room: id });
  });

  test('FREE MATCH：chat は chat_closed、room_chat は []、room_poll.chat は 0', async () => {
    const c = await fk.game({ op: 'create', kind: 'free', config: cfg(2) });
    await failsWith(fk.game({ op: 'chat', room: c.room, text: 'hi' }), 'chat_closed');
    mock.timers.tick(2100);
    assert.equal((await fk.rpc('room_poll', { p_room: c.room, p_ver: -1 })).view.status, 'running');
    await failsWith(fk.game({ op: 'chat', room: c.room, text: 'hi' }), 'chat_closed');
    assert.deepEqual(await fk.rpc('room_chat', { p_room: c.room, p_after: 0 }), []);
    assert.equal((await fk.rpc('room_poll', { p_room: c.room, p_ver: -1 })).chat, 0);
    mock.timers.tick(120_000);                               // Bot は FREE MATCH では喋らない
    await fk.rpc('room_poll', { p_room: c.room, p_ver: 0 });
    assert.equal(roomOf(c.room).chat.length, 0);
    await fk.game({ op: 'leave', room: c.room });
  });

  test('終局後（leave で finished）も送れる。件数の上限（chat_full）は postChat のあとに見る。room_chat は新しい方から 200 件を古い順', async () => {
    const id = await startPrivate();
    mock.timers.tick(2100);
    const R = roomOf(id);
    for (let i = 1; i <= 250; i++) R.chat.push({ seq: i, seat: 1 - seatOfMe(id), text: 'm' + i, at: T0 });
    assert.equal((await fk.rpc('room_poll', { p_room: id, p_ver: 0 })).chat, 250);
    const last = await fk.rpc('room_chat', { p_room: id, p_after: 0 });
    assert.equal(last.length, 200); assert.equal(last[0].seq, 51); assert.equal(last.at(-1).seq, 250);
    assert.deepEqual((await fk.rpc('room_chat', { p_room: id, p_after: 248 })).map(m => m.seq), [249, 250]);
    R.chat.length = CHAT_ROOM_MAX;
    await failsWith(fk.game({ op: 'chat', room: id, text: 'full' }), 'chat_full');
    await failsWith(fk.game({ op: 'chat', room: id, text: '' }), 'malformed');           // 先に postChat（不正は malformed が優先）
    R.chat.length = 10;
    await fk.game({ op: 'leave', room: id });
    assert.equal(R.room.status, 'finished');
    assert.equal((await fk.game({ op: 'chat', room: id, text: 'gg' })).msg.text, 'gg');
    assert.equal((await fk.rpc('room_poll', { p_room: id, p_ver: 0 })).chat, 11);
  });

  test('結果はコピー（呼び出し側が書き換えても内部の履歴は変わらない）', async () => {
    const id = await startPrivate();
    mock.timers.tick(2100);
    const m = (await fk.game({ op: 'chat', room: id, text: 'copy' })).msg;
    m.text = 'tampered';
    const log = await fk.rpc('room_chat', { p_room: id, p_after: 0 }); log[0].text = 'tampered too';
    assert.equal(roomOf(id).chat.find(x => x.seat === seatOfMe(id)).text, 'copy');
    await fk.game({ op: 'leave', room: id });
  });

  test('Bot は PRIVATE の卓だけで喋り、連投しない（同じ席の発言は 1 秒以上あく・上限の幅以内）', async () => {
    const id = await startPrivate();
    mock.timers.tick(2100);
    for (let i = 0; i < 40; i++) { mock.timers.tick(5000); await fk.rpc('room_poll', { p_room: id, p_ver: 0 }); }   // 200 秒ぶん
    const log = roomOf(id).chat;
    assert.ok(log.length >= 1, 'Bot が 1 回は喋る（開始の挨拶）');
    const lastBySeat = {};
    for (const m of log) {
      assert.ok(bots(id).includes(roomOf(id).room.members[m.seat]));
      assert.equal(normalizeChat(m.text), m.text); assert.ok(chatUnits(m.text) <= CHAT_MAX_UNITS);
      if (lastBySeat[m.seat] != null) assert.ok(m.at - lastBySeat[m.seat] >= 1000, '連投');
      lastBySeat[m.seat] = m.at;
    }
    assert.deepEqual(log.map(m => m.seq), log.map((m, i) => i + 1));
    await fk.game({ op: 'leave', room: id });
  });
});

// ---------------- DB の結合テスト ----------------
const DBURL = process.env.TEST_DATABASE_URL;
describe('DB：チャットの QA（専用 DB）', { skip: !DBURL && 'TEST_DATABASE_URL が無い' }, () => {
  let admin, pool, dbName;
  const urlFor = name => { const u = new URL(DBURL); u.pathname = '/' + name; return u.toString(); };
  async function as(role, claims, sql, args = []) {
    const c = await pool.connect();
    try {
      await c.query('begin');
      if (claims !== undefined) await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
      await c.query(`set local role ${role}`);
      const r = await c.query(sql, args);
      await c.query('commit');
      return r.rows;
    } catch (e) { await c.query('rollback').catch(() => {}); throw e; } finally { c.release(); }
  }
  const rpc = (uid, fn, args = []) => as('authenticated', { sub: uid, role: 'authenticated' }, `select public.${fn}(${args.map((_, i) => '$' + (i + 1)).join(',')}) as x`, args).then(r => r[0].x);
  async function newUsers(n) {
    const us = Array.from({ length: n }, () => randomUUID());
    for (const u of us) { await pool.query('insert into neon_auth."user"(id) values($1)', [u]); await rpc(u, 'me'); }
    return us;
  }
  const rejectsCode = (p, c) => assert.rejects(p, e => e.code === c || new RegExp(c).test(e.message));
  const age = (room, ms = 2000) => pool.query(`update public.room_chat set created_at = created_at - make_interval(secs => $2::float8 / 1000) where room = $1`, [room, ms]);
  // 2〜3 人の PRIVATE の卓を開始まで作る
  async function table(n) {
    const us = await newUsers(n), db = makeDb(pool, { rnd: rng(11) });
    const a = await db.create(us[0], 'private', { ...DEFAULT_CONFIG, players: n });
    for (let i = 1; i < n; i++) await db.join(us[i], a.view.room.code);
    return { us, db, room: a.room };
  }

  before(async () => {
    const pg = (await import('pg')).default;
    admin = new pg.Pool({ connectionString: DBURL, max: 2 });
    admin.on('error', () => {});
    dbName = `qa_chat_${process.pid}_${Date.now()}`;
    await admin.query(`create database ${dbName} template template0 encoding 'UTF8'`);
    pool = new pg.Pool({ connectionString: urlFor(dbName), max: 12 });
    pool.on('error', () => {});
    await pool.query(`do $$ begin
      if not exists (select from pg_roles where rolname = 'anonymous') then create role anonymous; end if;
      if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated; end if; end $$`);
    await pool.query('create schema neon_auth; create table neon_auth."user"(id uuid primary key, email text not null unique, name text not null, image text); create table neon_auth.account(id uuid primary key default gen_random_uuid(), "userId" uuid not null references neon_auth."user"(id) on delete cascade, "idToken" text, "accessToken" text, "refreshToken" text); create table neon_auth.session(id uuid primary key default gen_random_uuid(), "userId" uuid not null references neon_auth."user"(id) on delete cascade, "ipAddress" text, "userAgent" text)');
    const dir = new URL('../db/migrations/', import.meta.url);
    for (const f of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) await pool.query(readFileSync(new URL(f, dir), 'utf8'));
  });
  after(async () => {
    try { await pool?.end(); } catch { /* ignore */ }
    try { if (admin && dbName) await admin.query(`drop database if exists ${dbName} with (force)`); } finally { await admin?.end(); }
  });

  test('文字：NUL・孤立サロゲート・ZWJ 列・国旗・NFD は正規化してから保存される（DB のエラーにならない）。読み戻しは同じ', async () => {
    const { us, db, room } = await table(2);
    const texts = [['a' + ch(0) + 'b', 'ab'], ['x\ud800y', 'xy'], [FAMILY, FAMILY], [FLAG + KEYCAP, FLAG + KEYCAP], [NFD_GA.repeat(40), 'が'.repeat(40)], ['<script>alert(1)</script>', '<script>alert(1)</script>'],
      ["'; drop table rooms; --", "'; drop table rooms; --"], ['\\u0000 \\', '\\u0000 \\'], ['a'.repeat(80), 'a'.repeat(80)], ['😀'.repeat(40), '😀'.repeat(40)], [ENGLAND, ENGLAND]];
    const got = [];
    for (const [t, want] of texts) {
      const m = await db.chat(us[0], room, t);
      assert.equal(m.msg.text, want, JSON.stringify(hex(t)));
      got.push(want); await age(room);
    }
    const log = await rpc(us[1], 'room_chat', [room, 0]);
    assert.deepEqual(log.map(m => m.text), got);
    const { rows } = await pool.query('select text from public.room_chat where room = $1 order by seq', [room]);
    assert.deepEqual(rows.map(x => x.text), got);
    for (const bad of ['', ' ', 'a'.repeat(81), ch(0), '\ud800', 'あ'.repeat(41), NFD_GA.repeat(41)]) await rejectsCode(db.chat(us[0], room, bad), 'malformed');
    for (const bad of [null, undefined, 42, {}, ['a']]) await rejectsCode(db.chat(us[0], room, bad), 'malformed');
    assert.equal((await pool.query('select chat_seq from public.rooms where id = $1', [room])).rows[0].chat_seq, texts.length, '失敗した発言は seq を進めない');
  });

  test('並行：同じ席の同時送信は 1 つだけ通り（too_fast）、別の席の同時送信は seq が重複しない', async () => {
    const { us, db, room } = await table(3);
    const same = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => db.chat(us[0], room, 'dup' + i)));
    assert.equal(same.filter(r => r.status === 'fulfilled').length, 1);
    assert.deepEqual(same.filter(r => r.status === 'rejected').map(r => r.reason.code), Array(5).fill('too_fast'));
    await age(room);
    const many = await Promise.allSettled([0, 1, 2].flatMap(s => [db.chat(us[s], room, 'p' + s)]));
    const okSeqs = many.filter(r => r.status === 'fulfilled').map(r => r.value.msg.seq).sort((a, b) => a - b);
    assert.ok(okSeqs.length >= 2 && new Set(okSeqs).size === okSeqs.length);
    const { rows } = await pool.query('select seq from public.room_chat where room = $1 order by seq', [room]);
    assert.deepEqual(rows.map(r => r.seq), rows.map((_, i) => i + 1), 'seq は欠けも重複もない');
    assert.equal((await pool.query('select chat_seq from public.rooms where id = $1', [room])).rows[0].chat_seq, rows.length);
    assert.equal((await rpc(us[1], 'room_poll', [room, 0])).chat, rows.length);
    // 同じ seat の別の発言が同時に来ても seq は一意（5 席ぶんを混ぜて追加）
    await age(room);
    const mixed = await Promise.allSettled(us.flatMap(u => [db.chat(u, room, 'q1'), db.chat(u, room, 'q2')]));
    const seqs = mixed.filter(r => r.status === 'fulfilled').map(r => r.value.msg.seq);
    assert.equal(seqs.length, 3, '席ごとに 1 つ'); assert.equal(new Set(seqs).size, 3);
  });

  test('チャットは ver・views・status・state を変えない（act が stale にならない）', async () => {
    const { us, db, room } = await table(2);
    const snap = async () => (await pool.query('select ver, views, status, state, started, members, ended_at, started_at from public.rooms where id = $1', [room])).rows[0];
    const before = await snap();
    await db.chat(us[0], room, 'hi'); await age(room); await db.chat(us[1], room, 'yo');
    assert.deepEqual(await snap(), before);
    const p = await rpc(us[0], 'room_poll', [room, -1]);
    assert.equal(p.ver, before.ver); assert.equal(p.chat, 2);
    assert.equal((await rpc(us[0], 'room_poll', [room, before.ver])).view, null);
    // 手番の人は、チャット前に読んだ ver のままでも act が通る（stale にならない）
    for (const u of us) {
      const v = (await rpc(u, 'room_poll', [room, -1])).view;
      if (v.hand?.toAct === v.seat) { await db.request(u, room, { op: 'act', ver: before.ver, move: { type: 'fold' } }); return; }
    }
    assert.fail('手番の席が見つからない');
  });

  test('room_chat の引数：null / 負 / 巨大な p_after・UUID でない p_room・非メンバー・退出した席は読める', async () => {
    const { us, db, room } = await table(3);
    await db.chat(us[0], room, 'one'); await db.chat(us[1], room, 'two');
    assert.equal((await rpc(us[2], 'room_chat', [room, null])).length, 2);
    assert.equal((await rpc(us[2], 'room_chat', [room, -100])).length, 2);
    assert.equal((await rpc(us[2], 'room_chat', [room, 2147483647])).length, 0);
    assert.equal((await rpc(us[2], 'room_chat', [room, 1])).length, 1);
    await assert.rejects(rpc(us[2], 'room_chat', ['not-a-uuid', 0]));
    await assert.rejects(pool.query('select 1').then(() => as('authenticated', { sub: us[2], role: 'authenticated' }, 'select public.room_chat($1, $2)', [room, 2147483648])));   // int の範囲外
    const [outsider] = await newUsers(1);
    await rejectsCode(rpc(outsider, 'room_chat', [room, 0]), 'not_found');
    await rejectsCode(db.chat(outsider, room, 'hi'), 'not_found');
    // 認証なし（sub 無し）は not_found か権限エラー
    await assert.rejects(as('authenticated', {}, 'select public.room_chat($1, 0)', [room]));
    // 退出（left）した席も、メンバーのままなので読める・送れる（仕様どおり）
    await db.leave(us[2], room);
    assert.equal((await rpc(us[2], 'room_chat', [room, 0])).length, 2);
    assert.equal((await db.chat(us[2], room, 'bye')).msg.text, 'bye');
  });

  test('中止された待機中の部屋・満席前の部屋・FREE MATCH は chat_closed。room_chat は [] / 0', async () => {
    const us = await newUsers(3), db = makeDb(pool, { rnd: rng(2) });
    const a = await db.create(us[0], 'private', { ...DEFAULT_CONFIG, players: 3 });
    await db.join(us[1], a.view.room.code);
    await rejectsCode(db.chat(us[1], a.room, 'hi'), 'chat_closed');          // 2/3 人
    assert.deepEqual(await rpc(us[1], 'room_chat', [a.room, 0]), []);
    await db.leave(us[0], a.room);                                           // ホストが抜けて中止
    assert.equal((await rpc(us[0], 'room_poll', [a.room, -1])).view.status, 'cancelled');
    await rejectsCode(db.chat(us[0], a.room, 'hi'), 'chat_closed');
    const f = await db.create(us[2], 'free', { ...DEFAULT_CONFIG, players: 2 });
    await rejectsCode(db.chat(us[2], f.room, 'hi'), 'chat_closed');
  });

  test('上限：chat_seq = 1999 から 2000 件目は通り、2001 件目は chat_full（chat_full でも seq は進まない）', async () => {
    const { us, db, room } = await table(2);
    await pool.query('update public.rooms set chat_seq = $2 where id = $1', [room, CHAT_ROOM_MAX - 1]);
    const m = await db.chat(us[0], room, 'last');
    assert.equal(m.msg.seq, CHAT_ROOM_MAX);
    await rejectsCode(db.chat(us[1], room, 'over'), 'chat_full');
    await rejectsCode(db.chat(us[1], room, ''), 'malformed');                 // 不正な文は chat_full より先
    assert.equal((await pool.query('select chat_seq from public.rooms where id = $1', [room])).rows[0].chat_seq, CHAT_ROOM_MAX);
    assert.equal((await rpc(us[1], 'room_poll', [room, 0])).chat, CHAT_ROOM_MAX);
    assert.deepEqual((await rpc(us[1], 'room_chat', [room, CHAT_ROOM_MAX - 1])).map(x => x.seq), [CHAT_ROOM_MAX]);
  });

  test('時刻：at は ms の整数で room_chat と一致・昇順。間隔は DB の時計（直前の発言が 1 秒より前なら通る）', async () => {
    const { us, db, room } = await table(2);
    const m1 = await db.chat(us[0], room, 'a');
    assert.ok(Number.isInteger(m1.msg.at));
    await rejectsCode(db.chat(us[0], room, 'b'), 'too_fast');
    await age(room, 1100);
    const m2 = await db.chat(us[0], room, 'b');
    const log = await rpc(us[1], 'room_chat', [room, 0]);
    assert.equal(log[0].at, m1.msg.at - 1100);                 // age() で 1100ms 過去にずらした
    assert.equal(log[1].at, m2.msg.at); assert.ok(log[0].at < log[1].at);
    // 別の席の発言は待たない
    assert.equal((await db.chat(us[1], room, 'c')).msg.seq, 3);
  });

  test('room_poll は従来の項目（ver / now / view）を保つ。待機中は view が席 0 の見え方で chat は 0', async () => {
    const us = await newUsers(2), db = makeDb(pool, { rnd: rng(5) });
    const a = await db.create(us[0], 'private', { ...DEFAULT_CONFIG, players: 2 });
    const p = await rpc(us[0], 'room_poll', [a.room, -1]);
    assert.deepEqual(Object.keys(p).sort(), ['chat', 'now', 'ver', 'view']);
    assert.equal(p.chat, 0); assert.equal(p.view.status, 'waiting'); assert.ok(Number.isInteger(p.now));
    assert.equal((await rpc(us[0], 'room_poll', [a.room, p.ver])).view, null);
    assert.equal((await rpc(us[0], 'room_poll', [a.room, null])).view.status, 'waiting');
  });
});
