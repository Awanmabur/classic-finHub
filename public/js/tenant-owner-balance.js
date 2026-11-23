'use strict';
// One existing balance panel; no second account funding form.
// Server owns all ledger changes, balance calculations and access checks.
for(const form of document.querySelectorAll('[data-owner-balance-form]')){
 const action=form.querySelector('[data-owner-balance-action]');
 const label=form.querySelector('[data-owner-balance-label]');
 const hint=form.querySelector('[data-owner-balance-hint]');
 const amount=form.querySelector('[data-owner-balance-amount]');
 if(!action||!label||!hint||!amount)continue;
 const currency=(label.textContent.match(/\((UGX|USD|SSP|KSH)\)/)||[])[1]||'account currency';
 const update=()=>{
  const add=action.value==='capital';
  label.textContent=(add?'Amount of new money received':'Current total actually counted')+' ('+currency+')';
  amount.placeholder=add?'Amount received':'Current total';
  hint.textContent=add?
   'Adds only genuinely new money to this account and owner capital. Enter the amount received, not the resulting balance.':
   'Records the real total in this account. If it differs from the recorded balance, the difference is flagged without changing the money or sending a routine review request.';
 };
 action.addEventListener('change',update);
 update();
}
