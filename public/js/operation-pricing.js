'use strict';
(() => {
 const bindings=new WeakMap();
 const scale=currency=>currency==='UGX'?0:2;
 function minor(value,places){const match=/^(\d+)(?:\.(\d+))?$/.exec(String(value||''));if(!match||(match[2]||'').length>places)return null;return BigInt(match[1])*10n**BigInt(places)+BigInt((match[2]||'').padEnd(places,'0')||'0');}
 function decimal(value,places){const units=10n**BigInt(places),whole=value/units;return String(whole)+(places?'.'+String(value%units).padStart(places,'0'):'');}
 function amount(value,currency){const places=scale(currency),plain=decimal(value,places),parts=plain.split('.');return (currency==='KES'?'KSH':currency)+' '+BigInt(parts[0]).toLocaleString('en-US')+(parts[1]?'.'+parts[1]:'');}
 function select(rules,operation,currency,branchId,network){return rules.filter(rule=>rule.enabled!==false&&rule.operation===operation&&rule.currency===currency&&(!rule.branchId||String(rule.branchId)===branchId)&&(!rule.network||rule.network===network)).sort((a,b)=>(Number(Boolean(b.branchId))*2+Number(Boolean(b.network)))-(Number(Boolean(a.branchId))*2+Number(Boolean(a.network))))[0];}
 function initialise(form){
  if(!form)return;if(bindings.has(form)){bindings.get(form)();return;}
  const host=form.querySelector('[data-pricing-context]');if(!host)return;
  let context;try{context=JSON.parse(host.dataset.pricingContext);}catch{return;}
  const field=form.elements.namedItem(context.field||'fee'),token=form.elements.namedItem('pricingPolicy');if(!field||!token)return;
  const refresh=()=>{
   let operation=context.operation,currency=form.elements.namedItem('currency')?.value||form.dataset.currency||'UGX';
   if(operation.startsWith('mobile_money.'))operation='mobile_money.'+(form.dataset.operation==='cash_out'?'cash_out':'cash_in');
   if(operation.startsWith('banking.'))operation='banking.'+({deposit_request:'deposit',withdrawal_request:'withdrawal',transfer_request:'transfer'}[form.elements.namedItem('kind')?.value]||'deposit');
   let base=minor(form.elements.namedItem('amount')?.value,scale(currency));
   if(operation.startsWith('forex.')){
    operation='forex.'+(form.elements.namedItem('operation')?.value||operation.split('.')[1]);
    const rate=form.elements.namedItem('rateId')?.selectedOptions[0],from=rate?.dataset.from,to=rate?.dataset.to;
    currency=to||currency;
    const source=from?minor(form.elements.namedItem('amount')?.value,scale(from)):null,rateMinor=minor(rate?.dataset.rate,8);
    if(source!==null&&rateMinor!==null&&from&&to){const numerator=source*rateMinor*10n**BigInt(scale(to)),denominator=100000000n*10n**BigInt(scale(from));base=(numerator+denominator/2n)/denominator;}else base=null;
   }
   const rule=select(context.rules||[],operation,currency,String(context.branchId||''),form.elements.namedItem('network')?.value||'');
   token.value=rule?String(rule._id)+':'+rule.revision:'default';
   let fee=0n,cost=0n;
   try{fee=BigInt(rule?.fixedFeeMinor||'0')+(base===null?0n:(base*BigInt(rule?.feeBps||0)+5000n)/10000n);cost=BigInt(rule?.fixedCostMinor||'0')+(base===null?0n:(base*BigInt(rule?.costBps||0)+5000n)/10000n);}catch{return;}
   const next=decimal(fee,scale(currency)),changed=field.value!==next;field.value=next;
   host.querySelector('[data-pricing-fee]').textContent=amount(fee,currency);host.querySelector('[data-pricing-cost]').textContent=amount(cost,currency);
   host.querySelector('[data-pricing-label]').textContent=rule?'Configured charges applied automatically. Operating cost is an estimate, not an additional customer charge.':'No charge is configured for this operation and currency. The customer fee is zero.';
   if(changed)field.dispatchEvent(new Event('input',{bubbles:true}));
  };
  bindings.set(form,refresh);form.addEventListener('input',event=>{if(event.target!==field)refresh();});form.addEventListener('change',event=>{if(event.target!==field)refresh();});form.addEventListener('reset',()=>queueMicrotask(refresh));refresh();
 }
 window.ClassicFinPricing=Object.freeze({initialise});document.querySelectorAll('form').forEach(initialise);
})();
