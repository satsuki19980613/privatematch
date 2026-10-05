import { proxyAuth } from '../../../src/authProxy.js';

/**
 * Cloudflare Pages Functions：/api/auth/* を Neon Auth に中継して、セッションの Cookie をこのサイトのもの（ファーストパーティ）にする。
 * 中継先（本番の Neon Auth の URL）は環境変数 NEON_AUTH_URL。GitHub Actions の Deploy が `wrangler pages secret put` で入れる。
 */
export const onRequest = ctx => {
  const upstream = ctx.env && ctx.env.NEON_AUTH_URL;
  if (!upstream) return new Response('auth relay is not configured', { status: 503 });
  const p = ctx.params.path;
  return proxyAuth(ctx.request, upstream, Array.isArray(p) ? p.join('/') : (p ?? ''));
};
