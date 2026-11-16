'use strict';
(() => {
  // Modal forms are inserted after script load. Initialize each form once.
  const bindings=new WeakSet();
  function initialise(form){
    if(!form?.matches?.('[data-mobile-money-form]')||bindings.has(form))return;
    bindings.add(form);
    const area=form.querySelector('[data-mobile-provider-quote]');
    if(!area)return;
    const commission=area.querySelector('[data-mobile-agent-commission]');
    const charge=area.querySelector('[data-mobile-provider-charge]');
    const note=area.querySelector('[data-mobile-quote-note]');
    const commissionRow=area.querySelector('[data-quote-commission-row]');
    const chargeRow=area.querySelector('[data-quote-customer-row]');
    const hide=()=>{area.hidden=true;if(commissionRow)commissionRow.hidden=true;if(chargeRow)chargeRow.hidden=true;};
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
        hide();
        return;
      }
      hide();
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
          const hasCommission=Boolean(data.agentCommission?.amount);
          const hasCharge=Boolean(data.customerNetworkCharge?.amount);
          if(commissionRow)commissionRow.hidden=!hasCommission;
          if(chargeRow)chargeRow.hidden=!hasCharge;
          commission.textContent=hasCommission?label(data.agentCommission):'';
          charge.textContent=hasCharge?label(data.customerNetworkCharge):'';
          if(!hasCommission&&!hasCharge){hide();return;}
          area.hidden=false;
          note.textContent=data.customerNetworkCharge?.source==='historical_reference'?
            'Historical rates: confirm current provider charges.':
            'Provider estimates only. Commission is recorded as income when actually received.';
        }catch(e){
          if(requestId!==pending||e.name==='AbortError')return;
          hide();
          note.textContent='Provider rates could not be checked. Do not assume commission or network charges.';
          area.hidden=false;
        }
      },220);
    };
    for(const control of [market,currency,amount])for(const eventName of ['input','change'])control?.addEventListener(eventName,preview);
    const observer=new MutationObserver(preview);
    observer.observe(form,{attributes:true,attributeFilter:['data-operation']});
    preview();
  }
  window.ClassicFinMobileQuote=Object.freeze({initialise});
  document.querySelectorAll('[data-mobile-money-form]').forEach(initialise);
})();
