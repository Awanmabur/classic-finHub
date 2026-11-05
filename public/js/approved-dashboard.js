'use strict';
/*
 * Interactive controller for the approved index.html markup. Unlike the
 * prototype this file never invents transactions, account balances, PINs or
 * settlement. POST forms are fetched from existing permission-checked routes.
 */
(() => {
  const doc = document;
  const one = (selector,within=doc) => within.querySelector(selector);
  const all = (selector,within=doc) => [...within.querySelectorAll(selector)];
  const jsonNode=one('#approvedDashboardConfig');
  if(!jsonNode) return;
  let data;
  try { data=JSON.parse(jsonNode.textContent); } catch { return; }
  const access=data.access||{};
  const recent=data.recent||{};
  const branches=Array.isArray(data.branches)?data.branches:[];
  const modal=one('#approvedOperationOverlay');
  const modalContent=one('#approvedOperationContent');
  const choices=one('#approvedOperationChoices');
  const modalTitle=one('#approvedOperationTitle');
  const modalSub=one('#approvedOperationSub');
  const services=one('#approvedServices');
  const side=one('#sidePanel');
  const menuOverlay=one('#menuOverlay');
  const branchSelect=one('#branchSelect');
  const currencySelect=one('#currencySelect');
  const views=all('.main section.view[id^="view-"]');
  let previousFocus=null;
  let currentView='overview';

  const allowedView={
    overview:true,transfer:!!access.transferView,mobile:!!access.mobileView,
    forex:!!access.forexView,'forex-rates':!!access.forexView,
    'forex-cash':!!access.forexView,'forex-records':!!access.forexView,
    'report-forex':!!access.forexView,banking:!!access.bankingView,
    customers:!!(access.transferContacts||access.bankingAccounts),
    accounts:!!access.bankingView,reports:!!access.reportsView
  };
  const actions={
    transfer:{permission:'transferCreate',page:'/tenant/money-transfer',action:'/tenant/money-transfer/requests',title:'Sending / Generate PIN',note:'This creates a transfer request for independent review; no PIN is generated and no funds move.'},
    mobileCashIn:{permission:'mobileCashIn',page:'/tenant/mobile-money',action:'/tenant/mobile-money/cash-in',title:'Cash-in',note:'Record network evidence for independent review. No provider settlement is claimed.',mode:'cash_in'},
    mobileCashOut:{permission:'mobileCashOut',page:'/tenant/mobile-money',action:'/tenant/mobile-money/cash-in',title:'Cash-out',note:'Record network evidence for independent review. No provider settlement is claimed.',mode:'cash_out'},
    bankingDeposit:{permission:'bankingCreate',page:'/tenant/banking',action:'/tenant/banking/requests',title:'Deposit',note:'This creates an unexecuted deposit request requiring independent review.',kind:'deposit_request'},
    bankingWithdraw:{permission:'bankingCreate',page:'/tenant/banking',action:'/tenant/banking/requests',title:'Withdraw',note:'This creates an unexecuted withdrawal request requiring independent review.',kind:'withdrawal_request'},
    bankingTransfer:{permission:'bankingCreate',page:'/tenant/banking',action:'/tenant/banking/requests',title:'Account transfer',note:'This creates an unexecuted bank transfer request requiring independent review.',kind:'transfer_request'},
    forexQuote:{permission:'forexQuote',page:'/tenant/forex',action:'/tenant/forex/quotes',title:'Forex',note:'Create an indicative customer quote; no currency trade occurs.'},
    forexRate:{permission:'forexRate',page:'/tenant/forex',action:'/tenant/forex/rates',title:'Active rate board',note:'Propose an indicative rate for another staff member to review.'},
    contact:{permission:'transferContacts',page:'/tenant/money-transfer/contacts',action:'/tenant/money-transfer/contacts',title:'New customer',note:'This is a sender or beneficiary contact, not a verified bank customer account.'},
    account:{permission:'bankingAccounts',page:'/tenant/banking/accounts',action:'/tenant/banking/accounts',title:'New account',note:'Only a masked bank account reference is recorded; no balance or bank-issued account is created.'},
    opening:{permission:'mobileShift',page:'/tenant/mobile-money/shifts',action:'/tenant/mobile-money/shifts/open',title:'Open day',note:'An opening physical cash count requires independent verification; this is not a general business-day posting or e-float.'}
  };
  function button(text, handler,cssClass='btn'){
    const el=doc.createElement('button');
    el.type='button';el.className=cssClass;el.textContent=text;
    el.addEventListener('click',handler);
    return el;
  }
  function clear(el){while(el.firstChild) el.removeChild(el.firstChild);}
  function paragraph(text,klass='approvedHelp'){
    const p=doc.createElement('p');p.className=klass;p.textContent=text;return p;
  }
  function link(label,href){
    const a=doc.createElement('a');a.className='btn';a.href=href;a.textContent=label;return a;
  }
  function closeModal(){
    modal.classList.remove('show');
    modal.setAttribute('aria-hidden','true');
    doc.body.classList.remove('approvedModalOpen');
    previousFocus?.focus?.();
  }
  function openModal(title,subtitle='Choose a section, then choose the exact operation.'){
    previousFocus=doc.activeElement;
    modalTitle.textContent=title;
    modalSub.textContent=subtitle;
    services.hidden=true;
    if(one('#approvedTransferActions'))one('#approvedTransferActions').hidden=true;
    if(one('#approvedDailyActions'))one('#approvedDailyActions').hidden=true;
    clear(modalContent);clear(choices);
    modal.classList.add('show');
    modal.setAttribute('aria-hidden','false');
    doc.body.classList.add('approvedModalOpen');
    one('#approvedClose')?.focus();
  }
  function information(title,message,route=null){
    openModal(title);
    modalContent.appendChild(paragraph(message));
    if(route){choices.appendChild(link('Open authorized workflow',route));}
  }
  function closeMenu(){
    side?.classList.remove('show');menuOverlay?.classList.remove('show');
    doc.body.classList.remove('drawerOpen');
    one('#menuBtn')?.setAttribute('aria-expanded','false');
  }
  function goToView(view){
    if(!allowedView[view]){
      information('Module unavailable','This module is not assigned to your account or current subscription. Ask your workspace administrator for access.');
      return;
    }
    const target=one('#view-'+view);
    if(!target)return;
    currentView=view;
    views.forEach(item=>item.classList.toggle('show',item===target));
    all('#sidePanel .item[data-view]').forEach(el=>el.classList.toggle('active',el.dataset.view===(view.startsWith('forex')||view==='report-forex'?'forex':view)));
    const label=one('.cardHead b',target);
    one('#pageTitle').textContent=label?.textContent||view;
    closeMenu();
  }
  function pageFor(config){
    const url=new URL(config.page,window.location.origin);
    // The current branch is selection context for owner operations, not a
    // global ledger filter; the backend still validates branch access.
    // Branch identity is resolved from session and assignment by the backend.
    return url;
  }
  function selectForm(form,config){
    if(config.kind){
      const kind=one('select[name="kind"]',form);
      if(kind && [...kind.options].some(x=>x.value===config.kind))kind.value=config.kind;
      const destination=one('select[name="destinationId"]',form);
      if(destination&&kind){
        const sync=()=>destination.required=kind.value==='transfer_request';
        kind.addEventListener('change',sync);sync();
      }
    }
    if(config.mode){
      const mode=config.mode==='cash_out'?'cash-out':'cash-in';
      const chosen=one('button[formaction="/tenant/mobile-money/'+mode+'"]',form);
      if(chosen){
        all('button[formaction]',form).forEach(b=>{b.hidden=b!==chosen;});
      }
    }
    // Existing form handlers remain ordinary same-origin POSTs with CSRF and
    // idempotency fields. Prevent duplicate clicks while navigation proceeds.
    let submitted=false;
    form.addEventListener('submit',event=>{
      if(submitted){event.preventDefault();return;}
      // Keep the clicked submitter enabled: it may carry a different
      // formaction (Cash-out versus Cash-in).
      submitted=true;
    });
  }
  async function openAction(key){
    const config=actions[key];
    if(!config){information('Not yet available','This reference dashboard action has no authorized backend operation. No records or funds were changed.');return;}
    if(!access[config.permission]){
      information(config.title,'Your role or module subscription does not permit this operation. No data was changed.');
      return;
    }
    const url=pageFor(config);
    openModal(config.title,config.note);
    // Keep the original index.html service tabs visible above the secure form.
    const group=key==='transfer'?'transfer':key.startsWith('mobile')?'mobile':key.startsWith('banking')?'banking':key.startsWith('forex')?'forex':key==='opening'?'daily':null;
    if(group){
      services.hidden=false;
      if(one('#approvedTransferActions'))one('#approvedTransferActions').hidden=group!=='transfer';
      if(one('#approvedDailyActions'))one('#approvedDailyActions').hidden=group!=='daily';
      all('#approvedServices [data-approved-service]').forEach(b=>b.classList.toggle('active',b.dataset.approvedService===group));
    }
    modalContent.appendChild(paragraph('Loading the secure workspace form…'));
    try{
      const response=await fetch(url.href,{credentials:'same-origin',headers:{Accept:'text/html'}});
      if(!response.ok||new URL(response.url).origin!==window.location.origin)throw Error('not authorized');
      const parsed=new DOMParser().parseFromString(await response.text(),'text/html');
      const form=all('form[data-operation-form]',parsed).find(f=>
        f.getAttribute('method')?.toLowerCase()==='post' &&
        new URL(f.getAttribute('action')||'',url.href).pathname===config.action &&
        one('input[name="_csrf"]',f)
      );
      clear(modalContent);
      if(!form){
        modalContent.appendChild(paragraph('Choose an active branch and complete any prerequisite records before submitting this operation.'));
        choices.appendChild(link('Open authorized workflow',url.pathname+url.search));
        return;
      }
      const copy=doc.importNode(form,true);
      selectForm(copy,config);
      modalContent.appendChild(copy);
      modalContent.insertBefore(paragraph(config.note),copy);
      const focus=one('input:not([type="hidden"]),select,textarea',copy);
      focus?.focus();
    }catch{
      clear(modalContent);
      modalContent.appendChild(paragraph('The secure form could not be loaded. Verify your session and retry from the module page.'));
      choices.appendChild(link('Open authorized workflow',url.pathname+url.search));
    }
  }
  one('#approvedTransferActions')?.addEventListener('click',event=>{
    const action=event.target.closest('[data-approved-action]')?.dataset.approvedAction;
    if(action==='transfer')void openAction('transfer');
    else if(action==='payout')openByType.payout();
  });
  one('#approvedDailyActions')?.addEventListener('click',event=>{
    const action=event.target.closest('[data-approved-action]')?.dataset.approvedAction;
    if(action==='opening')void openAction('opening');
    else if(action==='closing')openByType.close_day();
    else if(action==='expense')openByType.expense();
    else if(action==='export')openCsv();
    else if(action==='print')openReport();
  });
  function chooseService(group){
    const actionsFor={
      transfer:[['Sending / Generate PIN','transfer']],
      banking:[['Deposit','bankingDeposit'],['Withdraw','bankingWithdraw'],['Account transfer','bankingTransfer']],
      mobile:[['Cash-in','mobileCashIn'],['Cash-out','mobileCashOut']],
      forex:[['Forex','forexQuote'],['Active rate board','forexRate']],
      daily:[['Open day','opening']]
    };
    services.hidden=false;
    if(one('#approvedTransferActions'))one('#approvedTransferActions').hidden=group!=='transfer';
    if(one('#approvedDailyActions'))one('#approvedDailyActions').hidden=group!=='daily';
    all('#approvedServices [data-approved-service]').forEach(b=>b.classList.toggle('active',b.dataset.approvedService===group));
    clear(modalContent);clear(choices);
    modalTitle.textContent='New operation';
    modalSub.textContent='Choose a section, then choose the exact operation.';
    for(const [label,key] of actionsFor[group]||[]){
      const b=button(label,()=>openAction(key),'btn');
      b.disabled=!access[actions[key].permission];
      choices.appendChild(b);
    }
  }
  services?.addEventListener('click',event=>{
    const el=event.target.closest('[data-approved-service]');
    if(el)chooseService(el.dataset.approvedService);
  });
  function showChooser(service=null){
    openModal('New transaction');
    chooseService(service||'transfer');
  }
  const openByType={
    transfer:()=>openAction('transfer'),
    payout:()=>information('Payout by PIN','Payout by PIN is not connected to a verified provider, ledger or independently reconciled settlement. No payout can be made from this screen.'),
    mobile:(node)=>openAction(node.dataset.mode==='cash_out'?'mobileCashOut':'mobileCashIn'),
    banking:(node)=>openAction(({withdraw:'bankingWithdraw',transfer:'bankingTransfer'}[node.dataset.mode])||'bankingDeposit'),
    forex:()=>openAction('forexQuote'),
    open_day:()=>openAction('opening'),
    close_day:()=>information('Close day','Physical cash shift closing and independent review are available in Cash Shifts. This is not a global day-close or bank settlement.','/tenant/mobile-money/shifts'),
    expense:()=>information('Add expense','General expense ledger posting is not yet available as a verified service. No expense is saved.'),
    export_csv:()=>openCsv(),
    print_report:()=>openReport()
  };
  function openCsv(){
    if(access.reportsExport){window.location.assign('/tenant/reports/export.csv');}
    else information('Export CSV','Operations Reports export is not available to this account.');
  }
  function openReport(){
    if(access.reportsView){window.location.assign('/tenant/reports');}
    else information('Print report','A verified Operations Report is required before printing financial figures.');
  }
  function lastReceipt(){
    const record=recent.latestAcknowledgement;
    if(access.lastAckView&&record?.href &&
      /^\/tenant\/(?:mobile-money|money-transfer)\/[a-f0-9]{24}\/acknowledgement$/i.test(record.href)){
      information('Last receipt','Only an internal, non-settlement acknowledgement is available. It is not proof of payment, PIN payout, banking settlement or FX execution.',record.href);
    }else information('Last receipt','There is no recent authorized operational acknowledgement to display.');
  }
  const selector={
    transfer:'transfer',mobile:'mobile',forex:'forex',banking:'banking',payout:'payout'
  };
  doc.addEventListener('click',event=>{
    if(event.target.closest('#approvedOperationOverlay'))return;
    const node=event.target.closest('[data-view],[data-open],[data-quick],[data-main],[data-receipt],[data-customer],[data-account],[data-day],[data-export],[data-print],[data-expense],[data-go],#newBtn,#lastReceiptBtn,#addCustomerBtn,#addAccountBtn,#expenseBtn,#exportBtn,#saveNotesBtn,#openDayBtn,#closeDayBtn,#demoBtn,#resetBtn,[data-approved-print]');
    if(!node)return;
    if(node.matches('button,a,[role="button"],.item'))event.preventDefault();
    if(node.dataset.go==='reports'){goToView('reports');return;}
    if(node.id==='demoBtn'){
      information('Load demo','Demo data is disabled in authenticated tenant databases. This action will not create simulated financial activity.');
      return;
    }
    if(node.id==='resetBtn'){
      information('Reset','Resetting financial records is disabled. Tenant records and audit history cannot be erased through a dashboard button.');
      return;
    }
    if(node.id==='openDayBtn'){void openAction('opening');return;}
    if(node.id==='closeDayBtn'){
      information('Close day','Use the verified physical cash-shift review workflow. A global daily ledger close is not implemented.','/tenant/mobile-money/shifts');return;
    }
    if(node.id==='newBtn'||node.dataset.main==='transaction'){showChooser();return;}
    if(node.id==='lastReceiptBtn'||node.dataset.receipt==='last'){lastReceipt();return;}
    if(node.id==='addAccountBtn'||node.dataset.account==='add'){void openAction('account');return;}
    if(node.id==='addCustomerBtn'||node.dataset.customer==='add'){void openAction('contact');return;}
    if(node.id==='expenseBtn'||node.dataset.expense==='add'){information('Add expense','General expense ledger posting is not yet available as a verified service.');return;}
    if(node.id==='exportBtn'||node.dataset.export==='csv'){openCsv();return;}
    if(node.id==='saveNotesBtn'){information('Save notes','Daily report notes are not yet connected to an audited store. No note was saved.');return;}
    if(node.dataset.approvedPrint!==undefined||node.dataset.print==='report'){openReport();return;}
    if(node.dataset.day){void(openByType[node.dataset.day+'_day']?.());return;}
    if(node.dataset.open){const handler=openByType[selector[node.dataset.open]||node.dataset.open];if(handler)void handler(node);return;}
    if(node.dataset.quick){const handler=openByType[selector[node.dataset.quick]||node.dataset.quick];if(handler)void handler(node);return;}
    if(node.dataset.view)goToView(node.dataset.view);
  });
  one('#menuBtn')?.addEventListener('click',()=>{
    const active=side?.classList.toggle('show');
    menuOverlay?.classList.toggle('show',!!active);
    doc.body.classList.toggle('drawerOpen',!!active);
    one('#menuBtn').setAttribute('aria-expanded',String(!!active));
    if(active)one('#sidePanel .item')?.focus();
  });
  menuOverlay?.addEventListener('click',closeMenu);
  one('#approvedClose')?.addEventListener('click',closeModal);
  modal?.addEventListener('click',e=>{if(e.target===modal)closeModal();});
  doc.addEventListener('keydown',event=>{
    if(event.key==='Escape'){
      if(modal.classList.contains('show')){event.preventDefault();closeModal();}
      else closeMenu();
    }
    if(event.key==='Tab'&&modal.classList.contains('show')){
      const focusable=all('button:not([disabled]):not([hidden]),a[href],input:not([type="hidden"]),select,textarea',modal).filter(el=>el.getClientRects().length);
      if(!focusable.length)return;
      if(event.shiftKey&&doc.activeElement===focusable[0]){event.preventDefault();focusable.at(-1).focus();}
      else if(!event.shiftKey&&doc.activeElement===focusable.at(-1)){event.preventDefault();focusable[0].focus();}
    }
    if((event.key==='Enter'||event.key===' ')&&doc.activeElement?.matches('.nav .item[data-view]')){
      event.preventDefault();goToView(doc.activeElement.dataset.view);
    }
  });
  all('.nav .item[data-view]').forEach(el=>{
    el.setAttribute('role','button');el.setAttribute('tabindex','0');
  });
  all('.nav button').forEach(el=>{el.type='button';});
  const report=one('#repOperator');
  if(report)report.textContent=one('#sideOperator')?.textContent||'—';
  const branch=one('#repBranch');
  if(branch)branch.textContent=one('#sideBranch')?.textContent||'—';
  const day=one('#repDate');
  if(day)day.textContent=new Date().toISOString().slice(0,10);
  if(branchSelect){
    branchSelect.textContent=data.user?.branchName||'Not assigned';
    branchSelect.title='Server-verified branch; authorized owners can activate another in Branch Management.';
  }
  const selected=branches.find(b=>b.id===data.user?.branchId);
  if(currencySelect&&selected&&[...currencySelect.options].some(o=>o.value===selected.currency))
    currencySelect.value=selected.currency;
  if(one('#sideBranch'))one('#sideBranch').textContent=data.user?.branchName||'Not assigned';
  if(currencySelect)currencySelect.title='Display currency selector from approved layout. No currency conversion or summed cross-currency balances are inferred.';
  const search=one('#search');
  search?.addEventListener('input',()=>{
    const q=search.value.trim().toLowerCase();
    const active=one('#view-'+currentView);
    if(!active)return;
    all('tbody tr,.tx',active).forEach(el=>{el.hidden=!!q&&!el.textContent.toLowerCase().includes(q);});
  });
  function text(tag,value){
    const el=doc.createElement(tag);el.textContent=String(value??'—');return el;
  }
  function amount(minor,currency){
    const s=String(minor||'');
    if(!/^-?\d{1,30}$/.test(s))return '—';
    const n=BigInt(s),places=['UGX','SSP'].includes(currency)?0:2;
    const abs=n<0n?-n:n;
    const base=10n**BigInt(places);
    const whole=(abs/base).toLocaleString('en-US');
    const fraction=places?'.'+(abs%base).toString().padStart(places,'0'):'';
    return currency+' '+(n<0n?'-':'')+whole+fraction;
  }
  function safeHref(category,id){
    if(!/^[a-f0-9]{24}$/i.test(id))return null;
    return '/tenant/'+category+'/'+id;
  }
  function renderTable(id,rows,cells,category=null){
    const target=one('#'+id);if(!target)return;
    clear(target);
    for(const row of rows){
      const tr=doc.createElement('tr');tr.setAttribute('data-search-row','');
      cells(row).forEach((value,index)=>{
        const td=text('td',value);
        if(index===0&&category){
          const href=safeHref(category,row.id);
          if(href){clear(td);const a=doc.createElement('a');a.href=href;a.textContent=String(value??'—');td.appendChild(a);}
        }
        tr.appendChild(td);
      });target.appendChild(tr);
    }
  }
  function renderActivity(id,rows,category,format){
    const target=one('#'+id);if(!target)return;
    clear(target);
    for(const row of rows){
      const href=safeHref(category,row.id);
      if(!href)continue;
      const a=doc.createElement('a');a.href=href;a.className='tx';
      const meta=doc.createElement('div');meta.className='txMeta';
      const b=text('b',format(row).title);
      const span=text('span',format(row).detail);
      meta.appendChild(b);meta.appendChild(span);
      a.appendChild(meta);a.appendChild(text('strong',format(row).amount));
      target.appendChild(a);
    }
  }
  renderTable('transferRows',recent.transfers||[],r=>[
    r.date?.slice(0,16).replace('T',' ')||'—',r.sender||'—',r.receiver||'—',
    'Not issued',amount(r.amountMinor,r.currency),amount(r.feeMinor,r.currency),
    r.status,r.branch||'—'
  ]);
  renderActivity('mobileList',recent.mobile||[],'mobile-money',r=>({
    title:r.customer||'Mobile Money',detail:[r.operation?.replace('_',' '),r.network,r.status,r.branch].filter(Boolean).join(' · '),
    amount:amount(r.amountMinor,r.currency)
  }));
  renderActivity('bankList',recent.bank||[],'banking',r=>({
    title:r.reference||'Banking request',detail:[r.kind?.replaceAll('_',' '),r.status,r.branch].filter(Boolean).join(' · '),
    amount:amount(r.amountMinor,r.currency)
  }));
  renderActivity('forexList',recent.forex||[],'forex',r=>({
    title:r.reference||'Forex quote',detail:[r.fromCurrency+' → '+r.toCurrency,r.status,r.branch].filter(Boolean).join(' · '),
    amount:amount(r.sourceMinor,r.fromCurrency)
  }));
  if(Number.isSafeInteger(recent.mobileTodayTotal))one('#mmCount').textContent=String(recent.mobileTodayTotal);
  if(one('#search'))one('#search').setAttribute('aria-label','Search records in the active dashboard section');
  if(one('#menuBtn'))one('#menuBtn').setAttribute('aria-label','Open menu');
})();
