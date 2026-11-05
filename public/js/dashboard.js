
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

  // The launcher loads the existing, permission-checked server form. It never
  // recreates financial rules, CSRF tokens or idempotency keys in the browser.
  const transactionDialog = document.getElementById('transactionDialog');
  if (transactionDialog && typeof transactionDialog.showModal === 'function') {
    const operations = Object.freeze({
      cash_in: {page:'/tenant/mobile-money',form:'/tenant/mobile-money/cash-in',action:'/tenant/mobile-money/cash-in',title:'Mobile money · cash in'},
      cash_out: {page:'/tenant/mobile-money',form:'/tenant/mobile-money/cash-in',action:'/tenant/mobile-money/cash-out',title:'Mobile money · cash out'},
      transfer: {page:'/tenant/money-transfer',form:'/tenant/money-transfer/requests',action:'/tenant/money-transfer/requests',title:'New transfer request'},
      banking: {page:'/tenant/banking',form:'/tenant/banking/requests',action:'/tenant/banking/requests',title:'New banking request'},
      forex: {page:'/tenant/forex',form:'/tenant/forex/quotes',action:'/tenant/forex/quotes',title:'New forex quotation'},
      approval: {page:'/tenant/approvals',form:'/tenant/approvals/requests',action:'/tenant/approvals/requests',title:'New approval request'},
      cash_shift_open: {page:'/tenant/mobile-money/shifts',form:'/tenant/mobile-money/shifts/open',action:'/tenant/mobile-money/shifts/open',title:'Open cash shift',description:'An independent supervisor must verify this opening count before transactions can be recorded.'}
    });
    const choices = transactionDialog.querySelector('[data-transaction-choices]');
    const formHost = transactionDialog.querySelector('[data-transaction-form]');
    const submitActions = transactionDialog.querySelector('[data-transaction-submit-actions]');
    const status = transactionDialog.querySelector('[data-transaction-status]');
    const title = transactionDialog.querySelector('#transactionTitle');
    const description = transactionDialog.querySelector('#transactionDescription');
    const back = transactionDialog.querySelector('[data-transaction-back]');
    const enabledKinds = new Set([...choices.querySelectorAll('[data-transaction-kind]')].map(button=>button.dataset.transactionKind));
    let previousFocus = null, activeRequest = null, requestVersion = 0, saving = false;
    const message = (text, failed = false) => {
      status.hidden = !text;
      status.textContent = text;
      status.setAttribute('role', failed ? 'alert' : 'status');
      status.classList.toggle('failed', failed);
    };
    const reset = group => {
      activeRequest?.abort();
      requestVersion++;
      formHost.replaceChildren();
      submitActions.replaceChildren();
      choices.hidden = false;
      choices.querySelectorAll('[data-transaction-kind]').forEach(button=>{
        button.hidden = group === 'mobile_money' && !['cash_in','cash_out'].includes(button.dataset.transactionKind);
      });
      choices.querySelectorAll('a').forEach(link=>{link.hidden = group === 'mobile_money';});
      title.textContent = group === 'mobile_money' ? 'New mobile money record' : 'New transaction';
      description.textContent = 'Choose a module, then enter the operation details.';
      back.hidden = !group;
      message('');
    };
    const open = group => {
      if (saving) return;
      if (!transactionDialog.open) {
        previousFocus = document.activeElement;
        setMenu(false);
        transactionDialog.showModal();
        document.body.classList.add('transactionOpen');
      }
      reset(group);
      choices.querySelector('button:not([hidden])')?.focus();
    };
    const close = () => {
      if (saving) return;
      activeRequest?.abort();
      requestVersion++;
      transactionDialog.close();
      document.body.classList.remove('transactionOpen');
      previousFocus?.focus();
    };
    const responseMessage = async response => {
      const text = await response.text();
      if ((response.headers.get('content-type') || '').includes('text/plain')) return text.slice(0,1000);
      const errorPage = new DOMParser().parseFromString(text,'text/html');
      return errorPage.querySelector('[role="alert"]')?.textContent?.trim().slice(0,1000) ||
        `The request could not be completed (HTTP ${response.status}). Review the details and try again.`;
    };
    const load = async kind => {
      if (!enabledKinds.has(kind) || !operations[kind] || saving) return;
      if (!transactionDialog.open) open();
      activeRequest?.abort();
      activeRequest = new AbortController();
      const version = ++requestVersion, operation = operations[kind];
      choices.hidden = true;
      formHost.replaceChildren();
      submitActions.replaceChildren();
      back.hidden = false;
      title.textContent = operation.title;
      const branchLabel = document.querySelector('[data-operating-branch]');
      const branchDescription = branchLabel?.dataset.branchName ? [branchLabel.dataset.branchName,branchLabel.dataset.branchCurrency].filter(Boolean).join(' · ') : 'Your operating branch follows your account assignment.';
      description.textContent = operation.description ? `${branchDescription} · ${operation.description}` : branchDescription;
      message('Loading operation details…');
      try {
        const response = await fetch(operation.page,{credentials:'same-origin',headers:{Accept:'text/html'},signal:activeRequest.signal});
        if (version !== requestVersion) return;
        if (!response.ok) throw new Error(await responseMessage(response));
        if (new URL(response.url).pathname !== operation.page) throw new Error('Your session or access has changed. Open the module page to continue.');
        const page = new DOMParser().parseFromString(await response.text(),'text/html');
        const source = [...page.querySelectorAll('form[method="post"]')].find(form=>form.getAttribute('action') === operation.form);
        if (!source || source.querySelector('select[name="branchId"]')) {
          throw new Error(page.querySelector('[data-operation-branch-error]')?.textContent?.trim() ||
            'This operation needs an assigned operating branch and its required setup. Open the module to review what is needed.');
        }
        const form = source.cloneNode(true);
        form.setAttribute('action',operation.action);
        form.classList.remove('card');
        form.classList.add('transactionForm');
        form.id='transactionOperationForm';
        form.querySelector('.cardHead')?.remove();
        if(['cash_in','cash_out'].includes(kind))form.querySelector('.cardBody>p.tiny:first-child')?.remove();
        form.querySelectorAll('script,style,iframe,object,embed').forEach(node=>node.remove());
        form.querySelectorAll('*').forEach(node=>{
          [...node.attributes].filter(attribute=>/^on/i.test(attribute.name)).forEach(attribute=>node.removeAttribute(attribute.name));
        });
        form.querySelectorAll('button').forEach(button=>{
          const action = button.getAttribute('formaction');
          if (action && action !== operation.action) button.remove();
          else button.removeAttribute('formaction');
        });
        const submitButtons=[...form.querySelectorAll('button[type="submit"],button:not([type])')];
        submitButtons.forEach(button=>{button.setAttribute('form','transactionOperationForm');button.classList.add('btnPrimary');});
        const ids = new Map();
        form.querySelectorAll('[id]').forEach(node=>{ids.set(node.id,'operation-'+node.id);node.id='operation-'+node.id;});
        form.querySelectorAll('[for],[list],[aria-describedby]').forEach(node=>{
          for (const attribute of ['for','list','aria-describedby']) {
            const value=node.getAttribute(attribute);
            if(value)node.setAttribute(attribute,value.split(' ').map(id=>ids.get(id)||id).join(' '));
          }
        });
        form.addEventListener('invalid', event=>message(event.target.validationMessage || 'Check the highlighted field.',true),true);
        form.addEventListener('submit',async event=>{
          event.preventDefault();
          if(saving || !form.reportValidity())return;
          const buttons=submitButtons;
          const disabled=buttons.map(button=>button.disabled);
          const fields=new URLSearchParams(new FormData(form));
          saving=true;
          buttons.forEach(button=>{button.disabled=true;});
          back.disabled=true;
          transactionDialog.querySelectorAll('[data-close-transaction]').forEach(button=>{button.disabled=true;});
          message('Saving the operation…');
          try {
            const result=await fetch(operation.action,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:fields});
            if(result.ok && result.redirected && new URL(result.url).origin===location.origin){location.assign(result.url);return;}
            message(await responseMessage(result),true);
          } catch {
            message('The connection was interrupted. Check the module history before retrying; your request may already have been recorded.',true);
          } finally {
            saving=false;
            buttons.forEach((button,index)=>{button.disabled=disabled[index];});
            back.disabled=false;
            transactionDialog.querySelectorAll('[data-close-transaction]').forEach(button=>{button.disabled=false;});
          }
        });
        if(version!==requestVersion)return;
        formHost.append(form);
        submitButtons.forEach(button=>submitActions.append(button));
        message('');
        form.querySelector('input:not([type="hidden"]),select,textarea')?.focus();
      } catch(error) {
        if(version!==requestVersion || error.name==='AbortError')return;
        message(error.message || 'This operation is unavailable. Open the module to continue.',true);
        const fallback=document.createElement('a');
        fallback.className='btn';fallback.href=operation.page;fallback.textContent='Open module';formHost.append(fallback);
      }
    };
    document.querySelectorAll('[data-open-transaction]').forEach(button=>button.addEventListener('click',()=>open()));
    document.querySelectorAll('a[data-transaction-kind]').forEach(link=>link.addEventListener('click',event=>{
      const kind=link.dataset.transactionKind;
      if(kind==='mobile_money'){event.preventDefault();open('mobile_money');}
      else if(enabledKinds.has(kind)){event.preventDefault();open();load(kind);}
    }));
    choices.querySelectorAll('[data-transaction-kind]').forEach(button=>button.addEventListener('click',()=>load(button.dataset.transactionKind)));
    transactionDialog.querySelectorAll('[data-close-transaction]').forEach(button=>button.addEventListener('click',close));
    back.addEventListener('click',()=>reset());
    transactionDialog.addEventListener('cancel',event=>{event.preventDefault();close();});
    transactionDialog.addEventListener('click',event=>{
      if(event.target===transactionDialog){const rect=transactionDialog.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)close();}
    });
  }

  const toast = document.querySelector('.toast');
  if (toast) setTimeout(() => toast.remove(), 5200);
})();
