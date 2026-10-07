// 演出 GIF の取得（KLIPY API。キーは VITE_KLIPY_KEY。公開の値で、ブラウザから直接呼ぶ前提のもの）。
// KLIPY の規約（https://docs.klipy.com/attribution）に合わせる：
//   - API もメディアもブラウザから直接（自前のサーバー・Service Worker を通さない。sw.js は他のサイトに触れない）
//   - 返った URL はそのまま使い、メディアも URL も端末に保存しない（持ち運ぶのは slug だけ。src/fx.js）
//   - 検索とトレンドの結果は並べ替えず・間引かない（不適切なものは content_filter と KLIPY の Partner Panel で除く）
//   - 検索欄のプレースホルダーは「Search KLIPY」（src/ui/settings.js）
// ?fake / ?demo ではキーを使わず、手元の見本（src/fxDemo.js）を同じ形で返す（useDemo）。
import { pickMedia } from './fx.js';
import { localGet, localSet } from './ui/util.js';

const KEY = import.meta.env.VITE_KLIPY_KEY ?? '';
const BASE = 'https://api.klipy.com/api/v1/';
const PER_PAGE = 24;

let demo = null;
/** ?fake / ?demo：KLIPY の代わりに見本を使う（main.js が起動時に入れる） */
export function useDemo(d) { demo = d; cache.clear(); }
/** 演出 GIF を選べる（キーがあるか、デモ） */
export const available = () => !!(demo || KEY);
export const isDemo = () => !!demo;

// KLIPY の customer_id：この端末のランダムな値（ログインの ID やメールアドレスは渡さない）
function customerId() {
  let id = localGet('pm-klipy-cid');
  if (!id || !/^[0-9a-f-]{36}$/.test(id)) { id = crypto.randomUUID(); localSet('pm-klipy-cid', id); }
  return id;
}

/** 1 件の GIF：{ slug, title, thumb: { url, video, w, h }, full: { url, video, w, h } }（形が足りなければ null） */
function itemOf(x) {
  if (!x || typeof x.slug !== 'string' || (x.type && x.type !== 'gif')) return null;
  const thumb = pickMedia(x.file, 'thumb'), full = pickMedia(x.file, 'full');
  return thumb && full ? { slug: x.slug, title: typeof x.title === 'string' ? x.title : '', thumb, full } : null;
}
// slug → item（この画面を開いている間だけ。URL は API が返したものをそのまま使う）
const cache = new Map();

async function get(path, params = {}) {
  const u = new URL(BASE + encodeURIComponent(KEY) + '/' + path);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') u.searchParams.set(k, String(v));
  const ctrl = new AbortController(), t = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const r = await fetch(u, { signal: ctrl.signal, credentials: 'omit', referrerPolicy: 'strict-origin-when-cross-origin' });
    const b = await r.json().catch(() => null);
    if (!r.ok || !b || b.result === false) throw new Error('klipy_' + r.status);
    return b.data;
  } finally { clearTimeout(t); }
}

/** 検索（q が空ならトレンド）。page は 1 から。=> { items, next }（並びは API のまま） */
export async function search(q, page = 1) {
  if (demo) return demo.search(q, page, PER_PAGE);
  const common = { page, per_page: PER_PAGE, customer_id: customerId(), locale: 'jp', content_filter: 'high', format_filter: 'webp,gif,mp4,webm' };
  const d = await get(q ? 'gifs/search' : 'gifs/trending', q ? { ...common, q } : common);
  const items = (d && Array.isArray(d.data) ? d.data : []).map(itemOf).filter(Boolean);
  items.forEach(it => cache.set(it.slug, it));
  return { items, next: !!(d && d.has_next) };
}

/** slug の GIF をまとめて引く（卓に入ったときに全席分を 1 回で）。=> Map slug → item（見つからない slug は入らない） */
export async function lookup(slugs) {
  const want = [...new Set(slugs.filter(Boolean))], out = new Map();
  const miss = want.filter(s => { const c = cache.get(s); if (c) out.set(s, c); return !c; });
  if (!miss.length) return out;
  const got = demo ? demo.lookup(miss) : ((await get('gifs/items', { slugs: miss.join(',') })) || {}).data || [];
  for (const x of got) { const it = demo ? x : itemOf(x); if (it) { cache.set(it.slug, it); if (miss.includes(it.slug)) out.set(it.slug, it); } }
  return out;
}

/** 選んだことを KLIPY に知らせる（Share Trigger。KLIPY の集計のため。返事は待たない） */
export function shared(slug, q) {
  if (demo || !KEY) return;
  fetch(BASE + encodeURIComponent(KEY) + '/gifs/share/' + encodeURIComponent(slug), {
    method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ customer_id: customerId(), q: q || '' }),
  }).catch(() => {});
}
