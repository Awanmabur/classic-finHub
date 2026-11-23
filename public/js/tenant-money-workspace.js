'use strict';
// Keep setup fields small. All financial changes are validated and posted
// by the existing server services; the browser never calculates balances.
for (const form of document.querySelectorAll('[data-money-create-form]')) {
  const kind = form.querySelector('[data-money-create-kind]');
  const field = form.querySelector('[data-money-create-network-field]');
  const network = form.querySelector('[data-money-create-network]');
  if (!kind || !field || !network) continue;
  const update = () => {
    const isWallet = kind.value === 'wallet';
    field.hidden = !isWallet;
    network.required = isWallet;
    if (!isWallet) network.value = '';
  };
  kind.addEventListener('change', update);
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
