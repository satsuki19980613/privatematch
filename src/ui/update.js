// アプリの自動更新：新しい版が配信されていたら、邪魔にならないとき（canReload）に読み込み直す。
// 確かめるのは、アプリを前に出したとき・開いたまま CHECK_MS ごと・メニューに戻ったとき（check を呼ぶ）。
// 試合中や入力の途中に見つけたときは覚えておき、次に check が呼ばれて canReload が true のときに読み込み直す。
// 新しい版で起動したら「バージョンを更新しました」と知らせる（announce。自動で読み込み直したときも、自分で開き直したときも）。
import { entryOf, isStale, mayReload, CHECK_MS } from '../update.js';
import { toast, localGet, localSet } from './util.js';

const RELOADED_KEY = 'pm-updated';   // 前に読み込み直した時刻（sessionStorage。繰り返しを防ぐ）
const SEEN_KEY = 'pm-version';       // 前に起動したときの入口（localStorage。版が変わったことを知らせるため）
const NOTICE_MS = 4000;              // 知らせを出しておく時間（アプリを前に出した直後に出るので、ふつうのトーストより長く）
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
/** 起動のあとに 1 回：前に開いたときと版が違えば知らせる（この端末で初めて開いたときは知らせない） */
export function announce() {
  if (!current) return;
  const seen = entryOf(localGet(SEEN_KEY));
  localSet(SEEN_KEY, current);
  if (isStale(current, seen)) toast('バージョンを更新しました', NOTICE_MS);
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
