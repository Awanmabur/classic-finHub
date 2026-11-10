'use strict';
// Module-local workspaces use the same authorization and immutable operational
// records as their transaction services. They do not depend on Reports add-on.
const crypto=require('node:crypto');
const mongoose=require('mongoose');
const mobile=require('./mobileMoney.service');
const {hasPermission,hasModuleForUser}=require('./moduleAccess.service');
const models=require('../models');
const {currencyCodes,forexCurrencyCodes}=require('../../config/currencies');
const branchCurrency=require('./branchCurrency.service');
const definitions=Object.freeze({
 money_transfer:{label:'Money Transfer',path:'money-transfer',model:models.transferOrderModel,
  creator:'Money Transfer Operator',statuses:['requested','approved_pending_provider','rejected','cancelled','expired','collected_manual','paid_out_manual'],
  kinds:[],currencies:currencyCodes,amount:'amountMinor',fees:'feeMinor'},
 banking:{label:'Banking',path:'banking',model:models.bankingRequestModel,
  creator:'Banking Operator',statuses:['requested','approved_pending_bank','rejected','cancelled','expired','posted_manual'],
  kinds:['deposit_request','withdrawal_request','transfer_request'],currencies:currencyCodes,amount:'amountMinor'},
 forex:{label:'Forex',path:'forex',model:models.forexQuoteModel,
  creator:'Forex Operator',statuses:['quoted','approved_pending_execution','rejected','cancelled','expired','posted_manual'],
  kinds:['buy','sell','quote'],currencies:forexCurrencyCodes,amount:'sourceMinor'}
});
function fail(message,status=400){const error=new Error(message);error.status=status;return error;}
function definition(key){if(!Object.hasOwn(definitions,key))throw fail('Unknown operational module');return definitions[key];}
function authorize(tenant,actor,key){
 definition(key);
 if(!hasModuleForUser(tenant,actor,key)||!hasPermission(actor,`${key}.view`))throw fail('Operational module or view permission unavailable',403);
}
function scopeFor(actor,key){
 const spec=definition(key),scope=require('./branchView.service').canViewBranches(actor)?require('./branchView.service').readScope(actor):{};
 if(!['Tenant Owner','Auditor'].includes(actor?.role)){
  if(!/^[a-f0-9]{24}$/i.test(String(actor?.branchId||'')))throw fail('An active assigned branch is required',403);
  scope.branchId=new mongoose.Types.ObjectId(actor.branchId);
 }
 if(actor?.role===spec.creator){
  if(!/^[a-f0-9]{24}$/i.test(String(actor.id||'')))throw fail('A valid staff account is required',403);
  scope.createdBy=new mongoose.Types.ObjectId(actor.id);
 }
 return scope;
}
function scalar(query,key){
 const value=query?.[key];if(value===undefined||value==='')return '';
 if(typeof value!=='string'||value.length>120)throw fail(`Invalid ${key} filter`);
 return value;
}
function filtersFor(key,query={}){
 const spec=definition(key),today=new Date();
 const end=today.toISOString().slice(0,10),start=new Date(today.getTime()-29*86400000).toISOString().slice(0,10);
 const from=scalar(query,'from')||start,to=scalar(query,'to')||end;
 const status=scalar(query,'status'),currency=scalar(query,'currency'),kind=scalar(query,'kind');
 if(status&&!spec.statuses.includes(status))throw fail('Invalid operation status');
 if(currency&&!spec.currencies.includes(currency))throw fail('Unsupported operation currency');
 if(kind&&!spec.kinds.includes(kind))throw fail('Invalid operation type');
 return {from,to,status,currency,kind,dateBounds:mobile.dateBounds({from,to})};
}
function queryFor(actor,key,filters){
 const scope=scopeFor(actor,key);
 const permitted=key==='money_transfer'&&scope.branchId?{$and:[{$or:[scope,{destinationBranchId:scope.branchId,status:{$in:['collected_manual','paid_out_manual']}}]}]}:scope;
 return {...permitted,createdAt:filters.dateBounds,
  ...(filters.status?{status:filters.status}:{}),
  ...(filters.currency?{[key==='forex'?'fromCurrency':'currency']:filters.currency}:{}),
  ...(filters.kind?key==='forex'?{operation:filters.kind==='quote'?{$in:['quote',null]}:filters.kind}:{kind:filters.kind}:{})};
}
function formatAmount(value,currency){return require('./forex.service').amountLabel(String(value??'0'),currency);}
function describe(key,row){
 const spec=definition(key);
 return {...row,
  activity:key==='forex'?`${(row.operation||'quote').replaceAll('_',' ')} · ${row.fromCurrency} → ${row.toCurrency}`:
   key==='banking'?row.kind.replaceAll('_',' '):(row.originBranchName&&row.destinationBranchName?`${row.originBranchName} → ${row.destinationBranchName}`:'Transfer request'),
  party:key==='forex'?row.customerLabel:key==='banking'?`${row.source.customerName} · ${row.source.institutionName} · ****${row.source.last4}`:`${row.sender.name} → ${row.beneficiary.name}`,
  volume:formatAmount(row[spec.amount]?.toString()||'0',key==='forex'?row.fromCurrency:row.currency),
  fee:key==='money_transfer'?formatAmount(row.feeMinor?.toString()||'0',row.currency):null,
  target:key==='forex'?formatAmount(row.targetMinor?.toString()||'0',row.toCurrency):null,
  href:`/tenant/${spec.path}/${row._id}`};
}
async function records(conn,tenant,actor,key,query={}){
 authorize(tenant,actor,key);
 const spec=definition(key),filters=filtersFor(key,query),filter=queryFor(actor,key,filters),cursor=mobile.decodeCursor(scalar(query,'cursor'));
 if(cursor)filter.$or=[{createdAt:{$lt:cursor.at}},{createdAt:cursor.at,_id:{$lt:new mongoose.Types.ObjectId(cursor.id)}}];
 const found=await spec.model(conn).find(filter).sort({createdAt:-1,_id:-1}).limit(41).lean();
 const visible=found.slice(0,40);
 return {items:visible.map(row=>describe(key,row)),nextCursor:found.length>40?mobile.encodeCursor(visible.at(-1)):null,filters};
}
async function report(conn,tenant,actor,key,query={}){
 authorize(tenant,actor,key);
 const spec=definition(key),filters=filtersFor(key,query),match=queryFor(actor,key,filters);
 const group={day:{$dateToString:{date:'$createdAt',format:'%Y-%m-%d',timezone:'UTC'}},status:'$status',
  currency:key==='forex'?'$fromCurrency':'$currency',kind:key==='forex'?{$ifNull:['$operation','quote']}:key==='banking'?'$kind':{$literal:'transfer_request'}};
 if(key==='forex')group.targetCurrency='$toCurrency';
 const values={_id:group,count:{$sum:1},volume:{$sum:`$${spec.amount}`}};
 if(spec.fees)values.fees={$sum:`$${spec.fees}`};
 if(key==='forex')values.target={$sum:'$targetMinor'};
 const found=await spec.model(conn).aggregate([{$match:match},{$group:values},{$sort:{'_id.day':-1,'_id.currency':1,'_id.kind':1,'_id.status':1}},{$limit:1001}]);
 if(found.length>1000)throw fail('Report has more than 1,000 groups. Narrow the dates or filters.',422);
 const rows=found.map(row=>({day:row._id.day,status:row._id.status,kind:row._id.kind,currency:row._id.currency,
  targetCurrency:row._id.targetCurrency||'',count:row.count,
  volume:formatAmount(row.volume?.toString()||'0',row._id.currency),
  fees:spec.fees?formatAmount(row.fees?.toString()||'0',row._id.currency):'',
  target:key==='forex'?formatAmount(row.target?.toString()||'0',row._id.targetCurrency):''}));
 return {moduleKey:key,label:spec.label,currencies:spec.currencies,filters,rows,total:rows.reduce((sum,row)=>sum+row.count,0),
  canExport:hasPermission(actor,`${key}.report`)||hasPermission(actor,'reports.export'),
  note:key==='forex'?'Quotations remain separate from posted manual exchanges. Reviewed manual movements update the foreign stock and settlement books; check the cash movement report for physical drawer effects.':
   key==='banking'?'Pending instructions remain separate from posted manual operations. Reviewed manual movements update the selected funds and internal customer accounts together.':
    'Pending requests remain separate from collected and paid-out manual transfers. Independently reviewed collection posts the funds and payable, then enables one-time PIN access; provider settlement remains separate.'};
}
function csv(report){
 const headers=['Date (UTC)','Operation','Status','Currency','Records','Requested / quoted amount','Proposed fees','Target currency','Target quoted amount'];
 return '\uFEFF'+[headers,...report.rows.map(row=>[row.day,row.kind,row.status,row.currency,row.count,row.volume,row.fees,row.targetCurrency,row.target])]
  .map(row=>row.map(mobile.csvCell).join(',')).join('\r\n')+'\r\n';
}
async function formContext(conn,tenant,actor,key,operationBranch,input={}){
 authorize(tenant,actor,key);
 const activeBranches=(await require('./branch.service').list(tenant)).filter(branch=>branch.status==='active');
 const branches=activeBranches.filter(branch=>
  (require('./branchView.service').canViewBranches(actor)||String(branch._id)===String(actor.branchId)));
 const selectedId=String(operationBranch?._id||''),selected=branches.find(branch=>String(branch._id)===selectedId);
 const operatingActor=require('./branchView.service').withoutReadView(actor);
 const common={branches,selectedBranchId:selected?selectedId:null,idempotencyKey:crypto.randomUUID(),formatMoneyMinor:mobile.formatMoneyMinor,
  currencyChoices:branchCurrency.options(operationBranch),selectedCurrency:operationBranch?branchCurrency.resolve(operationBranch,input.currency):null};
 if(key==='money_transfer'){
  const service=require('./moneyTransfer.service');
  const [list,queue]=await Promise.all([
   service.list(conn,tenant,actor),
   ['Tenant Owner','Branch Manager','Reconciliation Officer'].includes(actor.role)&&hasPermission(actor,'money_transfer.review')?service.reviewQueue(conn,tenant,actor):[]]);
  return {...common,destinationBranches:activeBranches.filter(branch=>String(branch._id)!==selectedId),countryOptions:require('../../utils/selectionOptions').countryOptions(),records:list,queue,canCreate:['Tenant Owner','Money Transfer Operator'].includes(actor.role)&&hasPermission(actor,'money_transfer.create'),
   canReview:['Tenant Owner','Branch Manager','Reconciliation Officer'].includes(actor.role)&&hasPermission(actor,'money_transfer.review')};
 }
 if(key==='banking'){
  const service=require('./banking.service');
  const [references,list,queue]=await Promise.all([selected?service.listReferences(conn,tenant,operatingActor,{branchId:selectedId}):[],service.list(conn,tenant,actor),
   service.reviewer(actor)&&hasPermission(actor,'banking.review')?service.reviewQueue(conn,tenant,actor):[]]);
  if(selected&&hasModuleForUser(tenant,actor,'accounts')&&hasPermission(actor,'accounts.view'))references.push(...await require('../customerAccounts/bankingBridge').choices(conn,tenant,actor,{branchId:selectedId}));
  return {...common,references,records:list,queue,canCreate:service.operator(actor)&&hasPermission(actor,'banking.requests.create'),
   canReview:service.reviewer(actor)&&hasPermission(actor,'banking.review')};
 }
 const service=require('./forex.service');
 const [listedRates,list,rateQueue,quoteQueue]=await Promise.all([service.listRates(conn,tenant,operatingActor,{status:'active',...(selected?{branchId:selectedId}:{})}),service.listQuotes(conn,tenant,actor),
  service.reviewer(actor)&&hasPermission(actor,'forex.rate_review')?service.rateReviewQueue(conn,tenant,actor):[],
  service.reviewer(actor)&&hasPermission(actor,'forex.quotes.review')?service.quoteReviewQueue(conn,tenant,actor):[]]);
 const rates=selected?listedRates.filter(rate=>service.enabledRate(selected,rate)):listedRates;
 return {...common,rates,records:list,rateQueue,quoteQueue,amountLabel:service.amountLabel,
  canPropose:service.operator(actor)&&hasPermission(actor,'forex.rate_manage'),canQuote:service.operator(actor)&&hasPermission(actor,'forex.quotes.create'),
  canRateReview:service.reviewer(actor)&&hasPermission(actor,'forex.rate_review'),canQuoteReview:service.reviewer(actor)&&hasPermission(actor,'forex.quotes.review')};
}
module.exports={definitions,definition,authorize,scopeFor,filtersFor,queryFor,describe,records,report,csv,formContext,formatAmount,fail};
