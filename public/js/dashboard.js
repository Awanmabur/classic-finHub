
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


  // Prototype-style modal presentation for REAL server-side forms. Original
  // form actions, CSRF fields, idempotency keys and permission gates stay intact.
  function attachDialog(dialog, triggers) {
    if(!dialog || !triggers.length) return null;
    const closeButton=dialog.querySelector('[data-dialog-close]');
    const isOpen=()=>dialog.classList.contains('show');
    let priorFocus=null;
    const close=()=>{
      if(!isOpen())return;
      dialog.classList.remove('show');
      dialog.setAttribute('aria-hidden','true');
      document.body.classList.remove('modalOpen');
      triggers.forEach(trigger=>trigger.setAttribute('aria-expanded','false'));
      (priorFocus?.isConnected ? priorFocus : triggers[0])?.focus();
    };
    const open=()=>{
      if(isOpen())return;
      priorFocus=document.activeElement;
      dialog.classList.add('show');
      dialog.setAttribute('aria-hidden','false');
      document.body.classList.add('modalOpen');
      triggers.forEach(trigger=>trigger.setAttribute('aria-expanded','true'));
      (dialog.querySelector('button:not([disabled]),input:not([type="hidden"]):not([disabled]),select:not([disabled]),a[href]')||dialog)?.focus();
    };
    triggers.forEach(trigger=>trigger.addEventListener('click',open));
    closeButton?.addEventListener('click',close);
    dialog.addEventListener('click',event=>{if(event.target===dialog)close();});
    document.addEventListener('keydown',event=>{
      if(!isOpen())return;
      if(event.key==='Escape'){event.preventDefault();close();return;}
      if(event.key!=='Tab')return;
      const focusable=[...dialog.querySelectorAll('a[href],button:not([disabled]),input:not([type="hidden"]):not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex="0"]')].filter(el=>el.getClientRects().length);
      if(!focusable.length){event.preventDefault();return;}
      const first=focusable[0],last=focusable[focusable.length-1];
      if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
      else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
    });
    return {open,close};
  }
  attachDialog(document.getElementById('operationChooser'),[
    document.getElementById('newTransactionBtn'),
    ...document.querySelectorAll('[data-open-operation-chooser]')
  ].filter(Boolean));

  const requestedForm = (()=>{try{return new URLSearchParams(window.location?.search||'').get('new');}catch{return null;}})();
  let autoOpened=false;
  document.querySelectorAll('form[data-operation-form]').forEach(form=>{
    const parent=form.parentElement;
    if(!parent)return;
    const kind=form.getAttribute('data-operation-form')||'record';
    const title=form.getAttribute('data-operation-title')||'New operation';
    const launcher=document.createElement('section');
    launcher.className='card operationLauncher';
    const head=document.createElement('div');
    head.className='cardHead';
    const heading=document.createElement('b');
    heading.textContent=title;
    head.appendChild(heading);
    const body=document.createElement('div');
    body.className='cardBody';
    const button=document.createElement('button');
    button.type='button';
    button.className='btn btnPrimary';
    button.textContent='Open '+title;
    button.setAttribute('aria-haspopup','dialog');
    button.setAttribute('aria-expanded','false');
    const dialogId='operationForm_'+kind;
    button.setAttribute('aria-controls',dialogId);
    const note=document.createElement('p');
    note.className='tiny';
    note.textContent='The same server-validated form opens in a modal. No action is performed until you submit it.';
    body.appendChild(button);body.appendChild(note);
    launcher.appendChild(head);launcher.appendChild(body);
    parent.replaceChild(launcher,form);

    const overlay=document.createElement('div');
    overlay.className='overlay';
    overlay.id=dialogId;
    overlay.setAttribute('role','dialog');
    overlay.setAttribute('aria-modal','true');
    overlay.setAttribute('aria-label',title);
    overlay.setAttribute('aria-hidden','true');
    const sheet=document.createElement('div');
    sheet.className='sheet operationSheet';
    const sheetHead=document.createElement('div');
    sheetHead.className='sheetHead';
    const sheetTitle=document.createElement('b');
    sheetTitle.textContent=title;
    const closeButton=document.createElement('button');
    closeButton.type='button';
    closeButton.className='btn btnIcon';
    closeButton.setAttribute('data-dialog-close','');
    closeButton.setAttribute('aria-label','Close '+title);
    closeButton.textContent='×';
    sheetHead.appendChild(sheetTitle);sheetHead.appendChild(closeButton);
    const sheetBody=document.createElement('div');
    sheetBody.className='sheetBody';
    sheetBody.appendChild(form);
    sheet.appendChild(sheetHead);sheet.appendChild(sheetBody);
    overlay.appendChild(sheet);
    document.body.appendChild(overlay);
    const controller=attachDialog(overlay,[button]);
    if(!autoOpened && requestedForm && (requestedForm==='1'||requestedForm===kind)){
      autoOpened=true;
      controller?.open();
    }
  });

  const toast = document.querySelector('.toast');
  if (toast) setTimeout(() => toast.remove(), 5200);
})();
