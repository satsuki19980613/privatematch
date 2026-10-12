// アプリの自動更新の判断（純関数）。画面への組み込みは src/ui/update.js。
// 版の見分け方：ビルドのたびに、index.html が読み込む入口のスクリプトの名前（/assets/index-<ハッシュ>.js）が変わる。
// 配信中の index.html の入口が、いま動いている入口と違えば、新しい版が出ている。

/** 開いたままのときに確かめる間隔 */
export const CHECK_MS = 10 * 60_000;
/** 読み込み直しの間隔の下限（配信が切り替わる途中で古い index.html が返っても、読み込み直しを繰り返さない） */
export const RELOAD_GAP_MS = 5 * 60_000;

const ENTRY = /\/assets\/index-[\w-]+\.js/;
/** index.html（かスクリプトの URL）から入口のスクリプトのパスを取り出す。無ければ null（開発サーバーなど） */
export const entryOf = text => ENTRY.exec(typeof text === 'string' ? text : '')?.[0] ?? null;
/** 新しい版が出ているか（どちらかが分からなければ false：分からないときは読み込み直さない） */
export const isStale = (current, latest) => !!current && !!latest && current !== latest;
/** 前に読み込み直した時刻（無ければ null や NaN）から、いま読み込み直してよいか */
export function mayReload(lastAt, now) {
  const last = Number(lastAt);
  // 記録が無い・壊れている・時計が戻った：止めない
  if (!Number.isFinite(last) || last <= 0 || now < last) return true;
  return now - last >= RELOAD_GAP_MS;
}
