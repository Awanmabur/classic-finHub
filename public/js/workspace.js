'use strict';
(()=>{
 let lastTrigger=null;
 const close=dialog=>{dialog?.close();lastTrigger?.focus();};
 document.addEventListener('click',async event=>{
  const trigger=event.target.closest('[data-workspace-open]');
  if(trigger){const dialog=document.getElementById(trigger.dataset.workspaceOpen);if(!dialog||typeof dialog.showModal!=='function')return;event.preventDefault();lastTrigger=trigger;dialog.showModal();dialog.querySelector('input:not([type=hidden]),select,textarea')?.focus();return;}
  const cancel=event.target.closest('[data-workspace-close]');if(cancel){const dialog=cancel.closest('dialog');if(dialog)close(dialog);else window.history.back();return;}
  const edit=event.target.closest('a[data-workspace-edit]');if(!edit)return;
  event.preventDefault();lastTrigger=edit;const dialog=document.getElementById('workspaceRemoteEditor');if(!dialog){window.location.assign(edit.href);return;}
  edit.setAttribute('aria-busy','true');
  try{
   const response=await (window.ClassicFinOffline?.pageResponse||fetch)(edit.href,{headers:{Accept:'text/html'},credentials:'same-origin'});
   if(!response.ok||response.redirected)throw new Error('Unable to open the form');
   const parsed=new DOMParser().parseFromString(await response.text(),'text/html'),form=parsed.querySelector('[data-workspace-form]');
   if(!form)throw new Error('Form unavailable');
   // Only server-rendered, same-origin form markup is accepted. Scripts are never copied.
   const action=new URL(form.getAttribute('action'),window.location.origin);if(action.origin!==window.location.origin||!action.pathname.startsWith('/tenant/workspace/'))throw new Error('Invalid form action');
   form.querySelectorAll('script').forEach(script=>script.remove());dialog.querySelector('[data-workspace-editor-body]').replaceChildren(document.importNode(form,true));
   dialog.querySelector('[data-workspace-editor-title]').textContent=form.dataset.workspaceTitle||'Edit workspace record';dialog.showModal();dialog.querySelector('input:not([type=hidden]),select,textarea')?.focus();
  }catch{window.location.assign(edit.href);}finally{edit.removeAttribute('aria-busy');}
 });
 document.querySelectorAll('dialog.workspaceDialog').forEach(dialog=>{
  dialog.addEventListener('cancel',event=>{event.preventDefault();close(dialog);});
  dialog.addEventListener('click',event=>{if(event.target===dialog){const rect=dialog.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)close(dialog);}});
 });
})();
