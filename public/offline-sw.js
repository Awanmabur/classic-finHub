'use strict';
// CacheStorage holds only public resources. Private workspace snapshots are
// encrypted in IndexedDB and unlocked by the signed-in browser tab.
const CACHE='classicfin-offline-'+(self.CLASSICFIN_ASSET_VERSION||'v2');
const PUBLIC=['/offline.html','/js/offline-workspace.js','/js/offline.js','/js/feedback.js','/js/operation-pricing.js','/js/dashboard.js','/js/network-tariffs.js','/js/customer-accounts.js','/js/expenses.js','/js/workspace.js','/js/branches.js','/css/approved-tenant.css','/css/dashboard-layout.css','/css/workspace.css','/css/branches.css','/css/feedback.css','/images/classicfinhub-logo.png','/vendor/fontawesome/css/all.min.css','/vendor/inter/inter.css',...['fa-brands-400','fa-regular-400','fa-solid-900','fa-v4compatibility'].map(name=>'/vendor/fontawesome/webfonts/'+name+'.woff2'),...['latin','latin-ext','cyrillic','cyrillic-ext','greek','greek-ext','vietnamese'].map(name=>'/vendor/inter/files/inter-'+name+'-wght-normal.woff2')];
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(cache=>Promise.all(PUBLIC.map(async path=>{const response=await fetch(new Request(path,{cache:'reload'}));if(!response.ok)throw Error('Offline shell update failed');await cache.put(path,response);}))).then(()=>self.skipWaiting()));});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('classicfin-offline-')&&key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',event=>{
 const request=event.request,url=new URL(request.url);if(request.method!=='GET'||url.origin!==self.location.origin)return;
 if(PUBLIC.includes(url.pathname)){
  const requestedVersion=url.searchParams.get('v');
  // A versioned online page must see the exact deployed asset, never an
  // earlier CacheStorage entry. Offline fallback only applies to this worker's
  // matching fingerprint; mismatches fail closed instead of mixing releases.
  if(requestedVersion){
   event.respondWith(fetch(request,{cache:'no-cache'}).then(async response=>{
    if(response.ok&&requestedVersion===self.CLASSICFIN_ASSET_VERSION){
     const cache=await caches.open(CACHE);
     await cache.put(url.pathname,response.clone());
    }
    return response;
   }).catch(async error=>{
    if(requestedVersion!==self.CLASSICFIN_ASSET_VERSION)throw error;
    const fallback=await caches.open(CACHE).then(cache=>cache.match(url.pathname));
    if(!fallback)throw error;
    return fallback;
   }));
   return;
  }
  event.respondWith(caches.open(CACHE).then(cache=>cache.match(url.pathname)).then(cached=>cached||fetch(request)));return;
 }
 if(request.mode==='navigate'&&(url.pathname==='/tenant'||url.pathname.startsWith('/tenant/')))event.respondWith(fetch(request,typeof AbortSignal!=='undefined'?{signal:AbortSignal.timeout(7000)}:undefined).catch(()=>caches.open(CACHE).then(cache=>cache.match('/offline.html'))));
});
