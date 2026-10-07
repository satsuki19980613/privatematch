// 演出 GIF の共有の決まり（サーバーとブラウザ）：GIF は KLIPY の slug（英数字とハイフン）だけで持ち運ぶ。
// メディアの URL は持ち運ばず、表示する端末がそのたびに KLIPY の API から受け取る（src/klipy.js。規約：URL は返ったまま・保存しない）。
export const FX_SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/;
/** slug として正しければそのまま、それ以外（空・長すぎ・記号・文字列でない）は null */
export const normalizeFx = x => (typeof x === 'string' && FX_SLUG.test(x) ? x : null);

const SIZES_FULL = ['md', 'hd', 'sm', 'xs'], SIZES_THUMB = ['sm', 'xs', 'md', 'hd'];
const VIDEO = ['mp4', 'webm'], IMAGE = ['webp', 'gif'];
const mediaOf = (x, fmt) => {
  if (typeof x === 'string' && x) return { url: x, video: VIDEO.includes(fmt), w: 0, h: 0 };
  if (x && typeof x.url === 'string' && x.url) return { url: x.url, video: VIDEO.includes(fmt), w: +x.width || 0, h: +x.height || 0 };
  return null;
};
/**
 * KLIPY の file（{ hd|md|sm|xs: { gif|webp|jpg|mp4|webm: { url, width, height } } }。大きさの段が無く形式が直に並ぶこともある）から 1 つ選ぶ。
 * use = 'full'（卓の中央）| 'thumb'（一覧）。どちらも動く画像（webp → gif）を優先し、無ければ動画。
 * 卓で動画を使わないのは、iPhone の Safari が画面に出していない動画を先読みせず、勝った瞬間に間に合わないため（画像はどの端末でも先読みできる）。
 * => { url, video, w, h } | null
 */
export function pickMedia(file, use = 'full') {
  if (!file || typeof file !== 'object') return null;
  const fmts = [...IMAGE, ...VIDEO];
  for (const f of fmts) for (const sz of use === 'full' ? SIZES_FULL : SIZES_THUMB) { const m = mediaOf(file[sz] && file[sz][f], f); if (m) return m; }
  for (const f of fmts) { const m = mediaOf(file[f], f); if (m) return m; }
  return null;
}
