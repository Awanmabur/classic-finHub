'use strict';
(() => {
  const bound=new WeakSet();
  const parseMinor=(text,currency)=>{
    const scale=currency==='UGX'?0:2,raw=String(text||'').trim();
    const ok=scale===0?/^(?:0|[1-9]\d{0,10})$/:/^(?:0|[1-9]\d{0,10})(?:\.\d{1,2})?$/;
    if(!ok.test(raw))return null;
    const [whole,part='']=raw.split('.');
    const value=BigInt(whole)*10n**BigInt(scale)+BigInt(part.padEnd(scale,'0')||'0');
    return value>0n?String(value):null;
  };
  const major=(minor,currency)=>{
    const scale=currency==='UGX'?0:2,n=BigInt(minor);
    if(scale===0)return String(n);
    return String(n/100n)+'.'+String(n%100n).padStart(2,'0');
  };
  function initialise(form){
    if(!form?.matches?.('[data-transfer-form]')||bound.has(form))return;
    const receiving=form.querySelector('[data-transfer-receive-currency]');
    if(!receiving)return;
    bound.add(form);
    const sending=form.elements.namedItem('currency'),destination=form.elements.namedItem('destinationBranchId');
    const amount=form.elements.namedItem('amount'),payout=form.querySelector('[data-transfer-receive-amount]');
    const rate=form.querySelector('[data-transfer-rate]'),submit=form.querySelector('button[type="submit"]');
    const payoutField=form.querySelector('[data-transfer-receive-amount-field]');
    const rateField=form.querySelector('[data-transfer-rate-field]');
    const summary=form.querySelector('[data-transfer-linked-preview]');
    const sent=form.querySelector('[data-transfer-linked-sending]');
    const received=form.querySelector('[data-transfer-linked-receiving]');
    const note=form.querySelector('[data-transfer-linked-note]');
    let previousAmount=amount?.value||'',ticket=0,controller=null,delay=null,current=null;
    const state=()=>({originCurrency:sending?.value||'',payoutCurrency:receiving?.value||'',
      destinationId:destination?.value||'',payoutMinor:parseMinor(payout?.value,receiving?.value),
      rateId:rate?.value||''});
    const reset=()=>{++ticket;clearTimeout(delay);controller?.abort();controller=null;current=null;};
    const filterRates=s=>{
      const choices=[];
      for(const option of rate.options){
        if(!option.value)continue;
        const matches=option.dataset.from===s.payoutCurrency&&option.dataset.to===s.originCurrency;
        option.disabled=!matches;option.hidden=!matches;
        if(matches)choices.push(option);
      }
      if(!choices.some(option=>option.value===rate.value))rate.value=choices.length===1?choices[0].value:'';
      return choices.length;
    };
    const show=(message)=>{
      if(summary)summary.hidden=false;
      if(sent)sent.textContent='—';
      if(received)received.textContent='—';
      if(note)note.textContent=message;
    };
    const update=()=>{
      reset();
      const s=state(),cross=s.originCurrency!==s.payoutCurrency;
      if(payoutField)payoutField.hidden=!cross;
      if(rateField)rateField.hidden=!cross;
      payout.disabled=!cross;payout.required=cross;
      rate.disabled=!cross;rate.required=cross;
      amount.readOnly=cross;
      if(!cross){
        amount.value=previousAmount;
        summary.hidden=true;
        if(submit)submit.disabled=false;
        destination.setCustomValidity(s.destinationId&&s.destinationId===form.dataset.operatingBranchId?
         'Use a different receiving branch for same-currency transfers.':'');
        return;
      }
      destination.setCustomValidity('');
      amount.value='';
      const supports=(destination?.selectedOptions?.[0]?.dataset.currencies||'').split(',').includes(s.payoutCurrency);
      const rateCount=filterRates(s);
      if(submit)submit.disabled=true;
      if(!supports)return show('This branch does not offer the chosen payout currency.');
      const next=state();
      if(!rateCount)return show('No independently approved sell rate exists for this currency direction.');
      if(!next.rateId||!next.payoutMinor||!next.destinationId)return show('Choose an approved rate, a receiving branch and the exact recipient amount.');
      delay=setTimeout(async()=>{
        controller=new AbortController();
        const token=++ticket;
        try{
          const response=await fetch('/tenant/settlements/preview/transfer-terms',{
            method:'POST',credentials:'same-origin',cache:'no-store',
            signal:controller.signal,
            headers:{'Content-Type':'application/json','Accept':'application/json'},
            body:JSON.stringify({
              _csrf:form.elements.namedItem('_csrf')?.value,
              collectionCurrency:next.originCurrency,payoutCurrency:next.payoutCurrency,
              destinationBranchId:next.destinationId,payoutMinor:next.payoutMinor,rateId:next.rateId
            })
          });
          const value=await response.json();
          if(token!==ticket)return;
          if(!response.ok)throw Error(value.error||'Server could not approve these transfer terms');
          current={...next,collectionMinor:value.collectionMinor};
          amount.value=major(value.collectionMinor,next.originCurrency);
          if(sent)sent.textContent=value.senderPays;
          if(received)received.textContent=value.recipientReceives;
          if(note)note.textContent='Server-approved '+value.side+' rate: '+value.rate+
           '. Quote expires '+new Date(value.expiresAt).toLocaleString()+'. No funds have been collected.';
          if(summary)summary.hidden=false;
          amount.dispatchEvent(new Event('input',{bubbles:true}));
          if(submit)submit.disabled=false;
        }catch(error){
          if(token!==ticket||error.name==='AbortError')return;
          current=null;amount.value='';
          show(error.message||'Quote unavailable. No transfer may be saved.');
        }
      },230);
    };
    for(const control of [sending,receiving,destination,payout,rate]){
      for(const eventName of ['change','input'])control?.addEventListener(eventName,update);
    }
    form.addEventListener('submit',event=>{
      const s=state();
      if(s.originCurrency===s.payoutCurrency)return;
      if(!current||!current.collectionMinor||!s.destinationId||
       s.originCurrency!==current.originCurrency||s.payoutCurrency!==current.payoutCurrency||
       s.destinationId!==current.destinationId||s.rateId!==current.rateId||
       s.payoutMinor!==current.payoutMinor||amount.value!==major(current.collectionMinor,s.originCurrency)){
       event.preventDefault();
       show('Recheck the live approved rate and recipient amount before saving this transfer.');
      }
    });
    // Legacy amount remains editable for same-currency transfers.
    amount.addEventListener('input',()=>{
      if(sending.value===receiving.value)previousAmount=amount.value;
    });
    update();
  }
  window.ClassicFinLinkedTransfer=Object.freeze({initialise});
  document.querySelectorAll('[data-transfer-form]').forEach(initialise);
  if(typeof MutationObserver!=='undefined')new MutationObserver(()=>{
    document.querySelectorAll('[data-transfer-form]').forEach(initialise);
  }).observe(document.body,{childList:true,subtree:true});
})();
