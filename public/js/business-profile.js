'use strict';
(() => {
  const copy=document.querySelector('[data-business-copy-url]');
  copy?.addEventListener('click',async()=>{
    const url=window.location.origin+window.location.pathname;
    try {
      await navigator.clipboard.writeText(url);
      const old=copy.textContent;copy.textContent='Link copied';
      copy.setAttribute('aria-live','polite');
      setTimeout(()=>{copy.textContent=old;},1800);
    } catch {copy.textContent='Select the address bar and copy the link';}
  });
  const dialog=document.querySelector('[data-business-gallery-dialog]');
  const items=[...document.querySelectorAll('[data-gallery-item]')];
  if(!dialog||!items.length||typeof dialog.showModal!=='function')return;
  const photo=dialog.querySelector('[data-gallery-current]');
  const count=dialog.querySelector('[data-gallery-count]');
  const original=dialog.querySelector('[data-gallery-original]');
  let index=0,startX=null;
  const choose=next=>{
    index=(next+items.length)%items.length;
    const img=items[index].querySelector('img');
    const src=img?.currentSrc||img?.src||items[index].href;
    photo.src=src;photo.alt=img?.alt||'Business gallery photo';
    original.href=items[index].href;
    count.textContent=(index+1)+' of '+items.length;
  };
  items.forEach((link,i)=>link.addEventListener('click',event=>{
    if(event.defaultPrevented||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey||event.button!==0)return;
    event.preventDefault();choose(i);dialog.showModal();
  }));
  dialog.querySelector('[data-gallery-close]')?.addEventListener('click',()=>dialog.close());
  dialog.querySelector('[data-gallery-prev]')?.addEventListener('click',()=>choose(index-1));
  dialog.querySelector('[data-gallery-next]')?.addEventListener('click',()=>choose(index+1));
  dialog.addEventListener('keydown',event=>{
    if(event.key==='ArrowLeft'){event.preventDefault();choose(index-1);}
    if(event.key==='ArrowRight'){event.preventDefault();choose(index+1);}
  });
  dialog.addEventListener('click',event=>{if(event.target===dialog)dialog.close();});
  photo.addEventListener('touchstart',event=>{startX=event.changedTouches[0]?.clientX??null;},{passive:true});
  photo.addEventListener('touchend',event=>{
    if(startX===null)return;
    const delta=(event.changedTouches[0]?.clientX??startX)-startX;
    if(Math.abs(delta)>55)choose(index+(delta<0?1:-1));
    startX=null;
  },{passive:true});
  dialog.addEventListener('close',()=>{photo.removeAttribute('src');startX=null;});
})();
