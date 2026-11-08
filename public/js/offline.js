/* global indexedDB, crypto */
'use strict';
(function(){
 if(!('indexedDB' in window)||!crypto.subtle)return;
 const routes=new Set(['/tenant/mobile-money/cash-in','/tenant/mobile-money/cash-out','/tenant/money-transfer/requests','/tenant/banking/requests','/tenant/forex/quotes','/tenant/expenses']);
 function operationLabel(action,form){if(action==='/tenant/banking/requests')return ({deposit_request:'Deposit',withdrawal_request:'Withdraw',transfer_request:'Account transfer'})[form.elements.namedItem('kind')?.value]||'Banking request';if(action==='/tenant/forex/quotes')return ({buy:'Buy forex from customer',sell:'Sell forex to customer'})[form.elements.namedItem('operation')?.value]||'Forex quotation';return ({'/tenant/mobile-money/cash-in':'Cash-in','/tenant/mobile-money/cash-out':'Cash-out','/tenant/money-transfer/requests':'Send money / Generate PIN','/tenant/expenses':'Expense'})[action]||'Operation';}
 const keyName='classicfin.offline.scope',onQueue=document.body.hasAttribute('data-offline-page');
 let context=null,key=null,scope=null,db=null,initializing=null,locked=false;
 const node=(tag,text,className)=>{const element=document.createElement(tag);if(text!==undefined)element.textContent=text;if(className)element.className=className;return element;};
 const status=message=>{const target=document.getElementById('offlineStatus')||document.querySelector('[data-offline-message]');if(target)target.textContent=message;};
 function open(){return new Promise((resolve,reject)=>{const request=indexedDB.open('classicfin-offline-v1',1);request.onupgradeneeded=()=>{request.result.createObjectStore('keys');request.result.createObjectStore('entries',{keyPath:'id'});};request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});}
 function store(name,mode,work){return new Promise((resolve,reject)=>{const tx=db.transaction(name,mode),request=work(tx.objectStore(name));tx.oncomplete=()=>resolve(request?.result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||Error('Local storage aborted'));});}
 const read=id=>store('entries','readonly',object=>object.get(id));
 const remove=id=>store('entries','readwrite',object=>object.delete(id));
 async function encrypt(value){const iv=crypto.getRandomValues(new Uint8Array(12)),plain=new TextEncoder().encode(JSON.stringify(value));return {iv,body:await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode(scope)},key,plain)};}
 async function decrypt(row){const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:row.iv,additionalData:new TextEncoder().encode(scope)},key,row.body);return JSON.parse(new TextDecoder().decode(plain));}
 async function save(id,value){const encrypted=await encrypt(value);await store('entries','readwrite',object=>object.put({id,scope,...encrypted}));}
 async function all(){const rows=await store('entries','readonly',object=>object.getAll());const result=[];for(const row of rows.filter(item=>item.scope===scope))try{result.push({id:row.id,...await decrypt(row)});}catch{status('One stored draft could not be decrypted. Contact your administrator before clearing this device.');}return result;}
 async function serverContext(){
  const response=await fetch('/tenant/offline/context',{cache:'no-store',credentials:'same-origin',headers:{Accept:'application/json'},redirect:'error'});
  if(locked||!response.ok||!response.headers.get('content-type')?.includes('application/json'))throw Error('Sign in again to sync drafts.');
  const value=await response.json();if(!/^[a-f0-9]{64}$/.test(value.scope)||!value.csrfToken)throw Error('Sign in again to sync drafts.');return value;
 }
 async function initialize(){
  if(initializing)return initializing;
  initializing=(async()=>{
   db=await open();let fresh=null;
   if(navigator.onLine)try{fresh=await serverContext();}catch{status('Sign in to open your offline drafts.');return false;}
   if(locked)return false;
   scope=fresh?.scope||sessionStorage.getItem(keyName);if(!scope)return false;
   key=await store('keys','readonly',object=>object.get(scope));
   if(!key&&fresh){key=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);await store('keys','readwrite',object=>object.put(key,scope));}
   if(!key)return false;
   sessionStorage.setItem(keyName,scope);
   if(fresh){context=fresh;const saved={...fresh};delete saved.csrfToken;await save(scope+':context',saved);}else{const row=await read(scope+':context');if(row)context=await decrypt(row);}
   if(!context||context.expiresAt<Date.now()){status('Reconnect and sign in to unlock offline capture.');return false;}
   return true;
  })().catch(()=>{status('Offline storage is unavailable. Keep this form open and reconnect before submitting.');return false;});
  return initializing;
 }
 function allowed(form){return form.method.toLowerCase()==='post'&&routes.has(new URL(form.action,location.origin).pathname)&&new URL(form.action,location.origin).origin===location.origin;}
 const preparedFields=new Set(['currency','network','paymentMethod','transferMethod','settlementMethod','operation','rateId']);
 function blueprint(form){
  const action=new URL(form.action,location.origin).pathname,fields=[];
  for(const input of form.elements){if(!input.name||['_csrf','idempotencyKey'].includes(input.name)||!['INPUT','SELECT','TEXTAREA'].includes(input.tagName)||['password','file','submit','button','checkbox','radio'].includes(input.type))continue;
   const field={name:input.name,label:input.closest('label')?.childNodes[0]?.textContent?.trim()||input.getAttribute('aria-label')||input.name,type:input.type==='hidden'?'hidden':input.tagName==='SELECT'?'select':input.tagName==='TEXTAREA'?'textarea':input.type||'text',value:input.value,required:input.required,maxLength:input.maxLength>0?input.maxLength:400,minLength:input.minLength>0?input.minLength:0,pattern:input.pattern||'',readOnly:input.readOnly,disabled:input.disabled};
   if(field.type==='select')field.options=[...input.options].map(option=>({value:option.value,label:option.textContent,disabled:option.disabled,hidden:option.hidden}));fields.push(field);
  }
  for(const field of fields)if(!['hidden','select'].includes(field.type)&&!field.readOnly&&!['fee','commission','validDays'].includes(field.name))field.value='';
  const choices=fields.filter(field=>preparedFields.has(field.name)),description=choices.filter(field=>['currency','network','operation','paymentMethod','transferMethod'].includes(field.name)).map(field=>field.value).filter(Boolean).join(' · ');
  return {type:'template',action,branchId:context.branchId,preparedAt:Date.now(),label:operationLabel(action,form)+(description?' · '+description:''),fields};
 }
 async function remember(form){if(!allowed(form)||!context||!navigator.onLine)return;const template=blueprint(form);if(template.fields.some(field=>preparedFields.has(field.name)&&field.required&&!field.value))return;const identity=JSON.stringify([template.action,...template.fields.filter(field=>preparedFields.has(field.name)).map(field=>[field.name,field.value])]),hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(identity)))).map(byte=>byte.toString(16).padStart(2,'0')).join('');await save(scope+':template:'+hash,template);
  const previous=(await all()).filter(row=>row.type==='template'&&row.action===template.action).sort((a,b)=>b.preparedAt-a.preparedAt);for(const old of previous.slice(20))await remove(old.id);}
 async function queue(form){
  if(!await initialize())throw Error('Visit the workspace while connected before using offline capture.');
  const values={};for(const [name,value]of new FormData(form)){if(typeof value!=='string'||name==='_csrf')continue;if(Object.hasOwn(values,name))throw Error('This form needs an online connection.');values[name]=value;}
  if(!values.idempotencyKey)values.idempotencyKey=crypto.randomUUID();
  if(JSON.stringify(values).length>24000)throw Error('This draft is too large for offline capture.');
  const action=new URL(form.action,location.origin).pathname,id=scope+':draft:'+values.idempotencyKey;
  const display=Object.entries(values).flatMap(([name,value])=>{const control=form.elements.namedItem(name);if(!value||name!=='idempotencyKey'&&control?.type==='hidden')return [];return [{label:name==='idempotencyKey'?'Local reference':control?.closest('label')?.childNodes[0]?.textContent?.trim()||name.replace(/([a-z])([A-Z])/g,'$1 $2'),value:control?.tagName==='SELECT'?control.selectedOptions[0]?.textContent||value:value}];});
  await save(id,{type:'draft',action,values,display,state:'pending',capturedAt:Date.now(),phoneCountry:context.phoneCountry,branchId:context.branchId,label:form.dataset.offlineLabel||operationLabel(action,form)});
  status('Saved on this device. Pending sync; no payment or final receipt has been issued.');
  if(onQueue)await render();else{let notice=document.querySelector('[data-offline-saved]');if(!notice){notice=node('p',undefined,'tiny');notice.dataset.offlineSaved='';notice.setAttribute('role','status');form.prepend(notice);}notice.textContent='Saved offline — pending sync. Open Offline drafts to check progress.';}
 }
 async function syncWork(){
  if(!await initialize())return;status('Checking your account and syncing pending drafts…');
  let fresh;try{fresh=await serverContext();}catch{status('Reconnect and sign in to sync. Your drafts remain on this device.');return;}
  if(fresh.scope!==scope||fresh.branchId!==context.branchId){status('Account or operating branch changed. These drafts have not been submitted. Sign in with the original account and branch to review them.');return;}
  for(const draft of (await all()).filter(row=>row.type==='draft'&&row.state==='pending').sort((a,b)=>a.capturedAt-b.capturedAt)){
   if(draft.branchId!==fresh.branchId){draft.state='needs_attention';draft.problem='Operating branch changed. Review before entering this operation again.';await save(draft.id,draft);continue;}
   let response;try{response=await fetch(draft.action,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/x-www-form-urlencoded','x-csrf-token':fresh.csrfToken,'x-classicfin-phone-country':draft.phoneCountry||context.phoneCountry||'SS'},body:new URLSearchParams({...draft.values,_csrf:fresh.csrfToken}),cache:'no-store'});}catch{status('Connection interrupted. Pending drafts will retry with the same reference.');break;}
   if(!new URL(response.url).pathname.startsWith('/tenant/')||[401,403].includes(response.status)){status('Sign in again or ask an administrator to review current access. Drafts remain pending.');break;}
   if(response.ok){await response.body?.cancel();draft.state='synced';draft.resultUrl=new URL(response.url).pathname;draft.syncedAt=Date.now();delete draft.values;delete draft.display;}
   else if(response.status===429||response.status>=500){status('The server is busy. Pending drafts will retry later.');break;}
   else{const detail=response.headers.get('content-type')?.includes('text/plain')?(await response.text()).slice(0,400):'';draft.state='needs_attention';draft.problem=`Server rejected this draft (HTTP ${response.status}). ${detail||'Review account balances, rates, references and required fields before entering it again.'}`;}
   await save(draft.id,draft);
  }
  status('Sync check complete. Only entries marked Synced were accepted by the server.');if(onQueue)await render();await updateBar();
 }
 async function sync(){if(navigator.locks)return navigator.locks.request('classicfin-offline-sync',{ifAvailable:true},lock=>lock?syncWork():undefined);return syncWork();}
 async function render(){
  if(!onQueue||!await initialize())return;document.getElementById('offlineIdentity').textContent=context.tenantName+' · '+context.userName;
  const rows=await all(),list=document.getElementById('offlineQueue'),templates=document.getElementById('offlineTemplates');list.replaceChildren();templates.replaceChildren();
  for(const template of rows.filter(row=>row.type==='template'&&row.branchId===context.branchId)){const button=node('button',template.label);button.type='button';button.addEventListener('click',()=>edit(template));templates.append(button);}
  const drafts=rows.filter(row=>row.type==='draft').sort((a,b)=>b.capturedAt-a.capturedAt);
  if(!drafts.length)list.append(node('p','No pending drafts on this device.'));
  for(const draft of drafts){const card=node('article',undefined,'offline-card');card.append(node('strong',draft.label+' — '+({pending:'Pending sync',synced:'Synced',needs_attention:'Needs attention'}[draft.state])),node('p',new Date(draft.capturedAt).toLocaleString()));
   if(draft.values){const details=node('details'),summary=node('summary','Review captured details');const facts=node('dl',undefined,'offline-result');for(const field of draft.display||Object.entries(draft.values).map(([label,value])=>({label,value})))facts.append(node('dt',field.label),node('dd',field.value));details.append(summary,facts);card.append(details);}
   if(draft.problem)card.append(node('p',draft.problem));if(draft.resultUrl){const link=node('a','Open accepted record');link.href=draft.resultUrl;card.append(link);}
   const discard=node('button',draft.state==='synced'?'Clear local status':'Discard local draft');discard.type='button';discard.addEventListener('click',async()=>{if(draft.state!=='synced'&&!confirm('Discard this device draft? Check server records first if a submission may already have reached the server.'))return;await remove(draft.id);await render();});card.append(discard);list.append(card);
  }
 }
 function edit(template){
  const holder=document.getElementById('offlineEditor');holder.replaceChildren(node('h2',template.label));holder.hidden=false;
  const form=node('form',undefined,'offline-form');form.method='post';form.action=template.action;form.dataset.offlineLabel=template.label;
  const identity=node('input');identity.type='hidden';identity.name='idempotencyKey';identity.value=crypto.randomUUID();form.append(identity);
  for(const field of template.fields){const label=node('label',field.label);let input;
   if(field.type==='select'){input=node('select');for(const choice of field.options){if(preparedFields.has(field.name)&&choice.value!==field.value)continue;const option=node('option',choice.label);option.value=choice.value;option.disabled=choice.disabled;option.hidden=choice.hidden;input.append(option);}}
   else if(field.type==='textarea')input=node('textarea');else{input=node('input');input.type=field.type;}
   input.name=field.name;input.value=field.value;input.required=field.required;input.disabled=field.disabled;input.readOnly=field.readOnly;if(field.pattern)input.pattern=field.pattern;if(field.maxLength)input.maxLength=field.maxLength;if(field.minLength)input.minLength=field.minLength;
   // Start a fresh customer instruction; retain configured selectors only.
   if(input.tagName!=='SELECT'&&input.type!=='hidden'&&!input.readOnly&&!['fee','commission','validDays'].includes(input.name))input.value='';
   label.hidden=field.type==='hidden';label.append(input);form.append(label);
  }
  const button=node('button','Save pending draft');button.type='submit';form.append(button);holder.append(form);form.addEventListener('submit',event=>{event.preventDefault();queue(form).then(()=>{holder.hidden=true;if(navigator.onLine)return sync();}).catch(error=>status(error.message));});
 }
 async function updateBar(){const target=document.querySelector('[data-offline-message]');if(!target||!context)return;const pending=(await all()).filter(row=>row.type==='draft'&&row.state!=='synced').length;target.textContent=(navigator.onLine?'Connected':'Offline')+(pending?' · '+pending+' pending':'');}
 document.addEventListener('change',event=>{const form=event.target.closest?.('form');if(form&&navigator.onLine&&!onQueue)setTimeout(()=>remember(form).catch(()=>{}),0);});
 document.addEventListener('submit',event=>{
  const form=event.target;if(form.action?.endsWith('/logout')){locked=true;sessionStorage.removeItem(keyName);context=null;scope=null;key=null;return;}
  if(onQueue||navigator.onLine||!allowed(form))return;event.preventDefault();event.stopImmediatePropagation();queue(form).catch(error=>{status(error.message);alert(error.message);});
 },true);
 async function start(){
  if(!await initialize())return;
  if(onQueue){await render();document.getElementById('offlineSync').addEventListener('click',()=>sync().catch(()=>status('Sync could not complete. Your drafts remain stored.')));document.getElementById('offlineRefresh').addEventListener('click',()=>render());}
  else{const bar=node('div',undefined,'offline-bar');const message=node('span');message.dataset.offlineMessage='';const link=node('a','Offline drafts');link.href='/offline.html';bar.append(message,link);document.querySelector('#sidePanel .sideFoot')?.append(bar);const rememberAll=()=>document.querySelectorAll('form').forEach(form=>remember(form).catch(()=>{}));rememberAll();new MutationObserver(rememberAll).observe(document.body,{subtree:true,childList:true});}
  await updateBar();if(navigator.onLine)await sync();
 }
 window.addEventListener('online',()=>sync().catch(()=>status('Sync interrupted. Drafts remain pending.')));window.addEventListener('offline',()=>updateBar());
 if('serviceWorker' in navigator&&!onQueue)navigator.serviceWorker.register('/offline-runtime.js',{scope:'/'}).catch(()=>status('Offline navigation is unavailable in this browser.'));
 start().catch(()=>status('Offline storage could not open. Reconnect before submitting.'));
})();
