'use strict';
(()=>{
 let lastTrigger=null;
 const close=dialog=>{dialog?.close();lastTrigger?.focus();};
 const toWebP=async file=>{
   if(typeof createImageBitmap!=='function')return file;
   let bitmap;
   try{
     bitmap=await createImageBitmap(file,{imageOrientation:'from-image'});
     const max=1800,ratio=Math.min(1,max/Math.max(bitmap.width,bitmap.height));
     const canvas=document.createElement('canvas');
     canvas.width=Math.max(1,Math.round(bitmap.width*ratio));
     canvas.height=Math.max(1,Math.round(bitmap.height*ratio));
     const ctx=canvas.getContext('2d');
     if(!ctx)throw Error('Canvas unavailable');
     ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);
     const converted=await new Promise(resolve=>canvas.toBlob(resolve,'image/webp',.84));
     return converted&&converted.type==='image/webp'&&converted.size>0?converted:file;
   }finally{bitmap?.close?.();}
 };
 document.addEventListener('change',async event=>{
   const input=event.target.closest?.('[data-r2-image-kind]');
   if(!input||!input.files?.length)return;
   const form=input.closest('form[data-workspace-form]');
   const status=form?.querySelector('[data-r2-upload-status]');
   const kind=input.dataset.r2ImageKind,file=input.files[0];
   if(!form||!status||!['logo','cover','gallery'].includes(kind))return;
   const field=form.elements.namedItem(kind==='logo'?'logoUrl':kind==='cover'?'coverUrl':'gallery');
   if(!field)return;
   if(kind==='gallery'&&String(field.value||'').split(/[\n,]+/).filter(Boolean).length>=8){
     status.textContent='The gallery already contains eight images. Remove one link first.';
     input.value='';return;
   }
   const submit=[...form.querySelectorAll('button[type=submit]')];
   submit.forEach(button=>button.disabled=true);input.disabled=true;
   status.textContent='Optimizing and uploading '+kind+' image…';
   try{
     let image=file;
     try{image=await toWebP(file);}catch{image=file;}
     if(image.size>3*1024*1024)throw Error('Image is larger than 3 MB after optimization. Resize it first.');
     const response=await fetch('/tenant/workspace/media/'+kind,{
       method:'POST',credentials:'same-origin',
       headers:{'Content-Type':image.type,'x-csrf-token':form.querySelector('[name=_csrf]')?.value||'',
         'Accept':'application/json','X-ClassicFin-Background':'true'},
       body:image,cache:'no-store',signal:AbortSignal.timeout(20000)
     });
     if(!response.ok)throw Error(response.status===503?'R2 storage is not yet configured or is unavailable. Ask the platform operator to check the private image-storage setup.':
       response.status===403?'Your session or upload permission has changed. Reload and sign in again.':
       response.status===413?'Image exceeds the configured upload limit.':
       'Upload failed (HTTP '+response.status+'). No website change was saved.');
     const result=await response.json();
     if(!result.url||!/^https:\/\//.test(result.url))throw Error('Storage returned an invalid image link.');
     if(kind==='gallery'){
       const entries=String(field.value||'').split(/[\n,]+/).map(value=>value.trim()).filter(Boolean);
       if(!entries.includes(result.url))entries.push(result.url);
       field.value=entries.join('\n');
     }else field.value=result.url;
     field.dispatchEvent(new Event('input',{bubbles:true}));
     status.textContent=kind.charAt(0).toUpperCase()+kind.slice(1)+' image uploaded to R2. Save changes, then publish your website to make the new image visible.';
   }catch(error){status.textContent=error?.message||'Image upload failed. Existing website content is unchanged.';}
   finally{submit.forEach(button=>button.disabled=false);input.disabled=false;input.value='';}
 });

 document.addEventListener('click',async event=>{
  const copier=event.target.closest('[data-website-copy-path]');
  if(copier){
   const url=new URL(copier.dataset.websiteCopyPath,window.location.origin);
   if(url.origin!==window.location.origin||!url.pathname.startsWith('/t/'))return;
   try{await navigator.clipboard.writeText(url.href);copier.textContent='Profile link copied';copier.setAttribute('aria-live','polite');}
   catch{copier.textContent='Open the profile and copy its address';}
   return;
  }
  const trigger=event.target.closest('[data-workspace-open]');
  if(trigger){const dialog=document.getElementById(trigger.dataset.workspaceOpen);if(!dialog||typeof dialog.showModal!=='function')return;event.preventDefault();lastTrigger=trigger;dialog.showModal();dialog.querySelector('input:not([type=hidden]),select,textarea')?.focus();return;}
  const cancel=event.target.closest('[data-workspace-close]');if(cancel){const dialog=cancel.closest('dialog');if(dialog)close(dialog);else window.history.back();return;}
  const edit=event.target.closest('a[data-workspace-edit]');if(!edit)return;
  event.preventDefault();lastTrigger=edit;const dialog=document.getElementById('workspaceRemoteEditor');if(!dialog){window.location.assign(edit.href);return;}
  edit.setAttribute('aria-busy','true');
  try{
   const response=await (window.ClassicFinOffline?.pageResponse||fetch)(edit.href,{headers:{Accept:'text/html','X-ClassicFin-Background':'true'},credentials:'same-origin',signal:AbortSignal.timeout(12000)});
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
