'use strict';
// One existing Cash-In / Cash-Out form. Cash-account currency drives the mode.
// No client quote is trusted at finalization: the server recomputes and fences
// the approved rate, native-currency amount and both Treasury accounts.
(()=>{
 const format=(value,code)=>{
  if(!/^-?[0-9]+$/.test(String(value)))return '—';
  const decimals=code==='UGX'?0:2,base=10n**BigInt(decimals);
  const num=BigInt(value),magnitude=num<0n?-num:num;
  const whole=(magnitude/base).toString().replace(/\B(?=(\d{3})+(?!\d))/g,',');
  return (code==='KES'?'KSH':code)+' '+(num<0n?'-':'')+whole+
   (decimals?'.'+(magnitude%base).toString().padStart(decimals,'0'):'');
 };
 function init(form){
  if(!form?.matches('[data-mobile-money-form][data-unified-currency="true"]'))return;
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
  const confirm=form.querySelector('[data-momo-cross-confirm]');
  const total=form.querySelector('[data-mobile-total]');
  const totalLabel=form.querySelector('[data-mobile-total-label]');
  const rateId=form.elements.namedItem('fxRateId');
  const rateVersion=form.elements.namedItem('fxRateVersion');
  const cashAmount=form.elements.namedItem('fxCashAmountMinor');
  const reference=form.elements.namedItem('networkReference');
  const appCheck=form.elements.namedItem('providerAppConfirmed');
  const cashCheck=form.elements.namedItem('cashHandoverConfirmed');
  if(!wallet||!drawer||!network||!currency||!amount||!submit||!rateId||!rateVersion||!cashAmount)return;
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
   ready=false;rateId.value='';rateVersion.value='';cashAmount.value='';
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
   if(field)field.hidden=eligible.length===1&&Boolean(wallet.value);
   amount.pattern=code==='UGX'?'[0-9]{1,11}':'[0-9]{1,11}([.][0-9]{1,2})?';
   for(const stat of form.querySelectorAll('[data-balance-kind]')){
    stat.hidden=(stat.dataset.balanceKind==='wallet'&&stat.dataset.balanceAccount!==wallet.value)||
     (stat.dataset.balanceKind==='cash'&&stat.dataset.balanceAccount!==drawer.value);
   }
  }
  function showError(text){
   if(message)message.textContent=text;
   if(cashText)cashText.textContent='—';
   if(total)total.textContent='—';
  }
  async function refresh(){
   resetQuote();
   updateWallet();
   const w=wallet.selectedOptions?.[0],d=drawer.selectedOptions?.[0];
   const wc=w?.dataset.currency||'',dc=d?.dataset.currency||'';
   const same=Boolean(w?.value&&d?.value&&wc===dc);
   const different=Boolean(w?.value&&d?.value&&wc!==dc);
   if(mode)mode.textContent=same?'Same currency':different?'Cross-currency · linked Forex':'Select wallet and cash drawer';
   if(cashCode)cashCode.textContent=dc?'('+ (dc==='KES'?'KSH':dc)+')':'';
   if(totalLabel)totalLabel.textContent=form.dataset.operation==='cash_out'?'Cash paid to customer':'Cash received from customer';
   if(confirm){
    confirm.hidden=!different;
    for(const c of [appCheck,cashCheck]){if(c)c.required=different;}
   }
   const amountText=String(amount.value||'').trim(),scale=wc==='UGX'?0:2;
   const valid=(scale===0?/^[1-9][0-9]{0,10}$/:/^(?:0|[1-9][0-9]{0,10})(?:\.[0-9]{1,2})?$/).test(amountText)&&Number(amountText)>0;
   if(!w?.value||!d?.value){showError('Choose an active wallet and your actual physical cash drawer.');submit.disabled=true;return;}
   if(!valid){showError('Enter the provider wallet amount to calculate what the customer receives or pays.');submit.disabled=true;return;}
   if(same){
    const n=BigInt(amountText.replace('.',''));const decimal=wc==='UGX'?0:(amountText.split('.')[1]||'').length;
    const minor=wc==='UGX'?n:BigInt((amountText.split('.')[0]||'0'))*100n+
      BigInt((amountText.split('.')[1]||'').padEnd(2,'0')||'0');
    const feeValue=fee?.value||'0';
    // Same-currency provider fee policy remains on the existing recording path.
    if(mode)mode.textContent='Same-currency Mobile Money';
    if(cashText)cashText.textContent=format(minor,dc);
    if(total)total.textContent=format(minor,dc);
    if(message)message.textContent='One Mobile Money record; cash and float update in '+wc+'. No Forex posting.';
    ready=true;submit.disabled=false;return;
   }
   if(fee&&String(fee.value||'0')!=='0'){
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
     url.searchParams.set('providerAmount',amountText);
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
     if(rateRow)rateRow.hidden=false;
     if(rateText)rateText.textContent='1,000 '+wc+' = '+(Number(result.rateDecimal)*1000).toLocaleString('en-US',{maximumFractionDigits:6})+' '+dc+
      ' ('+result.rateSide+')';
     if(cashText)cashText.textContent=format(result.cashAmountMinor,dc);
     if(total)total.textContent=format(result.cashAmountMinor,dc);
     if(message)message.textContent='Confirm the real provider transaction and cash handover, then finalize once. The Forex record is linked automatically; no second cash/float posting.';
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
   if(w.dataset.currency!==d.dataset.currency&&(!rateId.value||!appCheck.checked||!cashCheck.checked)){
    e.preventDefault();showError('Confirm the actual provider transfer and physical cash amount before finalizing.');
   }
  });
  selectWallet();refresh();
 }
 document.querySelectorAll('[data-mobile-money-form][data-unified-currency="true"]').forEach(init);
})();
