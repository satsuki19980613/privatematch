// Service worker for installing PrivateMatch as an app (Android "Install app" / home screen).
// It caches nothing. Page navigations (including the Google sign-in round trip) and requests to other sites
// (Neon) are not touched; same-site files simply go to the network, so new versions show up right away.
// An app that stays open picks up a new version by itself: src/ui/update.js reloads the page when the entry script changes.
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
self.addEventListener('fetch',e=>{
  const r=e.request;
  if(r.method!=='GET'||r.mode==='navigate'||new URL(r.url).origin!==self.location.origin)return;
  e.respondWith(fetch(r));
});
