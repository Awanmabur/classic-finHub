'use strict';
(() => {
  const root=document.querySelector('.networkTariffPage');
  if(!root)return;

  const create=(tag,attrs={},label='')=>{
    const el=document.createElement(tag);
    for(const [key,value] of Object.entries(attrs)){
      if(key==='className')el.className=value;
      else el.setAttribute(key,value);
    }
    if(label)el.textContent=label;
    return el;
  };
  const draftForm=root.querySelector('#network-sheet-form form');
  const provider=draftForm?.querySelector('[data-provider-select]');
  if(provider){
    const curr=draftForm.querySelector('[data-provider-currency]');
    const label=draftForm.querySelector('[data-provider-currency-display]');
    const marketWallet=draftForm.querySelector('[data-tariff-market-wallet]');
    const marketWalletField=draftForm.querySelector('[data-tariff-market-wallet-field]');
    const branch=draftForm.elements.namedItem('branchId');
    const setMarket=()=>{
      const fixed=provider.selectedOptions[0]?.dataset.currency||'';
      const needsWallet=Boolean(provider.value&&!fixed);
      if(marketWallet&&marketWalletField){
        marketWallet.disabled=!needsWallet;
        marketWallet.required=needsWallet;
        marketWalletField.hidden=!needsWallet;
        const available=[];
        for(const option of marketWallet.options){
          if(!option.value)continue;
          const allowed=needsWallet&&option.dataset.network===provider.value&&
            option.dataset.branch===branch?.value;
          option.hidden=!allowed;
          option.disabled=!allowed;
          if(allowed)available.push(option);
        }
        if(!available.some(o=>o.value===marketWallet.value))marketWallet.value=available.length===1?available[0].value:'';
      }
      const code=fixed||(needsWallet?marketWallet?.selectedOptions[0]?.dataset.currency||'':'');
      curr.value=code;
      label.value=code;
      label.placeholder=needsWallet?'Select a reconciled provider wallet':'Select a network first';
    };
    provider.addEventListener('change',setMarket);
    branch?.addEventListener('change',setMarket);
    marketWallet?.addEventListener('change',setMarket);
    setMarket();
    root.querySelectorAll('[data-choose-provider]').forEach(link=>link.addEventListener('click',()=>{
      provider.value=link.dataset.chooseProvider;
      const operation=link.dataset.chooseOperation;
      if(operation&&draftForm.elements.namedItem('operation'))draftForm.elements.namedItem('operation').value=operation;
      if(draftForm.elements.namedItem('scheduleKind'))draftForm.elements.namedItem('scheduleKind').value='agent_commission';
      setMarket();
    }));
  }

  const payoutWallet=root.querySelector('[data-payout-wallet]');
  if(payoutWallet){
    const parent=payoutWallet.closest('form');
    const network=parent?.querySelector('[data-payout-network]');
    const currency=parent?.querySelector('[data-payout-currency]');
    const readOnly=parent?.querySelector('[data-payout-market]');
    const syncWallet=()=>{
      const option=payoutWallet.selectedOptions[0];
      const chosenNetwork=option?.dataset.network||'';
      const chosenCurrency=option?.dataset.currency||'';
      if(network)network.value=chosenNetwork;
      if(currency)currency.value=chosenCurrency;
      if(readOnly)readOnly.textContent=chosenNetwork?chosenNetwork+' · '+chosenCurrency:'Choose a wallet to identify its network and currency';
    };
    payoutWallet.addEventListener('change',syncWallet);
    syncWallet();
  }

  // Keep the original comma-separated textarea as the canonical server input
  // and as a functional no-JavaScript fallback. An enhanced table is optional.
  root.querySelectorAll('textarea[data-rate-editor]').forEach(textarea=>{
    const wrapper=textarea.closest('.field');
    if(!wrapper)return;
    const tableRegion=create('div',{className:'networkRateEditor'});
    const scroller=create('div',{className:'networkTariffScroll',role:'region',tabindex:'0','aria-label':'Editable amount ranges'});
    const table=create('table',{className:'networkRateTable'});
    const thead=create('thead');
    const row=create('tr');
    ['Minimum (minor units)','Maximum (minor units)','Rate type','Rate value',''].forEach(t=>row.append(create('th',{},t)));
    thead.append(row);
    const tbody=create('tbody');
    table.append(thead,tbody);scroller.append(table);
    const bar=create('div',{className:'networkRateToolbar'});
    const add=create('button',{type:'button',className:'btn'},'Add amount range');
    const hint=create('small',{},'Use whole minor units: UGX 1 = 1; SSP 1.00 = 100. Percentage rates use basis points (100 = 1%).');
    bar.append(add,hint);
    tableRegion.append(scroller,bar);
    wrapper.after(tableRegion);
    const initial=textarea.value.trim().split(/\r?\n/).filter(Boolean);
    const append=(values=['','','flat',''])=>{
      if(tbody.children.length>=250)return;
      const tr=create('tr');
      const fields=[];
      for(let i=0;i<4;i++){
        const td=create('td');
        let input;
        if(i===2){
          input=create('select',{className:'control','aria-label':'Rate type'});
          [['flat','Fixed amount'],['basis_points','Percentage']].forEach(([value,text])=>{
            const option=create('option',{value},text);input.append(option);
          });
          input.value=values[i]==='basis_points'?'basis_points':'flat';
        }else{
          input=create('input',{className:'control',type:'text',inputmode:'numeric',pattern:'(?:0|[1-9][0-9]*)','aria-label':['Minimum minor units','Maximum minor units','','Rate value'][i]});
          input.value=values[i]||'';
          input.required=true;
        }
        fields.push(input);
        td.append(input);tr.append(td);
      }
      const actions=create('td');
      const remove=create('button',{type:'button',className:'btn','aria-label':'Remove this amount range'},'Remove');
      remove.addEventListener('click',()=>{tr.remove();sync();});
      actions.append(remove);tr.append(actions);
      tbody.append(tr);
      fields.forEach(field=>field.addEventListener('input',sync));
      fields.forEach(field=>field.addEventListener('change',sync));
      sync();
    };
    function sync(){
      textarea.value=[...tbody.rows].map(tr=>[...tr.querySelectorAll('input,select')].map(el=>el.value.trim()).join(', ')).join('\n');
    }
    initial.forEach(line=>{
      const parts=line.split(',').map(v=>v.trim());
      if(parts.length===4)append(parts);
    });
    if(!tbody.rows.length)append();
    add.addEventListener('click',()=>append());
    // Do not conceal the fallback until the enhanced editor is operational.
    textarea.hidden=true;
    textarea.setAttribute('aria-hidden','true');
    textarea.removeAttribute('required');
    wrapper.closest('form')?.addEventListener('submit',event=>{
      sync();
      if(!tbody.rows.length||[...tbody.querySelectorAll('input')].some(input=>!input.value.trim()||!/^(?:0|[1-9][0-9]*)$/.test(input.value.trim()))){
        event.preventDefault();
        const bad=[...tbody.querySelectorAll('input')].find(input=>!input.value.trim()||!/^(?:0|[1-9][0-9]*)$/.test(input.value.trim()));
        bad?.focus();
        return;
      }
    });
  });
})();
