'use strict';
// Display server-provided ledger balances, never a browser-generated financial amount.
for(const form of document.querySelectorAll('[data-capital-topup-form]')){
 const account=form.querySelector('[data-capital-account]');
 const balance=form.querySelector('[data-capital-balance]');
 const amount=form.querySelector('[data-capital-amount]');
 if(!account||!balance||!amount)continue;
 const refresh=()=>{
  const selected=account.selectedOptions[0];
  const currency=selected?.dataset.currency;
  balance.textContent=currency?(selected.dataset.balance||currency):'Choose an account';
  amount.placeholder=currency?'Amount in '+(currency==='KES'?'KSH':currency):'Enter amount';
 };
 account.addEventListener('change',refresh);
 refresh();
}
