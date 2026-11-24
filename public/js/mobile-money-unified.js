'use strict';
// One existing Cash-In / Cash-Out form. Cash-account currency drives the mode.
// No client quote is trusted at finalization: the server recomputes and fences
// the approved rate, native-currency amount and both Treasury accounts.
(()=>{
 const initialized=new WeakSet();
 const handlers=new WeakMap();
 const currencyLabel=code=>code==='KES'?'KSH':code;
 const rateIssue=code=>/^FX_RATE_(?:MISSING|EXPIRED|EXPIRING|CHANGED)$/.test(code||'');
 const format=(value,code)=>{
  if(!/^-?[0-9]+$/.test(String(value)))return '—';
  const decimals=code==='UGX'?0:2,base=10n**BigInt(decimals);
  const num=BigInt(value),magnitude=num<0n?-num:num;
  const whole=(magnitude/base).toString().replace(/\B(?=(\d{3})+(?!\d))/g,',');
  return (code==='KES'?'KSH':code)+' '+(num<0n?'-':'')+whole+
   (decimals?'.'+(magnitude%base).toString().padStart(decimals,'0'):'');
 };
 function init(form){
  if(!form?.matches('[data-mobile-money-form][data-unified-currency="true"]')||initialized.has(form))return;
  initialized.add(form);
  const wallet=form.querySelector('[data-wallet-account]');
  const drawer=form.querySelector('[data-payment-account]');
  const network=form.elements.namedItem('network');
  const currency=form.elements.namedItem('currency');
  const amount=form.elements.namedItem('amount');
  const fee=form.elements.namedItem('fee');
  const policy=form.querySelector('[data-wallet-fee-policy]');
  const submit=form.querySelector('[data-mobile-submit-label]');
  const mode=form.querySelector('[data-momo-unified-mode]');
  const cashText=form.querySelector('[data-momo-unified-cash]');
  const cashCode=form.querySelector('[data-momo-cash-currency]');
  const message=form.querySelector('[data-momo-unified-message]');
  const rateRow=form.querySelector('[data-momo-rate-row]');
  const rateText=form.querySelector('[data-momo-rate]');
  const total=form.querySelector('[data-mobile-total]');
  const totalLabel=form.querySelector('[data-mobile-total-label]');
  const rateId=form.elements.namedItem('fxRateId');
  const rateVersion=form.elements.namedItem('fxRateVersion');
  const cashAmount=form.elements.namedItem('fxCashAmountMinor');
  const providerAmount=form.elements.namedItem('fxProviderAmountMinor');
  const providerText=form.querySelector('[data-momo-float-amount]');
  const entryCurrencyLabel=form.querySelector('[data-mobile-currency-label]');
  const entryAmountLabel=form.querySelector('[data-mobile-entry-amount-label]');
  const rateNotice=form.querySelector('[data-momo-rate-notice]');
  const rateFeedback=form.querySelector('[data-momo-rate-feedback]');
  const retryRate=form.querySelector('[data-momo-rate-retry]');
  const rateSettings=form.querySelector('[data-momo-rate-settings]');
  if(!wallet||!drawer||!network||!currency||!amount||!submit||!rateId||!rateVersion||!cashAmount||!providerAmount)return;
  let version=0,timer=null,expiryTimer=null,expiresAt=0,abort=null,ready=false;
  const isWithdrawal=()=>form.dataset.operation==='cash_out';
  const rateSide=()=>isWithdrawal()?'Buy':'Sell';
  const available=option=>Boolean(option.value)&&!option.disabled&&
    option.dataset.state==='active'&&option.dataset.reconciliation==='matched'&&
    /^[0-9]+$/.test(option.dataset.expectedMinor||'');
  function selectWallet(){
   const options=[...wallet.options].filter(o=>available(o)&&o.dataset.network===network.value);
   if(options.some(o=>o.value===wallet.value))return;
   const assigned=options.filter(o=>o.dataset.assigned==='true');
   const candidates=assigned.length?assigned:options;
   const preferred=candidates.filter(o=>o.dataset.default==='true');
   wallet.value=preferred.length===1?preferred[0].value:candidates.length===1?candidates[0].value:'';
  }
  function setReady(value){
   ready=value;
   submit.disabled=!value||form.dataset.operationSaving==='true';
  }
  function resetQuote(){
   setReady(false);rateId.value='';rateVersion.value='';cashAmount.value='';providerAmount.value='';
   if(abort)abort.abort();clearTimeout(timer);clearTimeout(expiryTimer);expiresAt=0;version++;
   if(rateRow)rateRow.hidden=true;
  }
  function updateWallet(){
   const chosen=wallet.selectedOptions?.[0];
   const code=chosen?.dataset.currency||'';
   if(chosen?.value){
    if(network.value!==chosen.dataset.network)network.value=chosen.dataset.network;
    currency.value=code;
    currency.dispatchEvent(new Event('change',{bubbles:false}));
    form.dataset.currency=code;form.dataset.currencyLabel=code==='KES'?'KSH':code;
    if(policy){policy.value=chosen.dataset.feeTreatment||'record_only';policy.disabled=false;}
   }else if(policy)policy.disabled=true;
   const field=form.querySelector('[data-wallet-account-field]');
   // Keep the actual wallet identity visible even when it is the only
   // eligible wallet. It is auto-selected, but must not seem to disappear.
   if(field)field.hidden=false;
   // Deposit is CASH -> FLOAT, withdrawal is FLOAT -> CASH.
   // Both currencies are inferred from the selected Treasury accounts.
   const cashCode=drawer.selectedOptions?.[0]?.dataset.currency||'';
   const sourceCode=form.dataset.operation==='cash_in'?cashCode:code;
   amount.pattern=sourceCode==='UGX'?'[0-9]{1,11}':'[0-9]{1,11}([.][0-9]{1,2})?';
   if(entryCurrencyLabel)entryCurrencyLabel.textContent=sourceCode==='KES'?'KSH':sourceCode;
   if(entryAmountLabel)entryAmountLabel.textContent=form.dataset.operation==='cash_in'?'Customer cash received':'Wallet withdrawal amount';
   for(const stat of form.querySelectorAll('[data-balance-kind]')){
    stat.hidden=(stat.dataset.balanceKind==='wallet'&&stat.dataset.balanceAccount!==wallet.value)||
     (stat.dataset.balanceKind==='cash'&&stat.dataset.balanceAccount!==drawer.value);
   }
  }
  function showError(text){
   if(message)message.textContent=text;
   if(cashText)cashText.textContent='—';
   if(total)total.textContent='—';
   if(providerText)providerText.textContent='—';
  }
  function clearRateNotice(){
   if(rateNotice)rateNotice.hidden=true;
  }
  function showRateIssue(text,code){
   resetQuote();
   showError('Check the active exchange rate before recording this transaction.');
   if(rateSettings)rateSettings.hidden=!rateIssue(code)||code==='FX_RATE_CHANGED';
   if(rateFeedback)rateFeedback.textContent=text;
   if(rateNotice)rateNotice.hidden=false;
  }
  function pairLabel(wc,dc){
   return rateSide()+' rate for '+currencyLabel(wc)+' → '+currencyLabel(dc);
  }
  function expired(wc,dc){
   showRateIssue('The '+pairLabel(wc,dc)+' has expired. '+(rateSettings?
    'Renew the rate before continuing.':'Ask the owner to renew it before continuing.'),'FX_RATE_EXPIRED');
  }
  function watchExpiry(result,wc,dc){
   const remaining=Number.isFinite(result.rateValidForMs)?result.rateValidForMs:Date.parse(result.rateExpiresAt)-Date.now();
   if(!(remaining>0)){expired(wc,dc);return false;}
   expiresAt=Date.now()+remaining;
   const current=version;
   const recheck=()=>{
    if(current!==version||!form.isConnected)return;
    const left=expiresAt-Date.now();
    if(left<=0){expired(wc,dc);return;}
    expiryTimer=setTimeout(recheck,Math.min(left,2147483647));
   };
   recheck();
   return true;
  }
  function confirmCurrentQuote(){
   const w=wallet.selectedOptions?.[0],d=drawer.selectedOptions?.[0];
   if(expiresAt&&Date.now()>=expiresAt){
    expired(w.dataset.currency,d.dataset.currency);
    return false;
   }
   if(!ready||!w?.value||!d?.value)return false;
   if(w.dataset.currency!==d.dataset.currency&&(!rateId.value||!providerAmount.value)){
    showError('Check the exchange rate before recording.');
    return false;
   }
   return true;
  }
  handlers.set(form,{
   confirmCurrentQuote,
   showIssue(text,code){showRateIssue(text,code);rateNotice?.scrollIntoView({block:'nearest'});}
  });
  function refresh(){
   resetQuote();
   clearRateNotice();
   updateWallet();
   const withdrawal=isWithdrawal();
   if(rateSettings)rateSettings.href='/tenant/mobile-money/'+(withdrawal?'cash-out':'cash-in')+'?fx=1#mobile-money-rate-settings';
   const w=wallet.selectedOptions?.[0],d=drawer.selectedOptions?.[0];
   const wc=w?.dataset.currency||'',dc=d?.dataset.currency||'';
   const same=Boolean(w?.value&&d?.value&&wc===dc);
   const different=Boolean(w?.value&&d?.value&&wc!==dc);
   if(mode)mode.textContent=same?'Same currency · no exchange':different?'Different currency · automatic Forex':'Select wallet and cash drawer';
   if(cashCode)cashCode.textContent=dc?'('+ (dc==='KES'?'KSH':dc)+')':'';
   if(totalLabel)totalLabel.textContent=form.dataset.operation==='cash_out'?'Cash paid to customer':'Cash received from customer';
   const amountText=String(amount.value||'').trim();
   const sourceCode=form.dataset.operation==='cash_in'?dc:wc;
   const scale=sourceCode==='UGX'?0:2;
   const valid=(scale===0?/^[1-9][0-9]{0,10}$/:/^(?:0|[1-9][0-9]{0,10})(?:\.[0-9]{1,2})?$/).test(amountText)&&Number(amountText)>0;
   const amountPrompt=withdrawal?'Enter the provider wallet withdrawal amount.':'Enter the actual cash amount received from the customer.';
   if(!w?.value||!d?.value){showError('Choose an active wallet and your actual physical cash drawer.');submit.disabled=true;return;}
   if(same){
    if(!valid){showError(amountPrompt);return;}
    const minor=wc==='UGX'?BigInt(amountText):
      BigInt((amountText.split('.')[0]||'0'))*100n+
      BigInt((amountText.split('.')[1]||'').padEnd(2,'0')||'0');
    const feeText=String(fee?.value||'0').trim();
    const validFee=wc==='UGX'?/^[0-9]{1,11}$/.test(feeText):
      /^[0-9]{1,11}(?:\.[0-9]{1,2})?$/.test(feeText);
    if(!validFee){showError('Enter a valid fee amount for the selected wallet currency.');submit.disabled=true;return;}
    const feeMinor=wc==='UGX'?BigInt(feeText):
      BigInt(feeText.split('.')[0])*100n+
      BigInt((feeText.split('.')[1]||'').padEnd(2,'0')||'0');
    const treatment=w.dataset.feeTreatment||'record_only';
    if(treatment==='wallet_commission'){
     showError('The wallet has a legacy commission policy. Ask the owner to change it to Record only before booking funds.');
     submit.disabled=true;return;
    }
    if(feeMinor>minor){
     showError('The customer fee cannot exceed the withdrawal or deposit amount.');
     submit.disabled=true;return;
    }
    const cashMinor=minor+(treatment==='payment_collected'?(withdrawal?-feeMinor:feeMinor):0n);
    const cashAvailable=d.dataset.expectedMinor, floatAvailable=w.dataset.expectedMinor;
    const available=withdrawal?cashAvailable:floatAvailable;
    const required=withdrawal?cashMinor:minor;
    if(!/^[0-9]+$/.test(available||'')||BigInt(available)<required){
     showError('Insufficient '+(withdrawal?'physical cash':'electronic float')+' in the selected account.');
     submit.disabled=true;return;
    }
    if(mode)mode.textContent='Same-currency Mobile Money';
    if(cashText)cashText.textContent=format(cashMinor,dc);
    if(total)total.textContent=format(cashMinor,dc);
    if(providerText)providerText.textContent=format(minor,wc);
    if(message)message.textContent='One Mobile Money transaction with the configured fee policy; cash and float update in '+wc+'. No Forex posting.';
    setReady(true);return;
   }
   if(fee&&!/^0+(?:\.0+)?$/.test(String(fee.value||'0'))){
    showError('Cross-currency settlement uses the owner\'s approved exchange rate. Remove an extra fee before finalizing.');
    submit.disabled=true;return;
   }
   showError('Checking the '+pairLabel(wc,dc)+'…');
   const nonce=version;
   timer=setTimeout(async()=>{
    abort=new AbortController();
    try{
     const url=new URL('/tenant/mobile-money/fx/preview',location.origin);
     url.searchParams.set('operation',withdrawal?'withdraw_provider_receive_cash':'deposit_cash_send_provider');
     url.searchParams.set('walletAccountId',w.value);
     url.searchParams.set('cashAccountId',d.value);
     if(valid)url.searchParams.set(withdrawal?'providerAmount':'cashAmount',amountText);
     else url.searchParams.set('rateOnly','1');
     const response=await fetch(url.toString(),{credentials:'same-origin',cache:'no-store',
      headers:{Accept:'application/json'},signal:abort.signal});
     const result=await response.json();
     if(nonce!==version)return;
     if(!response.ok){
      const text=result.error||'Unable to check the '+pairLabel(wc,dc)+'. Try again.';
      if(rateIssue(result.code)||response.status===503||response.status>=500||!valid)showRateIssue(text,result.code);
      else showError(text);
      return;
     }
     if(result.walletAccountId!==w.value||result.cashAccountId!==d.value||
       result.providerCurrency!==wc||result.cashCurrency!==dc)throw new Error('Quote account mismatch');
     if(!watchExpiry(result,wc,dc))return;
     if(rateRow)rateRow.hidden=false;
     if(rateText)rateText.textContent='1,000 '+currencyLabel(wc)+' = '+(Number(result.rateDecimal)*1000).toLocaleString('en-US',{maximumFractionDigits:6})+
      ' '+currencyLabel(dc)+' ('+result.rateSide+')';
     if(result.financialPosting==='disabled'){
      showError('Cross-currency recording is currently unavailable. Use accounts in the same currency or contact support.');
      return;
     }
     if(!valid){showError(amountPrompt);return;}
     const availableMinor=String(d.dataset.expectedMinor||'');
     const walletMinor=String(w.dataset.expectedMinor||'');
     const debit=withdrawal?BigInt(result.cashAmountMinor):BigInt(result.providerAmountMinor);
     const availableAmount=withdrawal?availableMinor:walletMinor;
     if(!/^[0-9]+$/.test(availableAmount)||BigInt(availableAmount)<debit)
      throw new Error('Insufficient '+(withdrawal?dc+' physical cash':wc+' electronic float')+' for this exchange');
     rateId.value=result.rateId;rateVersion.value=String(result.rateVersion);
     cashAmount.value=result.cashAmountMinor;
     providerAmount.value=result.providerAmountMinor;
     if(cashText)cashText.textContent=format(result.cashAmountMinor,dc);
     if(total)total.textContent=format(result.cashAmountMinor,dc);
     if(providerText)providerText.textContent=format(result.providerAmountMinor,wc);
     if(message)message.textContent='Check the displayed cash and float amounts, then record once. Forex is linked automatically without a second cash/float posting.';
     setReady(true);
    }catch(e){if(nonce!==version||e.name==='AbortError')return;
     if(e instanceof TypeError||e instanceof SyntaxError)showRateIssue('Could not check the '+pairLabel(wc,dc)+'. Check your connection and try again.');
     else showError(e.message||'Unable to confirm the exchange quote.');
    }
   },240);
  }
  wallet.addEventListener('change',()=>{
   const current=wallet.selectedOptions?.[0];
   if(current?.value&&network.value!==current.dataset.network)network.value=current.dataset.network;
   refresh();
  });
  network.addEventListener('change',()=>{selectWallet();refresh();});
  drawer.addEventListener('change',refresh);
  amount.addEventListener('input',refresh);
  fee?.addEventListener('change',refresh);
  fee?.addEventListener('input',refresh);
  form.addEventListener('classicfin:submit-restored',()=>setReady(ready));
  retryRate?.addEventListener('click',refresh);
  rateSettings?.addEventListener('click',event=>{
   const settings=document.getElementById('mobile-money-rate-settings');
   if(!settings)return;
   event.preventDefault();
   settings.open=true;
   const settingsForm=settings.querySelector('form');
   const from=settingsForm?.elements.namedItem('fromCurrency'),to=settingsForm?.elements.namedItem('toCurrency');
   const side=settingsForm?.elements.namedItem('side');
   if(from)from.value=wallet.selectedOptions[0]?.dataset.currency||'';
   if(to)to.value=drawer.selectedOptions[0]?.dataset.currency||'';
   if(side)side.value=rateSide().toLowerCase();
   settings.querySelector('summary')?.focus();
  });
  form.addEventListener('submit',e=>{if(!confirmCurrentQuote())e.preventDefault();},{capture:true});
  // Full-page entries stay in place on a rejected POST, instead of sending
  // the cashier to an error page behind a dialog or losing the entered values.
  // The shared transaction dialog has its own single-submit handler.
  if(!form.closest('[data-operation-dialog]')){
   const feedback=form.querySelector('[data-mobile-form-feedback]');
   const submitButton=form.querySelector('[data-mobile-submit-label]');
   let saving=false;
   const showInline=(message)=>{
    if(!feedback)return;
    feedback.querySelector('[data-mobile-form-feedback-text]').textContent=message;
    feedback.hidden=false;
    feedback.focus({preventScroll:true});
    feedback.scrollIntoView({block:'start',behavior:'smooth'});
   };
   const hideInline=()=>{if(feedback)feedback.hidden=true;};
   form.addEventListener('input',hideInline);
   form.addEventListener('change',hideInline);
   form.addEventListener('submit',async event=>{
    if(event.defaultPrevented)return;
    event.preventDefault();
    if(saving||!form.reportValidity())return;
    if(!ready){showInline('Check the amount, wallet and cash drawer before recording.');return;}
    saving=true;form.dataset.operationSaving='true';hideInline();
    if(submitButton)submitButton.disabled=true;
    const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),20000);
    try{
     const result=await fetch(form.action,{method:'POST',credentials:'same-origin',
      headers:{'Content-Type':'application/x-www-form-urlencoded','X-ClassicFin-Redirect':'json','X-ClassicFin-Background':'true',Accept:'application/json, text/plain, text/html'},
      body:new URLSearchParams(new FormData(form)),signal:controller.signal});
     const outcome=await window.ClassicFinFeedback.response(result);
     if(handleRateError(form,result,outcome.message))return;
     if(result.ok&&outcome.redirect){
      if(outcome.flash?.type==='bad'){showInline(outcome.flash.message);return;}
      location.assign(outcome.redirect);return;
     }
     showInline(outcome.message||'Transaction not saved. Check the highlighted fields and try again.');
    }catch{
     showInline('Could not confirm whether this transaction saved. Check Mobile Money history before recording it again.');
    }finally{clearTimeout(timeout);saving=false;delete form.dataset.operationSaving;setReady(ready);}
   });
  }
  selectWallet();refresh();
 }
 function handleRateIssue(form,code,message){
  const handle=handlers.get(form);
  if(!rateIssue(code)||!message||!handle)return false;
  handle.showIssue(message,code);
  return true;
 }
 function handleRateError(form,response,message){
  return handleRateIssue(form,response.headers.get('X-ClassicFin-Rate-State'),message);
 }
 const canSubmit=form=>handlers.get(form)?.confirmCurrentQuote()??true;
 window.ClassicFinMobileUnified=Object.freeze({initialise:init,handleRateError,handleRateIssue,canSubmit});
 document.querySelectorAll('[data-mobile-money-form][data-unified-currency="true"]').forEach(init);
})();
