/**
 * Relay to Neon Auth (same approach as WWYD, detailed spec 12 §7.2).
 * Neon Auth's session cookie lives on the Neon Auth domain, a third-party cookie for this site that Safari and others drop
 * after a few days. Sign-in, session, token and sign-out go through this site's /api/auth/* so the cookie is first-party.
 * - production: Cloudflare Pages Functions (functions/api/auth/[[path]].js)
 * - development / preview: the Vite proxy (vite.config.js)
 */

/** Neon Auth APIs that are relayed (everything else is 404). `ok` is the health check */
export const PROXIED_PATHS=['sign-in/social','get-session','token','sign-out','ok'];
/** Neon Auth cookie names (both `neon-auth.` and `neonauth.` are used) */
export const NEON_AUTH_COOKIE=/^(__Secure-|__Host-)?neon-?auth\./;
export const AUTH_PROXY_PREFIX='/api/auth';

/** strip leading / trailing slashes */
const noLead=s=>{let i=0;while(s[i]==='/'){i++}return s.slice(i)};
export const noTrail=s=>{let n=s.length;while(s[n-1]==='/'){n--}return s.slice(0,n)};

export function isProxiedPath(path){return PROXIED_PATHS.includes(noTrail(noLead(path)))}

/** Neon Auth Set-Cookie → first-party cookie: drop Domain and Partitioned, SameSite=None → Lax; keep the rest */
export function firstPartyCookie(setCookie){
  const[pair='',...attrs]=setCookie.split(';').map(s=>s.trim());const kept=[];
  for(const a of attrs){
    const name=(a.split('=')[0]??'').trim().toLowerCase();
    if(name==='domain'||name==='partitioned'||a==='')continue;
    kept.push(name==='samesite'&&/=\s*none$/i.test(a)?'SameSite=Lax':a);
  }
  return[pair,...kept].join('; ');
}

/** forward only the Neon Auth cookies */
export function authCookies(cookie){
  if(!cookie)return null;
  const kept=cookie.split(';').map(s=>s.trim()).filter(c=>NEON_AUTH_COOKIE.test(c));
  return kept.length?kept.join('; '):null;
}

const DROP_REQUEST=new Set(['host','cookie','content-length','connection','cf-connecting-ip','cf-ipcountry','cf-ray','cf-visitor','cdn-loop']);

export async function toUpstream(req,upstream,path){
  const url=new URL(req.url);
  const target=`${noTrail(upstream)}/${noLead(path)}${url.search}`;
  const headers=new Headers();
  req.headers.forEach((v,k)=>{if(!DROP_REQUEST.has(k.toLowerCase()))headers.set(k,v)});
  const cookie=authCookies(req.headers.get('cookie'));if(cookie)headers.set('cookie',cookie);
  const hasBody=req.method!=='GET'&&req.method!=='HEAD';
  return new Request(target,{method:req.method,headers,body:hasBody?await req.arrayBuffer():undefined,redirect:'manual'});
}

export function fromUpstream(res){
  const headers=new Headers();
  res.headers.forEach((v,k)=>{const key=k.toLowerCase();if(key==='set-cookie'||key.startsWith('access-control-')||key==='content-encoding'||key==='content-length'){return}headers.set(k,v)});
  for(const c of res.headers.getSetCookie())headers.append('set-cookie',firstPartyCookie(c));
  headers.set('cache-control','no-store');headers.set('x-content-type-options','nosniff');
  return new Response(res.body,{status:res.status,statusText:res.statusText,headers});
}

export async function proxyAuth(req,upstream,path,fetcher=fetch){
  if(!isProxiedPath(path))return new Response('not found',{status:404});
  let res;try{res=await fetcher(await toUpstream(req,upstream,path))}
  catch{return new Response(JSON.stringify({error:'auth_unreachable'}),{status:502,headers:{'content-type':'application/json','cache-control':'no-store'}})}
  return fromUpstream(res);
}
