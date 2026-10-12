// FRIEND MATCH の「番号での確認」（Discord のサーバーで /link 番号）：
// 署名とコマンドの読み取り（discord.js）・HTTP（handler.js）・Discord のアプリの準備（scripts/discord.mjs）の単体テストと、
// TEST_DATABASE_URL があるときだけ動く DB の結合テスト（専用のデータベースを作る。test/dbkit.js）。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { makeDiscord, LINK_COMMAND, LINK_REPLY } from '../server/game/discord.js';
import { createHandler, MAX_INTERACTION } from '../server/game/handler.js';
import { makeDb } from '../server/game/db.js';
import { prepareDiscord, registerLink } from '../scripts/discord.mjs';
import { DEFAULT_CONFIG } from '../src/structure.js';
import { seeded } from '../src/rnd.js';
import { DBURL, openTestDb } from './dbkit.js';

const U = i => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const GUILD = '9000000001', ROLE = '7000000001';
// Discord のアプリの鍵の代役（本物と同じ Ed25519。公開鍵は生の 32 バイトの 16 進）
const keys = generateKeyPairSync('ed25519');
const PUBLIC = keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
const CFG = { clientId: '111', clientSecret: 's3cret', guildId: GUILD, publicKey: PUBLIC };
const TS = '1800000000';
const signed = (raw, ts = TS, key = keys.privateKey) => sign(null, Buffer.from(ts + raw), key).toString('hex');
const keyOf = id => createHmac('sha256', CFG.clientSecret).update(`${GUILD}:${id}`).digest('hex');
// サーバーの中で /link を打ったときに Discord が送ってくる本文
const command = (code, { user = '123456789012345678', guild = GUILD, roles = [], name = 'link' } = {}) =>
  ({ type: 2, guild_id: guild, member: { user: { id: user }, roles }, data: { name, options: [{ type: 3, name: 'code', value: code }] } });

describe('番号での確認：署名とコマンド', () => {
  const d = makeDiscord(CFG);

  test('公開鍵が無い・形が違えば、番号での確認だけが使えない（OAuth2 はそのまま）', () => {
    for (const publicKey of [undefined, null, '', 'abc', 'z'.repeat(64), PUBLIC + '00', 5]) {
      const x = makeDiscord({ ...CFG, publicKey });
      assert.equal(x.interactions, false, String(publicKey));
      assert.equal(x.checkSignature('{}', signed('{}'), TS), false);
      assert.ok(x.authorizeUrl('https://app.example/', 'state-1234567890abcd').startsWith('https://discord.com/'));
    }
    assert.equal(d.interactions, true);
    assert.equal(d.guild, GUILD);
  });

  test('署名は、その時刻・その本文に、アプリの鍵で付けたものだけが合う', () => {
    const raw = JSON.stringify({ type: 1 });
    assert.equal(d.checkSignature(raw, signed(raw), TS), true);
    assert.equal(d.checkSignature(raw + ' ', signed(raw), TS), false);              // 本文が違う
    assert.equal(d.checkSignature(raw, signed(raw), '1800000001'), false);          // 時刻が違う
    assert.equal(d.checkSignature(raw, signed(raw, TS, generateKeyPairSync('ed25519').privateKey), TS), false);   // 別の鍵
    assert.equal(d.checkSignature(raw, signed(raw).toUpperCase(), TS), true);       // 16 進の大文字も読む
    for (const bad of ['', 'x', signed(raw).slice(2), signed(raw) + '00', null, undefined, 5]) assert.equal(d.checkSignature(raw, bad, TS), false, String(bad));
    for (const ts of ['', 'abc', '12 34', null, undefined]) assert.equal(d.checkSignature(raw, signed(raw), ts), false, String(ts));
    assert.equal(d.checkSignature(null, signed(raw), TS), false);
  });

  test('疎通の確認（PING）には pong。知らないコマンドは受けない', () => {
    assert.deepEqual(d.readInteraction({ type: 1 }), { type: 'pong' });
    for (const b of [null, undefined, {}, { type: 3 }, { type: 2 }, { type: 2, data: {} }, command('123456', { name: 'other' })])
      assert.deepEqual(d.readInteraction(b), { type: 'reply', text: LINK_REPLY.unknown }, JSON.stringify(b));
  });

  test('専用のサーバーの中で本人が打った /link だけを受け、Discord の ID は鍵付きハッシュにする（OAuth2 と同じ値）', () => {
    assert.deepEqual(d.readInteraction(command('123456')), { type: 'claim', key: keyOf('123456789012345678'), code: '123456' });
    assert.notEqual(d.readInteraction(command('123456', { user: '223456789012345678' })).key, keyOf('123456789012345678'));
    // 全角の数字・空白・区切りはそろえる
    for (const v of ['123 456', ' 123456 ', '１２３４５６', '123-456', '１２３　４５６']) assert.equal(d.readInteraction(command(v)).code, '123456', v);
    for (const v of ['12345', '1234567', 'abcdef', '', null, undefined, 123456.5, {}])
      assert.deepEqual(d.readInteraction(command(v)), { type: 'reply', text: LINK_REPLY.badCode }, String(v));
    // ほかのサーバー・DM（guild_id も member も無い）・ID のおかしな呼び出しは受けない
    const dm = { type: 2, user: { id: '123456789012345678' }, data: command('123456').data };
    for (const b of [command('123456', { guild: '9000000002' }), dm, command('123456', { user: 'abc' }), command('123456', { user: '' })])
      assert.deepEqual(d.readInteraction(b), { type: 'reply', text: LINK_REPLY.notMember }, JSON.stringify(b));
    const noOptions = command('123456'); delete noOptions.data.options;
    assert.deepEqual(d.readInteraction(noOptions), { type: 'reply', text: LINK_REPLY.badCode });
  });

  test('ロールを決めているときは、そのロールを持つ人だけ', () => {
    const r = makeDiscord({ ...CFG, roleId: ROLE });
    assert.equal(r.readInteraction(command('123456', { roles: ['1', ROLE] })).type, 'claim');
    assert.deepEqual(r.readInteraction(command('123456', { roles: ['1'] })), { type: 'reply', text: LINK_REPLY.notMember });
    const noRoles = command('123456'); delete noRoles.member.roles;
    assert.deepEqual(r.readInteraction(noRoles), { type: 'reply', text: LINK_REPLY.notMember });
  });

  test('登録するコマンドは、サーバーの中だけで使える /link（番号は必須）', () => {
    assert.equal(LINK_COMMAND.name, 'link'); assert.equal(LINK_COMMAND.type, 1);
    assert.deepEqual(LINK_COMMAND.contexts, [0]); assert.deepEqual(LINK_COMMAND.integration_types, [0]);
    assert.deepEqual(LINK_COMMAND.options.map(o => [o.name, o.type, o.required]), [['code', 3, true]]);
    assert.ok(LINK_COMMAND.description.length <= 100 && LINK_COMMAND.options[0].description.length <= 100);
  });
});

describe('HTTP：Discord からの呼び出し', () => {
  const calls = [];
  let answer = { type: 1 };
  const h = createHandler({
    allowedOrigins: ['https://app.example'], verifyToken: async t => (t === 'good' ? U(1) : null), logError: () => {},
    discordInteract: async (raw, sig, ts) => { calls.push([raw, sig, ts]); if (answer instanceof Error) { throw answer; } return answer; },
    discordCode: async uid => { calls.push(['code', uid]); return { code: '123456', until: 1, guild: GUILD }; },
  });
  const call = async (body, headers = { 'X-Signature-Ed25519': 'sig', 'X-Signature-Timestamp': TS }) => {
    const r = await h(new Request('https://f/', { method: 'POST', headers, body }));
    return [r.status, await r.json()];
  };

  test('署名の付いた呼び出しは、本文をそのまま渡して確かめる（ログインのトークンは要らない）', async () => {
    const raw = '{"type":1,  "x":"そのまま"}';
    answer = { type: 1 };
    assert.deepEqual(await call(raw), [200, { type: 1 }]);
    assert.deepEqual(calls.at(-1), [raw, 'sig', TS]);
    answer = { type: 4, data: { content: 'ok', flags: 64 } };
    assert.deepEqual(await call(raw), [200, answer]);
  });

  test('署名が合わない・大きすぎる・設定が無いときは 401、内部の失敗は 500', async () => {
    answer = null;
    assert.deepEqual(await call('{}'), [401, { error: 'invalid_signature' }]);
    assert.deepEqual(await call('{}', { 'X-Signature-Ed25519': '' }), [401, { error: 'invalid_signature' }]);
    const n = calls.length;
    assert.equal((await call('x'.repeat(MAX_INTERACTION + 1)))[0], 401);
    assert.equal(calls.length, n);   // 読む前に断る
    answer = new Error('db down');
    assert.deepEqual(await call('{}'), [500, { error: 'internal' }]);
    const off = createHandler({ allowedOrigins: [], verifyToken: async () => null, logError: () => {} });
    const r = await off(new Request('https://f/', { method: 'POST', headers: { 'X-Signature-Ed25519': 'sig', 'X-Signature-Timestamp': TS }, body: '{}' }));
    assert.equal(r.status, 401);
    // 署名のヘッダが無ければ、ふつうの呼び出し（ログインが要る）
    assert.deepEqual(await call('{}', {}), [401, { error: 'not_authenticated' }]);
  });

  test('番号を出すのはログインした本人だけ', async () => {
    const post = async token => {
      const r = await h(new Request('https://f/', { method: 'POST', headers: { Authorization: `Bearer ${token}`, Origin: 'https://app.example' }, body: JSON.stringify({ op: 'discord_code' }) }));
      return [r.status, await r.json()];
    };
    assert.deepEqual(await post('good'), [200, { code: '123456', until: 1, guild: GUILD }]);
    assert.deepEqual(calls.at(-1), ['code', U(1)]);
    assert.equal((await post('bad'))[0], 401);
  });
});

describe('Discord のアプリの準備（配備のとき）', () => {
  // Discord の代役：呼ばれた内容を覚え、決めた応答を順に返す
  async function withDiscord(replies, fn) {
    const seen = [], real = globalThis.fetch, log = console.log, said = [];
    globalThis.fetch = async (url, init) => {
      seen.push({ url: String(url), method: init?.method ?? 'GET', auth: init?.headers?.Authorization ?? null, body: init?.body ?? null });
      const next = replies.shift() ?? { status: 500, body: {} };
      return new Response(JSON.stringify(next.body), { status: next.status ?? 200, headers: { 'Content-Type': 'application/json' } });
    };
    console.log = text => { said.push(String(text)); };
    try { return [await fn(), seen, said]; } finally { globalThis.fetch = real; console.log = log; }
  }
  const ENV = { DISCORD_CLIENT_ID: '111', DISCORD_CLIENT_SECRET: 's3cret' };
  const TOKEN = { body: { access_token: 'app-token' } };

  test('設定が無ければ Discord を呼ばない', async () => {
    const [app, seen] = await withDiscord([], () => prepareDiscord({}));
    assert.deepEqual(app, { clientId: null, token: null, publicKey: null });
    assert.equal(seen.length, 0);
    await registerLink(app, 'https://f/');
  });

  test('アプリ自身として入り、公開鍵を読む（コマンドの登録に使える scope だけ）', async () => {
    const [app, seen] = await withDiscord([TOKEN, { body: { application: { id: '111', verify_key: PUBLIC } } }], () => prepareDiscord(ENV));
    assert.deepEqual(app, { clientId: '111', token: 'app-token', publicKey: PUBLIC });
    assert.equal(seen[0].url, 'https://discord.com/api/v10/oauth2/token'); assert.equal(seen[0].method, 'POST');
    assert.equal(seen[0].auth, 'Basic ' + Buffer.from('111:s3cret').toString('base64'));
    assert.deepEqual(Object.fromEntries(new URLSearchParams(seen[0].body)), { grant_type: 'client_credentials', scope: 'applications.commands.update' });
    assert.deepEqual([seen[1].url, seen[1].auth], ['https://discord.com/api/v10/oauth2/@me', 'Bearer app-token']);
  });

  test('公開鍵が手で入っていれば、それを使う（Discord からは読まない）', async () => {
    const [app, seen] = await withDiscord([TOKEN], () => prepareDiscord({ ...ENV, DISCORD_PUBLIC_KEY: PUBLIC }));
    assert.deepEqual(app, { clientId: '111', token: 'app-token', publicKey: PUBLIC });
    assert.equal(seen.length, 1);
  });

  test('読めなければ警告を出して続ける（番号での確認だけが使えない）', async () => {
    const [noKey, , said] = await withDiscord([TOKEN, { body: { application: { id: '111' } } }], () => prepareDiscord(ENV));
    assert.deepEqual(noKey, { clientId: '111', token: 'app-token', publicKey: null });
    assert.ok(said.some(t => t.includes('DISCORD_PUBLIC_KEY')));
    const [denied, seen, warned] = await withDiscord([{ status: 401, body: {} }], () => prepareDiscord({ ...ENV, DISCORD_PUBLIC_KEY: PUBLIC }));
    assert.deepEqual(denied, { clientId: '111', token: null, publicKey: PUBLIC });   // 入れなくても、手で入れた公開鍵は使う
    assert.equal(seen.length, 1);   // 401 はやり直さない
    assert.equal(warned.length, 1);
    assert.ok(!said.concat(warned).join('\n').includes('s3cret'));
  });

  test('/link を登録する（公開鍵が無ければ登録しない。登録できなくても止めない）', async () => {
    const [, seen, said] = await withDiscord([{ body: [] }], () => registerLink({ clientId: '111', token: 'app-token', publicKey: PUBLIC }, 'https://f/'));
    assert.deepEqual([seen[0].url, seen[0].method, seen[0].auth], ['https://discord.com/api/v10/applications/111/commands', 'PUT', 'Bearer app-token']);
    assert.deepEqual(JSON.parse(seen[0].body), [LINK_COMMAND]);
    assert.ok(said.some(t => t.includes('https://f/')));
    const [, none] = await withDiscord([], () => registerLink({ clientId: '111', token: 'app-token', publicKey: null }, 'https://f/'));
    assert.equal(none.length, 0);
    const [, noToken, warned] = await withDiscord([], () => registerLink({ clientId: '111', token: null, publicKey: PUBLIC }, 'https://f/'));
    assert.equal(noToken.length, 0); assert.equal(warned.length, 1);
    const [, failed, warned2] = await withDiscord([{ status: 403, body: {} }], () => registerLink({ clientId: '111', token: 'app-token', publicKey: PUBLIC }, 'https://f/'));
    assert.equal(failed.length, 1); assert.equal(warned2.length, 1);
  });
});

/* ---------------- DB の結合テスト ---------------- */
describe('番号での確認（専用 DB）', { skip: !DBURL && 'TEST_DATABASE_URL が無い' }, () => {
  let T, clock, who, db;
  const discord = makeDiscord(CFG);
  // Discord が呼んできたことにする（本物と同じ署名を付ける）
  const send = (body, to = db) => { const raw = JSON.stringify(body); return to.discordInteract(raw, signed(raw), TS); };
  const said = text => ({ type: 4, data: { content: text, flags: 64 } });
  const members = async () => (await T.pool.query('select uid, discord_key from public.friend_members order by discord_key')).rows.map(r => [r.uid, r.discord_key]);
  const codes = async () => (await T.pool.query('select code, uid from public.friend_codes order by code')).rows.map(r => [r.code, r.uid]);
  const code = e => e.code;
  const ALICE = '123456789012345678', BOB = '223456789012345678';

  before(async () => {
    T = await openTestDb('link');
    clock = { t: Date.now() };
    db = makeDb(T.pool, { now: () => clock.t, rnd: seeded(42), discord });
    who = await T.newUsers(5);
  });
  after(async () => { await T?.close(); });

  test('権限：番号の表はブラウザから読めない', async () => {
    const { rows: [c] } = await T.pool.query("select relrowsecurity from pg_class where oid = 'public.friend_codes'::regclass");
    assert.equal(c.relrowsecurity, true);
    for (const role of ['authenticated', 'anonymous'])
      await assert.rejects(T.as(role, { sub: who[0], role }, 'select * from public.friend_codes'), e => e.code === '42501', role);
  });

  test('番号は 1 人 1 つ・6 桁・10 分。出し直すと前の番号は使えない', async () => {
    const [a, b] = who;
    const first = await db.discordCode(a);
    assert.match(first.code, /^\d{6}$/); assert.equal(first.guild, GUILD);
    assert.ok(Math.abs(first.until - (Date.now() + 600_000)) < 30_000);
    const second = await db.discordCode(a), other = await db.discordCode(b);
    assert.notEqual(second.code, first.code); assert.notEqual(other.code, second.code);
    assert.deepEqual((await codes()).map(x => x[1]).sort(), [a, b].sort());
    assert.deepEqual(await send(command(first.code)), said(LINK_REPLY.badCode));
    assert.deepEqual(await members(), []);
    await T.pool.query('delete from public.friend_codes');
  });

  test('サーバーの中で /link 番号 と打つと、その番号を出した人がメンバーになる（番号は 1 回で消える）', async () => {
    const [a] = who;
    assert.equal((await T.rpc(a, 'me')).friend, null);
    await assert.rejects(db.create(a, 'friend', DEFAULT_CONFIG), e => code(e) === 'not_friend');
    const c = await db.discordCode(a);
    assert.deepEqual(await send({ type: 1 }), { type: 1 });
    assert.deepEqual(await send(command(`${c.code.slice(0, 3)} ${c.code.slice(3)}`, { user: ALICE })), said(LINK_REPLY.ok));
    assert.deepEqual(await members(), [[a, keyOf(ALICE)]]);
    assert.deepEqual(await codes(), []);
    const me = await T.rpc(a, 'me');
    assert.equal(me.friend.ok, true);
    assert.ok(Math.abs(me.friend.until - (Date.now() + 30 * 86_400_000)) < 60_000);
    const made = await db.create(a, 'friend', DEFAULT_CONFIG);
    await db.leave(a, made.room);
    // 同じ番号をもう一度送っても、何も起きない
    assert.deepEqual(await send(command(c.code, { user: BOB })), said(LINK_REPLY.badCode));
    assert.deepEqual(await members(), [[a, keyOf(ALICE)]]);
  });

  test('署名が合わなければ何もしない。ほかのサーバーからの呼び出し・期限切れの番号は受けない', async () => {
    const [, b] = who;
    const c = await db.discordCode(b), raw = JSON.stringify(command(c.code, { user: BOB }));
    assert.equal(await db.discordInteract(raw, signed(raw + ' '), TS), null);
    assert.equal(await db.discordInteract(raw, signed(raw, TS, generateKeyPairSync('ed25519').privateKey), TS), null);
    assert.equal(await makeDb(T.pool, { discord: makeDiscord({ ...CFG, publicKey: null }) }).discordInteract(raw, signed(raw), TS), null);
    assert.equal(await makeDb(T.pool, {}).discordInteract(raw, signed(raw), TS), null);
    assert.deepEqual(await send(command(c.code, { user: BOB, guild: '9000000002' })), said(LINK_REPLY.notMember));
    // 読めない本文は「使えません」
    assert.deepEqual(await db.discordInteract('not json', signed('not json'), TS), said(LINK_REPLY.unknown));
    assert.deepEqual((await codes()).map(x => x[0]), [c.code]);
    await T.pool.query("update public.friend_codes set expires_at = now() - interval '1 second' where uid=$1", [b]);
    assert.deepEqual(await send(command(c.code, { user: BOB })), said(LINK_REPLY.badCode));
    assert.equal((await T.rpc(b, 'me')).friend, null);
    // 期限切れの番号は、次に誰かが番号を出すときに消える
    await db.discordCode(who[2]);
    assert.deepEqual((await codes()).map(x => x[1]), [who[2]]);
    await T.pool.query('delete from public.friend_codes');
  });

  test('同じ Discord アカウントは 1 人だけ（OAuth2 で確認した人とも同じ値で見分ける）', async () => {
    const [a, , c] = who;
    assert.deepEqual(await members(), [[a, keyOf(ALICE)]]);
    const k = await db.discordCode(c);
    assert.deepEqual(await send(command(k.code, { user: ALICE })), said(LINK_REPLY.ok));
    assert.deepEqual(await members(), [[c, keyOf(ALICE)]]);
    assert.equal((await T.rpc(a, 'me')).friend, null);
  });

  test('番号を出せるのは 10 分に 10 回まで。公開鍵が無い・プロフィールが無いと出せない', async () => {
    const [, , , d] = who;
    for (let i = 0; i < 10; i++) await db.discordCode(d);
    await assert.rejects(db.discordCode(d), e => code(e) === 'too_many');
    await assert.rejects(makeDb(T.pool, { discord: makeDiscord({ ...CFG, publicKey: null }) }).discordCode(who[4]), e => code(e) === 'friend_off');
    await assert.rejects(makeDb(T.pool, {}).discordCode(who[4]), e => code(e) === 'friend_off');
    await assert.rejects(db.discordCode(randomUUID()), e => code(e) === 'no_profile');
  });

  test('空いている番号が引けなければ busy（ほかの人の番号は上書きしない）', async () => {
    const [, , , , e] = who;
    const taken = await db.discordCode(who[1]);
    const stuck = makeDb(T.pool, { now: () => clock.t, rnd: () => Number(taken.code) / 1e6 + 1e-9, discord });
    await assert.rejects(stuck.discordCode(e), x => code(x) === 'busy');
    assert.deepEqual((await codes()).filter(x => x[0] === taken.code), [[taken.code, who[1]]]);
  });
});
