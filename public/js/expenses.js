'use strict';
document.addEventListener('DOMContentLoaded',()=>{
 const dialog=document.getElementById('expenseDialog');if(!dialog)return;
 const form=dialog.querySelector('[data-expense-form]');
 const currency=form?.querySelector('[name="currency"]');
 const method=form?.querySelector('[name="paymentMethod"]');
 const source=form?.querySelector('[name="treasuryAccountId"]');
 const sourceHint=form?.querySelector('#expenseSourceHint');
 const methodKind={'Cash':'cash','Mobile Money':'wallet','Bank':'bank'};
 function updateSource(){
  if(!currency||!method||!source)return;
  const kind=methodKind[method.value],code=currency.value;
  let count=0;
  for(const option of [...source.options]){
   if(!option.value)continue;
   const permitted=option.dataset.expenseKind===kind&&option.dataset.expenseCurrency===code;
   option.hidden=!permitted;option.disabled=!permitted;
   if(permitted)count++;
  }
  if(source.selectedOptions[0]?.disabled||!count)source.value='';
  if(sourceHint)sourceHint.textContent=count?
   'Choose the account that paid. After independent approval, its balance is deducted once automatically.':
   'No verified '+method.value+' account in '+(code==='KES'?'KSH':code)+'. Set up or reconcile an account in Treasury before recording.';
 }
 for(const control of [currency,method])control?.addEventListener('change',updateSource);
 updateSource();
 let opener=null;
 const open=()=>{
  if(typeof dialog.showModal!=='function')return;
  opener=document.activeElement;if(dialog.open)dialog.close();dialog.showModal();updateSource();dialog.querySelector('[name="expenseType"]')?.focus();
 };
 document.querySelectorAll('[data-expense-open]').forEach(trigger=>trigger.addEventListener('click',event=>{
  if(typeof dialog.showModal!=='function')return;event.preventDefault();open();
 }));
 dialog.querySelector('[data-expense-clear]')?.addEventListener('click',()=>{form?.reset();updateSource();});
 dialog.querySelectorAll('[data-expense-close]').forEach(trigger=>trigger.addEventListener('click',()=>dialog.close()));
 dialog.addEventListener('close',()=>{opener?.focus();});
 dialog.addEventListener('click',event=>{if(event.target!==dialog)return;const bounds=dialog.getBoundingClientRect();
  if(event.clientX<bounds.left||event.clientX>bounds.right||event.clientY<bounds.top||event.clientY>bounds.bottom)dialog.close();});
 if(dialog.open&&typeof dialog.showModal==='function')open();
});
