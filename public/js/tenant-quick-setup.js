(() => {
  'use strict';
  const container = document.getElementById('tenantQuickSetup');
  if (!container) return;
  const currency = container.querySelector('[data-quick-branch-currency]');
  const zone = container.querySelector('[data-quick-branch-zone]');
  const commonZone = { SSP:'Africa/Juba', UGX:'Africa/Kampala', KES:'Africa/Nairobi' };
  if (currency && zone) {
    currency.addEventListener('change', () => {
      const suggested = commonZone[currency.value];
      if (suggested && (!zone.value || zone.dataset.autoValue === zone.value)) {
        zone.value = suggested;
        zone.dataset.autoValue = suggested;
      }
    });
    zone.addEventListener('change', () => {
      zone.dataset.autoValue = '';
    });
  }
  const kind = container.querySelector('[data-quick-account-kind]');
  const provider = container.querySelector('[data-quick-provider]');
  const selectedCurrency = container.querySelector('[data-quick-account-currency]');
  const selectedBranch = container.querySelector('[data-quick-account-branch]');
  const operator = container.querySelector('[data-quick-operator]');
  if (!kind) return;
  const update = () => {
    for (const row of container.querySelectorAll('[data-quick-kind-field]')) {
      const visible = row.dataset.quickKindField.split(/\s+/).includes(kind.value);
      row.hidden = !visible;
      for (const field of row.querySelectorAll('input,select')) {
        field.disabled = !visible;
      }
    }
    if (provider) {
      provider.required = kind.value === 'wallet';
      if (kind.value !== 'wallet') provider.value = '';
    }
    if (operator && selectedBranch) {
      const branchId = selectedBranch.value;
      for (const option of operator.options) {
        option.disabled = Boolean(option.dataset.branchId && option.dataset.branchId !== branchId);
      }
      if (operator.selectedOptions[0]?.disabled) operator.value = '';
    }
    if (kind.value === 'wallet' && provider && selectedCurrency) {
      const fixed = provider.selectedOptions[0]?.dataset.marketCurrency;
      if (fixed && [...selectedCurrency.options].some(option => option.value === fixed)) {
        selectedCurrency.value = fixed;
      }
    }
  };
  kind.addEventListener('change', update);
  provider?.addEventListener('change', update);
  selectedBranch?.addEventListener('change', update);
  update();
})();