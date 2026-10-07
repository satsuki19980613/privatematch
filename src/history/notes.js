// プレイヤーのメモと色の印。この端末の localStorage に置く（デモ ?demo は別のキー）。卓の席のプレートが毎回読むので同期で引ける形にする。
//   { [nameKey(名前)]: { name, mark: 0..MARKS（0 = なし）, text, at } }。STATS の EXPORT / IMPORT に含める。
// 名前は自由な文字列（"constructor" や "__proto__" もありうる）なので、入れ物はプロトタイプの無いオブジェクトにして自分のキーだけを引く。
import { nameKey } from './stats.js';

export const MARKS = 6;        // 印の色の数（style.css の --mk1〜--mk6）
export const NOTE_MAX = 200;   // メモの文字数（コードポイント）
export const NOTES_MAX = 3000; // 保存する人数の上限（読み込みで localStorage を溢れさせない）
const DEMO = typeof location !== 'undefined' && new URLSearchParams(location.search).has('demo');
const KEY = DEMO ? 'pm-notes-demo' : 'pm-notes';
const EMPTY = Object.freeze({ mark: 0, text: '' });
const dict = () => Object.create(null);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** メモの文：改行とタブ以外の制御文字を消し、上限で切る */
export const cleanNote = t => Array.from(String(t ?? '').replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '')).slice(0, NOTE_MAX).join('');
/** 1 件の検証（壊れた行・細工した行は null）。at は未来にしない */
export function normalizeNote(x, now = Date.now()) {
  if (!x || typeof x !== 'object' || typeof x.name !== 'string' || !x.name.trim() || x.name.length > 64) return null;
  const mark = Number.isInteger(x.mark) && x.mark >= 0 && x.mark <= MARKS ? x.mark : 0;
  const text = typeof x.text === 'string' ? cleanNote(x.text) : '';
  if (!mark && !text.trim()) return null;
  return { name: x.name, mark, text, at: Number.isFinite(x.at) ? Math.max(0, Math.min(x.at, now)) : 0 };
}
/** 全体の検証（キーは名前から付け直す。新しい順に NOTES_MAX 人まで） */
export function normalizeNotes(obj) {
  const out = dict();
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;
  const list = Object.values(obj).map(v => normalizeNote(v)).filter(Boolean).sort((a, b) => b.at - a.at);
  for (const n of list) { const k = nameKey(n.name); if (!own(out, k) && Object.keys(out).length < NOTES_MAX) out[k] = n; }
  return out;
}

let cache = null;
const subs = new Set();
function load() {
  if (cache) return cache;
  try { cache = normalizeNotes(JSON.parse(localStorage.getItem(KEY))); } catch (e) { cache = dict(); }
  return cache;
}
const notify = () => subs.forEach(f => f());
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch (e) { /* プライベートモードなど：この画面の間だけ持つ */ }
  notify();
}
// ほかのタブで書き換わった：読み直す（古い中身で上書きしない）
if (typeof addEventListener === 'function') addEventListener('storage', e => { if (e.key === KEY || e.key === null) { cache = null; notify(); } });

/** その人のメモ（無ければ { mark: 0, text: '' }） */
export const noteOf = name => { const c = load(), k = nameKey(name); return own(c, k) ? c[k] : EMPTY; };
export const markOf = name => noteOf(name).mark;
/** 書き換える（印もメモも空なら消す。中身が変わらなければ何もしない＝時刻も変えない） */
export function setNote(name, { mark, text }) {
  const k = nameKey(name); if (!k) return;
  const cur = noteOf(name), m = mark ?? cur.mark, t = cleanNote(text ?? cur.text);
  if (m === cur.mark && t === cur.text) return;
  const n = normalizeNote({ name: String(name), mark: m, text: t, at: Date.now() }), notes = load();
  if (n) notes[k] = n; else if (own(notes, k)) delete notes[k]; else return;
  save();
}
/** 書き出し用 */
export const allNotes = () => ({ ...load() });
/** 読み込み（同じ人は新しい方を残す）。=> 取り込んだ件数 */
export function importNotes(obj) {
  const add = normalizeNotes(obj), notes = load();
  let n = 0;
  for (const [k, v] of Object.entries(add)) {
    if (own(notes, k) ? (notes[k].at ?? 0) > v.at : Object.keys(notes).length >= NOTES_MAX) continue;
    notes[k] = v; n++;
  }
  if (n) save();
  return n;
}
/** 変わったら呼ぶ（卓の席の印を描き直す） */
export function onNotes(fn) { subs.add(fn); return () => subs.delete(fn); }
