
(function(){
  const side = document.getElementById('sidePanel');
  const overlay = document.getElementById('menuOverlay');
  const menuBtn = document.getElementById('menuBtn');
  const mobile = window.matchMedia('(max-width:1120px)');
  const focusable = () => [...(side?.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex="0"]') || [])];
  const setMenu = (open, restoreFocus = false) => {
    const visible = mobile.matches && open;
    side?.classList.toggle('show', visible);
    overlay?.classList.toggle('show', visible);
    document.body.classList.toggle('drawerOpen', visible);
    menuBtn?.setAttribute('aria-expanded', String(visible));
    menuBtn?.setAttribute('aria-label', visible ? 'Close menu' : 'Open menu');
    if (side) side.inert = mobile.matches && !visible;
    if (visible) focusable()[0]?.focus();
    else if (restoreFocus) menuBtn?.focus();
  };
  menuBtn?.addEventListener('click', () => setMenu(!side?.classList.contains('show')));
  overlay?.addEventListener('click', () => setMenu(false, true));
  mobile.addEventListener('change', () => setMenu(false));
  document.addEventListener('keydown', event => {
    if (!side?.classList.contains('show')) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      setMenu(false, true);
    } else if (event.key === 'Tab') {
      const items = focusable();
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  });
  setMenu(false);

  const search = document.getElementById('search');
  search?.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    document.querySelectorAll('[data-search-row]').forEach((row) => {
      row.style.display = row.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
  });

  // Choosing a branch fills its already-configured currency; the server validates
  // both values again. No account identifiers or balances are fetched here.
  document.querySelectorAll('select[data-currency-target]').forEach(branch => {
    const currency=document.getElementById(branch.dataset.currencyTarget);
    if(!currency) return;
    const sync=()=>{
      const value=branch.selectedOptions[0]?.dataset.currency;
      if(value && [...currency.options].some(option=>option.value===value))currency.value=value;
    };
    branch.addEventListener('change',sync);
    sync();
  });

  document.querySelectorAll('[data-confirm]').forEach((el) => {
    el.addEventListener('click', (event) => {
      if (!confirm(el.getAttribute('data-confirm'))) event.preventDefault();
    });
  });

  // External event handling keeps the dashboard functional under a strict script CSP.
  document.querySelectorAll('[data-select-on-focus]').forEach(el => el.addEventListener('focus', () => el.select()));

  document.querySelectorAll('[data-tenant-create-form]').forEach(form => {
    const status = form.querySelector('[data-tenant-form-status]');
    const submit = form.querySelector('button[type="submit"]');
    const label = submit?.textContent;
    form.addEventListener('invalid', event => {
      if (status) {
        status.hidden = false;
        status.textContent = 'Please check the form. ' + event.target.validationMessage;
      }
    }, true);
    form.addEventListener('submit', () => {
      if (status) {
        status.hidden = false;
        status.textContent = 'Creating the tenant and preparing the owner invitation…';
      }
      if (submit) { submit.disabled = true; submit.textContent = 'Creating tenant…'; }
    });
    window.addEventListener('pageshow', () => {
      if (submit) { submit.disabled = false; submit.textContent = label; }
      if (status) status.hidden = true;
    });
  });

  const toast = document.querySelector('.toast');
  if (toast) setTimeout(() => toast.remove(), 5200);
})();
