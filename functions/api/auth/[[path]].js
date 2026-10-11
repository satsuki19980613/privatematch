import { proxyAuth } from '../../../src/authProxy.js';
import { NEON_AUTH_URL } from '../../../src/prodConfig.js';

/**
 * Cloudflare Pages Functions：/api/auth/* を Neon Auth に中継して、セッションの Cookie をこのサイトのもの（ファーストパーティ）にする。
 * 中継先は本番の Neon Auth の URL（src/prodConfig.js。GitHub Actions の Deploy が書く）。Pages の環境変数 NEON_AUTH_URL があればそちらを使う。
 */
export const onRequest = ctx => {
  const upstream = ctx.env?.NEON_AUTH_URL || NEON_AUTH_URL;
  if (!upstream) return new Response('auth relay is not configured', { status: 503 });
  const p = ctx.params.path;
  return proxyAuth(ctx.request, upstream, Array.isArray(p) ? p.join('/') : (p ?? ''));
};
