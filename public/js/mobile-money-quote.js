'use strict';
(() => {
  const fields=document.querySelectorAll('[data-mobile-money-form]');
  for(const form of fields){
    const area=form.querySelector('[data-mobile-provider-quote]');
    if(!area)continue;
    const commission=area.querySelector('[data-mobile-agent-commission]');
    const charge=area.querySelector('[data-mobile-provider-charge]');
    const note=area.querySelector('[data-mobile-quote-note]');
    const market=form.elements.namedItem('network');
    const currency=form.elements.namedItem('currency');
    const amount=form.elements.namedItem('amount');
    let pending=0,abortController=null,delay=null;
    const preview=()=>{
      clearTimeout(delay);
      if(abortController)abortController.abort();
      const requestId=++pending;
      const currencyCode=currency?.value||'';
      const marketCode=market?.value||'';
      const number=amount?.value?.trim()||'';
      const scale=currencyCode==='UGX'?0:2;
      const valid=scale===0?/^(?:0|[1-9]\d{0,10})$/:/^(?:0|[1-9]\d{0,10})(?:\.\d{1,2})?$/;
      if(!marketCode||!currencyCode||!valid.test(number)||!Number(number)){
        commission.textContent='Enter a valid amount';
        charge.textContent='Enter a valid amount';
        note.textContent='Select a network and amount to check any approved provider sheets. Provider rates are estimates only.';
        return;
      }
      commission.textContent='Checking approved rate…';
      charge.textContent='Checking approved rate…';
      delay=setTimeout(async()=>{
        abortController=new AbortController();
        try{
          const url=new URL('/tenant/mobile-money/quote',location.origin);
          url.searchParams.set('network',marketCode);
          url.searchParams.set('currency',currencyCode);
          url.searchParams.set('operation',form.dataset.operation||'cash_in');
          url.searchParams.set('amount',number);
          const result=await fetch(url.toString(),{credentials:'same-origin',cache:'no-store',signal:abortController.signal,headers:{Accept:'application/json'}});
          const data=await result.json();
          if(requestId!==pending)return;
          if(!result.ok)throw new Error(data.error||'Quote is currently unavailable');
          const label=value=>value?.amount?
            value.amount+(value.source==='published_reference'?' · published reference only':value.source==='historical_reference'?' · historical reference only — verify provider':' · approved-sheet estimate'):null;
          commission.textContent=label(data.agentCommission)||'Not configured — request approved agent rate sheet';
          charge.textContent=label(data.customerNetworkCharge)||'No matching published or approved charge';
          note.textContent=data.note||'Agent earnings are estimates until the network settles the provider commission.';
        }catch(e){
          if(requestId!==pending||e.name==='AbortError')return;
          commission.textContent='Not available';
          charge.textContent='Not available';
          note.textContent='A verified quote could not be retrieved. Do not assume any provider commission or charge.';
        }
      },220);
    };
    for(const control of [market,currency,amount])for(const eventName of ['input','change'])control?.addEventListener(eventName,preview);
    const observer=new MutationObserver(preview);
    observer.observe(form,{attributes:true,attributeFilter:['data-operation']});
    preview();
  }
})();
