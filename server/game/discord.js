// FRIEND MATCH のメンバー確認（Discord の OAuth2）。専用の Discord サーバーに居る人だけを通す。
//   1. ブラウザを authorizeUrl へ送る（scope: identify guilds.members.read。もう許可済みなら同意の画面は出ない）。
//      state はサーバーが作る：ログイン中の人と期限（10 分）に鍵付きの署名を付けたもので、戻ってきたときに同じ人のものかを確かめる。
//      ブラウザに預けた値と照合する方式にしないのは、Discord のアプリ内ブラウザから始めると、認可のあと別のブラウザ（Safari / Chrome）へ
//      戻ってくることがあるため（そのブラウザでも同じ人がログインしていれば、確認を最後まで進められる）
//   2. 戻ってきた code をアクセストークンに換え、そのサーバーでの本人のメンバー情報を読む（居なければ 404）
//   3. トークンはその場で失効させ、どこにも残さない。Discord の利用者 ID も残さず、鍵付きハッシュ（key）だけを返す
// もう 1 つの確認：番号（Discord のアプリだけで済む。iPhone の Discord アプリは上の OAuth2 を受け取らないため）
//   1. アプリが 6 桁の番号を出す（db.js の discordCode。10 分だけ使える）
//   2. 本人が専用のサーバーの中で /link 番号 と打つ。Discord がこの Function を呼ぶ（Interactions。署名付き）
//   3. 署名を確かめ（公開鍵 DISCORD_PUBLIC_KEY）、専用のサーバーの中からの呼び出しなら、その番号を出した人をメンバーとして残す
//      サーバーの中でコマンドを打てること自体がメンバーの証明になる。残すのは OAuth2 と同じ鍵付きハッシュ（同じ Discord アカウントは同じ値）
// 設定（Function の環境変数。scripts/deploy-game.mjs が渡す）：DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET / DISCORD_GUILD_ID、
// 任意で DISCORD_ROLE_ID（そのロールを持つ人だけ）。そろっていなければ makeDiscord は null（FRIEND MATCH は friend_off）。
// DISCORD_PUBLIC_KEY（アプリの公開鍵。16 進 64 桁）が無ければ、番号での確認だけが使えない（interactions = false）。
import { createHmac, createPublicKey, timingSafeEqual, verify as verifySignature } from 'node:crypto';
import { MoveError } from './rules.js';

const API = 'https://discord.com/api/v10';
const AUTHORIZE = 'https://discord.com/oauth2/authorize';
const SCOPE = 'identify guilds.members.read';
const TIMEOUT_MS = 8000;
export const STATE_TTL_MS = 10 * 60_000;
const SNOWFLAKE = /^\d{5,25}$/;
const HEX64 = /^[0-9a-f]{64}$/i, HEX128 = /^[0-9a-f]{128}$/i, TIMESTAMP = /^\d{1,20}$/;
// Ed25519 の公開鍵（生の 32 バイト）を Node が読める形（SPKI）にするための頭
const ED25519_SPKI = '302a300506032b6570032100';

/** 番号での確認のコマンド（Discord に登録する形。scripts/discord.mjs が使う）。サーバーの中でだけ使える */
export const LINK_COMMAND = {
  name: 'link', type: 1, description: 'PrivateMatch の FRIEND MATCH に入るための確認（アプリに出た 6 桁の番号）',
  options: [{ type: 3, name: 'code', description: 'PrivateMatch に出た 6 桁の番号', required: true, min_length: 6, max_length: 12 }],
  integration_types: [0], contexts: [0],
};
/** コマンドへの返事（打った本人にだけ見える） */
export const LINK_REPLY = {
  ok: '確認できました。PrivateMatch に戻ってください。',
  badCode: '番号が違うか、期限が切れています。PrivateMatch で番号を出し直してください。',
  notMember: 'このサーバーのメンバーだけが使えます。',
  unknown: 'このコマンドは使えません。',
  failed: 'うまくいきませんでした。少し待ってからもう一度。',
};
// 番号の入力をそろえる（全角の数字・空白・区切りを許す）。6 桁でなければ null
function codeOf(v) {
  const s = String(v ?? '').replace(/[０-９]/g, c => String.fromCodePoint(c.codePointAt(0) - 0xFEE0)).replace(/[\s\-‐－ー]/g, '');
  return /^\d{6}$/.test(s) ? s : null;
}

export function makeDiscord({ clientId, clientSecret, guildId, roleId = null, publicKey = null, fetcher = fetch }) {
  if (![clientId, clientSecret, guildId].every(v => typeof v === 'string' && v)) return null;
  const verifyKey = typeof publicKey === 'string' && HEX64.test(publicKey)
    ? createPublicKey({ key: Buffer.from(ED25519_SPKI + publicKey, 'hex'), format: 'der', type: 'spki' }) : null;
  // その Discord アカウントの鍵付きハッシュ（ID そのものは残さない。OAuth2 でも番号でも同じ値）
  const keyOf = userId => createHmac('sha256', clientSecret).update(`${guildId}:${userId}`).digest('hex');
  const basic = 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const form = (path, params) => fetcher(API + path, {
    method: 'POST', headers: { Authorization: basic, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(), signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  async function tokenOf(code, redirect) {
    const r = await form('/oauth2/token', { grant_type: 'authorization_code', code, redirect_uri: redirect });
    const b = r.ok ? await r.json() : null;
    if (typeof b?.access_token !== 'string' || !b.access_token) throw new MoveError('discord_failed');
    return b.access_token;
  }
  // そのサーバーでの本人。=> { id, roles } | null（メンバーでない）
  async function memberOf(token) {
    const r = await fetcher(`${API}/users/@me/guilds/${encodeURIComponent(guildId)}/member`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (r.status === 404) return null;
    const b = r.ok ? await r.json() : null, id = b?.user?.id;
    if (typeof id !== 'string' || !SNOWFLAKE.test(id)) throw new MoveError('discord_failed');
    return { id, roles: Array.isArray(b.roles) ? b.roles : [] };
  }
  // state の署名（その人・その期限のものだけが合う）
  const sign = (uid, exp) => createHmac('sha256', clientSecret).update(`state:${uid}:${exp}`).digest('base64url');
  const revoke = token => form('/oauth2/token/revoke', { token, token_type_hint: 'access_token' }).catch(() => { /* 失効できなくても 7 日で切れる */ });

  return {
    /** その人の state（'期限.署名'。now から 10 分だけ使える） */
    stateFor(uid, now) {
      const exp = now + STATE_TTL_MS;
      return `${exp}.${sign(uid, exp)}`;
    },
    /** 戻ってきた state が、その人に出した・まだ期限の内のものか */
    checkState(state, uid, now) {
      const [head, sig, ...rest] = String(state).split('.'), exp = Number(head);
      if (rest.length || !sig || !Number.isSafeInteger(exp) || exp < now || exp > now + STATE_TTL_MS) return false;
      const want = Buffer.from(sign(uid, exp)), got = Buffer.from(sig);
      return want.length === got.length && timingSafeEqual(want, got);
    },
    /** Discord の同意の画面の URL */
    authorizeUrl(redirect, state) {
      return `${AUTHORIZE}?${new URLSearchParams({ client_id: clientId, response_type: 'code', scope: SCOPE, redirect_uri: redirect, state, prompt: 'none' })}`;
    },
    /** code を確かめる。=> { member: true, key } | { member: false }。Discord に届かない・code が正しくなければ MoveError('discord_failed') */
    async verify(code, redirect) {
      let token = null;
      try {
        token = await tokenOf(code, redirect);
        const m = await memberOf(token);
        if (!m || (roleId && !m.roles.includes(roleId))) return { member: false };
        return { member: true, key: keyOf(m.id) };
      } catch (e) {
        if (e instanceof MoveError) throw e;
        throw new MoveError('discord_failed');
      } finally {
        if (token) await revoke(token);
      }
    },
    /** 番号での確認が使えるか（公開鍵がある） */
    interactions: !!verifyKey,
    /** 専用のサーバーの ID（秘密ではない。アプリが「Discord を開く」のリンクに使う） */
    guild: guildId,
    /** Discord からの呼び出しの署名（時刻 + 本文に、アプリの鍵で付けたもの）が正しいか */
    checkSignature(raw, signature, timestamp) {
      if (!verifyKey || typeof raw !== 'string' || !HEX128.test(signature ?? '') || !TIMESTAMP.test(timestamp ?? '')) return false;
      try { return verifySignature(null, Buffer.from(timestamp + raw), verifyKey, Buffer.from(signature, 'hex')); } catch { return false; }
    },
    /**
     * Discord からの呼び出し（署名を確かめたあとの本文）を読む。
     * => { type: 'pong' }（疎通の確認） | { type: 'claim', key, code }（番号での確認） | { type: 'reply', text }
     */
    readInteraction(b) {
      if (b?.type === 1) return { type: 'pong' };
      if (b?.type !== 2 || b.data?.name !== LINK_COMMAND.name) return { type: 'reply', text: LINK_REPLY.unknown };
      // 専用のサーバーの中から、その本人が打ったものだけ（DM やほかのサーバーからは受けない）
      const id = b.member?.user?.id, roles = Array.isArray(b.member?.roles) ? b.member.roles : [];
      if (b.guild_id !== guildId || typeof id !== 'string' || !SNOWFLAKE.test(id) || (roleId && !roles.includes(roleId))) return { type: 'reply', text: LINK_REPLY.notMember };
      const options = Array.isArray(b.data.options) ? b.data.options : [];
      const code = codeOf(options.find(o => o?.name === 'code')?.value);
      return code ? { type: 'claim', key: keyOf(id), code } : { type: 'reply', text: LINK_REPLY.badCode };
    },
  };
}
