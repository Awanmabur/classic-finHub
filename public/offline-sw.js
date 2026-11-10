'use strict';
// CacheStorage holds only public resources. Private workspace snapshots are
// encrypted in IndexedDB and unlocked by the signed-in browser tab.
const CACHE='classicfin-offline-'+(self.CLASSICFIN_ASSET_VERSION||'v2');
const PUBLIC=['/offline.html','/js/offline-workspace.js','/js/offline.js','/js/feedback.js','/js/dashboard.js','/js/customer-accounts.js','/js/expenses.js','/js/workspace.js','/js/branches.js','/css/approved-tenant.css','/css/dashboard-layout.css','/css/workspace.css','/css/branches.css','/css/feedback.css','/images/classicfinhub-logo.png','/vendor/fontawesome/css/all.min.css','/vendor/inter/inter.css',...['fa-brands-400','fa-regular-400','fa-solid-900','fa-v4compatibility'].map(name=>'/vendor/fontawesome/webfonts/'+name+'.woff2'),...['latin','latin-ext','cyrillic','cyrillic-ext','greek','greek-ext','vietnamese'].map(name=>'/vendor/inter/files/inter-'+name+'-wght-normal.woff2')];
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(cache=>Promise.all(PUBLIC.map(async path=>{const response=await fetch(new Request(path,{cache:'reload'}));if(!response.ok)throw Error('Offline shell update failed');await cache.put(path,response);}))).then(()=>self.skipWaiting()));});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('classicfin-offline-')&&key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',event=>{
 const request=event.request,url=new URL(request.url);if(request.method!=='GET'||url.origin!==self.location.origin)return;
 if(PUBLIC.includes(url.pathname)){
  // A still-controlling worker must not return an older script/style for a
  // freshly deployed HTML version. Keep the old public shell for offline use.
  if(url.searchParams.has('v')&&url.searchParams.get('v')!==self.CLASSICFIN_ASSET_VERSION){event.respondWith(fetch(request).catch(()=>caches.open(CACHE).then(cache=>cache.match(url.pathname))));return;}
  event.respondWith(caches.open(CACHE).then(cache=>cache.match(url.pathname)).then(cached=>cached||fetch(request)));return;
 }
 if(request.mode==='navigate'&&(url.pathname==='/tenant'||url.pathname.startsWith('/tenant/')))event.respondWith(fetch(request).catch(()=>caches.open(CACHE).then(cache=>cache.match('/offline.html'))));
});
