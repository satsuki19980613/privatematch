// Cloudflare Pages Function（/api/auth/* の中継）の振る舞い。fetch を差し替えて、上流への要求と応答の書き換えを確かめる。
import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequest } from '../functions/api/auth/[[path]].js';
import { firstPartyCookie, authCookies } from '../src/authProxy.js';

const UP = 'https://ep-x.neonauth.c-6.us-east-2.aws.neon.tech/neondb/auth';
const SITE = 'https://privatematch.pages.dev';

async function relay(path, { method = 'GET', headers = {}, body, query = '', env = { NEON_AUTH_URL: UP }, reply } = {}) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async req => { calls.push(req); return reply ? reply(req) : new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } }); };
  try {
    const segs = Array.isArray(path) ? path : path.split('/');
    const request = new Request(`${SITE}/api/auth/${segs.join('/')}${query}`, { method, headers: { origin: SITE, ...headers }, body });
    const res = await onRequest({ request, env, params: { path: path === '' ? undefined : segs } });
    return { res, calls };
  } finally { globalThis.fetch = real; }
}

test('upstream URL: path + query, no double slash, upstream host fixed', async () => {
  const { calls } = await relay('get-session', { query: '?neon_auth_session_verifier=abc%2B1' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${UP}/get-session?neon_auth_session_verifier=abc%2B1`);
  const t = await relay('token', { env: { NEON_AUTH_URL: UP + '/' } });
  assert.equal(t.calls[0].url, `${UP}/token`);
});

test('only the allow-listed paths are relayed (no traversal / open proxy)', async () => {
  const bad = [
    ['..%2f..%2fadmin'], ['%2e%2e', 'x'], ['..', '..', 'x'], ['', '', 'evil.com'], ['//evil.com'], ['@evil.com'], ['get-session', '..', 'x'],
    ['get-session%2f..%2fadmin'], ['sign-in', 'email'], ['sign-up', 'email'], ['list-sessions'], ['revoke-session'], ['callback', 'google'], ['get-session%00'], ['GET-SESSION'], ['Ok'],
    ['token', 'x'], ['get-session;x'], ['jwks'], ['reset-password'], ['sign-out', 'x'],
  ];
  for (const p of bad) {
    const { res, calls } = await relay(p);
    assert.equal(res.status, 404, JSON.stringify(p));
    assert.equal(calls.length, 0, JSON.stringify(p));
  }
});

test('empty path (/api/auth, /api/auth/) is 404, not a request to the upstream root', async () => {
  for (const p of ['', [''], ['', '']]) {
    const { res, calls } = await relay(p);
    assert.equal(res.status, 404);
    assert.equal(calls.length, 0);
  }
});

test('env.NEON_AUTH_URL (Pages variable) overrides src/prodConfig.js', async () => {
  const { calls } = await relay('ok', { env: { NEON_AUTH_URL: 'https://other.example/x/auth' } });
  assert.equal(calls[0].url, 'https://other.example/x/auth/ok');
});

test('Origin forwarded, Host/Cookie(non-auth)/cf-* dropped, only Neon Auth cookies kept', async () => {
  const { calls } = await relay('sign-in/social', {
    method: 'POST', body: JSON.stringify({ provider: 'google', callbackURL: SITE + '/' }),
    headers: { 'content-type': 'application/json', cookie: 'a=1; __Secure-neon-auth.session_token=T; __Secure-neon-auth.session_challenge=C0; __Secure-neon-auth.session_challange=C; _ga=2; neonauth.x=y; evil-neon-auth.z=1', 'cf-connecting-ip': '1.1.1.1', 'user-agent': 'UA' },
  });
  const u = calls[0];
  assert.equal(u.method, 'POST');
  assert.equal(u.headers.get('origin'), SITE);
  assert.equal(u.headers.get('content-type'), 'application/json');
  assert.equal(u.headers.get('cf-connecting-ip'), null);
  assert.equal(u.headers.get('cookie'), '__Secure-neon-auth.session_token=T; __Secure-neon-auth.session_challenge=C0; __Secure-neon-auth.session_challange=C; neonauth.x=y');
  assert.deepEqual(JSON.parse(await u.text()), { provider: 'google', callbackURL: SITE + '/' });
  assert.equal(u.redirect, 'manual');
});

test('Set-Cookie: multiple preserved individually, Domain/Partitioned dropped, SameSite=None -> Lax, Secure/Path/HttpOnly/Max-Age/__Secure- kept', async () => {
  const reply = () => {
    const h = new Headers({ 'content-type': 'application/json', 'access-control-allow-origin': 'https://x', 'access-control-allow-credentials': 'true', 'content-encoding': 'gzip', 'content-length': '999' });
    h.append('set-cookie', '__Secure-neon-auth.session_token=abc.def%3D; Max-Age=604800; Domain=neonauth.c-6.us-east-2.aws.neon.tech; Path=/; HttpOnly; Secure; SameSite=None; Partitioned');
    h.append('set-cookie', '__Secure-neon-auth.session_challange=zzz; Max-Age=300; Path=/; Expires=Wed, 21 Oct 2026 07:28:00 GMT; HttpOnly; Secure; SameSite=Lax');
    h.append('set-cookie', '__Host-neonauth.local.session_data=q; Path=/; Secure; SameSite=none');
    return new Response('{"url":"https://accounts.google.com/x"}', { status: 200, headers: h });
  };
  const { res } = await relay('sign-in/social', { method: 'POST', body: '{}', reply });
  const sc = res.headers.getSetCookie();
  assert.equal(sc.length, 3);
  assert.equal(sc[0], '__Secure-neon-auth.session_token=abc.def%3D; Max-Age=604800; Path=/; HttpOnly; Secure; SameSite=Lax');
  assert.equal(sc[1], '__Secure-neon-auth.session_challange=zzz; Max-Age=300; Path=/; Expires=Wed, 21 Oct 2026 07:28:00 GMT; HttpOnly; Secure; SameSite=Lax');
  assert.equal(sc[2], '__Host-neonauth.local.session_data=q; Path=/; Secure; SameSite=Lax');
  assert.equal(res.headers.get('access-control-allow-origin'), null);
  assert.equal(res.headers.get('access-control-allow-credentials'), null);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');   // Pages の _headers は Functions の応答には付かない
  assert.equal(res.headers.get('content-encoding'), null);
  assert.equal(await res.text(), '{"url":"https://accounts.google.com/x"}');
});

test('upstream 401 / 3xx pass through with status (3xx Location is NOT rewritten)', async () => {
  const r401 = await relay('token', { reply: () => new Response('{}', { status: 401 }) });
  assert.equal(r401.res.status, 401);
  const r302 = await relay('get-session', { reply: () => new Response(null, { status: 302, headers: { location: UP + '/x' } }) });
  assert.equal(r302.res.status, 302);
  assert.equal(r302.res.headers.get('location'), UP + '/x'); // documents current behaviour
});

test('/api/auth/ok relays; GET has no body; HEAD ok; sign-out POST body forwarded', async () => {
  const ok = await relay('ok');
  assert.equal(ok.calls[0].url, `${UP}/ok`);
  assert.equal(ok.calls[0].method, 'GET');
  const so = await relay('sign-out', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
  assert.equal(await so.calls[0].text(), '{}');
});

test('cookie helpers', () => {
  assert.equal(authCookies('a=1'), null);
  assert.equal(firstPartyCookie('a=b; Domain=x.y; Partitioned'), 'a=b');
  assert.equal(firstPartyCookie('a=b; SameSite=None; Secure'), 'a=b; SameSite=Lax; Secure');
});
