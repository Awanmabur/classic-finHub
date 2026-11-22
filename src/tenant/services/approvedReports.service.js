'use strict';
// Approved report pages share the same source entitlements as the reporting hub.
// A report subscription does not authorize a source module or a payment action.
const {Types}=require('mongoose');
const reports=require('./operationsReports.service');
const mobile=require('./mobileMoney.service');
const businessTime=require('../../utils/businessTime');
const {hasPermission}=require('./moduleAccess.service');
const adapters=require('../reporting/registry');
const {cashSessionModel,mobileTransactionModel}=require('../models');
const {expenseModel}=require('../models/expenses');
const MAX_ROWS=5000;
const cashSources=Object.freeze({mobile_money:'Mobile Money',money_transfer:'Money Transfer',banking:'Banking',forex:'Forex',expenses:'Expenses',loans:'Loan Management',airtime:'Airtime'});
const pages=Object.freeze({
 daily:{title:'Daily business report',subtitle:'Daily control, multi-currency income, cash summary, and operation totals.'},
 opening:{title:'Opening cash report',subtitle:'Opening drawer baseline captured for the business day.',source:'cash_shifts'},
 closing:{title:'Closing cash / expected cash',subtitle:'Expected and actual cash balances by currency for day close.',source:'cash_shifts'},
 transactions:{title:'Transaction summary',subtitle:'Transaction and earnings summaries by permitted operating module.'},
 expenses:{title:'Expenses report',subtitle:'Daily expenses with vendor, method, reference, and amount.',source:'expenses'},
 transfer:{title:'Transfer report summary',subtitle:'Dedicated report for transfer count, volume, fees, pending payouts, and records.',source:'money_transfer'},
 mobile:{title:'Mobile money report',subtitle:'Dedicated report for mobile money count, volume, network mix, and drawer impact.',source:'mobile_money'},
 banking:{title:'Banking report summary',subtitle:'Dedicated report for deposits, withdrawals, account transfers, accounts, and balances.',source:'banking'},
 forex:{title:'Forex report',subtitle:'Currency quotations, volumes, rates, and independent decisions.',source:'forex'},
 loans:{title:'Loan Management report',subtitle:'Applications, verified disbursements, collected principal and interest.',source:'loans'},
 airtime:{title:'Airtime report',subtitle:'Actual stock purchases, manually confirmed sales and recorded gross profit.',source:'airtime'}
});
function fail(message,status=400){const error=new Error(message);error.status=status;return error;}
function id(value){if(!/^[a-f0-9]{24}$/i.test(String(value||'')))throw fail('An authorized reporting scope is required',403);return new Types.ObjectId(String(value));}
function scopeFor(actor){
 const branch=reports.scopeFor(actor);
 return {...branch,...(!['Tenant Owner','Auditor','Branch Manager','Reconciliation Officer','Reports Analyst','Analytics Analyst'].includes(actor.role)?{operatorId:String(id(actor.id))}:{})};
}
function matchFor(scope,dateRange){return {createdAt:dateRange,...(scope.branchId?{branchId:id(scope.branchId)}:{}),...(scope.operatorId?{operatorId:id(scope.operatorId)}:{})};}
async function cashData(conn,scope,dateRange){
 const items=await cashSessionModel(conn).find(matchFor(scope,dateRange)).sort({createdAt:-1,_id:-1}).limit(MAX_ROWS+1).maxTimeMS(5000).lean();
 if(items.length>MAX_ROWS)throw fail('Cash report exceeds 5,000 shifts. Narrow the dates.',422);
 const byCurrency=new Map();
 for(const shift of items){
  if(!byCurrency.has(shift.currency))byCurrency.set(shift.currency,{currency:shift.currency,count:0,openingMinor:0n,verifiedOpeningMinor:0n,expectedMinor:0n,
   countedExpectedMinor:0n,actualMinor:0n,varianceMinor:0n,countedCount:0,verifiedCount:0});
  const row=byCurrency.get(shift.currency);row.count++;row.openingMinor+=BigInt(String(shift.openingMinor));
  if(shift.openingVerifiedAt&&shift.status!=='opening_rejected'){
   row.verifiedCount++;row.verifiedOpeningMinor+=BigInt(String(shift.openingMinor));
   row.expectedMinor+=BigInt(String(shift.openingMinor))+BigInt(String(shift.provisionalMovementMinor));
  }
  if(shift.declaredClosingMinor!=null&&shift.expectedClosingMinor!=null){row.countedCount++;
   row.countedExpectedMinor+=BigInt(String(shift.expectedClosingMinor));row.actualMinor+=BigInt(String(shift.declaredClosingMinor));
   row.varianceMinor+=BigInt(String(shift.varianceMinor));}
 }
 return {items,totals:[...byCurrency.values()].sort((a,b)=>a.currency.localeCompare(b.currency)).map(row=>{
  for(const key of Object.keys(row))if(typeof row[key]==='bigint')row[key]=String(row[key]);return row;})};
}
async function cashImpact(conn,scope,dateRange,{legacyOnly=false}={}){
 const rows=await mobileTransactionModel(conn).aggregate([{$match:{...matchFor(scope,dateRange),status:{$ne:'voided_internal'},correctionState:{$ne:'voided'},
  ...(legacyOnly?{fundingState:{$ne:'book_recorded'}}:{}),
  $or:[{paymentMethod:'Cash'},{paymentMethod:{$exists:false}},{paymentMethod:null}]}},{$group:{_id:{$ifNull:['$cashCurrency','$currency']},amount:{$sum:{$cond:[
   {$ne:[{$ifNull:['$physicalCashMovementMinor',null]},null]},'$physicalCashMovementMinor',{$cond:[{$eq:['$operation','cash_in']},'$amountMinor',{$multiply:['$amountMinor',-1]}]}]}}}}]).option({maxTimeMS:5000});
 return Object.fromEntries(rows.map(row=>[row._id,String(row.amount)]));
}
async function postedCash(conn,tenant,scope,dateRange,sourceKeys){
 const permitted=[...new Set(sourceKeys.filter(key=>Object.hasOwn(cashSources,key)))];
 if(!permitted.length)return [];
 const mobileAllowed=permitted.includes('mobile_money'),forexAllowed=permitted.includes('forex');
 const other=permitted.filter(key=>key!=='mobile_money'&&key!=='forex');
 const sourceMatches=[
  ...(other.length?[{sourceType:{$in:other}}]:[]),
  ...(mobileAllowed?[{sourceType:'mobile_money'},{sourceType:'forex',sourceRef:/^(?:MFX:|MM-VOID:)/}]:[]),
  ...(forexAllowed?[{sourceType:'forex',sourceRef:{$not:/^(?:MFX:|MM-VOID:)/}}]:[])
 ];
 // MFX:<uuid> is a single Forex Treasury posting for a Mobile Money
 // customer operation. Include it in MoMo cash reporting even without the
 // Forex subscription. Do NOT expose it to Forex-only readers or count twice.
 const funds=require('../treasury/models').models(conn);
 const rows=await funds.movement.aggregate([
  {$match:{tenantId:id(tenant._id),occurredAt:dateRange,$or:sourceMatches,...(scope.branchId?{branchId:id(scope.branchId)}:{})}},
  {$lookup:{from:funds.account.collection.name,localField:'accountId',foreignField:'_id',as:'fund'}},{$unwind:'$fund'},
  {$match:{'fund.kind':'cash','fund.tenantId':id(tenant._id),...(scope.operatorId?{'fund.operatorId':id(scope.operatorId)}:{}),$expr:{$and:[{$eq:['$fund.branchId','$branchId']},{$eq:['$fund.currency','$currency']}]}}},
  {$lookup:{from:funds.batch.collection.name,localField:'batchId',foreignField:'_id',as:'batch'}},{$unwind:'$batch'},
  {$match:{'batch.tenantId':id(tenant._id),...(scope.operatorId?{'batch.operatingActorId':id(scope.operatorId)}:{}),$expr:{$and:[{$eq:['$batch.branchId','$branchId']},{$eq:['$batch.sourceType','$sourceType']}]}}},
  {$addFields:{reportedSource:{$cond:[
   {$and:[{$eq:['$sourceType','forex']},{$regexMatch:{input:'$sourceRef',regex:/^(?:MFX:|MM-VOID:)/}}]},
   'mobile_money','$sourceType'
  ]}}},
  {$group:{_id:{sourceType:'$reportedSource',currency:'$currency'},count:{$sum:1},net:{$sum:'$deltaMinor'},
   cashIn:{$sum:{$cond:[{$gt:['$deltaMinor',0]},'$deltaMinor',0]}},cashOut:{$sum:{$cond:[{$lt:['$deltaMinor',0]},{$multiply:['$deltaMinor',-1]},0]}}}},
  {$sort:{'_id.sourceType':1,'_id.currency':1}},{$limit:MAX_ROWS+1}
 ]).option({maxTimeMS:5000});
 if(rows.length>MAX_ROWS)throw fail('Cash movement report exceeds 5,000 groups. Narrow the dates.',422);
 return rows.map(row=>({sourceType:row._id.sourceType,module:cashSources[row._id.sourceType],currency:row._id.currency,count:row.count,
  cashInMinor:String(row.cashIn),cashOutMinor:String(row.cashOut),netMinor:String(row.net)}));
}
async function expenseItems(conn,actor,scope,dateRange){
 if(!hasPermission(actor,'expenses.view'))return null;
 const items=await expenseModel(conn).find(matchFor(scope,dateRange)).sort({createdAt:-1,_id:-1}).limit(MAX_ROWS+1).maxTimeMS(5000).lean();
 if(items.length>MAX_ROWS)throw fail('Expense report exceeds 5,000 records. Narrow the dates.',422);return items;
}
function currencyTotals(rows){
 const result=new Map();
 for(const row of rows){
  // Only posted-internal expense evidence is counted as an expense. Module
  // request amounts and quoted fees are not realized revenue or bank balances.
  if(row.module==='Expenses'&&row.status!=='approved')continue;
  if(!result.has(row.currency))result.set(row.currency,{currency:row.currency,recordedFeesMinor:0n,approvedExpensesMinor:0n});
  const total=result.get(row.currency);
  if(row.module==='Mobile Money'&&!['voided_internal','rejected'].includes(row.recordStatus||String(row.status).split('/')[0].trim())&&(row.correctionState||String(row.status).split('/')[2]?.trim())!=='voided'&&row.feesMinor!=null)total.recordedFeesMinor+=BigInt(String(row.feesMinor));
  if(row.module==='Expenses'&&row.amountMinor!=null)total.approvedExpensesMinor+=BigInt(String(row.amountMinor));
 }
 return [...result.values()].filter(row=>Object.hasOwn(mobile.currencies,row.currency)).map(row=>({currency:row.currency,
  recordedFeesMinor:String(row.recordedFeesMinor),approvedExpensesMinor:String(row.approvedExpensesMinor)}));
}
// Independently posted income, grouped by native currency and source.
// Request/quote fees and commissions estimated by sheets never enter income.
async function postedIncome(conn,tenant,scope,range,sources){
 const allowed=new Set(sources.map(item=>item.key));
 const moduleTypes=['money_transfer','banking'].filter(key=>allowed.has(key));
 const sourceScope={...(scope.branchId?{branchId:id(scope.branchId)}:{}),
  ...(scope.operatorId?{createdBy:id(scope.operatorId)}:{})};
 const execution=moduleTypes.length?require('../funded/models').models(conn).execution.aggregate([
  {$match:{...sourceScope,sourceType:{$in:moduleTypes},status:'posted_manual',
   reviewedAt:range,action:{$in:['banking','transfer_collect']}}},
  {$group:{_id:{source:'$sourceType',currency:'$sourceSnapshot.currency'},
   count:{$sum:1},amount:{$sum:{$convert:{input:'$sourceSnapshot.feeMinor',to:'decimal',onError:0,onNull:0}}}}},
  {$limit:201}
 ]).option({maxTimeMS:8000}):Promise.resolve([]);
 const payouts=allowed.has('mobile_money')&&!scope.operatorId?
  require('../pricing/commissionPayoutModels').model(conn).aggregate([
   {$match:{tenantId:tenant._id,status:'posted',creditedAt:range,
    ...(scope.branchId?{branchId:id(scope.branchId)}:{})}},
   {$group:{_id:{source:{$literal:'mobile_money'},currency:'$currency'},
    count:{$sum:1},amount:{$sum:{$toDecimal:'$amountMinor'}}}},
   {$limit:201}
  ]).option({maxTimeMS:8000}):Promise.resolve([]);
 const loanIncome=allowed.has('loans')?require('../retailFinance/loans.models').models(conn).payment.aggregate([
  {$match:{tenantId:tenant._id,createdAt:range,...sourceScope}},
  {$group:{_id:{source:{$literal:'loans'},currency:'$currency'},count:{$sum:1},amount:{$sum:'$interestMinor'}}},
  {$limit:201}
 ]).option({maxTimeMS:5000}):Promise.resolve([]);
 const airtimeIncome=allowed.has('airtime')?require('../retailFinance/airtime.models').models(conn).record.aggregate([
  {$match:{tenantId:tenant._id,createdAt:range,type:'sale',...sourceScope}},
  {$group:{_id:{source:{$literal:'airtime'},currency:'$currency'},count:{$sum:1},amount:{$sum:'$profitMinor'}}},
  {$limit:201}
 ]).option({maxTimeMS:5000}):Promise.resolve([]);
 // A reversal is a separate, dated, immutable accounting event. Negative
 // correction entries are recognized on the refund date, not silently deleted
 // from their original reporting day. Join original actor for teller scope.
 const originalOperator=scope.operatorId?id(scope.operatorId):null;
 const loanCorrections=allowed.has('loans')?require('../retailFinance/loans.models').models(conn).correction.aggregate([
  {$match:{tenantId:tenant._id,createdAt:range,...(scope.branchId?{branchId:id(scope.branchId)}:{})}},
  ...(originalOperator?[{$lookup:{from:require('../retailFinance/loans.models').models(conn).payment.collection.name,localField:'paymentId',foreignField:'_id',as:'origin'}},
     {$match:{'origin.createdBy':originalOperator}}]:[]),
  {$group:{_id:{source:{$literal:'loans'},currency:'$currency',reversed:{$literal:true}},count:{$sum:1},amount:{$sum:'$interestMinor'}}},
  {$limit:201}
 ]).option({maxTimeMS:5000}):Promise.resolve([]);
 const airtimeCorrections=allowed.has('airtime')?require('../retailFinance/airtime.models').models(conn).correction.aggregate([
  {$match:{tenantId:tenant._id,createdAt:range,type:'sale',...(scope.branchId?{branchId:id(scope.branchId)}:{})}},
  ...(originalOperator?[{$lookup:{from:require('../retailFinance/airtime.models').models(conn).record.collection.name,localField:'recordId',foreignField:'_id',as:'origin'}},
     {$match:{'origin.createdBy':originalOperator}}]:[]),
  {$group:{_id:{source:{$literal:'airtime'},currency:'$currency',reversed:{$literal:true}},count:{$sum:1},amount:{$sum:'$profitMinor'}}},
  {$limit:201}
 ]).option({maxTimeMS:5000}):Promise.resolve([]);
 const groups=await Promise.all([execution,payouts,loanIncome,airtimeIncome,loanCorrections,airtimeCorrections]);
 if(groups.some(group=>group.length>200))throw fail('Too many realized income groups. Narrow the date range.',422);
 const net=new Map();
 for(const row of groups.flat()){
  const source=row._id.source,currency=row._id.currency,groupKey=source+':'+currency,sign=row._id.reversed?-1n:1n;
  if(!net.has(groupKey))net.set(groupKey,{source,currency,count:0,amount:0n});
  const target=net.get(groupKey);
  target.amount+=sign*BigInt(String(row.amount));
  target.count+=Number(row.count||0)*(row._id.reversed?-1:1);
 }
 return [...net.values()].filter(row=>row.amount!==0n).map(row=>({
  module:({money_transfer:'Money Transfer',banking:'Banking',mobile_money:'Mobile Money',loans:'Loan Management',airtime:'Airtime'})[row.source],
  currency:row.currency,count:row.count,amountMinor:String(row.amount),
  activity:row.source==='loans'?'Net collected loan interest (after corrections)':row.source==='airtime'?'Net airtime gross profit (after corrections)':'Posted fee/commission income',
  amount:require('./forex.service').amountLabel(String(row.amount),row.currency)
 })).sort((a,b)=>a.currency.localeCompare(b.currency)||a.module.localeCompare(b.module));
}
async function generate(conn,tenant,actor,key,query={},timeZone='UTC'){
 if(!tenant||conn.name!==require('../../config/tenantDatabaseName').tenantDbNameFromSlug(tenant.slug))throw fail('Tenant database context does not match this workspace',403);
 const page=pages[key];if(!page)throw fail('Unknown report page',404);
 const sources=reports.sourcesFor(tenant,actor);if(!sources.length)throw fail('Operations Reports subscription and reporting permission required',403);
 const filters=reports.parseFilters({from:query.from,to:query.to,source:'all'},sources,timeZone),scope=scopeFor(actor);
 const sourceAvailable=!page.source||sources.some(source=>source.key===page.source),transactionKeys=['money_transfer','mobile_money','banking','forex','loans','airtime'];
 const requested=sources.filter(source=>page.source?source.key===page.source:transactionKeys.includes(source.key)||(key==='daily'&&source.key==='expenses'));
 let rows=[];
 if(sourceAvailable)for(const source of requested){
  const adapter=adapters.find(candidate=>candidate.key===source.key);if(!adapter)throw fail('Report source is not registered',403);
  rows.push(...await adapter.rows({conn,tenant,user:actor,filters,dateRange:filters.dateRange,scope}));
  if(rows.length>MAX_ROWS)throw fail('Too many report groups. Narrow the date range.',422);
 }
 const hasCash=sources.some(source=>source.key==='cash_shifts'),hasMobile=sources.some(source=>source.key==='mobile_money'),hasExpenses=sources.some(source=>source.key==='expenses');
 const [cash,impact,expenses,cashMovements,realizedIncome]=await Promise.all([
  hasCash&&['daily','opening','closing'].includes(key)?cashData(conn,scope,filters.dateRange):null,
  hasMobile&&['daily','transactions','mobile'].includes(key)?cashImpact(conn,scope,filters.dateRange,{legacyOnly:true}):{},
  hasExpenses&&key==='expenses'?expenseItems(conn,actor,scope,filters.dateRange):null,
  sourceAvailable&&!['opening','closing'].includes(key)?postedCash(conn,tenant,scope,filters.dateRange,requested.map(source=>source.key)):[],
  sourceAvailable&&['daily','transfer','mobile','banking','loans','airtime','transactions'].includes(key)?
   postedIncome(conn,tenant,scope,filters.dateRange,requested):[]
 ]);
 return {key,page,filters,timeZone,sources,scope,sourceAvailable,rows,cash,impact,postedCash:cashMovements,expenses,realizedIncome,income:currencyTotals(rows),format:require('./forex.service').amountLabel,
  note:'Each source describes its own internal evidence. Amounts and currencies remain separate. Pending requests and recorded fees do not prove provider settlement, available funds, or realized income.'};
}
function csv(report){
 let rows;
 if(report.key==='expenses'&&report.expenses) return require('./expenses.service').csv(report.expenses,report.timeZone||'UTC');
 if(['opening','closing'].includes(report.key)&&report.cash){
  rows=[['Opened ('+(report.timeZone||'UTC')+')','Shift','Currency','Status','Opening minor units','Opening verified','Expected minor units','Counted minor units','Variance minor units'],
   ...report.cash.items.map(shift=>[businessTime.format(shift.createdAt,report.timeZone||'UTC',true),String(shift._id),shift.currency,shift.status,String(shift.openingMinor),
    shift.openingVerifiedAt?businessTime.format(shift.openingVerifiedAt,report.timeZone||'UTC',true):'',shift.expectedClosingMinor==null?'':String(shift.expectedClosingMinor),
    shift.declaredClosingMinor==null?'':String(shift.declaredClosingMinor),shift.varianceMinor==null?'':String(shift.varianceMinor)])];
 }else rows=[['Source','Activity','Status','Currency','Count','Volume label','Fees label','Amount minor units','Fees minor units','Quoted target currency','Quoted target amount minor units','Net cash movement minor units','Cash movement evidence'],
  ...report.rows.map(row=>[row.module,row.activity,row.status,row.currency,row.count,row.volume,row.fees,row.amountMinor??'',row.feesMinor??'',row.targetCurrency??'',row.targetAmountMinor??'','','']),
  ...(report.realizedIncome||[]).map(row=>[row.module,row.activity||'Verified posted income','posted',row.currency,row.count,'',row.amount,'',row.amountMinor,'','','','Actual posted income net of corrections: fees, commissions, collected loan interest or airtime gross profit; not customer principal']),
  ...(report.postedCash||[]).map(row=>[row.module,'Physical cash movement','posted',row.currency,row.count,'','','','','','',row.netMinor,'Immutable Treasury movements by actual event date; includes reversals and collected cash fees']),
  ...Object.entries(report.impact||{}).map(([currency,amount])=>['Mobile Money','Legacy physical cash record','untracked evidence',currency,'','','','','','','',amount,'Legacy records by creation date; no Treasury posting'])];
 return '\uFEFF'+rows.map(row=>row.map(mobile.csvCell).join(',')).join('\r\n')+'\r\n';
}
module.exports={pages,generate,csv,scopeFor,matchFor,cashData,cashImpact,postedCash,currencyTotals,postedIncome};
