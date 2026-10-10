/**
 * Neon Function "game"（PrivateMatch）。配備: npm run deploy:game -- --branch <branch>（GitHub Actions の Deploy から）
 * DATABASE_URL（データベースの所有者）、NEON_AUTH_JWKS_URL、NEON_AUTH_BASE_URL は Neon が入れる。ALLOWED_ORIGINS は --env で渡す。
 */
import { attachDatabasePool } from '@neon/functions';
import { createRemoteJWKSet, errors, jwtVerify } from 'jose';
import pg from 'pg';
import { createHandler } from './handler.js';
import { makeDb } from './db.js';

const env = n => { const v = process.env[n]; if (!v) throw new Error(`missing env ${n}`); return v; };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const pool = new pg.Pool({ connectionString: env('DATABASE_URL'), max: 3 });
attachDatabasePool(pool);
const jwks = createRemoteJWKSet(new URL(env('NEON_AUTH_JWKS_URL')));
const issuer = new URL(env('NEON_AUTH_BASE_URL')).origin;
const db = makeDb(pool);

const handler = createHandler({
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean),
  async verifyToken(token) {
    let payload;
    try { ({ payload } = await jwtVerify(token, jwks, { issuer, requiredClaims: ['exp', 'sub'] })); }
    catch (e) {
      // 鍵（JWKS）に届かない・壊れているのはトークンの誤りではない（401 にするとブラウザがログアウトしてしまう）
      if (e instanceof errors.JWKSTimeout || e instanceof errors.JWKSInvalid || !(e instanceof errors.JOSEError) || e.code === 'ERR_JOSE_GENERIC') throw Object.assign(new Error('jwks unavailable'), { unavailable: true });
      throw e;
    }
    if (payload.role !== 'authenticated') return null;
    return typeof payload.sub === 'string' && UUID.test(payload.sub) ? payload.sub.toLowerCase() : null;
  },
  ...db,
  logError(m, e) { console.error(m, e instanceof Error ? `${e.name}: ${e.message}` : String(e)); },
});

export default { fetch: handler };
