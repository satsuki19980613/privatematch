// アプリの自動更新：新しい版が配信されていたら、邪魔にならないとき（canReload）に読み込み直す。
// 確かめるのは、アプリを前に出したとき・開いたまま CHECK_MS ごと・メニューに戻ったとき（check を呼ぶ）。
// 試合中や入力の途中に見つけたときは覚えておき、次に check が呼ばれて canReload が true のときに読み込み直す。
import { entryOf, isStale, mayReload, CHECK_MS } from '../update.js';

const RELOADED_KEY = 'pm-updated';   // 前に読み込み直した時刻（sessionStorage。繰り返しを防ぐ）
// いま動いている入口（開発サーバーでは /src/main.js なので null：自動更新は働かない）
const current = entryOf(document.querySelector('script[type="module"][src*="/assets/index-"]')?.getAttribute('src'));
let stale = false, checking = false, canReload = () => false;

function lastReload() { try { return Number(sessionStorage.getItem(RELOADED_KEY)); } catch { return null; } }
function markReload(now) { try { sessionStorage.setItem(RELOADED_KEY, String(now)); } catch { /* プライベートモード */ } }

// 配信中の index.html を読んで、入口が変わっていないかを見る（読めなければ何もしない）
async function look() {
  if (stale || checking) return;
  checking = true;
  try {
    const res = await fetch('/', { cache: 'no-store', credentials: 'same-origin' });
    if (res.ok) stale = isStale(current, entryOf(await res.text()));
  } catch { /* オフライン：次の機会に */ } finally { checking = false; }
}
function apply() {
  const now = Date.now();
  if (!stale || !canReload() || !mayReload(lastReload(), now)) return;
  markReload(now);
  location.reload();
}
/** 新しい版が出ていないかを確かめ、出ていて邪魔にならないときは読み込み直す */
export async function check() {
  if (!current) return;
  await look();
  apply();
}
const whenVisible = () => { if (document.visibilityState === 'visible') void check(); };

/** 起動時に 1 回。safe() = いま読み込み直してよいか（メニューに居て、ダイアログも入力も無い） */
export function init(safe) {
  canReload = safe;
  if (!current) return;
  document.addEventListener('visibilitychange', whenVisible);
  addEventListener('pageshow', e => { if (e.persisted) void check(); });
  setInterval(whenVisible, CHECK_MS);
  // 後から読み込む部品（ルールのモーダルなど）が取れない：配信が新しい版に替わって、古い版の部品が消えている
  addEventListener('vite:preloadError', () => { stale = true; apply(); });
}
