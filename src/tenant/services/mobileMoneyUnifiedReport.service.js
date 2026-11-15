'use strict';
// Read-only Mobile Money reporting. All sums retain their native currency;
// estimates are never booked as revenue and shared expenses are never allocated
// to an individual provider without evidence.
const {mobileTransactionModel}=require('../models');
const {expenseModel}=require('../models/expenses');
const {model:payoutModel}=require('../pricing/commissionPayoutModels');
const {hasModuleForUser,hasPermission}=require('./moduleAccess.service');
const workspace=require('./mobileMoneyWorkspace.service');
const mobile=require('./mobileMoney.service');
function fail(message,status=400){return Object.assign(new Error(message),{status});}
const periods=new Set(['today','week','month','quarter','year','custom']);
function date(value){
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))throw fail('Enter a valid calendar date (YYYY-MM-DD)');
 const parsed=new Date(value+'T00:00:00.000Z');
 if(!Number.isFinite(parsed.getTime())||parsed.toISOString().slice(0,10)!==value)throw fail('Enter a valid calendar date');
 return parsed;
}
function periodWindow(input={},now=new Date()){
 if(!Number.isFinite(new Date(now).getTime()))throw fail('Invalid report date');
 const period=input.period||((input.from||input.to)?'custom':'today');
 if(!periods.has(period))throw fail('Choose today, week, month, quarter, year or custom');
 const t=new Date(now),year=t.getUTCFullYear(),month=t.getUTCMonth(),day=t.getUTCDate();
 const midnight=(y,m,d)=>new Date(Date.UTC(y,m,d));
 let start,end;
 if(period==='custom'){
  if(!input.from||!input.to)throw fail('Custom reports require both start and end dates');
  start=date(input.from);end=date(input.to);
 }else if(period==='today'){start=midnight(year,month,day);end=start;}
 else if(period==='week'){
  const today=midnight(year,month,day);
  start=new Date(today.getTime()-((today.getUTCDay()+6)%7)*86400000);
  end=new Date(start.getTime()+6*86400000);
 }else if(period==='month'){start=midnight(year,month,1);end=midnight(year,month+1,0);}
 else if(period==='quarter'){const q=Math.floor(month/3)*3;start=midnight(year,q,1);end=midnight(year,q+3,0);}
 else {start=midnight(year,0,1);end=midnight(year,11,31);}
 if(end<start||end.getTime()-start.getTime()>365*86400000)throw fail('Report range must not exceed one calendar year');
 const before=new Date(end.getTime()+86400000);
 return {key:period,from:start.toISOString().slice(0,10),to:end.toISOString().slice(0,10),
  bounds:{$gte:start,$lt:before}};
}
const whole=value=>BigInt(String(value??'0'));
function blank(network,currency){
 return {network,currency,depositCount:0,withdrawalCount:0,manualCount:0,smsCount:0,
  pendingReviewCount:0,providerUnverifiedCount:0,voidedCount:0,
  depositMinor:0n,withdrawalMinor:0n,volumeMinor:0n,cashImpactMinor:0n,
  recordedFeeMinor:0n,collectedFeeMinor:0n,legacyWalletFeeMinor:0n,
  estimatedCommissionMinor:0n,receivedCommissionMinor:0n,grossCommissionMinor:0n,
  withheldTaxMinor:0n,providerCostMinor:0n};
}
const format=(amount,currency)=>mobile.formatMoneyMinor(amount,currency);
function renderRow(row){
 const result={...row};
 for(const key of Object.keys(result))if(typeof result[key]==='bigint')result[key+'Formatted']=format(result[key],row.currency);
 return result;
}
function summarize(transactionGroups,payoutGroups,expenseGroups){
 const networks=new Map(),currencies=new Map();
 const ensure=(network,currency)=>{
  const key=network+'|'+currency;
  if(!networks.has(key))networks.set(key,blank(network,currency));
  if(!currencies.has(currency))currencies.set(currency,blank('All networks',currency));
  return [networks.get(key),currencies.get(currency)];
 };
 for(const group of transactionGroups){
  const {network,currency,operation,entrySource,feeTreatment,voided,reviewState,status}=group._id;
  if(!network||!Object.hasOwn(mobile.currencies,currency))throw fail('Unsupported transaction currency/provider in report',409);
  const rows=ensure(network,currency);
  for(const row of rows){
   if(voided){row.voidedCount+=group.count;continue;}
   const amount=whole(group.amountMinor),fees=whole(group.feeMinor);
   row[operation==='cash_in'?'depositCount':'withdrawalCount']+=group.count;
   row[entrySource==='sms'?'smsCount':'manualCount']+=group.count;
   if(reviewState==='awaiting_review')row.pendingReviewCount+=group.count;
   if(status==='pending_verification')row.providerUnverifiedCount+=group.count;
   row[operation==='cash_in'?'depositMinor':'withdrawalMinor']+=amount;
   row.volumeMinor+=amount;
   row.cashImpactMinor+=whole(group.cashMovementMinor);
   row.recordedFeeMinor+=fees;
   if(feeTreatment==='payment_collected')row.collectedFeeMinor+=fees;
   if(feeTreatment==='wallet_commission')row.legacyWalletFeeMinor+=fees;
   row.estimatedCommissionMinor+=whole(group.estimatedCommissionMinor);
  }
 }
 for(const group of payoutGroups){
  const {network,currency}=group._id;
  if(!network||!Object.hasOwn(mobile.currencies,currency))throw fail('Unsupported commission payout currency',409);
  for(const row of ensure(network,currency)){
   row.receivedCommissionMinor+=whole(group.amountMinor);
   row.grossCommissionMinor+=whole(group.grossMinor);
   row.withheldTaxMinor+=whole(group.taxMinor);
   row.providerCostMinor+=whole(group.costMinor);
  }
 }
 const expenses=expenseGroups.map(row=>({currency:row._id.currency,count:row.count,
  amountMinor:String(row.amountMinor),formatted:format(row.amountMinor,row._id.currency)}));
 return {networks:[...networks.values()].sort((a,b)=>a.network.localeCompare(b.network)||a.currency.localeCompare(b.currency)).map(renderRow),
  currencies:[...currencies.values()].sort((a,b)=>a.currency.localeCompare(b.currency)).map(renderRow),
  expenses:expenses.sort((a,b)=>a.currency.localeCompare(b.currency))};
}
async function generate(conn,tenant,actor,input={}){
 if(!workspace.canReport(actor))throw fail('Mobile Money reporting permission required',403);
 const window=periodWindow(input),scope=workspace.readScope(actor),match={...scope,createdAt:window.bounds};
 if(input.network){if(!workspace.networks.includes(input.network))throw fail('Unknown network');match.network=input.network;}
 if(input.currency){if(!Object.hasOwn(mobile.currencies,input.currency))throw fail('Unknown currency');match.currency=input.currency;}
 // Each group keeps voids, methods, commissions, and review states distinct.
 const txQuery=mobileTransactionModel(conn).aggregate([{$match:match},{$group:{
  _id:{network:'$network',currency:'$currency',operation:'$operation',entrySource:{$ifNull:['$entrySource','manual']},
   feeTreatment:{$ifNull:['$feeTreatment','record_only']},reviewState:{$ifNull:['$reviewState','awaiting_review']},status:'$status',
   voided:{$or:[{$eq:['$status','voided_internal']},{$eq:['$correctionState','voided']}]}},
  count:{$sum:1},amountMinor:{$sum:'$amountMinor'},feeMinor:{$sum:'$feeMinor'},
  cashMovementMinor:{$sum:{$cond:[{$eq:[{$ifNull:['$paymentMethod','Cash']},'Cash']},
    {$ifNull:['$physicalCashMovementMinor',{$cond:[{$eq:['$operation','cash_in']},'$amountMinor',{$multiply:['$amountMinor',-1]}]}]},0]}},
  estimatedCommissionMinor:{$sum:{$convert:{input:'$agentCommissionEstimate.amountMinor',to:'decimal',onError:0,onNull:0}}}
 }}]).option({maxTimeMS:8000});
 const broad=['Tenant Owner','Reconciliation Officer','Branch Manager','Auditor'].includes(actor.role);
 const hasPayoutScope=broad&&hasPermission(actor,'treasury.view');
 const providerScope={...(scope.branchId?{branchId:scope.branchId}:{}),
  ...(input.network?{network:input.network}:{}),...(input.currency?{currency:input.currency}:{})};
 const payoutQuery=hasPayoutScope?payoutModel(conn).aggregate([{$match:{
    tenantId:tenant._id,...providerScope,status:'posted',creditedAt:window.bounds
  }},{$group:{_id:{network:'$network',currency:'$currency'},amountMinor:{$sum:{$toDecimal:'$amountMinor'}},
    grossMinor:{$sum:{$toDecimal:'$grossMinor'}},taxMinor:{$sum:{$toDecimal:'$taxWithheldMinor'}},
    costMinor:{$sum:{$toDecimal:'$providerCostMinor'}}}
  }]).option({maxTimeMS:8000}):Promise.resolve([]);
 const expensesAccessible=hasModuleForUser(tenant,actor,'expenses')&&hasPermission(actor,'expenses.view');
 const expenseQuery=expensesAccessible?expenseModel(conn).aggregate([{$match:{
  ...scope,status:'approved',reviewedAt:window.bounds,...(input.currency?{currency:input.currency}:{})
 }},{$group:{_id:{currency:'$currency'},count:{$sum:1},amountMinor:{$sum:'$amountMinor'}}}]).option({maxTimeMS:8000}):Promise.resolve([]);
 const [transactions,payouts,expenses]=await Promise.all([txQuery,payoutQuery,expenseQuery]);
 return {window,...summarize(transactions,payouts,expenses),expensesAccessible,
  payoutsAccessible:hasPayoutScope,
  note:'Cash/float principal is not revenue. Recorded fees and provider commission estimates are not received income. Provider network charges are not agent revenue. Only posted provider payouts and explicitly collected agent fees are identified as received/collected. Expenses cover all approved branch costs and are not allocated to an individual network. Historical wallet-commission recognition is shown separately to detect double counting. Provider settlement is not established by an internal review.'};
}
function csv(report){
 const fields=['Network','Currency','Deposit count','Withdrawal count','Deposit principal','Withdrawal principal',
  'Net physical cash movement','Fees recorded (not income)','Explicitly collected agent fees',
  'Legacy wallet fee recognition','Estimated agent commission (unreceived)','Provider commission actually received',
  'Provider gross commission','Withheld tax','Provider deductions','Unreviewed records','Provider-unverified records','Voided records'];
 const rows=[fields,...report.networks.map(row=>[
  row.network,row.currency,row.depositCount,row.withdrawalCount,
  row.depositMinor,row.withdrawalMinor,row.cashImpactMinor,row.recordedFeeMinor,row.collectedFeeMinor,
  row.legacyWalletFeeMinor,row.estimatedCommissionMinor,row.receivedCommissionMinor,
  row.grossCommissionMinor,row.withheldTaxMinor,row.providerCostMinor,row.pendingReviewCount,row.providerUnverifiedCount,row.voidedCount
 ].map(v=>typeof v==='bigint'?String(v):v)),
 ['Period UTC',report.window.from+' to '+report.window.to],
 ['Expenses scope','All approved branch expenses, not allocated by provider'],
 ...report.expenses.map(e=>['Approved expenses '+e.currency,e.amountMinor])
 ];
 return '\uFEFF'+rows.map(row=>row.map(mobile.csvCell).join(',')).join('\r\n')+'\r\n';
}
module.exports={periodWindow,blank,summarize,generate,csv};
