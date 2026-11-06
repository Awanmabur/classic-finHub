
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

  document.querySelectorAll('[data-module-record-allocation]').forEach(select=>{
    const input=select.form?.elements.namedItem('recordsPerMonth');
    if(!input)return;
    let previousPositive=Number(input.value)>0?input.value:'1000';
    const sync=()=>{
      const required=select.selectedOptions[0]?.dataset.requiresRecords==='true';
      if(Number(input.value)>0)previousPositive=input.value;
      input.min=required?'1':'0';input.max=required?'1000000':'0';
      input.value=required?previousPositive:'0';input.readOnly=!required;
    };
    select.addEventListener('change',sync);sync();
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

  // Mobile Money uses the same server-issued form on its pages and in the sheet.
  // The preview is for display only; amounts and branch assignment are checked
  // again by the server when the operation is recorded.
  const initialiseMobileMoneyForm = (form, onOperationChange) => {
    if (!form?.matches('[data-mobile-money-form]')) return;
    const amount = form.elements.namedItem('amount');
    const fee = form.elements.namedItem('fee');
    const currency = form.dataset.currency;
    const decimals = currency === 'UGX' ? 0 : 2;
    const toMinor = value => {
      const match = String(value || '').match(/^(\d+)(?:\.(\d{1,2}))?$/);
      if (!match || (match[2] || '').length > decimals) return null;
      return BigInt(match[1]) * (10n ** BigInt(decimals)) + BigInt((match[2] || '').padEnd(decimals, '0') || '0');
    };
    const updateTotal = () => {
      const amountMinor = toMinor(amount.value), feeMinor = toMinor(fee.value);
      fee.setCustomValidity(amountMinor !== null && feeMinor !== null && feeMinor > amountMinor ? 'Fee / commission cannot exceed the amount.' : '');
      const total = form.querySelector('[data-mobile-total]');
      if (!total) return;
      if (amountMinor === null || amountMinor <= 0n || feeMinor === null || feeMinor > amountMinor) { total.textContent = '—'; return; }
      const totalMinor = amountMinor + (form.dataset.operation === 'cash_in' ? feeMinor : 0n);
      total.textContent = (form.dataset.currencyLabel || currency) + ' ' + (Number(totalMinor) / 10 ** decimals).toLocaleString('en-US', {minimumFractionDigits:decimals, maximumFractionDigits:decimals});
    };
    amount.addEventListener('input', updateTotal);
    fee.addEventListener('input', updateTotal);
    form.querySelectorAll('[data-mobile-operation]').forEach(tab => tab.addEventListener('click', event => {
      if (!onOperationChange) return; // Real page links remain usable without a dialog.
      event.preventDefault();
      const kind = tab.dataset.mobileOperation;
      if (!onOperationChange(kind)) return;
      form.dataset.operation = kind;
      form.querySelector('[data-mobile-operation-label]').value = kind === 'cash_in' ? 'Cash-in' : 'Cash-out';
      form.querySelectorAll('[data-mobile-operation]').forEach(option => {
        const selected = option === tab;
        option.classList.toggle('active', selected);
        if (selected) option.setAttribute('aria-current', 'page'); else option.removeAttribute('aria-current');
      });
      updateTotal();
    }));
    updateTotal();
  };
  document.querySelectorAll('[data-mobile-money-form]').forEach(form => initialiseMobileMoneyForm(form));

  const operationBindings = new WeakSet();
  const operationMinor = (text,scale) => {
    if(!/^(?:0|[1-9]\d{0,8})(?:\.\d{1,8})?$/.test(String(text||'')))return null;
    const [whole,part='']=String(text).split('.');
    if(part.length>scale)return null;
    return BigInt(whole)*10n**BigInt(scale)+BigInt(part.padEnd(scale,'0')||'0');
  };
  const operationAmount = (amount,code) => {
    const scale=code==='UGX'?0:2,factor=10n**BigInt(scale),n=amount<0n?-amount:amount;
    return `${code==='KES'?'KSH':code} ${amount<0n?'-':''}${(n/factor).toString().replace(/\B(?=(\d{3})+(?!\d))/g,',')}${scale?'.'+(n%factor).toString().padStart(scale,'0'):''}`;
  };
  const initialiseOperationForm = form => {
    if(!form?.matches('[data-transfer-form],[data-forex-form]')||operationBindings.has(form))return;
    operationBindings.add(form);
    if(form.matches('[data-transfer-form]')){
      form.querySelectorAll('[data-party-select]').forEach(select=>{
        const sync=()=>{
          const party=select.dataset.partySelect,option=select.selectedOptions[0];
          const phone=form.querySelector(`[data-party-phone="${party}"]`),country=form.querySelector(`[data-party-country="${party}"]`);
          if(phone)phone.value=option?.dataset.phone||'';
          if(country)country.value=[option?.dataset.country,country.dataset.branchName].filter(Boolean).join(' / ');
        };
        select.addEventListener('change',sync);sync();
      });
      const update=()=>{
        const scale=form.dataset.currency==='UGX'?0:2;
        const amount=operationMinor(form.elements.namedItem('amount').value,scale),fee=operationMinor(form.elements.namedItem('fee').value,scale);
        form.querySelector('[data-transfer-total]').textContent=amount!==null&&amount>0n&&fee!==null?operationAmount(amount+fee,form.dataset.currency):'—';
      };
      form.addEventListener('input',update);update();
    }
    if(form.matches('[data-forex-form]')){
      const rate=form.elements.namedItem('rateId');
      const update=()=>{
        const option=rate.selectedOptions[0],from=option?.dataset.from,to=option?.dataset.to;
        form.querySelector('[data-forex-currency="from"]').value=from==='KES'?'KSH':from||'';
        form.querySelector('[data-forex-currency="to"]').value=to==='KES'?'KSH':to||'';
        const source=from?operationMinor(form.elements.namedItem('amount').value,from==='UGX'?0:2):null;
        const scaled=option?.dataset.rate?operationMinor(option.dataset.rate,8):null;
        const output=form.querySelector('[data-forex-total]');
        if(source===null||source<=0n||scaled===null||scaled<=0n||!to){output.textContent='—';return;}
        const numerator=source*scaled*10n**BigInt(to==='UGX'?0:2),denominator=100000000n*10n**BigInt(from==='UGX'?0:2);
        output.textContent=operationAmount((numerator+denominator/2n)/denominator,to)+' (indicative)';
      };
      form.addEventListener('input',update);rate.addEventListener('change',update);update();
    }
  };
  document.querySelectorAll('[data-transfer-form],[data-forex-form]').forEach(initialiseOperationForm);

  // The launcher loads the existing, permission-checked server form. It never
  // recreates financial rules, CSRF tokens or idempotency keys in the browser.
  const transactionDialog = document.getElementById('transactionDialog');
  if (transactionDialog && typeof transactionDialog.showModal === 'function') {
    const operations = Object.freeze({
      cash_in: {page:'/tenant/mobile-money/cash-in',form:'/tenant/mobile-money/cash-in',action:'/tenant/mobile-money/cash-in',title:'Mobile Money - Cash-in',description:'Only mobile money fields are shown.'},
      cash_out: {page:'/tenant/mobile-money/cash-out',form:'/tenant/mobile-money/cash-out',action:'/tenant/mobile-money/cash-out',title:'Mobile Money - Cash-out',description:'Only mobile money fields are shown.'},
      transfer: {page:'/tenant/money-transfer/send',form:'/tenant/money-transfer/requests',action:'/tenant/money-transfer/requests',title:'Send money / Generate PIN'},
      banking_deposit: {page:'/tenant/banking/deposit',form:'/tenant/banking/requests',action:'/tenant/banking/requests',title:'Banking - Deposit'},
      banking_withdrawal: {page:'/tenant/banking/withdraw',form:'/tenant/banking/requests',action:'/tenant/banking/requests',title:'Banking - Withdraw'},
      banking_transfer: {page:'/tenant/banking/transfer',form:'/tenant/banking/requests',action:'/tenant/banking/requests',title:'Banking - Account transfer'},
      customer: {page:'/tenant/customers/new',form:'/tenant/customers',action:'/tenant/customers',title:'New customer'},
      account: {page:'/tenant/accounts/new',form:'/tenant/accounts',action:'/tenant/accounts',title:'New account'},
      expense: {page:'/tenant/expenses/new',form:'/tenant/expenses',action:'/tenant/expenses',title:'Add expense'},
      forex_buy: {page:'/tenant/forex/buy',form:'/tenant/forex/quotes',action:'/tenant/forex/quotes',title:'Forex Operations - Buy',description:'Buy or sell foreign currency with rate, commission, and drawer impact.'},
      forex_sell: {page:'/tenant/forex/sell',form:'/tenant/forex/quotes',action:'/tenant/forex/quotes',title:'Forex Operations - Sell',description:'Buy or sell foreign currency with rate, commission, and drawer impact.'},
      banking: {page:'/tenant/banking',form:'/tenant/banking/requests',action:'/tenant/banking/requests',title:'New banking request'},
      forex: {page:'/tenant/forex',form:'/tenant/forex/quotes',action:'/tenant/forex/quotes',title:'New forex quotation'},
      approval: {page:'/tenant/approvals',form:'/tenant/approvals/requests',action:'/tenant/approvals/requests',title:'New approval request'},
      cash_shift_close: {page:'/tenant/day/close',form:'/tenant/day/close',action:'/tenant/day/close',title:'Close day',description:'Auto closing balances from reports.'},
      cash_shift_open: {page:'/tenant/mobile-money/shifts',form:'/tenant/mobile-money/shifts/open',action:'/tenant/mobile-money/shifts/open',title:'Open day',description:'Opening drawer by currency. An independent supervisor verifies the opening count.'}
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
      if(mobile.matches && side?.contains(previousFocus))menuBtn?.focus();else previousFocus?.focus();
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
      description.textContent = operation.description || branchDescription;
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
        form.querySelectorAll('[data-expense-close],[data-directory-close]').forEach(node=>node.remove());
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
        let submitAction = operation.action;
        initialiseMobileMoneyForm(form, nextKind => {
          if (!enabledKinds.has(nextKind) || !['cash_in','cash_out'].includes(nextKind) || saving) return false;
          submitAction = operations[nextKind].action;
          form.setAttribute('action', submitAction);
          title.textContent = operations[nextKind].title;
          message('');
          return true;
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
            const result=await fetch(submitAction,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:fields});
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
        window.ClassicFinDirectory?.initialiseForm(form);
        initialiseOperationForm(form);
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
    document.querySelectorAll('[data-open-transaction]').forEach(button=>button.addEventListener('click',event=>{event.preventDefault();open();}));
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

  document.querySelectorAll('[data-print-report]').forEach(button=>button.addEventListener('click',()=>window.print()));

  const toast = document.querySelector('.toast');
  if (toast) setTimeout(() => toast.remove(), 5200);
})();
