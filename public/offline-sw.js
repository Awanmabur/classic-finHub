'use strict';
// Cache only this fixed public shell. Private pages, APIs, receipts, balances,
// authenticated HTML and POST responses must never enter CacheStorage.
const CACHE='classicfin-offline-'+(self.CLASSICFIN_ASSET_VERSION||'v1');
const PUBLIC=['/offline.html','/js/offline.js','/css/offline.css','/images/classicfinhub-logo.png','/vendor/inter/inter.css',...['latin','latin-ext','cyrillic','cyrillic-ext','greek','greek-ext','vietnamese'].map(name=>'/vendor/inter/files/inter-'+name+'-wght-normal.woff2')];
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(cache=>Promise.all(PUBLIC.map(async path=>{const response=await fetch(new Request(path,{cache:'reload'}));if(!response.ok)throw Error('Offline shell update failed');await cache.put(path,response);}))).then(()=>self.skipWaiting()));});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('classicfin-offline-')&&key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',event=>{
 const request=event.request,url=new URL(request.url);if(request.method!=='GET'||url.origin!==self.location.origin)return;
 if(PUBLIC.includes(url.pathname)&&!url.search){event.respondWith(caches.match(request).then(cached=>cached||fetch(request)));return;}
 if(request.mode==='navigate'&&url.pathname.startsWith('/tenant'))event.respondWith(fetch(request).catch(()=>caches.match('/offline.html')));
});
