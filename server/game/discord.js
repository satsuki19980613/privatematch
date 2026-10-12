// FRIEND MATCH のメンバー確認（Discord の OAuth2）。専用の Discord サーバーに居る人だけを通す。
//   1. ブラウザを authorizeUrl へ送る（scope: identify guilds.members.read。もう許可済みなら同意の画面は出ない）。
//      state はサーバーが作る：ログイン中の人と期限（10 分）に鍵付きの署名を付けたもので、戻ってきたときに同じ人のものかを確かめる。
//      ブラウザに預けた値と照合する方式にしないのは、Discord のアプリ内ブラウザから始めると、認可のあと別のブラウザ（Safari / Chrome）へ
//      戻ってくることがあるため（そのブラウザでも同じ人がログインしていれば、確認を最後まで進められる）
//   2. 戻ってきた code をアクセストークンに換え、そのサーバーでの本人のメンバー情報を読む（居なければ 404）
//   3. トークンはその場で失効させ、どこにも残さない。Discord の利用者 ID も残さず、鍵付きハッシュ（key）だけを返す
// 設定（Function の環境変数。scripts/deploy-game.mjs が渡す）：DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET / DISCORD_GUILD_ID、
// 任意で DISCORD_ROLE_ID（そのロールを持つ人だけ）。そろっていなければ makeDiscord は null（FRIEND MATCH は friend_off）。
import { createHmac, timingSafeEqual } from 'node:crypto';
import { MoveError } from './rules.js';

const API = 'https://discord.com/api/v10';
const AUTHORIZE = 'https://discord.com/oauth2/authorize';
const SCOPE = 'identify guilds.members.read';
const TIMEOUT_MS = 8000;
export const STATE_TTL_MS = 10 * 60_000;
const SNOWFLAKE = /^\d{5,25}$/;

export function makeDiscord({ clientId, clientSecret, guildId, roleId = null, fetcher = fetch }) {
  if (![clientId, clientSecret, guildId].every(v => typeof v === 'string' && v)) return null;
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
        return { member: true, key: createHmac('sha256', clientSecret).update(`${guildId}:${m.id}`).digest('hex') };
      } catch (e) {
        if (e instanceof MoveError) throw e;
        throw new MoveError('discord_failed');
      } finally {
        if (token) await revoke(token);
      }
    },
  };
}
