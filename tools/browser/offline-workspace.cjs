// Browser regression: disposable loopback MongoDB only; optional Playwright and Chromium.
'use strict';
const req=require('node:module').createRequire(require('node:path').resolve(process.cwd(),'package.json'));
const crypto=require('node:crypto'),assert=require('node:assert/strict'),fs=require('node:fs');
const nonce=crypto.randomBytes(7).toString('hex'),scratch='cfh_currency_browser_'+nonce,slug='currency-browser-'+nonce;
process.env.NODE_ENV='test';process.env.MFA_ENABLED='true';process.env.MONGO_PLATFORM_URI='mongodb://127.0.0.1:27018/'+scratch+'?replicaSet=rs0&directConnection=true';
delete process.env.PLATFORM_DB_URI;delete process.env.MONGO_URI_BASE;
process.env.APP_URL='http://localhost:3000';process.env.MFA_ENCRYPTION_KEY=crypto.randomBytes(32).toString('hex');process.env.TRANSFER_SMS_ENCRYPTION_KEY=crypto.randomBytes(32).toString('hex');process.env.TRANSFER_SMS_PROVIDER='none';
process.env.TENANT_BACKUPS_ENABLED='true';process.env.TENANT_BACKUP_ENCRYPTION_KEY=crypto.randomBytes(32).toString('hex');process.env.TENANT_BACKUP_DIR='/tmp/cfh-browser-backups-'+nonce;
const mongoose=req('mongoose'),bcrypt=req('bcryptjs'),{chromium}=req('playwright'),mfa=req('./src/platform/services/mfa.service');
const core=req('./src/tenant/models'),Tenant=req('./src/platform/models/Tenant'),Identity=req('./src/platform/models/AccountIdentity'),commerce=req('./src/platform/services/commercial.service');
const treasury=req('./src/tenant/treasury/service'),fundModels=req('./src/tenant/treasury/models'),cash=req('./src/tenant/services/cashDrawer.service'),funded=req('./src/tenant/services/fundedOperations.service');
const {permissionsFor}=req('./src/config/roles'),directory=req('./src/tenant/customerAccounts/service');
const out=require('node:path').resolve(process.env.BROWSER_REVIEW_DIR||'/tmp/classicfin-workspace-offline-browser');fs.mkdirSync(out,{recursive:true});
const result={browserErrors:[],resourceErrors:[],layouts:[],cash:{}};
const backgroundRequests={contextRequests:0,preparationRequests:0},observedHttp=[];
let browser,server,conn,page,serveLegacyWorker=true;
// Simulate the previous fixed allowlist worker, which ignored version query strings.
const legacyWorker="self.addEventListener('install',event=>event.waitUntil(caches.open('classicfin-offline-browser-legacy').then(cache=>cache.put('/js/offline.js',new Response('window.CLASSICFIN_LEGACY_RUNTIME=true;',{headers:{'Content-Type':'application/javascript'}}))).then(()=>self.skipWaiting())));self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));self.addEventListener('fetch',event=>{if(new URL(event.request.url).pathname==='/js/offline.js')event.respondWith(caches.open('classicfin-offline-browser-legacy').then(cache=>cache.match('/js/offline.js')));});";
const decision={decision:'approve',note:'Independent original evidence and physical source funds checked'};
const actor=row=>({id:String(row._id),role:row.role,name:row.name,branchId:String(row.branchId),authVersion:row.authVersion||0,permissions:permissionsFor(row.role),allowedModules:row.allowedModules});
async function login(base,row,password,secret){await page.goto(base+'/signin');await page.locator('[name=email]').fill(row.email);await page.locator('[name=password]').fill(password);await Promise.all([page.waitForURL('**/mfa/challenge'),page.locator('form[action="/signin"] button[type=submit]').click()]);await page.locator('[name=code]').fill(mfa.counterCode(secret,Math.floor(Date.now()/30000)));await Promise.all([page.waitForURL('**/tenant/dashboard'),page.locator('button[type=submit]').click()]);}
async function navigate(base,route){const response=await page.goto(base+route);assert.equal(response.status(),200,route+' HTTP');await page.evaluate(()=>document.fonts.ready);}
async function capture(name){for(const width of [1440,390,320]){await page.setViewportSize({width,height:1000});if(width<=1120)await page.waitForFunction(()=>{const side=document.querySelector('#sidePanel');return !side||side.classList.contains('show')||side.getBoundingClientRect().right<=0;});const data=await page.evaluate(()=>{const ids=[...document.querySelectorAll('[id]')].map(e=>e.id);return {overflow:document.documentElement.scrollWidth>innerWidth,duplicateIds:ids.filter((id,i)=>ids.indexOf(id)!==i)};});assert.equal(data.overflow,false,name+' overflow '+width);assert.equal(data.duplicateIds.length,0,name+' duplicate ids');result.layouts.push({name,width,...data});await page.screenshot({path:out+'/'+name+'-'+width+'.png',fullPage:false});}await page.setViewportSize({width:1440,height:1000});}
async function main(){
 await req('./src/config/mongo').connectPlatformMongo();await Promise.all([Tenant.createIndexes(),Identity.createIndexes()]);
 const modules=['mobile_money','money_transfer','banking','forex','customers','accounts','expenses','reports'];
 const version={...commerce.asPlanVersion({...req('./src/data/store').plans.find(p=>p.code==='enterprise'),code:'currency_browser',modules}),status:'published'},terms=commerce.planSnapshot(version);
 const tenant=await Tenant.create({name:'Currency Browser Workspace',slug,dbName:req('./src/config/tenantDatabaseName').tenantDbNameFromSlug(slug),owner:'Owner',email:'owner-'+nonce+'@example.invalid',plan:'currency_browser',status:'active',setupStatus:'complete',enabledModules:modules,seatsReserved:2,branchCount:2,subscription:{...terms,status:'granted',source:'manual_admin_grant',generation:1,periodStart:new Date(Date.now()-10000),periodEnd:new Date(Date.now()+86400000)}});
 conn=req('./src/config/mongo').getTenantConnection(slug);await core.ensureTenantIndexes(conn);await fundModels.ensure(conn);
 const ownerId=new mongoose.Types.ObjectId(),reviewerId=new mongoose.Types.ObjectId();
 const branch=await core.branchModel(conn).create({name:'Main multi-currency office',code:'main',currency:'UGX',createdBy:ownerId,updatedBy:ownerId});
 const destination=await core.branchModel(conn).create({name:'Receiving office',code:'receiver',currency:'UGX',createdBy:ownerId,updatedBy:ownerId});
 const password='Currency-Browser-'+nonce+'#9a',ownerSecret=mfa.generateSecret(),people=[];
 for(const [id,role,name,email,secret]of[[ownerId,'Tenant Owner','Multi-currency Owner',tenant.email,ownerSecret],[reviewerId,'Reconciliation Officer','Independent Reviewer','reviewer-'+nonce+'@example.invalid',mfa.generateSecret()]]){const row=await core.tenantUserModel(conn).create({_id:id,name,email,passwordHash:await bcrypt.hash(password,10),role,branchId:branch._id,allowedModules:modules,status:'active',authVersion:0,mfaSecretEncrypted:mfa.encryptSecret(secret),mfaEnabledAt:new Date(),mfaLastCounter:-1});await Identity.create({email,kind:'tenant',tenantId:tenant._id,accountId:id});people.push(row.toObject());}
 const [owner,reviewer]=people,ownerActor=actor(owner),reviewerActor=actor(reviewer),accounts={};
 async function account(currency,kind,balance,network=''){const code=(currency+'_'+kind+(network?'_'+network.replace(/[^A-Za-z0-9]/g,''):'')).toUpperCase();const row=await treasury.createAccount(conn,tenant.toObject(),ownerActor,{kind,code,name:code,currency,network,operatorId:kind==='cash'?String(ownerId):'',isDefault:true});const observed=await treasury.requestObservation(conn,tenant.toObject(),ownerActor,row._id,{kind:'opening',actualBalance:balance,observedAt:new Date(Date.now()-1000).toISOString(),evidenceType:kind==='forex_stock'?'stock_count':kind==='cash'?'cash_count':kind==='transfer_clearing'?'transfer_register':kind==='wallet'?'provider_app':'bank_statement',evidenceReference:'CUR-OPEN-'+code,note:'Actual currency-specific original source balance physically verified',idempotencyKey:crypto.randomUUID()});await treasury.reviewObservation(conn,tenant.toObject(),reviewerActor,observed.observation._id,decision);accounts[currency+'_'+kind]=row;return row;}
 for(const currency of ['USD','SSP']){await account(currency,'cash','10000.00');await account(currency,'wallet','50000.00',currency==='SSP'?'MTN SSD':'MTN');await account(currency,'bank','50000.00');await account(currency,'transfer_clearing','0');const shift=await cash.open(conn,tenant.toObject(),ownerActor,{currency,openingCash:'10000.00'});await cash.decideOpening(conn,tenant.toObject(),reviewerActor,shift._id,decision);}
 const active=await core.cashSessionModel(conn).find({operatorId:ownerId,status:'open'}).lean();assert.equal(active.length,2);assert.deepEqual(active.map(x=>x.currency).sort(),['SSP','USD']);assert.notEqual(active[0].activeKey,active[1].activeKey);result.cash.independentCurrencyShifts=true;
 const customer=(await directory.customerCreate(conn,tenant.toObject(),ownerActor,{name:'Currency Customer',phone:'+211912345678',country:'South Sudan',idempotencyKey:crypto.randomUUID()})).record;
 const customerAccounts={};for(const currency of ['USD','SSP']){customerAccounts[currency]=(await directory.accountCreate(conn,tenant.toObject(),ownerActor,{customerId:String(customer._id),currency,type:'Current Account',status:'active',risk:'Low',idempotencyKey:crypto.randomUUID()})).record;assert.equal(customerAccounts[currency].currency,currency);}

 const app=req('./src/app')();
 server=await new Promise(resolve=>{const s=require('node:http').createServer((request,response)=>{observedHttp.push({method:request.method,path:new URL(request.url,'http://loopback').pathname,redirect:request.headers['x-classicfin-redirect'],scope:request.headers['x-classicfin-offline-scope'],branch:request.headers['x-classicfin-offline-branch']});if(serveLegacyWorker&&new URL(request.url,'http://loopback').pathname==='/offline-runtime.js'){response.writeHead(200,{'Content-Type':'application/javascript','Cache-Control':'no-store','Service-Worker-Allowed':'/'});response.end(legacyWorker);return;}app(request,response);}).listen(0,()=>resolve(s));});const base='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox']});const context=await browser.newContext();page=await context.newPage();page.setDefaultTimeout(30000);page.setDefaultNavigationTimeout(30000);page.on('request',request=>{if(new URL(request.url()).pathname==='/tenant/offline/context')backgroundRequests.contextRequests++;if(request.headers()['x-classicfin-prepare'])backgroundRequests.preparationRequests++;});page.on('response',async response=>{if(response.request().method()==='POST'&&response.status()===400)console.error('SYNTHETIC FORM ERROR',await response.text().catch(()=>''));});page.on('pageerror',e=>result.browserErrors.push(e.message));page.on('response',r=>{if(r.status()>=400&&/\.(?:css|js|woff2?|png)(?:\?|$)/.test(r.url()))result.resourceErrors.push({path:new URL(r.url()).pathname,status:r.status()});});
 await page.goto(base+'/signin');
 await page.evaluate(async()=>{await navigator.serviceWorker.register('/offline-runtime.js',{scope:'/'});await navigator.serviceWorker.ready;});
 await page.waitForFunction(()=>navigator.serviceWorker.controller!==null);
 await login(base,owner,password,ownerSecret);


 await page.setViewportSize({width:1440,height:1000});
 await page.waitForFunction(()=>navigator.serviceWorker.controller!==null);
 await page.waitForFunction(()=>document.getElementById('offlineStatus')?.textContent==='This page is saved for offline access.');
 await navigate(base,'/tenant/money-transfer/send?currency=SSP');
 assert.equal(await page.locator('select[name=fromBranchId]').count(),0);
 assert.equal(await page.locator('[data-transfer-form] input[readonly]').count(),1);
 assert.equal(await page.locator('select[name=destinationBranchId] option[value="'+branch._id+'"]').count(),0);
 for(const name of ['fee','validDays','senderCountry','receiverCountry'])assert.equal(await page.locator('[data-transfer-form] [name="'+name+'"]').getAttribute('type'),'hidden',name+' is derived rather than entered by the teller');
 assert.equal(await page.locator('[data-transfer-form] [name=pricingMode]').inputValue(),'configured');
 assert.equal(await page.locator('[data-transfer-form] details').evaluate(details=>details.open),false,'Additional metadata stays out of the daily entry path');
 result.minimalTransferForm={automaticCharges:true,automaticValidityAndCountry:true,optionalDetailsCollapsed:true,branchInferred:true};
 await page.waitForFunction(()=>document.getElementById('offlineStatus')?.textContent==='This page is saved for offline access.');
 // Neither fresh page should perform authenticated background reads when no drafts exist.
 await page.waitForTimeout(400);
 assert.equal(backgroundRequests.contextRequests,0,'Fresh server-rendered context avoids an extra account request');
 assert.equal(backgroundRequests.preparationRequests,0,'Navigation must not automatically fetch the workspace');
 assert.equal(observedHttp.filter(request=>request.method==='GET'&&request.path==='/health/ready').length,0,'Healthy idle navigation must not poll readiness');
 result.startup={...backgroundRequests,healthyReadinessPolls:0,visitedPagesSaved:true};
 assert.equal(await page.evaluate(()=>window.CLASSICFIN_LEGACY_RUNTIME),undefined,'First navigation must bypass the obsolete cached runtime');
 assert.equal(await page.evaluate(async()=>!!await(await caches.open('classicfin-offline-browser-legacy')).match('/js/offline.js')),true,'Obsolete runtime really remains cached during the first navigation');
 result.startup.staleWorkerFirstNavigationRecovered=true;
 // Upgrade normally, without deleting encrypted drafts or asking the user to clear site data.
 serveLegacyWorker=false;
 await page.evaluate(async()=>{const changed=new Promise(resolve=>navigator.serviceWorker.addEventListener('controllerchange',resolve,{once:true}));const registration=await navigator.serviceWorker.getRegistration('/');await registration.update();await changed;});
 await page.getByRole('button',{name:'Pending sync',exact:true}).click();
 await page.locator('#offlineQueueDialog details summary').click();
 await page.locator('#offlinePrepare').click();
 await page.waitForFunction(()=>document.getElementById('offlineStatus')?.textContent==='Workspace pages are saved for offline access.',null,{timeout:120000});
 assert(backgroundRequests.preparationRequests>0,'Explicit preparation saves additional pages');
 result.startup.explicitPreparationRequests=backgroundRequests.preparationRequests;
 await page.locator('#offlineQueueDialog [data-offline-close]').first().click();
 await capture('online-transfer');
 const signature=await page.evaluate(()=>({nav:document.querySelector('#nav').textContent,title:document.querySelector('#pageTitle').textContent,form:document.querySelector('[data-transfer-form]').className}));
 const form=page.locator('[data-transfer-form]'),draftKey=await form.locator('[name=idempotencyKey]').inputValue();
 async function fillTransfer(form,name,amount){await form.locator('[name=senderName]').fill(name);await form.locator('[name=senderPhone]').fill('+211921234567');await form.locator('[name=receiverName]').fill('Offline Receiver');await form.locator('[name=receiverPhone]').fill('+211922345678');await form.locator('[name=destinationBranchId]').selectOption(String(destination._id));await form.locator('[name=amount]').fill(amount);}
 await fillTransfer(form,'Offline Sender','25.50');
 await context.setOffline(true);await form.getByRole('button',{name:'Save transfer & continue'}).click();await page.getByText('Saved offline — pending sync.',{exact:false}).waitFor();assert.equal(await core.transferOrderModel(conn).countDocuments({idempotencyKey:draftKey}),0);
 await page.reload();await page.locator('[data-offline-snapshot]').waitFor();
 assert.deepEqual(await page.evaluate(()=>({nav:document.querySelector('#nav').textContent,title:document.querySelector('#pageTitle').textContent,form:document.querySelector('[data-transfer-form]').className})),signature);
 assert.equal(await page.locator('#transactionDialog').count(),1);
 await capture('offline-same-transfer');
 await page.getByRole('button',{name:'Pending sync',exact:true}).click();await page.locator('#offlineQueue').getByText('Offline Sender',{exact:true}).waitFor({state:'attached'});await page.locator('#offlineQueueDialog [data-offline-close]').first().click();
 const secondKey=await page.locator('[data-transfer-form] [name=idempotencyKey]').inputValue();assert.notEqual(secondKey,draftKey);
 await page.locator('#newTransactionBtn').click();await page.locator('#transactionDialog [data-transaction-kind=transfer]').click();
 const modal=page.locator('#transactionOperationForm');await modal.waitFor();await fillTransfer(modal,'Offline Second Sender','5.00');const modalKey=await modal.locator('[name=idempotencyKey]').inputValue();assert.notEqual(modalKey,draftKey);
 await modal.getByRole('button',{name:'Save transfer & continue'}).click();await modal.getByText('Saved offline — pending sync.',{exact:false}).waitFor();
 await page.locator('#transactionDialog [data-transaction-clear]').click();await fillTransfer(modal,'Offline Third Sender','7.00');const thirdKey=await modal.locator('[name=idempotencyKey]').inputValue();assert.notEqual(thirdKey,modalKey);await modal.getByRole('button',{name:'Save transfer & continue'}).click();await page.waitForFunction(()=>document.querySelector('[data-offline-message]')?.textContent.includes('3 pending'));await page.locator('#transactionDialog [data-close-transaction]').first().click();
 await page.goto(base+'/tenant/dashboard');await page.locator('[data-offline-snapshot]').waitFor();assert.equal(await page.locator('#pageTitle').innerText(),'Overview');await capture('offline-dashboard');
 await page.locator('#nav a[href="/tenant/mobile-money/network-activity"]').click();await page.locator('[data-offline-snapshot]').waitFor();assert.match(await page.locator('#pageTitle').innerText(),/Network activity/i);
 await page.goto(base+'/tenant/money-transfer/send?currency=SSP');await page.locator('[data-offline-snapshot]').waitFor();
 const publicCaches=await page.evaluate(async()=>{const result={};for(const name of await caches.keys())result[name]=(await(await caches.open(name)).keys()).map(request=>new URL(request.url).pathname);return result;});assert(!Object.values(publicCaches).flat().some(path=>path.startsWith('/tenant/')));
 const stored=await page.evaluate(async()=>{const db=await new Promise(resolve=>{const r=indexedDB.open('classicfin-offline-v1');r.onsuccess=()=>resolve(r.result);});const rows=await new Promise(resolve=>{const r=db.transaction('entries').objectStore('entries').getAll();r.onsuccess=()=>resolve(r.result);});db.close();return rows.map(row=>JSON.stringify(row));});assert(stored.every(row=>!row.includes('Offline Sender')&&!row.includes('+211921234567')&&!row.includes('<html')));
 const sanitizedSnapshots=await page.evaluate(async()=>{const database=await new Promise(resolve=>{const request=indexedDB.open('classicfin-offline-v1');request.onsuccess=()=>resolve(request.result);}),active=sessionStorage.getItem('classicfin.offline.scope');const get=(name,work)=>new Promise(resolve=>{const request=work(database.transaction(name).objectStore(name));request.onsuccess=()=>resolve(request.result);});const key=await get('keys',store=>store.get(active)),entries=await get('entries',store=>store.getAll());let checked=0;for(const entry of entries.filter(row=>row.id.startsWith(active+':page:'))){const record=JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:entry.iv,additionalData:new TextEncoder().encode(active)},key,entry.body))),dom=new DOMParser().parseFromString(record.html,'text/html'),roots=[dom];for(let i=0;i<roots.length;i++)for(const template of roots[i].querySelectorAll('template'))roots.push(template.content);for(const root of roots)if([...root.querySelectorAll('input[name="_csrf"],input[name="idempotencyKey"],input[type="password"]')].some(input=>input.getAttribute('value')))throw Error('A saved page retained a transient form credential');checked++;}database.close();return checked;});assert(sanitizedSnapshots>0);result.sanitizedTemplatesAndPages=true;
 // Keep an older draft's request in flight. A separate online operation must still finish.
 const backlogKeys=new Set([draftKey,modalKey,thirdKey]);let releaseBacklog,backlogObserved;
 const heldBacklog=new Promise(resolve=>{releaseBacklog=resolve;}),backlogStarted=new Promise(resolve=>{backlogObserved=resolve;});
 const holdOldRequest=async route=>{const request=route.request(),values=new URLSearchParams(request.postData()||'');if(request.method()==='POST'&&backlogKeys.has(values.get('idempotencyKey'))){backlogObserved();await heldBacklog;await route.fulfill({status:503,contentType:'text/plain',body:'Synthetic interrupted backlog'});}else await route.continue();};
 await context.route('**/tenant/money-transfer/requests',holdOldRequest);
 await context.setOffline(false);await Promise.race([backlogStarted,new Promise((_,reject)=>setTimeout(()=>reject(Error('Background sync did not start')),10000))]);
 await page.locator('#newTransactionBtn').click();await page.locator('#transactionDialog [data-transaction-kind=transfer]').click();await modal.waitFor();await fillTransfer(modal,'Connected Sender','3.00');const connectedKey=await modal.locator('[name=idempotencyKey]').inputValue(),foregroundStart=observedHttp.length;await modal.getByRole('button',{name:'Save transfer & continue'}).click();
 await page.waitForURL(/\/tenant\/money-transfer\/[a-f0-9]{24}(?:\/acknowledgement)?$/,{timeout:10000});
 assert.equal(await core.transferOrderModel(conn).countDocuments({idempotencyKey:connectedKey}),1);
 const foregroundHttp=observedHttp.slice(foregroundStart),acceptedPath=new URL(page.url()).pathname;
 assert.equal(foregroundHttp.filter(request=>request.method==='GET'&&request.path==='/tenant/offline/context').length,0,'Foreground POST uses the current tab context without an extra handshake');
 assert.equal(foregroundHttp.filter(request=>request.method==='GET'&&request.path===acceptedPath).length,1,'Accepted page must render exactly once, on document navigation');
 const foregroundPost=foregroundHttp.find(request=>request.method==='POST'&&request.path==='/tenant/money-transfer/requests');
 assert.equal(foregroundPost?.redirect,'json');assert.match(foregroundPost?.scope||'',/^[a-f0-9]{64}$/);assert.equal(foregroundPost?.branch,String(branch._id));
 await page.getByText('Transfer request recorded. No money has been sent or collected.',{exact:true}).waitFor();
 assert.equal(await page.locator('[data-session-flash]').isVisible(),true,'Success survives the background POST until actual navigation');
 result.foregroundRequests={contextGets:0,acceptedPageGets:1,jsonRedirect:true,liveScopeAndBranchHeaders:true,successMessageVisible:true};
 for(const idempotencyKey of backlogKeys)assert.equal(await core.transferOrderModel(conn).countDocuments({idempotencyKey}),0,'Older blocked entries must remain pending');
 result.offlineForegroundIndependent=true;
 releaseBacklog();await page.waitForTimeout(200);await context.unroute('**/tenant/money-transfer/requests',holdOldRequest);
 await navigate(base,'/tenant/money-transfer/send?currency=SSP');await page.getByRole('button',{name:'Pending sync',exact:true}).click();await page.locator('#offlineSync').click();await page.waitForFunction(()=>[...document.querySelectorAll('#offlineQueue strong')].filter(el=>el.textContent.includes('Synced')).length===4);
 for(const idempotencyKey of backlogKeys)assert.equal(await core.transferOrderModel(conn).countDocuments({idempotencyKey}),1);
 await page.locator('#offlineSync').click();await page.waitForTimeout(300);assert.equal(await core.transferOrderModel(conn).countDocuments({idempotencyKey:draftKey}),1);await page.locator('#offlineQueueDialog [data-offline-close]').first().click();
 await page.locator('#newTransactionBtn').click();await page.locator('#transactionDialog [data-transaction-kind=transfer]').click();await modal.waitFor();await fillTransfer(modal,'Online network outage','4.00');const outageKey=await modal.locator('[name=idempotencyKey]').inputValue();
 const interruptedPost=route=>route.abort(),interruptedHealth=route=>route.abort();
 await context.route('**/tenant/money-transfer/requests',interruptedPost);await context.route('**/health/ready',interruptedHealth);
 assert.equal(await page.evaluate(()=>navigator.onLine),true);
 await page.evaluate(()=>{window.offlineReviewOnlineEvents=0;window.addEventListener('online',()=>{window.offlineReviewOnlineEvents++;});});
 const outagePage=page.url();await modal.getByRole('button',{name:'Save transfer & continue'}).click();
 await page.waitForFunction(()=>document.body.dataset.connectionMode==='offline');
 assert.equal(await core.transferOrderModel(conn).countDocuments({idempotencyKey:outageKey}),0);
 assert.equal(await page.evaluate(()=>navigator.onLine),true,'The browser can report online while the application is unreachable');
 assert.equal(await modal.locator('[name=senderName]').inputValue(),'Online network outage');
 assert.equal(await modal.locator('[name=idempotencyKey]').inputValue(),outageKey,'An interrupted instruction retains its reference');
 await context.unroute('**/tenant/money-transfer/requests',interruptedPost);await context.unroute('**/health/ready',interruptedHealth);
 // Recovery must be discovered by the bounded connection monitor, without an
 // online event, page navigation or an operator pressing Sync now.
 await page.waitForFunction(()=>document.body.dataset.connectionMode==='online'&&[...document.querySelectorAll('#offlineQueue strong')].filter(el=>el.textContent.includes('Synced')).length===5,null,{timeout:25000});
 assert.equal(await page.evaluate(()=>window.offlineReviewOnlineEvents),0,'Recovery did not rely on navigator online events');
 assert.equal(await core.transferOrderModel(conn).countDocuments({idempotencyKey:outageKey}),1);
 assert.equal(page.url(),outagePage,'Returning online must not navigate away from an open editor');
 assert.equal(await page.locator('#transactionDialog').evaluate(dialog=>dialog.open),true);
 assert.equal(await modal.locator('[name=senderName]').inputValue(),'Online network outage');
 await page.evaluate(()=>{for(let index=0;index<3;index++)window.dispatchEvent(new Event('online'));});await page.waitForTimeout(350);
 assert.equal(await core.transferOrderModel(conn).countDocuments({idempotencyKey:outageKey}),1,'Repeated resume signals cannot create another transfer');
 result.automaticRecovery={networkFailureWhileBrowserOnline:true,offlineModeAutomatic:true,recoveryWithoutOnlineEvent:true,noManualSync:true,editorPreserved:true,oneRecordAfterRepeatedResume:true};
 await page.locator('#transactionDialog [data-close-transaction]').first().click();
 // The server may commit before a response disappears. Retry the persisted UUID
 // rather than treating the missing response as permission to create a new row.
 await page.locator('#newTransactionBtn').click();await page.locator('#transactionDialog [data-transaction-kind=transfer]').click();await modal.waitFor();await page.locator('#transactionDialog [data-transaction-clear]').click();
 await fillTransfer(modal,'Committed response lost','2.00');const lostResponseKey=await modal.locator('[name=idempotencyKey]').inputValue();let committedResponseLost=false;
 const dropCommittedResponse=async route=>{const values=new URLSearchParams(route.request().postData()||'');if(route.request().method()==='POST'&&values.get('idempotencyKey')===lostResponseKey){const response=await route.fetch();assert.equal(response.status(),200);committedResponseLost=true;await route.abort();}else await route.continue();};
 await context.route('**/tenant/money-transfer/requests',dropCommittedResponse);await context.route('**/health/ready',interruptedHealth);
 await modal.getByRole('button',{name:'Save transfer & continue'}).click();await page.waitForFunction(()=>document.body.dataset.connectionMode==='offline');
 assert.equal(committedResponseLost,true);assert.equal(await core.transferOrderModel(conn).countDocuments({idempotencyKey:lostResponseKey}),1);
 assert.equal(await modal.locator('[name=idempotencyKey]').inputValue(),lostResponseKey);
 await context.unroute('**/tenant/money-transfer/requests',dropCommittedResponse);await context.unroute('**/health/ready',interruptedHealth);
 await page.waitForFunction(()=>document.body.dataset.connectionMode==='online'&&[...document.querySelectorAll('#offlineQueue strong')].filter(el=>el.textContent.includes('Synced')).length===6,null,{timeout:25000});
 assert.equal(await core.transferOrderModel(conn).countDocuments({idempotencyKey:lostResponseKey}),1,'Automatic retry of a committed operation must remain idempotent');
 result.lostResponseRetry={sameReference:true,acceptedExactlyOnce:true,automaticRecovery:true};
 await page.locator('#transactionDialog [data-close-transaction]').first().click();
 // Changed business settings cannot silently reprice an already captured
 // offline instruction. The operator must review it before any new request.
 await navigate(base,'/tenant/money-transfer/send?currency=SSP');
 const pricingForm=page.locator('[data-transfer-form]');await fillTransfer(pricingForm,'Stale Pricing Sender','8.00');
 assert.equal(await pricingForm.locator('[name=pricingPolicy]').inputValue(),'default');
 const stalePricingKey=await pricingForm.locator('[name=idempotencyKey]').inputValue();
 await context.setOffline(true);await pricingForm.getByRole('button',{name:'Save transfer & continue'}).click();await page.getByText('Saved offline — pending sync.',{exact:false}).waitFor();
 assert.equal(await core.transferOrderModel(conn).countDocuments({idempotencyKey:stalePricingKey}),0);
 await req('./src/tenant/pricing/service').save(conn,tenant.toObject(),ownerActor,{operation:'money_transfer.send',currency:'SSP',branchId:'',network:'',feeFixed:'1.00',feePercent:'0',costFixed:'0',costPercent:'0',enabled:'true',revision:'0'});
 await context.setOffline(false);
 await page.waitForFunction(()=>[...document.querySelectorAll('#offlineQueue article')].some(row=>row.textContent.includes('Stale Pricing Sender')&&row.textContent.includes('Needs attention')&&row.textContent.includes('Charges changed since this form was prepared')),null,{timeout:25000});
 assert.equal(await core.transferOrderModel(conn).countDocuments({idempotencyKey:stalePricingKey}),0,'A stale fee quote must not be silently updated and booked');
 assert.equal(await page.evaluate(()=>document.body.dataset.connectionMode),'online','A pricing conflict is a business validation result, not a second offline mode');
 result.stalePricingHeldForReview=true;
 // Moving the account after render must invalidate the old operating-branch header before any write.
 await navigate(base,'/tenant/money-transfer/send?currency=SSP');
 const staleForm=page.locator('[data-transfer-form]');await fillTransfer(staleForm,'Stale Branch Sender','1.00');
 const staleKey=await staleForm.locator('[name=idempotencyKey]').inputValue();
 await core.tenantUserModel(conn).updateOne({_id:ownerId},{$set:{branchId:destination._id}});
 try{
  const denied=await page.evaluate(async()=>{const form=document.querySelector('[data-transfer-form]'),context=JSON.parse(document.body.dataset.offlineContext);const response=await fetch(form.action,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/x-www-form-urlencoded','X-ClassicFin-Redirect':'json','X-ClassicFin-Offline-Scope':context.scope,'X-ClassicFin-Offline-Branch':context.branchId,'x-csrf-token':context.csrfToken},body:new URLSearchParams(new FormData(form))});return{status:response.status,body:await response.text()};});
  assert.equal(denied.status,409,'Live branch must override the stale browser context');assert.match(denied.body,/operating branch changed/i);assert.equal(await core.transferOrderModel(conn).countDocuments({idempotencyKey:staleKey}),0);
  result.staleBranchRejectedBeforeWrite=true;
 }finally{await core.tenantUserModel(conn).updateOne({_id:ownerId},{$set:{branchId:branch._id}});}
 const priorScope=await page.evaluate(()=>sessionStorage.getItem('classicfin.offline.scope'));const otherTab=await context.newPage();await otherTab.goto(base+'/tenant/dashboard');await otherTab.waitForFunction(()=>sessionStorage.getItem('classicfin.offline.scope')!==null);
 await navigate(base,'/tenant/dashboard');await page.locator('.sidebarAccount summary').click();await page.locator('form[action="/logout"] button').click();await page.waitForURL('**/signin');assert.equal(await page.evaluate(()=>sessionStorage.getItem('classicfin.offline.scope')),null);await otherTab.waitForURL('**/signin');assert.equal(await otherTab.evaluate(()=>sessionStorage.getItem('classicfin.offline.scope')),null);await otherTab.close();
 // A suspended old tab may miss the logout event; an explicit online denial must still lock it.
 await page.evaluate(value=>sessionStorage.setItem('classicfin.offline.scope',value),priorScope);await page.goto(base+'/offline.html');await page.waitForFunction(()=>document.getElementById('offlineStatus')?.textContent.includes('Reconnect and sign in'));assert.equal(await page.locator('#nav').count(),0);assert.equal(await page.evaluate(()=>sessionStorage.getItem('classicfin.offline.scope')),null);
 await context.setOffline(true);await page.goto(base+'/tenant/dashboard');assert.equal(await page.locator('#nav').count(),0);assert.match(await page.locator('#offlineStatus').innerText(),/Reconnect and sign in/);
 result.offline={sameWorkspaceDOM:true,sameTransactionModal:true,encryptedSnapshotsAndDrafts:true,publicAssetsOnly:publicCaches,exactlyOneRecordPerKey:true,clearKeepsSeparateReferences:true,onlineSubmission:true,networkOutageWithOnlineFlag:true,crossTabLogoutLocks:true,serverDenialLocks:true,logoutLocks:true};
 assert.deepEqual(result.browserErrors,[]);assert.deepEqual(result.resourceErrors,[]);fs.writeFileSync(out+'/results.json',JSON.stringify(result,null,2));console.log('PASS '+JSON.stringify(result));
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;}).finally(async()=>{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));if(conn&&mongoose.connection.name===scratch){await conn.db.dropDatabase();await mongoose.connection.db.dropDatabase();}await mongoose.disconnect();if(process.env.TENANT_BACKUP_DIR?.startsWith('/tmp/cfh-browser-backups-'))await fs.promises.rm(process.env.TENANT_BACKUP_DIR,{recursive:true,force:true});});
