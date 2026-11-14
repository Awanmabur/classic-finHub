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
      const formDisclosure=root.querySelector('#network-sheet-form');
      if(formDisclosure)formDisclosure.open=true;
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

  // UI shows amounts in the selected currency, not internal minor units.
  // The canonical hidden textarea remains the existing server-validated payload.
  root.querySelectorAll('textarea[data-rate-editor]').forEach(textarea=>{
    const wrapper=textarea.closest('.field'),form=textarea.closest('form');
    if(!wrapper||!form)return;
    const currency=()=>form.querySelector('[data-provider-currency]')?.value||form.dataset.editorCurrency||'';
    const factor=c=>c==='UGX'?1n:100n;
    const decode=(raw,c)=>{
      if(!/^(?:0|[1-9]\d*)$/.test(String(raw)))return String(raw||'');
      const n=BigInt(raw),f=factor(c),whole=(n/f).toString();
      if(f===1n)return whole;
      return whole+'.'+(n%f).toString().padStart(2,'0');
    };
    const encode=(raw,c)=>{
      if(!c||!['UGX','SSP','KES','USD'].includes(c))return null;
      const text=String(raw||'').trim();
      const regex=c==='UGX'?/^(?:0|[1-9]\d{0,17})$/:/^(?:0|[1-9]\d{0,17})(?:\.\d{1,2})?$/;
      if(!regex.test(text))return null;
      const parts=text.split('.');
      const n=BigInt(parts[0])*factor(c)+(c==='UGX'?0n:BigInt((parts[1]||'').padEnd(2,'0')||'0'));
      const result=n.toString();
      return result.length<=18?result:null;
    };
    const toPercent=raw=>decode(String(raw||'0'),'SSP');
    const fromPercent=raw=>{
      const match=String(raw||'').trim();
      if(!/^(?:0|[1-9]\d{0,2})(?:\.\d{1,2})?$/.test(match))return null;
      const parts=match.split('.');
      const bps=BigInt(parts[0])*100n+BigInt((parts[1]||'').padEnd(2,'0')||'0');
      return bps<=10000n?bps.toString():null;
    };
    const editor=create('div',{className:'networkRateEditor'});
    const scroller=create('div',{className:'networkTariffScroll',role:'region',tabindex:'0','aria-label':'Editable commission ranges; scroll horizontally for more columns'});
    const table=create('table',{className:'networkRateTable'});
    const thead=create('thead'),head=create('tr');
    ['From amount','To amount','Calculation','Commission amount or %',''].forEach(value=>head.append(create('th',{},value)));
    thead.append(head);
    const tbody=create('tbody');
    table.append(thead,tbody);scroller.append(table);
    const toolbar=create('div',{className:'networkRateToolbar'});
    const add=create('button',{type:'button',className:'btn'},'Add amount range');
    const help=create('small',{},'Enter actual amounts in the selected currency (for example, SSP 1,000.00). Fixed commissions use that currency; percentages use 2.5 for 2.5%.');
    toolbar.append(add,help);editor.append(scroller,toolbar);wrapper.after(editor);
    function sync(){
      const c=currency();
      const lines=[];
      for(const tr of tbody.rows){
        const fields=[...tr.querySelectorAll('input,select')];
        const min=encode(fields[0].value,c),max=encode(fields[1].value,c);
        const kind=fields[2].value;
        const amount=kind==='basis_points'?fromPercent(fields[3].value):encode(fields[3].value,c);
        if(!min||!max||amount===null){textarea.value='';return false;}
        lines.push([min,max,kind,amount].join(', '));
      }
      textarea.value=lines.join('\n');
      return lines.length>0;
    }
    const append=(raw=['','','flat',''])=>{
      if(tbody.rows.length>=250)return;
      const tr=create('tr'),cells=[];
      for(let col=0;col<4;col++){
        const td=create('td');
        let control;
        if(col===2){
          control=create('select',{className:'control','aria-label':'Commission calculation'});
          [['flat','Fixed commission'],['basis_points','Percentage (%)']].forEach(([value,label])=>control.append(create('option',{value},label)));
          control.value=raw[col]==='basis_points'?'basis_points':'flat';
        }else{
          control=create('input',{className:'control',type:'text',inputmode:'decimal','aria-label':['Minimum amount','Maximum amount','','Commission amount or percentage'][col],placeholder:col===3?'0.00':'0'});
          control.required=true;
          control.value=col===3&&raw[2]==='basis_points'?toPercent(raw[col]):raw[col]?decode(raw[col],currency()):'';
        }
        cells.push(control);td.append(control);tr.append(td);
      }
      const actionCell=create('td');
      const remove=create('button',{type:'button',className:'btn','aria-label':'Remove this amount range'},'Remove');
      remove.addEventListener('click',()=>{tr.remove();sync();});
      actionCell.append(remove);tr.append(actionCell);tbody.append(tr);
      cells.forEach((field,index)=>{
        field.addEventListener('input',sync);
        field.addEventListener('change',()=>{
          if(index===2)cells[3].value=''; // switching fixed/percent requires an explicit new rate
          sync();
        });
      });
      sync();
    };
    const original=textarea.value.trim().split(/\r?\n/).filter(Boolean);
    original.forEach(line=>{
      const parts=line.split(',').map(x=>x.trim());
      if(parts.length===4)append(parts);
    });
    if(!tbody.rows.length)append();
    add.addEventListener('click',()=>append());
    for(const selector of ['[data-provider-select]','[data-tariff-market-wallet]']){
      form.querySelector(selector)?.addEventListener('change',sync);
    }
    textarea.hidden=true;
    textarea.setAttribute('aria-hidden','true');
    textarea.removeAttribute('required');
    form.addEventListener('submit',event=>{
      if(!sync()){
        event.preventDefault();
        const invalid=[...tbody.querySelectorAll('input')].find(input=>!input.value.trim())||tbody.querySelector('input');
        invalid?.focus();
        return;
      }
      if([...tbody.rows].some(tr=>[...tr.querySelectorAll('input')].some(input=>!input.value.trim()))){
        event.preventDefault();tbody.querySelector('input')?.focus();
      }
    });
  });
})();
