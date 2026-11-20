(() => {
  const button=document.querySelector('[data-business-copy-url]');
  if(!button)return;
  button.addEventListener('click',async()=>{
    const url=window.location.origin+window.location.pathname;
    try{
      await navigator.clipboard.writeText(url);
      const original=button.textContent;
      button.textContent='Link copied';
      button.setAttribute('aria-live','polite');
      setTimeout(()=>{button.textContent=original;},1800);
    }catch{
      button.textContent='Select the address bar and copy the link';
    }
  });
})();
