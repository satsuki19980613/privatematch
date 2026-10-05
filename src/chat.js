// 卓のチャット（PRIVATE MATCH だけ）の文字の決まり。サーバー（server/game/rules.js の postChat）とブラウザ（入力欄）の両方が使う。
// 幅の単位：全角（East Asian Width の W / F 相当・絵文字）= 2、それ以外 = 1。コードポイント単位で数える。
export const CHAT_MAX_UNITS = 40;          // 全角 20 文字 / 半角 40 文字
export const CHAT_MIN_INTERVAL_MS = 1000;  // 同じ席の連投の間隔
export const CHAT_ROOM_MAX = 2000;         // 1 部屋の上限件数

// 全角（W / F）とみなすもの：ハングル字母（初声）、CJK の記号・部首・かな・注音・互換文字、CJK 統合漢字（拡張 A・B 以降も）、
// 彝文字、ハングル音節、互換漢字、縦書き・互換形、全角英数記号（FF01–FF60, FFE0–FFE6）、西夏文字・かな補助など、囲み表意文字補助。
const WIDE = /[\u1100-\u115F\u2329\u232A\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uA960-\uA97F\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF01-\uFF60\uFFE0-\uFFE6\u{16FE0}-\u{1B2FF}\u{1F200}-\u{1F2FF}\u{20000}-\u{3FFFD}]/u;
// 絵文字：絵文字の見た目が既定のもの（Emoji_Presentation）・肌の色、および U+1F000 以降の Extended_Pictographic（未割り当ての将来の絵文字を含む）。
// © ® ™ ↔ など文字の見た目が既定のものは 1（後ろに U+FE0F が付けば合わせて 2）
const EMOJI = /[\p{Emoji_Presentation}\p{Emoji_Modifier}]/u;
const PICTO = /\p{Extended_Pictographic}/u;

const unitOf = ch => {
  if (WIDE.test(ch) || EMOJI.test(ch)) return 2;
  return ch.codePointAt(0) >= 0x1F000 && PICTO.test(ch) ? 2 : 1;
};

/** 幅の単位の合計（全角 = 2、それ以外 = 1） */
export function chatUnits(s) {
  let n = 0;
  for (const ch of String(s ?? '')) n += unitOf(ch);
  return n;
}

// 書記素（見た目の 1 文字）に分ける。Intl.Segmenter が無ければ「結合文字・異体字セレクタ・肌の色・ZWJ でつながる文字」をまとめる近似
const SEG = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
const CLUSTER = /\p{RI}\p{RI}|(?:.[\p{M}\u{1F3FB}-\u{1F3FF}\u{E0020}-\u{E007F}]*)(?:\u200D.[\p{M}\u{1F3FB}-\u{1F3FF}]*)*/gsu;
const graphemes = s => (SEG ? Array.from(SEG.segment(s), x => x.segment) : s.match(CLUSTER) ?? []);

/** 上限（CHAT_MAX_UNITS）に収まるところまで切った文字列。書記素の途中では切らない（入力欄の制限に使う） */
export function clipChat(s) {
  s = String(s ?? '');
  if (chatUnits(s) <= CHAT_MAX_UNITS) return s;
  let out = '', n = 0;
  for (const g of graphemes(s)) {
    const u = chatUnits(g);
    if (n + u > CHAT_MAX_UNITS) break;
    out += g; n += u;
  }
  return out;
}

// 空白類（改行・タブ・NBSP・全角スペースなど）→ 半角スペース
const SPACES = /[\t\n\v\f\r \u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]/gu;
// 削除するもの：制御文字・孤立サロゲート、見えない文字・ゼロ幅・方向制御（20261006000000_hardening.sql の set_nickname と同じ集合）
// ZWJ（U+200D）だけは絵文字どうしをつなぐもの（👨‍👩‍👧 など）を残す
const INVISIBLE = /(?<![\p{Extended_Pictographic}\uFE0F\u{1F3FB}-\u{1F3FF}])\u200D|\u200D(?!\p{Extended_Pictographic})|[\p{Cc}\p{Cs}\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u2000-\u200C\u200E\u200F\u2028-\u202F\u205F-\u206F\u2800\u3164\uFEFF\uFFA0\uFFF9-\uFFFC]/gu;

/** 送る文を正規化する。=> 文字列、または null（文字列でない・空・上限を超える。切り詰めはしない） */
export function normalizeChat(s) {
  if (typeof s !== 'string') return null;
  // 消してから NFC（消した文字の両側が合成されることがあるため）
  const t = s.replace(SPACES, ' ').replace(INVISIBLE, '').normalize('NFC').replace(/ {2,}/g, ' ').trim();
  if (!t || chatUnits(t) > CHAT_MAX_UNITS) return null;
  return t;
}
