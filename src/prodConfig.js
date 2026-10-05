// 本番の Neon Auth の URL（公開の住所。秘密ではない）。GitHub Actions の Deploy が scripts/write-config.mjs で書き換えてコミットする。
// functions/api/auth/[[path]].js（ログインの中継）が読む。サイト側の URL は .env.production にある。
export const NEON_AUTH_URL = '';
