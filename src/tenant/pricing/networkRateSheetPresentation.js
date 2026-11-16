'use strict';
// Four independent rate components are one user-facing provider sheet.
// No database rewriting: transaction snapshots retain their exact component IDs.
const NAMES={MTN:'MTN MoMo Uganda','MTN SSD':'MTN MoMo South Sudan',Airtel:'Airtel Money Uganda'};
const OPERATIONS={cash_in:'Deposit',cash_out:'Withdrawal',send:'Send money',bill_payment:'Bill payment',
 airtime_sale:'Airtime',merchant_payment:'Merchant payment'};
const KINDS=['agent_commission','customer_network_fee'];
function rangeRows(rows){
 const edges=new Set();
 for(const schedule of rows)for(const tier of schedule?.tiers||[]){
  edges.add(BigInt(tier.minMinor).toString());
  edges.add((BigInt(tier.maxMinor)+1n).toString());
 }
 const sorted=[...edges].map(BigInt).sort((a,b)=>a<b?-1:a>b?1:0);
 const value=(schedule,n)=>{
  const tier=schedule?.tiers?.find(t=>n>=BigInt(t.minMinor)&&n<=BigInt(t.maxMinor));
  return tier?{kind:tier.rate.kind,value:String(tier.rate.value)}:null;
 };
 const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
 const result=[];
 for(let i=0;i+1<sorted.length;i++){
  const start=sorted[i],end=sorted[i+1]-1n;
  const commission=value(rows[0],start),charge=value(rows[1],start);
  if(!commission&&!charge)continue;
  const prior=result.at(-1);
  if(prior&&BigInt(prior.maxMinor)+1n===start&&same(prior.commission,commission)&&same(prior.charge,charge)){
   prior.maxMinor=String(end);continue;
  }
  result.push({minMinor:String(start),maxMinor:String(end),commission,charge});
 }
 return result;
}
function group(schedules=[],branches=[]){
 const branchNames=new Map(branches.map(b=>[String(b._id),b.name]));
 const groups=new Map();
 for(const schedule of schedules){
  if(!['approved','draft'].includes(schedule.status))continue;
  const branchId=String(schedule.branchId||'');
  const key=JSON.stringify([branchId,schedule.network,schedule.currency]);
  let sheet=groups.get(key);
  if(!sheet){sheet={key,branchId,branchName:branchNames.get(branchId)||'Operating branch',
   network:schedule.network,currency:schedule.currency,
   displayName:NAMES[schedule.network]||schedule.network,records:[],operations:[]};groups.set(key,sheet);}
  sheet.records.push(schedule);
 }
 for(const sheet of groups.values()){
  const active=sheet.records.filter(r=>r.status==='approved');
  const drafts=sheet.records.filter(r=>r.status==='draft');
  sheet.status=active.length?'approved':'draft';
  sheet.hasDraft=drafts.length>0;
  sheet.sourceKind=active.length&&active.every(r=>r.sourceKind==='published_reference')?'published_reference':'custom';
  const kinds=new Map();
  for(const schedule of active){
   const id=schedule.operation+'|'+schedule.scheduleKind;
   const old=kinds.get(id);
   if(!old||schedule.version>old.version)kinds.set(id,schedule);
  }
  const operations=new Set([...sheet.records.map(r=>r.operation)]);
  for(const operation of operations){
   const commission=kinds.get(operation+'|agent_commission')||null;
   const charge=kinds.get(operation+'|customer_network_fee')||null;
   if(!commission&&!charge)continue;
   const rows=rangeRows([commission,charge]);
   if(rows.length)sheet.operations.push({
    key:operation,label:OPERATIONS[operation]||operation,
    hasCommission:!!commission,hasCharge:!!charge,rows
   });
  }
  sheet.operations.sort((a,b)=>Object.keys(OPERATIONS).indexOf(a.key)-Object.keys(OPERATIONS).indexOf(b.key));
  sheet.completeMTN=['cash_in','cash_out'].every(op=>KINDS.every(kind=>kinds.has(op+'|'+kind)));
  // Do not expose four Mongo documents as four "approved rate sheets".
  delete sheet.records;
 }
 return [...groups.values()].sort((a,b)=>(a.displayName+a.branchName).localeCompare(b.displayName+b.branchName));
}
module.exports={group,rangeRows};
