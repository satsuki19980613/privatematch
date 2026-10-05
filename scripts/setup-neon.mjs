// Neon の準備（何度実行しても同じ結果になる）：node scripts/setup-neon.mjs --branch <branch>
//   1. ブランチが無ければ作る（既定のブランチから）
//   2. Neon Auth を有効にし、Google ログインを足す（Neon の共有 OAuth アプリ。自前のクライアントは GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET）
//   3. Data API を有効にする（認証は Neon Auth）
//   4. ログインの戻り先として APP_ORIGIN を信頼するドメインに足す（開発ブランチは localhost も許可）
//   5. Neon Auth と Data API の URL を表示し、GitHub Actions ならステップ出力 auth_url / data_url に書く
import { branchArg, neon, output, pickUrl } from './neon.mjs';

const branch = branchArg(), DB = 'neondb';
const tryNeon = async (...a) => { try { return await neon(...a); } catch (e) { return null; } };
const json = s => { try { return JSON.parse(s); } catch { return null; } };

// 1. ブランチ
const branches = json(await neon('branches', 'list', '--output', 'json')) || [];
const list = Array.isArray(branches) ? branches : branches.branches || [];
if (!list.some(b => b.name === branch || b.id === branch)) {
  console.log(`ブランチ ${branch} を作ります`);
  await neon('branches', 'create', '--name', branch, '--output', 'json');
}

// 2. Neon Auth と Google
let auth = await tryNeon('neon-auth', 'status', '--branch', branch, '--output', 'json');
if (!auth || !/neonauth/.test(auth)) {
  console.log('Neon Auth を有効にします');
  await neon('neon-auth', 'enable', '--branch', branch, '--database-name', DB, '--output', 'json');
  auth = await neon('neon-auth', 'status', '--branch', branch, '--output', 'json');
}
const providers = (await tryNeon('neon-auth', 'oauth-provider', 'list', '--branch', branch, '--output', 'json')) || '';
if (!/google/i.test(providers)) {
  const own = process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
    ? ['--oauth-client-id', process.env.GOOGLE_CLIENT_ID, '--oauth-client-secret', process.env.GOOGLE_CLIENT_SECRET] : [];
  console.log(`Google ログインを足します（${own.length ? '自前の OAuth クライアント' : 'Neon の共有 OAuth アプリ'}）`);
  await neon('neon-auth', 'oauth-provider', 'add', '--branch', branch, '--provider-id', 'google', ...own);
}

// 3. Data API
let api = await tryNeon('data-api', 'get', '--branch', branch, '--database', DB, '--output', 'json');
if (!api || !/apirest/.test(api)) {
  console.log('Data API を有効にします');
  await neon('data-api', 'create', '--branch', branch, '--database', DB, '--auth-provider', 'neon_auth', '--output', 'json');
  api = await neon('data-api', 'get', '--branch', branch, '--database', DB, '--output', 'json');
}

// 4. ログインの戻り先
if (process.env.APP_ORIGIN) {
  const host = process.env.APP_ORIGIN.replace(/\/+$/, '');
  const domains = (await tryNeon('neon-auth', 'domain', 'list', '--branch', branch, '--output', 'json')) || '';
  if (!domains.includes(host.replace(/^https?:\/\//, ''))) { console.log(`信頼するドメインに ${host} を足します`); await tryNeon('neon-auth', 'domain', 'add', host, '--branch', branch); }
}
if (process.env.ALLOW_LOCALHOST === '1') await tryNeon('neon-auth', 'domain', 'allow-localhost', 'enable', '--branch', branch);

// 5. URL
const authUrl = process.env.VITE_NEON_AUTH_URL || pickUrl(auth, /neonauth/, '/auth');
const dataUrl = process.env.VITE_NEON_DATA_API_URL || pickUrl(api, /apirest/, '/rest/v1');
if (!authUrl || !dataUrl) { console.log(auth, api); throw new Error('Neon Auth / Data API の URL が分かりません（Variables の VITE_NEON_AUTH_URL / VITE_NEON_DATA_API_URL で指定できます）'); }
output('auth_url', authUrl); output('data_url', dataUrl);
console.log(`Neon Auth: ${authUrl}\nData API:  ${dataUrl}`);
