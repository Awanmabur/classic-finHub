'use strict';
// Read-only Mobile Money reporting. All sums retain their native currency;
// estimates are never booked as revenue and shared expenses are never allocated
// to an individual provider without evidence.
const {mobileTransactionModel}=require('../models');
const {models:treasuryModels}=require('../treasury/models');
const {expenseModel}=require('../models/expenses');
const {model:payoutModel}=require('../pricing/commissionPayoutModels');
const {hasModuleForUser,hasPermission}=require('./moduleAccess.service');
const workspace=require('./mobileMoneyWorkspace.service');
const mobile=require('./mobileMoney.service');
const businessTime=require('../../utils/businessTime');
function fail(message,status=400){return Object.assign(new Error(message),{status});}
const periods=new Set(['today','week','month','quarter','year','custom']);
function periodWindow(input={},now=new Date(),timeZone='UTC'){
 if(!Number.isFinite(new Date(now).getTime()))throw fail('Invalid report date');
 const period=input.period||((input.from||input.to)?'custom':'today');
 if(!periods.has(period))throw fail('Choose today, week, month, quarter, year or custom');
 const today=businessTime.parseDay(businessTime.localDay(now,timeZone));
 const year=today.getUTCFullYear(),month=today.getUTCMonth(),day=today.getUTCDate();
 const midnight=(y,m,d)=>new Date(Date.UTC(y,m,d));
 const key=value=>value.toISOString().slice(0,10);
 let start,end;
 if(period==='custom'){
  if(!input.from||!input.to)throw fail('Custom reports require both start and end dates');
  try{start=businessTime.parseDay(input.from);end=businessTime.parseDay(input.to);}catch{throw fail('Enter valid calendar dates');}
 }else if(period==='today'){start=midnight(year,month,day);end=start;}
 else if(period==='week'){
  start=midnight(year,month,day);
  start=new Date(start.getTime()-((start.getUTCDay()+6)%7)*86400000);
  end=new Date(start.getTime()+6*86400000);
 }else if(period==='month'){start=midnight(year,month,1);end=midnight(year,month+1,0);}
 else if(period==='quarter'){const q=Math.floor(month/3)*3;start=midnight(year,q,1);end=midnight(year,q+3,0);}
 else {start=midnight(year,0,1);end=midnight(year,11,31);}
 if(end<start||end.getTime()-start.getTime()>365*86400000)throw fail('Report range must not exceed one calendar year');
 const from=key(start),to=key(end);
 const bounds=businessTime.dayBounds({from,to},timeZone,366);
 return {key:period,from,to,bounds:{$gte:bounds.$gte,$lt:bounds.$lt},timeZone};
}
const whole=value=>BigInt(String(value??'0'));
function blank(network,currency){
 return {network,currency,depositCount:0,withdrawalCount:0,manualCount:0,smsCount:0,
  pendingReviewCount:0,providerUnverifiedCount:0,voidedCount:0,
  depositMinor:0n,withdrawalMinor:0n,volumeMinor:0n,cashImpactMinor:0n,floatMovementMinor:0n,
  recordedFeeMinor:0n,collectedFeeMinor:0n,legacyWalletFeeMinor:0n,
  estimatedCommissionMinor:0n,commissionMissingCount:0,customerNetworkChargeEstimateMinor:0n,
  publishedCommissionReferenceMinor:0n,publishedCustomerChargeReferenceMinor:0n,configuredCostEstimateMinor:0n,receivedCommissionMinor:0n,grossCommissionMinor:0n,
  withheldTaxMinor:0n,providerCostMinor:0n};
}
const format=(amount,currency)=>mobile.formatMoneyMinor(amount,currency);
function renderRow(row){
 const result={...row};
 for(const key of Object.keys(result))if(typeof result[key]==='bigint')result[key+'Formatted']=format(result[key],row.currency);
 return result;
}
function summarize(transactionGroups,payoutGroups,expenseGroups){
 const networks=new Map(),currencies=new Map(),cashCurrencies=new Map();
 const ensure=(network,currency)=>{
  const key=network+'|'+currency;
  if(!networks.has(key))networks.set(key,blank(network,currency));
  if(!currencies.has(currency))currencies.set(currency,blank('All networks',currency));
  return [networks.get(key),currencies.get(currency)];
 };
 for(const group of transactionGroups){
  const {network,currency,operation,entrySource,feeTreatment,voided,reviewState,status,fundingState}=group._id;
  const cashCurrency=group._id.cashCurrency||currency;
  if(!network||!Object.hasOwn(mobile.currencies,currency))throw fail('Unsupported transaction currency/provider in report',409);
  const rows=ensure(network,currency);
  for(const row of rows){
   if(voided){row.voidedCount+=group.count;continue;}
   const amount=whole(group.amountMinor),fees=whole(group.feeMinor);
   row[operation==='cash_in'?'depositCount':'withdrawalCount']+=group.count;
   row[entrySource==='sms'?'smsCount':'manualCount']+=group.count;
   if(reviewState==='awaiting_review')row.pendingReviewCount+=group.count;
   if(status==='pending_verification'||status==='recorded')row.providerUnverifiedCount+=group.count;
   row[operation==='cash_in'?'depositMinor':'withdrawalMinor']+=amount;
   row.volumeMinor+=amount;
   if(fundingState==='book_recorded')row.floatMovementMinor+=operation==='cash_out'?amount:-amount;
   if(fundingState==='book_recorded'&&cashCurrency===currency)row.cashImpactMinor+=whole(group.cashMovementMinor);
   row.recordedFeeMinor+=fees;
   if(feeTreatment==='payment_collected')row.collectedFeeMinor+=fees;
   if(feeTreatment==='wallet_commission')row.legacyWalletFeeMinor+=fees;
   row.estimatedCommissionMinor+=whole(group.estimatedCommissionMinor);
   row.commissionMissingCount+=group.commissionMissingCount||0;
   row.customerNetworkChargeEstimateMinor+=whole(group.customerNetworkChargeEstimateMinor);
   row.publishedCommissionReferenceMinor+=whole(group.publishedCommissionReferenceMinor);
   row.publishedCustomerChargeReferenceMinor+=whole(group.publishedCustomerChargeReferenceMinor);
   row.configuredCostEstimateMinor+=whole(group.configuredCostEstimateMinor);
  }
  // Report physical cash by ACTUAL drawer currency even if provider float is
  // in UGX/KES. This is the same transaction, not a duplicate settlement.
  if(!voided&&fundingState==='book_recorded'&&(group._id.paymentMethod||'Cash')==='Cash'){
   if(!cashCurrencies.has(cashCurrency))cashCurrencies.set(cashCurrency,{currency:cashCurrency,count:0,movementMinor:0n,inMinor:0n,outMinor:0n});
   const actual=cashCurrencies.get(cashCurrency),delta=whole(group.cashMovementMinor);
   actual.count+=group.count;actual.movementMinor+=delta;
   if(delta>=0n)actual.inMinor+=delta;else actual.outMinor-=delta;
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
  cashCurrencies:[...cashCurrencies.values()].sort((a,b)=>a.currency.localeCompare(b.currency)).map(row=>({...row,
   formatted:format(row.movementMinor,row.currency),inFormatted:format(row.inMinor,row.currency),outFormatted:format(row.outMinor,row.currency)})),
  expenses:expenses.sort((a,b)=>a.currency.localeCompare(b.currency))};
}
async function generate(conn,tenant,actor,input={},timeZone='UTC'){
 if(!workspace.canReport(actor))throw fail('Mobile Money reporting permission required',403);
 const window=periodWindow(input,new Date(),timeZone),scope=workspace.readScope(actor),match={...scope,createdAt:window.bounds};
 if(input.network){if(!workspace.networks.includes(input.network))throw fail('Unknown network');match.network=input.network;}
 if(input.currency){if(!Object.hasOwn(mobile.currencies,input.currency))throw fail('Unknown currency');match.currency=input.currency;}
 // Each group keeps voids, methods, commissions, and review states distinct.
 const txQuery=mobileTransactionModel(conn).aggregate([{$match:match},{$group:{
  _id:{network:'$network',currency:'$currency',operation:'$operation',entrySource:{$ifNull:['$entrySource','manual']},
   cashCurrency:{$ifNull:['$cashCurrency','$currency']},paymentMethod:{$ifNull:['$paymentMethod','Cash']},
   fundingState:{$ifNull:['$fundingState','legacy_untracked']},
   feeTreatment:{$ifNull:['$feeTreatment','record_only']},reviewState:{$ifNull:['$reviewState','awaiting_review']},status:'$status',
   voided:{$or:[{$eq:['$status','voided_internal']},{$eq:['$correctionState','voided']}]}},
  count:{$sum:1},amountMinor:{$sum:'$amountMinor'},feeMinor:{$sum:'$feeMinor'},
  cashMovementMinor:{$sum:{$cond:[{$eq:[{$ifNull:['$paymentMethod','Cash']},'Cash']},
    {$ifNull:['$physicalCashMovementMinor',{$cond:[{$eq:['$operation','cash_in']},'$amountMinor',{$multiply:['$amountMinor',-1]}]}]},0]}},
  estimatedCommissionMinor:{$sum:{$convert:{input:'$agentCommissionEstimate.amountMinor',to:'decimal',onError:0,onNull:0}}},
  commissionMissingCount:{$sum:{$cond:[{$ifNull:['$agentCommissionEstimate.scheduleId',false]},0,1]}},
  customerNetworkChargeEstimateMinor:{$sum:{$convert:{input:'$customerNetworkFeeEstimate.amountMinor',to:'decimal',onError:0,onNull:0}}},
  publishedCommissionReferenceMinor:{$sum:{$convert:{input:'$agentCommissionPublishedReference.amountMinor',to:'decimal',onError:0,onNull:0}}},
  publishedCustomerChargeReferenceMinor:{$sum:{$convert:{input:'$customerNetworkChargePublishedReference.amountMinor',to:'decimal',onError:0,onNull:0}}},
  configuredCostEstimateMinor:{$sum:{$convert:{input:'$pricing.costMinor',to:'decimal',onError:0,onNull:0}}}
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
 // Cross-currency customer operations are stored once in their own immutable
 // record collection. Report them inside Mobile Money, but never combine UGX
 // electronic principal and SSP/KES physical cash into one fictitious amount.
 const fxScope={tenantId:tenant._id,settledAt:window.bounds,
  ...(scope.branchId?{branchId:scope.branchId}:{}),
  ...(scope.operatorId?{actorId:scope.operatorId}:{})};
 if(input.network)fxScope.network=input.network;
 if(input.currency)fxScope.$or=[{providerCurrency:input.currency},{cashCurrency:input.currency}];
 const fxQuery=require('../schemas/MomoFxSettlement').records(conn).aggregate([
  {$match:fxScope},
  // Preserve immutable original FX evidence but exclude independently reversed
  // entries from active exchange volume. Corrections remain in audit/history.
  {$lookup:{from:mobileTransactionModel(conn).collection.name,
   localField:'mobileMoneyRecordId',foreignField:'_id',as:'linkedMobile'}},
  {$match:{$or:[{mobileMoneyRecordId:null},{'linkedMobile.status':{$ne:'voided_internal'}}]}},
  {$group:{_id:{network:'$network',operation:'$operation',
     providerCurrency:'$providerCurrency',cashCurrency:'$cashCurrency'},
   count:{$sum:1},providerMinor:{$sum:'$providerAmountMinor'},
   cashMinor:{$sum:'$cashAmountMinor'},
   unverified:{$sum:{$cond:[{$eq:['$providerSettlementState','unverified']},1,0]}}}},
  {$sort:{'_id.network':1,'_id.providerCurrency':1,'_id.cashCurrency':1}},
  {$limit:501}
 ]).option({maxTimeMS:8000});
 // Live account positions are distinct from period flows: a date filter
 // must never mislabel today's book balance as a historical closing balance.
 const positionsAllowed=hasPermission(actor,'treasury.view');
 const accountScope={tenantId:tenant._id,status:{$ne:'archived'},kind:{$in:['wallet','cash']},
  ...(scope.branchId?{branchId:scope.branchId}:{}),
  ...(scope.operatorId?{operatorId:scope.operatorId}:{}),
  // A UGX wallet filter must still show its SSP (or other currency)
  // physical drawer: otherwise a real cross-currency cash impact disappears.
  ...(input.network||input.currency?{$and:[
   ...(input.network?[{$or:[{kind:'cash'},{kind:'wallet',network:input.network}]}]:[]),
   ...(input.currency?[{$or:[{kind:'cash'},{kind:'wallet',currency:input.currency}]}]:[])
  ]}:{})};
 const positionQuery=positionsAllowed?treasuryModels(conn).account.find(accountScope)
  .select('name network currency kind bookBalanceMinor lastObservedMinor lastVarianceMinor lastObservationAt lastExpectedAtObservationMinor lastObservationStale reconciliationState status openingBalanceMinor branchId')
  .sort({currency:1,kind:1,name:1}).limit(301).lean():Promise.resolve([]);
 const [transactions,payouts,expenses,fxGroups,positionRows]=await Promise.all([txQuery,payoutQuery,expenseQuery,fxQuery,positionQuery]);
 if(positionRows.length>300)throw fail('Too many cash and float accounts. Narrow the branch or currency filter.',422);
 const positions=positionRows.map(account=>({name:account.name,network:account.network,kind:account.kind,currency:account.currency,
  bookFormatted:format(account.bookBalanceMinor,account.currency),
  actualFormatted:account.lastObservedMinor===null?'Not checked':format(account.lastObservedMinor,account.currency),
  varianceFormatted:account.lastVarianceMinor===null?'—':format(account.lastVarianceMinor,account.currency),
  status:account.lastObservationStale?'needs fresh count':account.status!=='active'?account.status:account.reconciliationState==='matched'?'matched at last count':account.reconciliationState,
  observedAt:account.lastObservationAt||null,
  comparedBookFormatted:account.lastExpectedAtObservationMinor===null?'Not checked':format(account.lastExpectedAtObservationMinor,account.currency)}));
 if(fxGroups.length>500)throw fail('Too many currency exchange report groups. Narrow the dates.',422);
 const fxRows=fxGroups.map(group=>({
  network:group._id.network,operation:group._id.operation,
  providerCurrency:group._id.providerCurrency,cashCurrency:group._id.cashCurrency,
  count:group.count,unverified:group.unverified,
  providerMinor:String(group.providerMinor),cashMinor:String(group.cashMinor),
  providerFormatted:format(group.providerMinor,group._id.providerCurrency),
  cashFormatted:format(group.cashMinor,group._id.cashCurrency)
 }));
 return {window,...summarize(transactions,payouts,expenses),fxRows,positions,positionsAccessible:positionsAllowed,expensesAccessible,
  payoutsAccessible:hasPayoutScope,
  note:'Cash/float principal is not revenue. Recorded fees and provider commission estimates are not received income. Provider network charges are not agent revenue. Only posted provider payouts and explicitly collected agent fees are identified as received/collected. Expenses cover all approved branch costs and are not allocated to an individual network. Historical wallet-commission recognition is shown separately to detect double counting. Provider settlement is not established by an internal review.'};
}
function csv(report){
 const fields=['Network','Currency','Deposit count','Withdrawal count','Deposit principal','Withdrawal principal',
  'Net physical cash movement in provider currency only','Net provider float movement','Fees recorded (not income)','Explicitly collected agent fees',
  'Legacy wallet fee recognition','Estimated agent commission (unreceived)','Transactions without approved agent commission rate','Estimated provider customer network charge (approved sheet)','Published agent commission reference (not a payout)','Published customer network charge (not agent revenue)','Configured operating cost estimate','Provider commission actually received',
  'Provider gross commission','Withheld tax','Provider deductions','Unreviewed records','Provider-unverified records','Voided records'];
 const rows=[fields,...report.networks.map(row=>[
  row.network,row.currency,row.depositCount,row.withdrawalCount,
  row.depositMinor,row.withdrawalMinor,row.cashImpactMinor,row.floatMovementMinor,row.recordedFeeMinor,row.collectedFeeMinor,
  row.legacyWalletFeeMinor,row.estimatedCommissionMinor,row.commissionMissingCount,row.customerNetworkChargeEstimateMinor,row.publishedCommissionReferenceMinor,row.publishedCustomerChargeReferenceMinor,row.configuredCostEstimateMinor,row.receivedCommissionMinor,
  row.grossCommissionMinor,row.withheldTaxMinor,row.providerCostMinor,row.pendingReviewCount,row.providerUnverifiedCount,row.voidedCount
 ].map(v=>typeof v==='bigint'?String(v):v)),
 ['Business period ('+report.window.timeZone+')',report.window.from+' to '+report.window.to],
 ['Expenses scope','All approved branch expenses, not allocated by provider'],
 ...report.expenses.map(e=>['Approved expenses '+e.currency,e.amountMinor]),
 ['Actual physical cash flows by drawer currency (NOT provider currency)'],
 ['Cash currency','Posted transaction count','Cash received minor units','Cash paid out minor units','Net cash movement minor units'],
 ...(report.cashCurrencies||[]).map(row=>[row.currency,row.count,row.inMinor,row.outMinor,row.movementMinor]),
 ['Current book balances and last independently observed balances (different timestamps)'],
 ['Account','Kind','Network','Currency','Current book','Last observed','Expected at last observation','Difference at last observation','Last observed time','State at last observation'],
 ...(report.positionsAccessible?(report.positions||[]).map(row=>[
   row.name,row.kind,row.network||'',row.currency,row.bookFormatted,row.actualFormatted,row.comparedBookFormatted,
   row.varianceFormatted,row.observedAt?new Date(row.observedAt).toISOString():'',row.status]):[]),
 ['Cross-currency Mobile Money (separate native currencies; never sum principals)'],
 ['Network','Operation','Provider currency','Cash currency','Count','Provider principal minor','Cash principal minor','Externally unverified'],
 ...(report.fxRows||[]).map(r=>[r.network,r.operation,r.providerCurrency,r.cashCurrency,
  r.count,r.providerMinor,r.cashMinor,r.unverified])
 ];
 return '\uFEFF'+rows.map(row=>row.map(mobile.csvCell).join(',')).join('\r\n')+'\r\n';
}
module.exports={periodWindow,blank,summarize,generate,csv};
