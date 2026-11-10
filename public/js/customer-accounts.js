'use strict';
(()=>{
 const boundForms=new WeakSet();
 function initialiseForm(form){
  if(!form||boundForms.has(form))return;boundForms.add(form);
  const lookup=form.querySelector('[data-customer-lookup]'),choices=form.querySelector('[data-customer-choices]'),status=form.querySelector('[data-customer-search-status]');
  if(!lookup||!choices||!status)return;
  let timer,controller;
  lookup.addEventListener('input',()=>{clearTimeout(timer);controller?.abort();timer=setTimeout(async()=>{
   controller=new AbortController();const request=controller;let timedOut=false;const timeout=setTimeout(()=>{timedOut=true;request.abort();},10000);status.textContent='Searching customers…';
   try{
    const response=await fetch('/tenant/accounts/customer-options?q='+encodeURIComponent(lookup.value),{signal:request.signal,credentials:'same-origin',headers:{Accept:'application/json'}});
    if(!response.ok)throw Error('Search unavailable');
    const data=await response.json();if(request!==controller)return;
    choices.replaceChildren(new Option('Select customer',''));
    data.items.forEach(c=>choices.add(new Option(`${c.name} · ${c.phone} · ${c.reference}`,c._id)));
    status.textContent=data.items.length?`${data.items.length} customer(s) found.`:'No active customers match this search in your operating branch.';
   }catch(error){if(request===controller&&(timedOut||error.name!=='AbortError'))status.textContent='Customer search is unavailable. Try again when connected.';}finally{clearTimeout(timeout);}
  },250);});
 }
 window.ClassicFinDirectory=Object.freeze({initialiseForm});
 document.querySelectorAll('#directoryForm').forEach(initialiseForm);
 const dialog=document.querySelector('[data-directory-dialog]');if(!dialog)return;
 let opener=null;
 function open(button){opener=button||null;if(dialog.open)dialog.close();dialog.showModal();document.body.classList.add('transactionOpen');}
 document.querySelectorAll('[data-directory-open]').forEach(button=>button.addEventListener('click',event=>{event.preventDefault();open(button);}));
 dialog.querySelector('[data-directory-clear]')?.addEventListener('click',()=>dialog.querySelector('form')?.reset());
 dialog.querySelectorAll('[data-directory-close]').forEach(button=>button.addEventListener('click',()=>dialog.close()));
 dialog.addEventListener('close',()=>{document.body.classList.remove('transactionOpen');opener?.focus();});
 dialog.addEventListener('click',event=>{if(event.target===dialog){const box=dialog.getBoundingClientRect();if(event.clientX<box.left||event.clientX>box.right||event.clientY<box.top||event.clientY>box.bottom)dialog.close();}});
 if(dialog.hasAttribute('data-directory-auto-open'))open();
})();
