'use strict';
(()=>{
 let lastTrigger=null;
 const close=dialog=>{dialog?.close();lastTrigger?.focus();};
 const MAX_UPLOAD=3*1024*1024;
 const galleryValues=value=>String(value||'').split(/[\n,]+/).map(v=>v.trim()).filter(Boolean);
 const imageField=(form,kind)=>form?.elements.namedItem(kind==='logo'?'logoUrl':kind==='cover'?'coverUrl':'gallery');
 const renderPhotos=form=>{
  if(!form)return;
  form.querySelectorAll('[data-r2-preview-kind]').forEach(container=>{
   const kind=container.dataset.r2PreviewKind,field=imageField(form,kind);
   const urls=kind==='gallery'?galleryValues(field?.value):field?.value?[field.value]:[];
   container.replaceChildren();
   if(!urls.length){
    const empty=document.createElement('p');
    empty.className='tiny';empty.textContent='No photo selected';
    container.append(empty);return;
   }
   urls.forEach((url,index)=>{
    if(!/^https:\/\//i.test(url))return;
    const card=document.createElement('div');card.className='workspacePhotoItem';
    const img=document.createElement('img');img.src=url;img.alt=kind==='gallery'?'Gallery photo '+(index+1):kind==='logo'?'Business logo':'Business cover';img.loading='lazy';img.decoding='async';
    const remove=document.createElement('button');remove.type='button';remove.className='btn';remove.textContent=kind==='gallery'?'Remove photo':'Remove';
    remove.dataset.r2RemoveImage=kind;remove.dataset.r2RemoveIndex=String(index);
    card.append(img,remove);container.append(card);
   });
  });
 };
 const toWebP=async file=>{
  let image=null,sourceUrl=null,bitmap=null;
  try{
   if(typeof createImageBitmap==='function'){
    try{bitmap=await createImageBitmap(file,{imageOrientation:'from-image'});}
    catch{bitmap=null;}
   }
   if(!bitmap){
    sourceUrl=URL.createObjectURL(file);
    image=new Image();
    image.src=sourceUrl;
    await image.decode();
   }
   const width=bitmap?.width||image.naturalWidth,height=bitmap?.height||image.naturalHeight;
   if(!width||!height||width*height>40_000_000)throw Error('This photo has too many pixels. Choose a smaller photo.');
   const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d');
   if(!ctx)throw Error('Photo optimization is unavailable in this browser.');
   for(const max of [1800,1400,1100,900,720]){
    const ratio=Math.min(1,max/Math.max(width,height));
    canvas.width=Math.max(1,Math.round(width*ratio));
    canvas.height=Math.max(1,Math.round(height*ratio));
    ctx.drawImage(bitmap||image,0,0,canvas.width,canvas.height);
    for(const quality of [.82,.7,.56]){
     const result=await new Promise(resolve=>canvas.toBlob(resolve,'image/webp',quality));
     if(!result||result.type!=='image/webp'){
      if(file.size<=MAX_UPLOAD)return file;
      throw Error('This browser cannot optimize the photo. Choose a photo smaller than 3 MB.');
     }
     if(result.size>0&&result.size<=MAX_UPLOAD)return result;
    }
   }
   throw Error('Photo is too large after optimization. Use a smaller image.');
  }finally{
   bitmap?.close?.();
   if(sourceUrl)URL.revokeObjectURL(sourceUrl);
  }
 };
 document.addEventListener('change',async event=>{
   const input=event.target.closest?.('[data-r2-image-kind]');
   if(!input||!input.files?.length)return;
   const form=input.closest('form[data-workspace-form]');
   const status=form?.querySelector('[data-r2-upload-status]');
   const kind=input.dataset.r2ImageKind,file=input.files[0];
   if(!form||!status||!['logo','cover','gallery'].includes(kind))return;
   if(file.size>20*1024*1024){
     status.textContent='Source image exceeds 20 MB. Please resize it before upload.';
     input.value='';return;
   }
   const field=imageField(form,kind);
   if(!field)return;
   if(kind==='gallery'&&galleryValues(field.value).length>=8){
     status.textContent='Your gallery is full (8 photos). Remove a photo first.';
     input.value='';return;
   }
   const submit=[...form.querySelectorAll('button[type=submit]')];
   submit.forEach(button=>button.disabled=true);input.disabled=true;
   status.textContent='Optimizing and uploading '+kind+' image…';
   try{
     const image=await toWebP(file);
     if(image.size>MAX_UPLOAD)throw Error('Photo is too large after optimization. Choose a smaller image.');
     const response=await fetch('/tenant/workspace/media/'+kind,{
       method:'POST',credentials:'same-origin',
       headers:{'Content-Type':image.type,'x-csrf-token':form.querySelector('[name=_csrf]')?.value||'',
         'Accept':'application/json','X-ClassicFin-Background':'true'},
       body:image,cache:'no-store',signal:AbortSignal.timeout(20000)
     });
     if(!response.ok)throw Error(response.status===503?'R2 storage is not yet configured or is unavailable. Ask the platform operator to check the private image-storage setup.':
       response.status===403?'Your session or upload permission has changed. Reload and sign in again.':
       response.status===413?'The site gateway rejected this photo. Please report the upload-size configuration to the platform operator.':
       'Upload failed (HTTP '+response.status+'). No website change was saved.');
     const result=await response.json();
     if(!result.url||!/^https:\/\//.test(result.url))throw Error('Storage returned an invalid image link.');
     if(kind==='gallery'){
       const entries=galleryValues(field.value);
       if(!entries.includes(result.url))entries.push(result.url);
       field.value=entries.join('\n');
     }else field.value=result.url;
     field.dispatchEvent(new Event('input',{bubbles:true}));
     renderPhotos(form);
     status.textContent=kind.charAt(0).toUpperCase()+kind.slice(1)+' image uploaded to R2. Save changes, then publish your website to make the new image visible.';
   }catch(error){status.textContent=error?.message||'Image upload failed. Existing website content is unchanged.';}
   finally{submit.forEach(button=>button.disabled=false);input.disabled=false;input.value='';}
 });

 document.addEventListener('click',async event=>{
  const remove=event.target.closest('[data-r2-remove-image]');
  if(remove){
   const form=remove.closest('form[data-workspace-form]'),kind=remove.dataset.r2RemoveImage;
   const field=imageField(form,kind);
   if(!field)return;
   if(kind==='gallery'){
    const entries=galleryValues(field.value),index=Number(remove.dataset.r2RemoveIndex);
    if(!Number.isInteger(index)||index<0||index>=entries.length)return;
    entries.splice(index,1);field.value=entries.join('\\n');
   }else field.value='';
   field.dispatchEvent(new Event('input',{bubbles:true}));
   renderPhotos(form);
   const status=form?.querySelector('[data-r2-upload-status]');
   if(status)status.textContent='Photo removed from this draft. Save changes and publish to update the live website.';
   return;
  }
  const mediaCopy=event.target.closest('[data-media-copy-url]');
  if(mediaCopy){
   try{
    await navigator.clipboard.writeText(mediaCopy.dataset.mediaCopyUrl);
    mediaCopy.textContent='Copied';mediaCopy.setAttribute('aria-live','polite');
   }catch{mediaCopy.textContent='Copy this image link manually from the website editor';}
   return;
  }
  const copier=event.target.closest('[data-website-copy-path]');
  if(copier){
   const url=new URL(copier.dataset.websiteCopyPath,window.location.origin);
   if(url.origin!==window.location.origin||!url.pathname.startsWith('/t/'))return;
   try{await navigator.clipboard.writeText(url.href);copier.textContent='Profile link copied';copier.setAttribute('aria-live','polite');}
   catch{copier.textContent='Open the profile and copy its address';}
   return;
  }
  const trigger=event.target.closest('[data-workspace-open]');
  if(trigger){const dialog=document.getElementById(trigger.dataset.workspaceOpen);if(!dialog||typeof dialog.showModal!=='function')return;event.preventDefault();lastTrigger=trigger;dialog.showModal();renderPhotos(dialog.querySelector('form[data-workspace-form]'));dialog.querySelector('input:not([type=hidden]),select,textarea:not([hidden])')?.focus();return;}
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
   dialog.querySelector('[data-workspace-editor-title]').textContent=form.dataset.workspaceTitle||'Edit workspace record';dialog.showModal();renderPhotos(dialog.querySelector('form[data-workspace-form]'));dialog.querySelector('input:not([type=hidden]),select,textarea:not([hidden])')?.focus();
  }catch{window.location.assign(edit.href);}finally{edit.removeAttribute('aria-busy');}
 });
 document.querySelectorAll('form[data-workspace-form]').forEach(renderPhotos);
 document.querySelectorAll('dialog.workspaceDialog').forEach(dialog=>{
  dialog.addEventListener('cancel',event=>{event.preventDefault();close(dialog);});
  dialog.addEventListener('click',event=>{if(event.target===dialog){const rect=dialog.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)close(dialog);}});
 });
})();
