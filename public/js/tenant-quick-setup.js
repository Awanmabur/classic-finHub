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
  const accountForm = container.querySelector('form[action="/tenant/setup/account"]');
  const kind = accountForm?.querySelector('[data-quick-account-kind]');
  const accountName = accountForm?.querySelector('[data-quick-account-name]');
  const provider = accountForm?.querySelector('[data-quick-provider]');
  const selectedCurrency = accountForm?.querySelector('[data-quick-account-currency]');
  const selectedBranch = accountForm?.querySelector('[data-quick-account-branch]');
  const operator = accountForm?.querySelector('[data-quick-operator]');
  const currencyStatus = accountForm?.querySelector('[data-quick-currency-status]');
  let nameCustomized = false;
  accountName?.addEventListener('input', () => { nameCustomized = Boolean(accountName.value.trim()); });
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
    if (selectedCurrency) {
      // Currency availability belongs to the selected branch, not the
      // platform-wide catalogue or currencies of other branches.
      const branchId = selectedBranch?.value || '';
      for (const option of selectedCurrency.options) {
        if (!option.value) continue;
        const branches = (option.dataset.enabledBranches || '').split(',').filter(Boolean);
        option.disabled = !branches.includes(branchId);
      }
      const fixed = kind.value === 'wallet'
        ? provider?.selectedOptions[0]?.dataset.marketCurrency || '' : '';
      const fixedOption = [...selectedCurrency.options].find(option => option.value === fixed);
      if (fixed && (!fixedOption || fixedOption.disabled)) {
        selectedCurrency.value = '';
        if (currencyStatus) currencyStatus.textContent =
          'This provider uses ' + (fixed === 'KES' ? 'KSH' : fixed) +
          '. Enable that currency in Branches before creating this wallet.';
      } else {
        if (fixed) selectedCurrency.value = fixed;
        else if (!selectedCurrency.value || selectedCurrency.selectedOptions[0]?.disabled) {
          const first = [...selectedCurrency.options].find(option => option.value && !option.disabled);
          selectedCurrency.value = first?.value || '';
        }
        if (currencyStatus) currencyStatus.textContent = selectedCurrency.value
          ? '' : 'Enable a supported currency in Branches to create this account.';
      }
    }
    // Suggest a clear label without overwriting an owner's own account name.
    if (accountName && !nameCustomized) {
      const currencyLabel = selectedCurrency?.value === 'KES' ? 'KSH' : (selectedCurrency?.value || '');
      const typeName = kind.value === 'wallet'
        ? (provider?.value ? provider.value + ' float' : 'Mobile money float')
        : kind.value === 'cash'
          ? (operator?.value ? operator.selectedOptions[0]?.textContent.split(' · ')[0] + ' cash drawer' : 'Owner cash drawer')
          : kind.value === 'bank' ? 'Bank account'
            : kind.value === 'forex_stock' ? 'Forex stock' : kind.value === 'transfer_clearing' ? 'Transfer payable' : '';
      accountName.value = typeName ? typeName + (currencyLabel ? ' ' + currencyLabel : '') : '';
    }
  };
  kind.addEventListener('change', update);
  provider?.addEventListener('change', update);
  selectedBranch?.addEventListener('change', update);
  operator?.addEventListener('change', update);
  selectedCurrency?.addEventListener('change', () => {
    // Provider currency is authoritative; do not show a misleading choice.
    update();
  });
  update();
})();