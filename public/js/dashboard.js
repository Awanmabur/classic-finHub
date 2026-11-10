
(function(){
  const side = document.getElementById('sidePanel');
  const overlay = document.getElementById('menuOverlay');
  const menuBtn = document.getElementById('menuBtn');
  const mobile = window.matchMedia('(max-width:1120px)');
  const scheduleNavigation=handler=>typeof requestAnimationFrame==='function'?requestAnimationFrame(handler):handler();
  const navigation=document.getElementById('nav');
  const activeNavigation=()=>navigation?.querySelector('[aria-current="page"]');
  const keepActiveNavigationVisible=()=>{
    const active=activeNavigation();if(!active||!navigation||mobile.matches&&!side?.classList.contains('show'))return;
    const bounds=navigation.getBoundingClientRect(),item=active.getBoundingClientRect(),gap=10;
    if(item.top<bounds.top+gap)navigation.scrollTop+=item.top-bounds.top-gap;
    else if(item.bottom>bounds.bottom-gap)navigation.scrollTop+=item.bottom-bounds.bottom+gap;
  };
  const focusable = () => [...(side?.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex="0"]') || [])];
  const setMenu = (open, restoreFocus = false) => {
    const visible = mobile.matches && open;
    side?.classList.toggle('show', visible);
    overlay?.classList.toggle('show', visible);
    document.body.classList.toggle('drawerOpen', visible);
    menuBtn?.setAttribute('aria-expanded', String(visible));
    menuBtn?.setAttribute('aria-label', visible ? 'Close menu' : 'Open menu');
    if (side) side.inert = mobile.matches && !visible;
    if (visible) { (activeNavigation()||focusable()[0])?.focus({preventScroll:true});scheduleNavigation(keepActiveNavigationVisible); }
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
  scheduleNavigation(keepActiveNavigationVisible);
  document.fonts?.ready.then(keepActiveNavigationVisible);
  window.addEventListener?.('pageshow',keepActiveNavigationVisible);
  if(navigation&&typeof ResizeObserver!=='undefined')new ResizeObserver(()=>scheduleNavigation(keepActiveNavigationVisible)).observe(navigation);

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

  let approvedFieldNumber=0;
  const initialiseApprovedFields = form => {
    form.querySelectorAll('label.field').forEach(outer=>{
      const control=[...outer.children].find(node=>node.matches('input,select,textarea,.control')&&!node.matches('input[type="hidden"],input[type="checkbox"],input[type="radio"]'));
      if(!control)return;
      const field=document.createElement('div');
      for(const attribute of outer.attributes){if(attribute.name!=='for')field.setAttribute(attribute.name,attribute.value);}
      const label=document.createElement('label');
      for(const node of [...outer.childNodes]){if(node===control)break;if(node.nodeType===1&&node.matches('input[type="hidden"]'))field.append(node);else label.append(node);}
      const input=control.matches('input,select,textarea')?control:control.querySelector('input,select,textarea');
      if(input){if(!input.id)input.id='approved-field-'+(++approvedFieldNumber);label.htmlFor=input.id;}
      field.append(label);
      if(control.matches('input,select,textarea')){const wrapper=document.createElement('div');wrapper.className='control';control.classList.remove('control');wrapper.append(control);field.append(wrapper);}else field.append(control);
      while(outer.firstChild)field.append(outer.firstChild);outer.replaceWith(field);
    });
  };
  document.querySelectorAll('[data-mobile-money-form],[data-transfer-form],[data-forex-form],#directoryForm,[data-expense-form],[data-funded-form],[data-payout-form],[data-cash-open-form]').forEach(initialiseApprovedFields);

  // Mobile Money uses the same server-issued form on its pages and in the sheet.
  // The preview is for display only; amounts and branch assignment are checked
  // again by the server when the operation is recorded.
  const initialiseMobileMoneyForm = (form, onOperationChange) => {
    if (!form?.matches('[data-mobile-money-form]')) return;
    const amount = form.elements.namedItem('amount');
    const fee = form.elements.namedItem('fee');
    const currencyControl = form.elements.namedItem('currency');
    const selectedCurrency = () => currencyControl?.value || form.dataset.currency;
    const toMinor = (value,decimals) => {
      const match = String(value || '').match(/^(\d+)(?:\.(\d{1,2}))?$/);
      if (!match || (match[2] || '').length > decimals) return null;
      return BigInt(match[1]) * (10n ** BigInt(decimals)) + BigInt((match[2] || '').padEnd(decimals, '0') || '0');
    };
    const updateTotal = () => {
      const currency=selectedCurrency(),decimals=currency==='UGX'?0:2;
      form.dataset.currency=currency;form.dataset.currencyLabel=currency==='KES'?'KSH':currency;
      const pattern=decimals?'[0-9]{1,11}([.][0-9]{1,2})?':'[0-9]{1,11}';amount.pattern=pattern;fee.pattern=pattern;
      const amountMinor = toMinor(amount.value,decimals), feeMinor = toMinor(fee.value,decimals);
      fee.setCustomValidity(amountMinor !== null && feeMinor !== null && feeMinor > amountMinor ? 'Fee / commission cannot exceed the amount.' : '');
      const total = form.querySelector('[data-mobile-total]');
      if (!total) return;
      const totalLabel=form.querySelector('[data-mobile-total-label]');
      if(totalLabel)totalLabel.textContent=form.dataset.operation==='cash_out'?'Total customer receives':'Total customer pays';
      if (amountMinor === null || amountMinor <= 0n || feeMinor === null || feeMinor > amountMinor) { total.textContent = '—'; return; }
      const collected=(form.elements.namedItem('feeTreatment')?.value||form.querySelector('[data-wallet-account]')?.selectedOptions[0]?.dataset.feeTreatment)==='payment_collected';
      const totalMinor = amountMinor + (collected?(form.dataset.operation === 'cash_in' ? feeMinor : -feeMinor):0n);
      total.textContent = (form.dataset.currencyLabel || currency) + ' ' + (Number(totalMinor) / 10 ** decimals).toLocaleString('en-US', {minimumFractionDigits:decimals, maximumFractionDigits:decimals});
    };
    amount.addEventListener('input', updateTotal);
    fee.addEventListener('input', updateTotal);
    currencyControl?.addEventListener('change',updateTotal);
    form.addEventListener('reset',()=>queueMicrotask(updateTotal));
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
  const mobileFundsBindings=new WeakSet();
  const initialiseMobileFunds=form=>{
    if(!form?.matches('[data-mobile-money-form]')||mobileFundsBindings.has(form))return;
    const wallet=form.querySelector('[data-wallet-account]'),customer=form.querySelector('[data-customer-wallet]');
    if(!wallet||!customer)return;mobileFundsBindings.add(form);
    const network=form.elements.namedItem('network'),method=form.elements.namedItem('paymentMethod'),amount=form.elements.namedItem('amount'),fee=form.elements.namedItem('fee'),currencyControl=form.elements.namedItem('currency');
    const selectedCurrency=()=>currencyControl?.value||form.dataset.currency;
    const parse=value=>{
      const scale=selectedCurrency()==='UGX'?0:2;
      const match=String(value||'').match(/^(\d{1,11})(?:\.(\d{1,2}))?$/);if(!match||(match[2]||'').length>scale)return null;
      return BigInt(match[1])*10n**BigInt(scale)+BigInt((match[2]||'').padEnd(scale,'0')||'0');
    };
    const refresh=()=>{
      const currency=selectedCurrency(),current=wallet.value,available=[];
      for(const option of wallet.options){if(!option.value)continue;const visible=option.dataset.network===network.value&&option.dataset.currency===currency;option.hidden=!visible;option.disabled=!visible||option.dataset.state!=='active'||!/^\d{1,34}$/.test(option.dataset.expectedMinor||'');if(!option.disabled)available.push(option);}
      if(!available.some(option=>option.value===current)){
        const own=available.filter(option=>option.dataset.assigned==='true'),eligible=own.length?own:available,defaults=eligible.filter(option=>option.dataset.default==='true');
        wallet.value=defaults.length===1?defaults[0].value:eligible.length===1?eligible[0].value:'';
      }
      for(const option of customer.options){if(!option.value)continue;const visible=option.dataset.currency===currency;option.hidden=!visible;option.disabled=!visible;}
      if(customer.selectedOptions[0]?.disabled)customer.value='';
      const internal=method.value==='Wallet Balance';form.querySelector('[data-customer-wallet-field]').hidden=!internal;customer.disabled=!internal;customer.required=internal;
    };
    const update=()=>{
      const currency=selectedCurrency();
      const option=wallet.selectedOptions[0],value=parse(amount.value),charge=parse(fee.value||'0'),treatment=option?.dataset.feeTreatment||'record_only';
      const policy=form.querySelector('[data-wallet-fee-policy]');if(policy){policy.value=treatment;policy.disabled=!option?.value;}
      const before=option?.value&&/^\d{1,34}$/.test(option.dataset.expectedMinor||'')?BigInt(option.dataset.expectedMinor):null;
      const after=before!==null&&value!==null&&charge!==null?before+(form.dataset.operation==='cash_in'?-value:value)+(treatment==='wallet_commission'?charge:0n):null;
      amount.setCustomValidity(value!==null&&value<=0n?'Enter an amount greater than zero.':after!==null&&after<0n?'The selected wallet has insufficient funds.':'');
      const label=form.querySelector('[data-mobile-total-label]');if(label)label.textContent=form.dataset.operation==='cash_out'?'Total customer receives':'Total customer pays';
      const total=form.querySelector('[data-mobile-total]');if(total)total.textContent=value!==null&&value>0n&&charge!==null&&charge<=value?operationAmount(value+(treatment==='payment_collected'?(form.dataset.operation==='cash_in'?charge:-charge):0n),currency):'—';
    };
    network.addEventListener('change',()=>{refresh();update();});method.addEventListener('change',()=>{refresh();update();});
    currencyControl?.addEventListener('change',()=>{refresh();update();});
    form.addEventListener('input',update);form.addEventListener('change',update);form.addEventListener('reset',()=>queueMicrotask(()=>{refresh();update();}));
    refresh();update();
  };
  document.querySelectorAll('[data-mobile-money-form]').forEach(initialiseMobileFunds);

  const initialiseOperationForm = form => {
    if(!form?.matches('[data-transfer-form],[data-forex-form],form:has([data-account-currency])')||operationBindings.has(form))return;
    operationBindings.add(form);
    if(form.matches('[data-transfer-form]')){
      const update=()=>{
        const currency=form.elements.namedItem('currency')?.value||form.dataset.currency;
        form.dataset.currency=currency;
        const destination=form.elements.namedItem('destinationBranchId');if(destination){for(const option of destination.options){if(!option.value)continue;option.disabled=Boolean(option.dataset.currencies)&&!option.dataset.currencies.split(',').includes(currency);}if(destination.selectedOptions[0]?.disabled)destination.value='';}
        const scale=currency==='UGX'?0:2;
        const amount=operationMinor(form.elements.namedItem('amount').value,scale),fee=operationMinor(form.elements.namedItem('fee').value,scale);
        form.querySelector('[data-transfer-total]').textContent=amount!==null&&amount>0n&&fee!==null?operationAmount(amount+fee,form.dataset.currency):'—';
      };
      form.addEventListener('input',update);form.addEventListener('change',update);form.addEventListener('reset',()=>queueMicrotask(update));update();
    }
    if(form.querySelector('[data-account-currency]')){
      const currency=form.elements.namedItem('currency'),kind=form.elements.namedItem('kind'),source=form.elements.namedItem('sourceId'),destination=form.elements.namedItem('destinationId'),channel=form.elements.namedItem('paymentChannel');
      const update=()=>{
        const transfer=kind?.value==='transfer_request';
        form.querySelectorAll('select:has([data-account-currency])').forEach(select=>{
          for(const option of select.options){
            if(!option.value)continue;
            const sameAccount=select===destination&&Boolean(source?.value)&&option.value===source.value;
            option.hidden=option.dataset.accountCurrency!==currency.value||sameAccount;option.disabled=option.hidden;
          }
          if(select.selectedOptions[0]?.disabled)select.value='';
        });
        if(destination){
          destination.disabled=!transfer;destination.required=transfer;
          const field=form.querySelector('[data-banking-destination-field]');if(field)field.hidden=!transfer;
          if(!transfer)destination.value='';
        }
        if(channel){
          for(const option of channel.options){option.hidden=(option.dataset.bankingChannel==='transfer')!==transfer;option.disabled=option.hidden;}
          if(!channel.value||channel.selectedOptions[0]?.disabled)channel.value=[...channel.options].find(option=>!option.disabled)?.value||'';
        }
        const available=source?[...source.options].filter(option=>option.value&&!option.disabled).length:0;
        const insufficient=available<(transfer?2:1),submit=form.querySelector('[data-banking-submit]'),status=form.querySelector('[data-banking-choices-status]');
        if(submit)submit.disabled=insufficient;
        if(status)status.textContent=insufficient?(transfer?'Account transfers need two different accounts in the selected currency.':'No customer account is available in the selected currency.'):'';
      };
      currency?.addEventListener('change',update);kind?.addEventListener('change',update);source?.addEventListener('change',update);
      form.addEventListener('reset',()=>queueMicrotask(update));if(currency)update();
    }
    if(form.matches('[data-forex-form]')){
      const rate=form.elements.namedItem('rateId'),validity=form.elements.namedItem('validMinutes'),commission=form.elements.namedItem('commission');
      const fromField=form.querySelector('[data-forex-currency="from"]'),toField=form.querySelector('[data-forex-currency="to"]');
      const pairOptions=()=>[...rate.options].filter(option=>option.value&&!option.disabled);
      const filterDestinations=()=>{
        if(toField?.tagName!=='SELECT')return;
        for(const option of toField.options){option.hidden=option.value===fromField.value||!pairOptions().some(candidate=>candidate.dataset.from===fromField.value&&candidate.dataset.to===option.value);option.disabled=option.hidden;}
        if(toField.selectedOptions[0]?.disabled)toField.value=[...toField.options].find(option=>!option.disabled)?.value||'';
      };
      const update=()=>{
        const now=Date.now();
        for(const candidate of rate.options){if(candidate.value&&candidate.dataset.expiresAt){const expiresAt=new Date(candidate.dataset.expiresAt).getTime();candidate.hidden=!Number.isFinite(expiresAt)||expiresAt<=now+5*60000+1000;candidate.disabled=candidate.hidden;}}
        if(rate.selectedOptions[0]?.disabled)rate.value='';
        const option=rate.selectedOptions[0],from=option?.dataset.from,to=option?.dataset.to;
        if(from)fromField.value=fromField.tagName==='SELECT'?from:from==='KES'?'KSH':from;
        if(to)toField.value=toField.tagName==='SELECT'?to:to==='KES'?'KSH':to;
        filterDestinations();
        if(validity&&option?.dataset.expiresAt){
          const expiresAt=new Date(option.dataset.expiresAt).getTime(),previous=Number(validity.value)||15;
          for(const minutes of validity.options){minutes.hidden=!Number.isFinite(expiresAt)||expiresAt<=now+Number(minutes.value)*60000+1000;minutes.disabled=minutes.hidden;}
          if(!validity.value||validity.selectedOptions[0]?.disabled)validity.value=[...validity.options].filter(minutes=>!minutes.disabled&&Number(minutes.value)<=previous).at(-1)?.value||[...validity.options].find(minutes=>!minutes.disabled)?.value||'';
        }
        rate.setCustomValidity(!rate.value||validity&&!validity.value?'Choose an approved rate with enough remaining validity.':'');
        const source=from?operationMinor(form.elements.namedItem('amount').value,from==='UGX'?0:2):null;
        const scaled=option?.dataset.rate?operationMinor(option.dataset.rate,8):null;
        const output=form.querySelector('[data-forex-total]');
        commission?.setCustomValidity('');
        if(source===null||source<=0n||scaled===null||scaled<=0n||!to){output.textContent='—';return;}
        const numerator=source*scaled*10n**BigInt(to==='UGX'?0:2),denominator=100000000n*10n**BigInt(from==='UGX'?0:2);
        const converted=(numerator+denominator/2n)/denominator,fee=operationMinor(commission?.value||'0',to==='UGX'?0:2),operation=form.elements.namedItem('operation')?.value||'quote';
        const invalidFee=fee===null||fee>converted||operation==='buy'&&fee===converted;
        if(commission&&invalidFee)commission.setCustomValidity(fee===null?'Enter a commission in the settlement currency’s precision.':operation==='buy'?'Commission must leave a positive amount for the customer.':'Commission cannot exceed the quoted settlement amount.');
        if(invalidFee){output.textContent='—';return;}
        output.textContent=operationAmount(operation==='buy'?converted-fee:operation==='sell'?converted+fee:converted,to)+' (indicative)';
      };
      form.addEventListener('input',event=>{if(event.target!==fromField&&event.target!==toField)update();});rate.addEventListener('change',update);
      form.querySelectorAll('select[data-forex-currency]').forEach(select=>select.addEventListener('change',()=>{
        filterDestinations();
        const from=form.querySelector('[data-forex-currency="from"]').value,to=form.querySelector('[data-forex-currency="to"]').value;
        const match=pairOptions().find(option=>option.dataset.from===from&&option.dataset.to===to);rate.value=match?.value||'';update();
      }));
      form.addEventListener('submit',event=>{update();if(!rate.value||validity&&!validity.value){event.preventDefault();rate.setCustomValidity('Choose an approved rate with enough remaining validity.');rate.reportValidity();}else rate.setCustomValidity('');},{capture:true});
      form.addEventListener('reset',()=>queueMicrotask(update));update();
    }
  };
  document.querySelectorAll('[data-transfer-form],[data-forex-form],form:has([data-account-currency])').forEach(initialiseOperationForm);

  document.querySelectorAll('[data-wallet-funding-form]').forEach(form=>{
    const source=form.elements.namedItem('sourceAccountId'),destination=form.elements.namedItem('destinationAccountId'),submit=form.querySelector('[data-funding-submit]'),status=form.querySelector('[data-funding-choices-status]');
    if(!source||!destination)return;
    const compatible=(from,to)=>Boolean(from?.value&&to?.value&&from.value!==to.value&&from.dataset.branchId&&from.dataset.currency&&from.dataset.branchId===to.dataset.branchId&&from.dataset.currency===to.dataset.currency&&(!from.dataset.operatorId||!to.dataset.operatorId||from.dataset.operatorId===to.dataset.operatorId));
    const update=()=>{
      const selected=source.selectedOptions[0];let available=0;
      for(const option of destination.options){
        if(!option.value)continue;
        option.hidden=Boolean(source.value)&&!compatible(selected,option);option.disabled=option.hidden;
        if(source.value&&!option.disabled)available++;
      }
      if(destination.selectedOptions[0]?.disabled)destination.value='';
      destination.disabled=!source.value;
      if(submit)submit.disabled=!compatible(selected,destination.selectedOptions[0]);
      if(status)status.textContent=!source.value?'Choose a funding source to see compatible destinations.':!available?'No other eligible account uses this source’s branch, currency and operator assignment.':'';
    };
    source.addEventListener('change',update);destination.addEventListener('change',update);form.addEventListener('reset',()=>queueMicrotask(update));update();
  });

  // The launcher loads the existing, permission-checked server form. It never
  // recreates financial rules, CSRF tokens or idempotency keys in the browser.
  const transactionDialog = document.getElementById('transactionDialog');
  if (transactionDialog && typeof transactionDialog.showModal === 'function') {
    const operations = Object.freeze({
      cash_in: {page:'/tenant/mobile-money/cash-in',form:'/tenant/mobile-money/cash-in',action:'/tenant/mobile-money/cash-in',title:'Mobile Money - Cash-in',description:'Only mobile money fields are shown.'},
      cash_out: {page:'/tenant/mobile-money/cash-out',form:'/tenant/mobile-money/cash-out',action:'/tenant/mobile-money/cash-out',title:'Mobile Money - Cash-out',description:'Only mobile money fields are shown.'},
      transfer: {page:'/tenant/money-transfer/send',form:'/tenant/money-transfer/requests',action:'/tenant/money-transfer/requests',title:'New transaction'},
      payout: {page:'/tenant/funded/payout',form:'/tenant/funded/payout',action:'/tenant/funded/payout',title:'Payout by PIN',keepOpenAfterPost:true},
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
      cash_shift_open: {page:'/tenant/cash/shifts',form:'/tenant/day/open',action:'/tenant/day/open',title:'Open day',description:'Opening drawer by currency. An independent supervisor verifies the opening count.'}
    });
    const choices = transactionDialog.querySelector('[data-transaction-choices]');
    const formHost = transactionDialog.querySelector('[data-transaction-form]');
    const status = transactionDialog.querySelector('[data-transaction-status]');
    const title = transactionDialog.querySelector('#transactionTitle');
    const description = transactionDialog.querySelector('#transactionDescription');
    const enabledKinds = new Set([...choices.querySelectorAll('[data-transaction-kind]')].map(button=>button.dataset.transactionKind));
    const groups = Object.freeze({transfer:'transfer',payout:'transfer',banking:'banking',banking_deposit:'banking',banking_withdrawal:'banking',banking_transfer:'banking',customer:'banking',account:'banking',cash_in:'mobile',cash_out:'mobile',forex:'forex',forex_buy:'forex',forex_sell:'forex',expense:'daily',cash_shift_open:'daily',cash_shift_close:'daily',approval:'daily'});
    const lastKinds = new Map();
    let previousFocus = null, activeRequest = null, requestVersion = 0, saving = false, currentKind = null;
    const message = (text, failed = false) => {
      status.hidden = !text;
      status.textContent = text;
      status.setAttribute('role', failed ? 'alert' : 'status');
      status.classList.toggle('failed', failed);
    };
    const selectKind = kind => {
      currentKind=kind;
      const group=groups[kind];lastKinds.set(group,kind);
      choices.querySelectorAll('[data-transaction-service]').forEach(button=>{
        const selected=button.dataset.transactionService===group;
        button.classList.toggle('active',selected);button.setAttribute('aria-pressed',String(selected));
      });
      choices.querySelectorAll('[data-transaction-actions]').forEach(row=>{row.hidden=row.dataset.transactionActions!==group;});
      choices.querySelectorAll('[data-transaction-kind]').forEach(button=>{
        const selected=button.dataset.transactionKind===kind;
        button.classList.toggle('active',selected);button.setAttribute('aria-pressed',String(selected));
      });
      title.textContent=operations[kind].title;
      description.textContent=group==='forex'?'Buy or sell foreign currency with rate, commission, and drawer impact.':'Choose a service and enter clean details';
    };
    const show = () => {
      if(transactionDialog.open)return;
      previousFocus=document.activeElement;setMenu(false);transactionDialog.showModal();document.body.classList.add('transactionOpen');
    };
    const close = () => {
      if (saving) return;
      activeRequest?.abort();requestVersion++;
      transactionDialog.close();document.body.classList.remove('transactionOpen');
      if(mobile.matches && side?.contains(previousFocus))menuBtn?.focus();else previousFocus?.focus();
    };
    const responseMessage = async response => {
      const text = await response.text();
      if ((response.headers.get('content-type') || '').includes('text/plain')) return text.slice(0,1000);
      const errorPage = new DOMParser().parseFromString(text,'text/html');
      return errorPage.querySelector('[role="alert"]')?.textContent?.trim().slice(0,1000) ||
        `The request could not be completed (HTTP ${response.status}). Review the details and try again.`;
    };
    const load = async (kind,{refresh=false}={}) => {
      if (!enabledKinds.has(kind) || !operations[kind] || saving) return;
      show();
      const present=formHost.querySelector('form');
      if(!refresh&&currentKind===kind&&present){present.querySelector('input:not([type="hidden"]):not([readonly]),select,textarea')?.focus();return;}
      // Cash-in/out share one immutable server-issued request key. Switching the
      // approved child tabs preserves entered details until the operation saves.
      if(present?.matches('[data-mobile-money-form]')&&['cash_in','cash_out'].includes(kind)){
        selectKind(kind);present.action=operations[kind].action;present.dataset.operation=kind;
        const label=present.querySelector('[data-mobile-operation-label]');if(label)label.value=kind==='cash_in'?'Cash-in':'Cash-out';
        present.elements.namedItem('amount')?.dispatchEvent(new Event('input',{bubbles:true}));message('');return;
      }
      activeRequest?.abort();activeRequest=new AbortController();
      const version=++requestVersion,operation=operations[kind],request=activeRequest;
      let timedOut=false;const loadTimeout=setTimeout(()=>{timedOut=true;request.abort();},12000);
      selectKind(kind);formHost.replaceChildren();message('Loading operation details…');
      try {
        const requestUrl=new URL(operation.page,location.origin),selectedCurrency=document.getElementById('currencySelect')?.value;
        if(selectedCurrency)requestUrl.searchParams.set('currency',selectedCurrency);
        const response=await (window.ClassicFinOffline?.pageResponse||fetch)(requestUrl,{credentials:'same-origin',headers:{Accept:'text/html','X-ClassicFin-Background':'true'},signal:request.signal});
        if(version!==requestVersion)return;
        if(!response.ok)throw new Error(await responseMessage(response));
        if(new URL(response.url).pathname!==operation.page)throw new Error('Your session or access has changed. Open the module page to continue.');
        const page=new DOMParser().parseFromString(await response.text(),'text/html');
        const source=[...page.querySelectorAll('form[method="post"]')].find(form=>form.getAttribute('action')===operation.form);
        if(!source||source.querySelector('select[name="branchId"]'))throw new Error(page.querySelector('[data-operation-branch-error]')?.textContent?.trim()||'This operation needs an assigned operating branch and its required setup. Open the module to review what is needed.');
        const form=source.cloneNode(true);form.action=operation.action;form.classList.remove('card');form.classList.add('transactionForm','svc');form.id='transactionOperationForm';
        form.querySelector('.cardHead')?.remove();
        form.querySelectorAll('[data-expense-close],[data-directory-close],.childActions').forEach(node=>node.remove());
        form.querySelectorAll('script,style,iframe,object,embed').forEach(node=>node.remove());
        form.querySelectorAll('*').forEach(node=>{[...node.attributes].filter(attribute=>/^on/i.test(attribute.name)).forEach(attribute=>node.removeAttribute(attribute.name));});
        const body=form.querySelector(':scope > .cardBody');if(body)body.replaceWith(...body.childNodes);
        form.querySelectorAll('button').forEach(button=>{const action=button.getAttribute('formaction');if(action&&action!==operation.action)button.remove();else button.removeAttribute('formaction');});
        const submitButtons=[...form.querySelectorAll('button[type="submit"],button:not([type])')];
        const submitActions=document.createElement('div');submitActions.dataset.transactionSubmitActions='';
        submitButtons.forEach(button=>{button.setAttribute('form','transactionOperationForm');submitActions.append(button);});
        form.querySelectorAll('.rowBtns').forEach(row=>{if(!row.children.length)row.remove();});form.append(submitActions);
        const ids=new Map();form.querySelectorAll('[id]').forEach(node=>{ids.set(node.id,'operation-'+node.id);node.id='operation-'+node.id;});
        form.querySelectorAll('[for],[list],[aria-describedby]').forEach(node=>{for(const attribute of ['for','list','aria-describedby']){const value=node.getAttribute(attribute);if(value)node.setAttribute(attribute,value.split(' ').map(id=>ids.get(id)||id).join(' '));}});
        initialiseApprovedFields(form);
        initialiseMobileMoneyForm(form);
        form.addEventListener('invalid',event=>message(event.target.validationMessage||'Check the highlighted field.',true),true);
        form.addEventListener('submit',async event=>{
          event.preventDefault();if(saving||!form.reportValidity())return;
          const disabled=submitButtons.map(button=>button.disabled),data=new FormData(form);
          if(event.submitter?.name)data.set(event.submitter.name,event.submitter.value);
          const fields=new URLSearchParams(data);
          const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),20000);
          saving=true;submitButtons.forEach(button=>{button.disabled=true;});
          transactionDialog.querySelectorAll('[data-close-transaction],[data-transaction-clear],[data-transaction-service],[data-transaction-kind]').forEach(button=>{button.disabled=true;});
          message('Saving the operation…');
          try{
            const action=operations[currentKind]?.action;if(!action)throw new Error('Operation selection changed. Reload the form.');
            const result=await fetch(action,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/x-www-form-urlencoded','X-ClassicFin-Redirect':'json','X-ClassicFin-Background':'true'},body:fields,signal:controller.signal});
            if(result.headers.get('content-type')?.includes('application/json')){
              const outcome=await window.ClassicFinFeedback.response(result);
              if(result.ok&&outcome.redirect){
                if(outcome.flash?.type==='bad'){message(outcome.flash.message,true);return;}
                if(operations[currentKind]?.keepOpenAfterPost&&new URL(outcome.redirect).pathname===operations[currentKind].page){saving=false;await load(currentKind,{refresh:true});message(outcome.flash?.message||'Request completed.');return;}
                location.assign(outcome.redirect);return;
              }
              message(outcome.message||'The operation could not be completed.',true);return;
            }
            if(result.ok&&result.redirected&&new URL(result.url).origin===location.origin){
              if(operations[currentKind]?.keepOpenAfterPost&&new URL(result.url).pathname===operations[currentKind].page){saving=false;await load(currentKind,{refresh:true});return;}
              location.assign(result.url);return;
            }
            message(await responseMessage(result),true);
          }catch{message('The connection was interrupted. Check the module history before retrying; your request may already have been recorded.',true);}
          finally{clearTimeout(timeout);saving=false;submitButtons.forEach((button,index)=>{button.disabled=disabled[index];});transactionDialog.querySelectorAll('[data-close-transaction],[data-transaction-clear],[data-transaction-service],[data-transaction-kind]').forEach(button=>{button.disabled=false;});}
        });
        if(version!==requestVersion)return;formHost.append(form);window.ClassicFinDirectory?.initialiseForm(form);initialiseOperationForm(form);initialiseMobileFunds(form);message('');
        form.querySelector('input:not([type="hidden"]):not([readonly]),select,textarea')?.focus();
      }catch(error){if(version!==requestVersion||error.name==='AbortError'&&!timedOut)return;message(timedOut?'Operation details took too long to load. Try again when connected, or open the module.':error.message||'This operation is unavailable. Open the module to continue.',true);const fallback=document.createElement('a');fallback.className='btn';fallback.href=operation.page;fallback.textContent='Open module';formHost.append(fallback);}finally{clearTimeout(loadTimeout);}
    };
    const firstKind=group=>group?[...enabledKinds].find(kind=>groups[kind]===group):['transfer','banking','mobile','forex','daily'].map(service=>[...enabledKinds].find(kind=>groups[kind]===service)).find(Boolean);
    const open=group=>load(lastKinds.get(group)||firstKind(group==='mobile_money'?'mobile':group));
    document.querySelectorAll('[data-open-transaction]').forEach(button=>button.addEventListener('click',event=>{event.preventDefault();open();}));
    document.querySelectorAll('a[data-transaction-kind]').forEach(link=>link.addEventListener('click',event=>{const kind=link.dataset.transactionKind;if(kind==='mobile_money'){event.preventDefault();open('mobile');}else if(enabledKinds.has(kind)){event.preventDefault();load(kind);}}));
    choices.querySelectorAll('[data-transaction-kind]').forEach(button=>button.addEventListener('click',()=>load(button.dataset.transactionKind)));
    choices.querySelectorAll('[data-transaction-service]').forEach(button=>button.addEventListener('click',()=>open(button.dataset.transactionService)));
    transactionDialog.querySelectorAll('[data-close-transaction]').forEach(button=>button.addEventListener('click',close));
    transactionDialog.querySelector('[data-transaction-clear]')?.addEventListener('click',()=>{
      if(saving)return;const form=formHost.querySelector('form');if(!form)return;form.reset();
      if(form.matches('[data-mobile-money-form]')){form.dataset.operation=currentKind;const label=form.querySelector('[data-mobile-operation-label]');if(label)label.value=currentKind==='cash_in'?'Cash-in':'Cash-out';}
      form.dispatchEvent(new Event('input',{bubbles:true}));form.elements.namedItem('amount')?.dispatchEvent(new Event('input',{bubbles:true}));message('');
    });
    transactionDialog.addEventListener('cancel',event=>{event.preventDefault();close();});
    transactionDialog.addEventListener('click',event=>{if(event.target===transactionDialog){const rect=transactionDialog.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)close();}});
  }

  document.querySelectorAll('[data-dashboard-currency-form]').forEach(form=>form.querySelector('select')?.addEventListener('change',()=>form.requestSubmit()));
  document.querySelectorAll('[data-branch-view-form]').forEach(form=>form.querySelector('select')?.addEventListener('change',()=>form.requestSubmit()));

  document.querySelectorAll('[data-print-report]').forEach(button=>button.addEventListener('click',()=>window.print()));

  const toast = document.querySelector('.toast');
  if (toast) setTimeout(() => toast.remove(), 5200);
})();

// Suggest the trusted edge country without changing existing international numbers.
(function(){
 const preparePhones=()=>document.querySelectorAll('input[type="tel"]').forEach(input=>{
  if(input.dataset.phonePrepared)return;input.dataset.phonePrepared='true';const prefix=input.dataset.phonePrefix||document.body.dataset?.phonePrefix;if(!prefix)return;
  input.placeholder=prefix+'…';
 });preparePhones();if(typeof MutationObserver!=='undefined')new MutationObserver(preparePhones).observe(document.body,{childList:true,subtree:true});
})();

// A queued backup reports completion without requiring another button click.
(function(){
 const panel=document.querySelector('[data-backup-pending="true"]');if(!panel)return;let attempts=0;
 const poll=async()=>{
  if(++attempts>45)return;
  try{const response=await fetch('/tenant/backups/status',{cache:'no-store',headers:{Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(8000)});if(!response.ok)return;const state=await response.json();
   if(state.result!=='queued'){
    panel.querySelector('[data-backup-result-label]').textContent=({never:'No backup yet',complete:'Backup complete',no_changes:'No unbacked data',error:'Needs attention'})[state.result]||'Check backup status';
    panel.querySelector('[data-backup-target]').textContent=state.target==='drive'?'Google Drive + platform':state.target==='fallback'?'Encrypted platform backup':'—';
    panel.querySelector('[data-backup-saved]').textContent=state.lastBackupAt?new Date(state.lastBackupAt).toLocaleString():'—';
    const notice=document.createElement('p');notice.className='tiny';notice.setAttribute('role','status');notice.textContent=(state.result==='no_changes'?'No unbacked data.':state.result==='complete'?'Backup complete.':'Backup needs attention.')+' Refresh status to view the latest archive history and any service details.';panel.prepend(notice);return;
   }
  }catch{}
  setTimeout(poll,2500);
 };setTimeout(poll,1500);
})();
