'use strict';
(() => {
  const label=code=>code==='KES'?'KSH':code;
  const until=(timestamp,callback)=>timestamp>Date.now()
    ? setTimeout(callback,Math.min(timestamp-Date.now()+10,2147483647))
    : undefined;
  const entry=document.querySelector('[data-banking-fx]');
  if(entry){
    const source=entry.elements.namedItem('sourceAccountId');
    const destination=entry.elements.namedItem('destinationAccountId');
    const rate=entry.elements.namedItem('rateChoice');
    const notice=entry.querySelector('[data-banking-fx-rate-notice]');
    const status=entry.querySelector('[data-banking-fx-rate-status]');
    const rateAction=entry.querySelector('[data-banking-fx-rate-action]');
    const submit=entry.querySelector('[data-banking-fx-submit]');
    const expiredPairs=new Set(entry.dataset.expiredPairs.split(' '));
    const choices=[...rate.options].filter(option=>option.value);
    const expiry=option=>Date.parse(option.dataset.expiresAt);
    let timer;
    const update=()=>{
      const debit=source.selectedOptions[0];
      const from=debit?.dataset.currency;
      const destinations=[...destination.options].filter(option=>option.value);
      const compatible=destinations.filter(option=>Boolean(from&&debit.dataset.customer
        &&option.dataset.customer===debit.dataset.customer&&option.dataset.currency!==from));
      for(const option of destinations)option.hidden=option.disabled=!compatible.includes(option);
      if(!compatible.some(option=>option.value===destination.value))destination.value='';
      const to=destination.selectedOptions[0]?.dataset.currency;
      const pair=choices.filter(option=>option.dataset.from===from&&option.dataset.to===to);
      const now=Date.now();
      const active=pair.filter(option=>expiry(option)>now);
      for(const option of choices)option.hidden=option.disabled=!active.includes(option);
      if(!active.some(option=>option.value===rate.value))rate.value=active.length===1?active[0].value:'';
      const rateMissing=Boolean(from&&to&&!active.length);
      const expired=rateMissing&&(expiredPairs.has(from+':'+to)||pair.some(option=>expiry(option)<=now));
      const pairLabel=label(from)+' → '+label(to);
      let message='';
      if(!from)message='Select the source and destination accounts.';
      else if(!compatible.length)message='This customer needs another active account in a different currency.';
      else if(!to)message='Select the destination account.';
      else if(rateMissing)message=expired?'The exchange rate for '+pairLabel+' has expired.':'No Buy/Sell rate is set for '+pairLabel+'.';
      else if(!rate.value)message='Choose the Buy or Sell rate for '+pairLabel+'.';
      if(rateMissing&&!rateAction)message+=' Ask the owner to update the rate.';
      status.textContent=message;
      notice.hidden=!message;
      if(rateAction){rateAction.hidden=!rateMissing;rateAction.textContent=expired?'Update exchange rate':'Set exchange rate';}
      submit.disabled=!rate.value;
      clearTimeout(timer);
      if(active.length)timer=until(Math.min(...active.map(expiry)),update);
    };
    entry.addEventListener('change',update);
    entry.addEventListener('submit',event=>{update();if(submit.disabled)event.preventDefault();});
    window.addEventListener('pageshow',update);
    update();
  }
  const confirmation=document.querySelector('[data-banking-fx-confirm]');
  if(confirmation){
    const expiry=Date.parse(confirmation.dataset.expiresAt);
    if(!Number.isFinite(expiry))return;
    const submit=confirmation.querySelector('[data-banking-fx-submit]');
    const message=confirmation.querySelector('[data-banking-fx-expired]');
    let timer;
    const update=()=>{
      const expired=expiry<=Date.now();
      message.hidden=!expired;
      submit.disabled=expired;
      clearTimeout(timer);
      if(!expired)timer=until(expiry,update);
    };
    confirmation.addEventListener('submit',event=>{update();if(submit.disabled)event.preventDefault();});
    window.addEventListener('pageshow',update);
    update();
  }
})();
