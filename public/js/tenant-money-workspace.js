'use strict';
// Keep setup fields small. All financial changes are validated and posted
// by the existing server services; the browser never calculates balances.
for (const form of document.querySelectorAll('[data-money-create-form]')) {
  const kind = form.querySelector('[data-money-create-kind]');
  const field = form.querySelector('[data-money-create-network-field]');
  const network = form.querySelector('[data-money-create-network]');
  const operatorField = form.querySelector('[data-money-create-operator-field]');
  const operator = form.querySelector('[data-money-create-operator]');
  const currency = form.querySelector('[data-money-create-currency]');
  const help = form.querySelector('[data-money-create-currency-help]');
  const submit = form.querySelector('button[type="submit"]');
  if (!kind || !field || !network || !operatorField || !operator || !currency || !help || !submit) continue;
  const update = () => {
    const isWallet = kind.value === 'wallet';
    const isCash = kind.value === 'cash';
    field.hidden = !isWallet;
    network.required = isWallet;
    if (!isWallet) network.value = '';
    operatorField.hidden = !isCash;
    if (!isCash) operator.value = '';
    const fixed = isWallet ? (network.selectedOptions[0]?.dataset.marketCurrency || '') : '';
    help.textContent = '';
    submit.disabled = false;
    if (fixed) {
      const choice = Array.from(currency.options).find(option => option.value === fixed);
      if (!choice || choice.disabled) {
        help.textContent = fixed + ' is not enabled for this branch. Enable it in Branches before creating this provider account.';
        submit.disabled = true;
      } else {
        currency.value = fixed;
        help.textContent = 'This provider uses ' + (fixed === 'KES' ? 'KSH' : fixed) + '. Currency selected automatically.';
      }
    }
  };
  kind.addEventListener('change', update);
  network.addEventListener('change', update);
  currency.addEventListener('change', update);
  update();
}
for (const form of document.querySelectorAll('.moneyQuickForm')) {
  form.addEventListener('submit', () => {
    const button = form.querySelector('button[type="submit"]');
    if (!button || button.disabled) return;
    button.disabled = true;
    button.dataset.originalText = button.textContent;
    button.textContent = 'Saving…';
  });
}
