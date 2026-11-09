'use strict';
(() => {
  let opener = null;
  const edit = document.getElementById('branchEditDialog');
  const details = document.getElementById('branchDetailsDialog');
  const currencyLabel = value => value === 'KES' ? 'KSH' : value;
  const show = (dialog, trigger) => {
    if (!dialog || typeof dialog.showModal !== 'function') return;
    opener = trigger;
    dialog.querySelectorAll('[data-branch-form-status]').forEach(node => { node.hidden = true; node.textContent = ''; });
    dialog.showModal();
    const field = dialog.querySelector('form input:not([type="hidden"]):not([readonly]),form select,form textarea');
    (field || dialog.querySelector('button[data-branch-close]'))?.focus();
  };
  document.querySelectorAll('[data-branch-open]').forEach(button => button.addEventListener('click', () => {
    const dialog = document.getElementById(button.dataset.branchOpen);
    dialog?.querySelector('form')?.reset(); show(dialog, button);
  }));
  document.querySelectorAll('[data-branch-edit]').forEach(button => button.addEventListener('click', () => {
    const row = button.closest('[data-branch-row]');
    if (!row || !edit || !/^[a-f0-9]{24}$/i.test(row.dataset.branchId)) return;
    const form = edit.querySelector('form');
    form.action = '/tenant/branches/' + row.dataset.branchId + '/update';
    form.elements.namedItem('name').value = row.dataset.branchName;
    form.elements.namedItem('address').value = row.dataset.branchAddress;
    edit.querySelector('[data-branch-edit-code]').textContent = row.dataset.branchCode;
    edit.querySelector('[data-branch-edit-default]').value = currencyLabel(row.dataset.branchCurrency);
    const enabled = row.dataset.branchCurrencies.split(',');
    form.querySelectorAll('[name="currencies"]').forEach(input => { input.checked = enabled.includes(input.value); });
    show(edit, button);
  }));
  document.querySelectorAll('[data-branch-details]').forEach(button => button.addEventListener('click', () => {
    const row = button.closest('[data-branch-row]'); if (!row || !details) return;
    const values = {name: row.dataset.branchName, code: row.dataset.branchCode, address: row.dataset.branchAddress || 'No address added', currencies: row.dataset.branchCurrencies.split(',').map(currencyLabel).join(' · '), currency: currencyLabel(row.dataset.branchCurrency), status: row.dataset.branchStatus};
    details.querySelectorAll('[data-branch-detail]').forEach(node => { node.textContent = values[node.dataset.branchDetail] || ''; });
    show(details, button);
  }));
  document.querySelectorAll('.branchDialog').forEach(dialog => {
    dialog.querySelectorAll('[data-branch-close]').forEach(button => button.addEventListener('click', () => dialog.close()));
    dialog.addEventListener('close', () => opener?.focus());
    dialog.addEventListener('click', event => {
      if (event.target !== dialog) return;
      const bounds = dialog.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
    });
  });
  const submitting = new WeakSet();
  document.querySelectorAll('form[data-branch-write]').forEach(form => form.addEventListener('submit', async event => {
    if (!window.fetch || !navigator.onLine) return;
    event.preventDefault(); if (submitting.has(form) || !form.reportValidity()) return;
    const target = new URL(form.action, location.origin);
    if (target.origin !== location.origin || !/^\/tenant\/branches(?:\/[a-f0-9]{24}\/(?:update|archive|restore)|\/operating)?$/i.test(target.pathname)) return;
    const status = form.querySelector('[data-branch-form-status]') || form.closest('[data-branch-row]')?.querySelector('[data-branch-row-status]');
    const buttons = [...form.elements].filter(input => input.tagName === 'BUTTON' && input.type === 'submit'), disabled = buttons.map(button => button.disabled);
    const fields = new URLSearchParams(new FormData(form));
    const controller = new AbortController(), timeout = window.setTimeout(() => controller.abort(), 15000);
    submitting.add(form); buttons.forEach(button => { button.disabled = true; });
    if (status) { status.hidden = false; status.textContent = 'Saving branch…'; }
    try {
      const response = await fetch(target, {method: 'POST', credentials: 'same-origin', headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: fields, signal: controller.signal});
      const destination = new URL(response.url);
      if (response.ok && response.redirected && destination.origin === location.origin && destination.pathname === '/tenant/branches') { location.assign(destination.href); return; }
      if (response.redirected && destination.origin === location.origin && destination.pathname === '/signin') { location.assign(destination.href); return; }
      const message = response.headers.get('content-type')?.includes('text/plain') ? (await response.text()).slice(0, 600) : 'The branch could not be saved. Review the details and try again.';
      if (status) status.textContent = message;
    } catch { if (status) status.textContent = 'Connection interrupted. Check the branch list before retrying; your changes may already have been saved.'; }
    finally { window.clearTimeout(timeout); submitting.delete(form); buttons.forEach((button, index) => { button.disabled = disabled[index]; }); }
  }));
})();
