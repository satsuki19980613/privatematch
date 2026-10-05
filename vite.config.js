import{readFileSync}from'node:fs';
import{defineConfig,loadEnv}from'vite';
import{AUTH_PROXY_PREFIX,authCookies,firstPartyCookie,isProxiedPath}from'./src/authProxy.js';

// headers of public/_headers (Cloudflare Pages) for `npm run preview`
function pagesHeaders(){
  const headers={};let inAll=false;
  for(const line of readFileSync(new URL('./public/_headers',import.meta.url),'utf8').split(/\r?\n/)){
    if(line.trim()===''||line.trimStart().startsWith('#'))continue;
    if(!/^\s/.test(line)){inAll=line.trim()==='/*';continue}
    const i=line.indexOf(':');if(inAll&&i>0)headers[line.slice(0,i).trim()]=line.slice(i+1).trim();
  }
  return headers;
}

// /api/auth/* → Neon Auth in development and preview (production uses Pages Functions)
function authProxy(authUrl){
  if(!authUrl)return{};
  const upstream=new URL(authUrl);
  return{[AUTH_PROXY_PREFIX]:{
    target:upstream.origin,changeOrigin:true,
    bypass:req=>isProxiedPath((req.url??'').split('?')[0].slice(AUTH_PROXY_PREFIX.length))?undefined:false,
    rewrite:p=>upstream.pathname.replace(/\/+$/,'')+p.slice(AUTH_PROXY_PREFIX.length),
    configure:proxy=>{
      proxy.on('proxyReq',r=>{const c=r.getHeader('cookie'),kept=authCookies(typeof c==='string'?c:null);if(kept)r.setHeader('cookie',kept);else r.removeHeader('cookie')});
      proxy.on('proxyRes',res=>{const c=res.headers['set-cookie'];if(c)res.headers['set-cookie']=c.map(firstPartyCookie);for(const k of Object.keys(res.headers))if(k.startsWith('access-control-'))delete res.headers[k]});
    },
  }};
}

export default defineConfig(({mode})=>{
  const proxy=authProxy(loadEnv(mode,'.','VITE_').VITE_NEON_AUTH_URL);
  return{
    server:{port:5180,strictPort:true,proxy},
    preview:{port:4180,strictPort:true,headers:pagesHeaders(),proxy},
  };
});
