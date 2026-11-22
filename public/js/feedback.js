'use strict';
(() => {
  const submitting=new WeakSet(),restorers=new Set();
  const headers=Object.freeze({'X-ClassicFin-Redirect':'json','X-ClassicFin-Background':'true'});
  function show(message,type='bad',{form,focus=true}={}){
    // Show input/submit errors immediately above the FORM that needs fixing.
    // Without a form (for example a global action), keep workspace-level feedback.
    // Validation errors belong beside their fields. All operational updates
    // (including successful payments) use the same centered notice surface.
    const host=type==='bad'&&form?.isConnected&&form.matches?.('form')?form:
      document.querySelector('main.panel.main')||document.querySelector('main')||document.body;
    const previous=host.querySelector(':scope > [data-session-flash]');
    if(previous)previous.dataset.feedbackMessage='';
    let target=[...host.children].find(node=>node.matches?.('[data-feedback-message]'));
    if(!target){target=document.createElement('div');target.dataset.feedbackMessage='';target.tabIndex=-1;const icon=document.createElement('span');icon.className='feedbackIcon';icon.setAttribute('aria-hidden','true');const content=document.createElement('div');content.className='feedbackContent';content.append(document.createElement('strong'),document.createElement('p'));const dismiss=document.createElement('button');dismiss.type='button';dismiss.className='feedbackDismiss';dismiss.dataset.feedbackDismiss='';dismiss.setAttribute('aria-label','Dismiss message');dismiss.textContent='×';target.append(icon,content,dismiss);host.prepend(target);}
    const kind=type==='good'?'good':type==='info'?'info':'bad';target.className='sessionFeedback feedback-'+kind;target.hidden=false;target.setAttribute('role',kind==='bad'?'alert':'status');target.querySelector('.feedbackIcon').textContent=kind==='bad'?'!':kind==='good'?'✓':'i';target.querySelector('.feedbackContent>strong').textContent=kind==='bad'?'Please check':kind==='good'?'Done':'Information';target.querySelector('.feedbackContent>p').textContent=String(message||'Please review this action.');
    if(focus){target.focus({preventScroll:true});if(!target.closest('main.panel.main'))target.scrollIntoView({block:'nearest',behavior:'instant'});}scheduleSoftDismiss(target);return target;
  }
  async function response(result){
    const type=result.headers.get('content-type')||'';
    if(type.includes('application/json')){const value=await result.json();if(typeof value.redirect==='string'){const destination=new URL(value.redirect,location.origin);if(destination.origin!==location.origin)throw Error('Unexpected response destination');return{redirect:destination.href,flash:value.flash};}return{message:typeof value.message==='string'?value.message:'The action could not be completed.'};}
    if(type.includes('text/plain'))return{message:(await result.text()).slice(0,800)};
    if(type.includes('text/html')){const html=new DOMParser().parseFromString(await result.text(),'text/html'),error=html.querySelector('[role="alert"],[data-form-error],.err.show');const detail=error?.querySelector('.feedbackContent > p')?.textContent||error?.querySelector('[data-feedback-text]')?.textContent||error?.textContent;return{message:(detail||(!html.body.children.length?html.body.textContent:'')).trim().slice(0,800)||'The action could not be completed. Please review the details.'};}
    return{message:'The action could not be completed. Please try again when connected.'};
  }

  // Success flashes are confirmations, not permanent dashboard banners.
  // Errors remain until dismissed; never hide a failed transaction automatically.
  const dismissTimers=new WeakMap();
  function scheduleSoftDismiss(node){
    if(!node||!node.matches?.('.main > [data-feedback-message]'))return;
    if(!node.classList.contains('feedback-good')&&!node.classList.contains('feedback-info'))return;
    if(dismissTimers.has(node))clearTimeout(dismissTimers.get(node));
    node.style.setProperty('--feedback-duration','4800ms');
    const timer=setTimeout(()=>{
      dismissTimers.delete(node);
      if(node.isConnected&&!node.matches(':focus-within'))node.remove();
    },4800);
    dismissTimers.set(node,timer);
  }
  document.querySelectorAll('main.panel.main > [data-session-flash]').forEach(scheduleSoftDismiss);

  window.ClassicFinFeedback=Object.freeze({show,response,headers});
  document.addEventListener('click',event=>{const button=event.target.closest('[data-feedback-dismiss]');if(button){const node=button.closest('[data-feedback-message]');if(node){if(dismissTimers.has(node))clearTimeout(dismissTimers.get(node));node.remove();}}});
  document.querySelectorAll('[data-session-flash][role="alert"]').forEach(target=>{target.focus({preventScroll:true});target.scrollIntoView({block:'nearest',behavior:'instant'});});
  // Browser constraint validation already displays one accessible field-specific
  // message. Do not echo the same "Please fill out this field" in a second flash
  // (and never emit one notification per invalid field).

  document.addEventListener('submit',async event=>{
    const form=event.target;if(event.defaultPrevented||!(form instanceof HTMLFormElement)||form.method.toLowerCase()!=='post'||form.target&&form.target!=='_self'||form.hasAttribute('data-feedback-skip')||form.enctype==='multipart/form-data'||!navigator.onLine)return;
    const action=new URL(event.submitter?.getAttribute('formaction')||form.action,location.origin);
    // These handoffs render private one-time HTML or use the dedicated,
    // durable financial submission handlers. Preserve their normal behavior.
    if(action.origin!==location.origin||action.pathname==='/logout'||action.pathname==='/tenant/view-branch'||/^\/platform\/tenants(?:\/[a-f0-9]{24}\/owner-invitation)?\/?$/i.test(action.pathname)||/\/reveal-pin\/?$/i.test(action.pathname)||action.pathname==='/tenant/backups/action'||action.pathname==='/tenant/users/invite'||form.matches('[data-mobile-money-form],[data-transfer-form],[data-forex-form],[data-funded-form],[data-payout-form],[data-expense-form]'))return;
    event.preventDefault();if(submitting.has(form)||!form.reportValidity())return;
    const fields=new URLSearchParams(new FormData(form));if(event.submitter?.name)fields.append(event.submitter.name,event.submitter.value);
    const buttons=[...form.elements].filter(node=>node.tagName==='BUTTON'&&node.type==='submit'),states=buttons.map(button=>({button,disabled:button.disabled,html:button.innerHTML}));
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
    const restore=()=>{clearTimeout(timer);submitting.delete(form);form.removeAttribute('aria-busy');states.forEach(({button,disabled,html})=>{button.disabled=disabled;button.innerHTML=html;});restorers.delete(restore);};
    submitting.add(form);restorers.add(restore);form.setAttribute('aria-busy','true');states.forEach(({button})=>{button.disabled=true;button.textContent=action.pathname==='/signin'?'Signing in…':'Submitting…';});show(action.pathname==='/signin'?'Checking your account…':'Saving your request…','info',{form,focus:false});
    try{
      const result=await fetch(action,{method:'POST',credentials:'same-origin',headers:{...headers,'Content-Type':'application/x-www-form-urlencoded',Accept:'application/json, text/plain, text/html'},body:fields,signal:controller.signal});
      const outcome=await response(result);
      if(result.ok&&outcome.redirect){if(outcome.flash?.type==='bad'){show(outcome.flash.message,'bad',{form});return;}location.assign(outcome.redirect);return;}
      if(result.redirected&&result.ok&&new URL(result.url).origin===location.origin){location.assign(result.url);return;}
      show(outcome.message||'The action could not be completed.','bad',{form});
    }catch{show('The connection was interrupted. Your form is still here. Check whether the action completed before trying again.','bad',{form});}
    finally{restore();}
  });
  window.addEventListener('pageshow',()=>{for(const restore of [...restorers])restore();});
})();
