// Invitation secrets are carried in URL fragments, never sent in GET requests or proxy logs.
(() => {
  const form = document.querySelector('[data-activation-form]');
  const hidden = form?.querySelector('[data-activation-token]');
  if (!form || !hidden) return;
  const token = new URLSearchParams(window.location.hash.slice(1)).get('token') || '';
  const slug = form.querySelector('input[name="slug"]')?.value;
  if (slug !== undefined && !/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/.test(slug)) return;
  if (!/^[a-f0-9]{64}$/.test(token)) return;
  hidden.value = token;
  form.hidden = false;
  document.querySelector('[data-activation-missing]')?.remove();
  history.replaceState(null, '', window.location.pathname + window.location.search);
})();
