// Backend access (Neon). Sign-in: Neon Auth through this site's /api/auth relay. Reads: Data API RPCs. Moves: the "game" Function.
import{AUTH_PROXY_PREFIX}from'./authProxy.js';

const env=import.meta.env;
export const DATA_URL=env.VITE_NEON_DATA_API_URL??'';
export const GAME_URL=env.VITE_GAME_URL??'';
export const online=Boolean(env.VITE_NEON_AUTH_URL&&DATA_URL&&GAME_URL);
const VERIFIER='neon_auth_session_verifier';

export class NetError extends Error{constructor(code,status){super(code);this.code=code;this.status=status}}

async function timed(url,init={},ms=10_000){
  const ctrl=new AbortController(),t=setTimeout(()=>ctrl.abort(),ms);
  try{return await fetch(url,{...init,signal:ctrl.signal})}
  catch(e){throw new NetError('network',0)}
  finally{clearTimeout(t)}
}
const session=(path,init={})=>timed(AUTH_PROXY_PREFIX+path,{...init,credentials:'same-origin'});

/** Google sign-in (leaves the page). Comes back to `back` with the session verifier. */
export async function signIn(back){
  const fail=new URL(back);fail.searchParams.set('error','login_failed');
  const r=await session('/sign-in/social',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({provider:'google',callbackURL:back,errorCallbackURL:fail.toString(),disableRedirect:true})});
  if(!r.ok)throw new NetError('signin',r.status);
  const{url}=await r.json();if(!url)throw new NetError('signin',r.status);
  location.assign(url);
}

/** current user ({id}) or null. Right after Google, the verifier in the URL completes the session (once). */
export async function currentUser(){
  const u=new URL(location.href),v=u.searchParams.get(VERIFIER);
  if(v||u.searchParams.has('error')){u.searchParams.delete(VERIFIER);u.searchParams.delete('error');history.replaceState(null,'',u.pathname+u.search+u.hash)}
  if(v){const x=await getSession(`?${VERIFIER}=${encodeURIComponent(v)}`);if(x)return x}
  return getSession('');
}
async function getSession(q){
  const r=await session('/get-session'+q);
  if(!r.ok)throw new NetError('session',r.status);
  const b=await r.json().catch(()=>null);
  return b&&b.user&&b.user.id?{id:b.user.id}:null;
}

export async function signOut(){token=null;await session('/sign-out',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})}

// JWT for the Data API and the Function (15 min; refreshed 30 s before it expires)
let token=null;
const expOf=jwt=>{try{return JSON.parse(atob(jwt.split('.')[1].replace(/-/g,'+').replace(/_/g,'/'))).exp*1000}catch{return 0}};
const lostListeners=new Set();
export const onSessionLost=f=>lostListeners.add(f);
function lost(){token=null;lostListeners.forEach(f=>f())}
async function getToken(){
  if(token&&token.exp-30_000>Date.now())return token.jwt;
  const r=await session('/token');
  if(r.status===401){lost();throw new NetError('not_authenticated',401)}
  if(!r.ok)throw new NetError('token',r.status);
  const{token:jwt}=await r.json();if(!jwt){lost();throw new NetError('not_authenticated',401)}
  token={jwt,exp:expOf(jwt)};return jwt;
}

async function call(url,body){
  const jwt=await getToken();
  const r=await timed(url,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${jwt}`},body:JSON.stringify(body)},15_000);
  const data=await r.json().catch(()=>null);
  if(r.ok)return data;
  const code=(data&&(data.error||data.message))||'http_'+r.status;
  if(r.status===401||code==='not_authenticated')lost();
  throw Object.assign(new NetError(code,r.status),{data});
}
/** Data API RPC (the database functions granted to authenticated) */
export const rpc=(name,args={})=>call(`${DATA_URL}/rpc/${name}`,args);
/** the "game" Function: create / join / leave / act / sitin / sitout / tick */
export const game=body=>call(GAME_URL,body);
