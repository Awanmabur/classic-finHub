'use strict';
// One existing Cash-In / Cash-Out form. Cash-account currency drives the mode.
// No client quote is trusted at finalization: the server recomputes and fences
// the approved rate, native-currency amount and both Treasury accounts.
(()=>{
 const initialized=new WeakSet();
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
  if(!wallet||!drawer||!network||!currency||!amount||!submit||!rateId||!rateVersion||!cashAmount||!providerAmount)return;
  let version=0,timer=null,abort=null,ready=false;
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
  function resetQuote(){
   ready=false;rateId.value='';rateVersion.value='';cashAmount.value='';providerAmount.value='';
   if(abort)abort.abort();clearTimeout(timer);version++;
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
   const eligible=[...wallet.options].filter(o=>available(o)&&o.dataset.network===network.value);
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
  async function refresh(){
   resetQuote();
   updateWallet();
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
   if(!w?.value||!d?.value){showError('Choose an active wallet and your actual physical cash drawer.');submit.disabled=true;return;}
   if(!valid){showError(form.dataset.operation==='cash_in'?'Enter the actual cash amount received from the customer.':'Enter the provider wallet withdrawal amount.');submit.disabled=true;return;}
   if(same){
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
    const withdrawal=form.dataset.operation==='cash_out';
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
    ready=true;submit.disabled=false;return;
   }
   if(fee&&!/^0+(?:\.0+)?$/.test(String(fee.value||'0'))){
    showError('Cross-currency settlement uses the owner\'s approved exchange rate. Remove an extra fee before finalizing.');
    submit.disabled=true;return;
   }
   if(message)message.textContent='Calculating owner-approved rate and checking the selected currency pair…';
   submit.disabled=true;
   const nonce=version;
   timer=setTimeout(async()=>{
    abort=new AbortController();
    try{
     const url=new URL('/tenant/mobile-money/fx/preview',location.origin);
     url.searchParams.set('operation',form.dataset.operation==='cash_out'?'withdraw_provider_receive_cash':'deposit_cash_send_provider');
     url.searchParams.set('walletAccountId',w.value);
     url.searchParams.set('cashAccountId',d.value);
     url.searchParams.set(form.dataset.operation==='cash_in'?'cashAmount':'providerAmount',amountText);
     const response=await fetch(url.toString(),{credentials:'same-origin',cache:'no-store',
      headers:{Accept:'application/json'},signal:abort.signal});
     const result=await response.json();
     if(nonce!==version)return;
     if(!response.ok)throw new Error(result.error||'Exchange rate not available');
     if(result.walletAccountId!==w.value||result.cashAccountId!==d.value||
       result.providerCurrency!==wc||result.cashCurrency!==dc)throw new Error('Quote account mismatch');
     const availableMinor=String((form.querySelector('[data-payment-account]')?.selectedOptions?.[0]?.dataset.expectedMinor)||'');
     const walletMinor=String(w.dataset.expectedMinor||'');
     const debit=form.dataset.operation==='cash_out'?BigInt(result.cashAmountMinor):BigInt(result.providerAmountMinor);
     const availableAmount=form.dataset.operation==='cash_out'?availableMinor:walletMinor;
     if(!/^[0-9]+$/.test(availableAmount)||BigInt(availableAmount)<debit)
      throw new Error('Insufficient '+(form.dataset.operation==='cash_out'?dc+' physical cash':wc+' electronic float')+' for this exchange');
     rateId.value=result.rateId;rateVersion.value=String(result.rateVersion);
     cashAmount.value=result.cashAmountMinor;
     providerAmount.value=result.providerAmountMinor;
     if(rateRow)rateRow.hidden=false;
     if(rateText)rateText.textContent='1,000 '+wc+' = '+(Number(result.rateDecimal)*1000).toLocaleString('en-US',{maximumFractionDigits:6})+' '+dc+
      ' ('+result.rateSide+')';
     if(cashText)cashText.textContent=format(result.cashAmountMinor,dc);
     if(total)total.textContent=format(result.cashAmountMinor,dc);
     if(providerText)providerText.textContent=format(result.providerAmountMinor,wc);
     if(message)message.textContent='Check the displayed cash and float amounts, then record once. Forex is linked automatically without a second cash/float posting.';
     ready=true;submit.disabled=false;
    }catch(e){if(nonce!==version||e.name==='AbortError')return;
     showError(e.message||'Unable to confirm exchange quote');submit.disabled=true;}
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
  form.addEventListener('submit',e=>{
   const w=wallet.selectedOptions?.[0],d=drawer.selectedOptions?.[0];
   if(!ready||!w?.value||!d?.value){e.preventDefault();showError('Wait until the amount and accounts are validated.');return;}
   if(w.dataset.currency!==d.dataset.currency&&(!rateId.value||!providerAmount.value)){
    e.preventDefault();showError('An owner-approved exchange quote is required before recording.');
   }
  });
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
    saving=true;hideInline();
    if(submitButton)submitButton.disabled=true;
    const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),20000);
    try{
     const result=await fetch(form.action,{method:'POST',credentials:'same-origin',
      headers:{'Content-Type':'application/x-www-form-urlencoded','X-ClassicFin-Redirect':'json','X-ClassicFin-Background':'true',Accept:'application/json, text/plain, text/html'},
      body:new URLSearchParams(new FormData(form)),signal:controller.signal});
     const outcome=await window.ClassicFinFeedback.response(result);
     if(result.ok&&outcome.redirect){
      if(outcome.flash?.type==='bad'){showInline(outcome.flash.message);return;}
      location.assign(outcome.redirect);return;
     }
     showInline(outcome.message||'Transaction not saved. Check the highlighted fields and try again.');
    }catch{
     showInline('Could not confirm whether this transaction saved. Check Mobile Money history before recording it again.');
    }finally{clearTimeout(timeout);saving=false;if(submitButton)submitButton.disabled=false;}
   });
  }
  selectWallet();refresh();
 }
 window.ClassicFinMobileUnified=Object.freeze({initialise:init});
 document.querySelectorAll('[data-mobile-money-form][data-unified-currency="true"]').forEach(init);
})();
