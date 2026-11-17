'use strict';
(() => {
  // The read-only quote is fetched from the authenticated tenant server.
  // Client arithmetic is used only to encode the native provider minor units.
  // A completed preview never establishes external provider settlement.
  const bound=new WeakSet();
  const minor=(raw,currency)=>{
    const scale=currency==='UGX'?0:2;
    const text=String(raw||'').trim();
    const rx=scale===0?/^(?:0|[1-9]\d{0,10})$/:/^(?:0|[1-9]\d{0,10})(?:\.\d{1,2})?$/;
    if(!rx.test(text))return null;
    const [whole,fraction='']=text.split('.');
    const result=BigInt(whole)*10n**BigInt(scale)+BigInt(fraction.padEnd(scale,'0')||'0');
    return result>0n?String(result):null;
  };
  function initialise(form){
    if(!form?.matches?.('[data-mobile-money-form]')||bound.has(form))return;
    const cash=form.querySelector('[data-linked-cash-currency]');
    if(!cash)return;
    bound.add(form);
    const rate=form.querySelector('[data-linked-rate]'),rateField=form.querySelector('[data-linked-rate-field]');
    const confirm=form.querySelector('[data-linked-confirm]'),confirmField=form.querySelector('[data-linked-confirm-field]');
    const summary=form.querySelector('[data-linked-preview]');
    const amount=form.elements.namedItem('amount'),currency=form.elements.namedItem('currency');
    const wallet=form.querySelector('[data-wallet-account]'),payment=form.querySelector('[data-payment-account]');
    const output=form.querySelector('[data-linked-preview-amount]'),float=form.querySelector('[data-linked-preview-wallet]');
    const note=form.querySelector('[data-linked-preview-note]'),total=form.querySelector('[data-mobile-total]');
    const submit=form.querySelector('[data-mobile-submit-label]');
    let seq=0,controller=null,debounce=null,verified=null;
    const cancelled=()=>{
      ++seq;clearTimeout(debounce);controller?.abort();controller=null;verified=null;
      if(summary)summary.hidden=true;
      if(confirm)confirm.checked=false;
    };
    const state=()=>{
      const networkCurrency=currency?.value||form.dataset.currency;
      const cashCurrency=cash.value||networkCurrency;
      return {networkCurrency,cashCurrency,cross:cashCurrency!==networkCurrency,
        side:form.dataset.operation==='cash_out'?'buy':'sell'};
    };
    const allowed=({networkCurrency,cashCurrency,side})=>{
      const options=[];
      for(const option of rate.options){
        if(!option.value)continue;
        const valid=option.dataset.from===networkCurrency&&option.dataset.to===cashCurrency&&option.dataset.side===side;
        option.disabled=!valid;option.hidden=!valid;
        if(valid)options.push(option);
      }
      if(!options.some(option=>option.value===rate.value))rate.value=options.length===1?options[0].value:'';
      return options.length;
    };
    const draw=()=>{
      const s=state();
      if(!s.cross){
        cancelled();
        if(rateField)rateField.hidden=true;
        if(confirmField)confirmField.hidden=true;
        rate.disabled=true;rate.required=false;
        confirm.disabled=true;confirm.required=false;
        if(submit)submit.disabled=false;
        return;
      }
      if(rateField)rateField.hidden=false;
      if(confirmField)confirmField.hidden=false;
      rate.disabled=false;rate.required=true;
      confirm.disabled=false;confirm.required=true;
      const available=allowed(s);
      const principal=minor(amount.value,s.networkCurrency);
      const matches=Boolean(wallet.value&&payment?.value&&rate.value&&principal&&available);
      const canRecord=Boolean(verified&&confirmed());
      if(submit)submit.disabled=!canRecord;
      if(!matches){
        if(summary){summary.hidden=false;output.textContent='—';float.textContent='—';}
        note.textContent=!available?'No approved rate for this direction and currency pair. Ask the authorized Forex reviewer.':
          !wallet.value||!payment?.value?'Assign a real reconciled provider wallet and cashier drawer in Treasury.':
          !principal?'Enter a valid provider amount.':'Select an approved buy/sell rate.';
        return;
      }
      debounce=setTimeout(async()=>{
        controller=new AbortController();
        const request=++seq;
        try{
          const response=await fetch('/tenant/settlements/preview/mobile-money',{
            method:'POST',credentials:'same-origin',cache:'no-store',
            signal:controller.signal,
            headers:{'Content-Type':'application/json','Accept':'application/json'},
            body:JSON.stringify({
              _csrf:form.elements.namedItem('_csrf')?.value,
              operation:form.dataset.operation,
              walletAccountId:wallet.value,cashAccountId:payment.value,
              cashCurrency:s.cashCurrency,providerPrincipalMinor:principal,rateId:rate.value
            })
          });
          const body=await response.json();
          if(request!==seq)return;
          if(!response.ok)throw new Error(body.error||'This currency quote could not be verified.');
          verified={wallet:wallet.value,cash:cash.value,rate:rate.value,
            principal,operation:form.dataset.operation};
          if(summary)summary.hidden=false;
          output.textContent=body.physicalCashAmount+' ('+(form.dataset.operation==='cash_out'?'paid':'received')+')';
          float.textContent=body.walletChange;
          note.textContent=body.note;
          if(total)total.textContent=body.physicalCashAmount;
          if(submit)submit.disabled=!confirmed();
        }catch(error){
          if(request!==seq||error.name==='AbortError')return;
          verified=null;
          if(summary)summary.hidden=false;
          output.textContent='—';float.textContent='—';
          note.textContent=error.message||'Quote unavailable; no cash has been recorded.';
          if(submit)submit.disabled=true;
        }
      },240);
    };
    const confirmed=()=>Boolean(confirm?.checked);
    const update=()=>{
      cancelled();
      draw();
    };
    for(const eventName of ['input','change']){
      for(const control of [cash,rate,amount,currency,wallet,payment])control?.addEventListener(eventName,update);
    }
    form.elements.namedItem('network')?.addEventListener('change',update);
    confirm?.addEventListener('change',()=>{
      const s=state();
      if(submit)submit.disabled=s.cross?!(verified&&confirmed()):false;
    });
    form.addEventListener('submit',event=>{
      const s=state();
      if(!s.cross)return;
      const same=verified&&verified.wallet===wallet.value&&verified.cash===cash.value&&
       verified.rate===rate.value&&verified.principal===minor(amount.value,s.networkCurrency)&&
       verified.operation===form.dataset.operation;
      if(!same||!confirmed()){
        event.preventDefault();
        if(note)note.textContent='Obtain the current server quote and confirm the actual cash amount before recording.';
        if(summary)summary.hidden=false;
      }
    });
    form.querySelectorAll('[data-mobile-operation]').forEach(a=>a.addEventListener('click',()=>{
      queueMicrotask(update);
    }));
    update();
  }
  window.ClassicFinLinkedSettlement=Object.freeze({initialise});
  document.querySelectorAll('[data-mobile-money-form]').forEach(initialise);
  if(typeof MutationObserver!=='undefined')new MutationObserver(()=>{
    document.querySelectorAll('[data-mobile-money-form]').forEach(initialise);
  }).observe(document.body,{childList:true,subtree:true});
})();
