'use strict';
// Read-only financial overview. This deliberately distinguishes recorded cash/
// float/assets from paid-in capital, and posted net income from FX trading P&L.
// No foreign currencies are summed or translated without a cost basis.
const {Types}=require('mongoose');
const models=require('../models');
const {models:fundsModels}=require('../treasury/models');
const {currencyCodes}=require('../../config/currencies');
const {hasPermission,hasModuleForUser}=require('./moduleAccess.service');
const businessTime=require('../../utils/businessTime');
const format=require('./mobileMoney.service').formatMoneyMinor;
const OID=/^[a-f0-9]{24}$/i;
const ASSET_KINDS=['cash','wallet','bank','forex_stock'];
const MODULES=['mobile_money','forex','banking','money_transfer','expenses'];
function groupMoney(rows,key,sign=1n){
 const groups=new Map();
 for(const row of rows){
  const currency=String(row.currency||'');
  if(!currencyCodes.includes(currency))continue;
  const amount=BigInt(String(row[key]??'0'))*sign;
  groups.set(currency,(groups.get(currency)||0n)+amount);
 }
 return groups;
}
function rowsOf(map){
 return [...map].sort(([a],[b])=>a.localeCompare(b))
  .map(([currency,amount])=>({currency,amountMinor:String(amount),formatted:format(amount,currency)}));
}
function branchScope(user,options={}){
 const view=options.viewBranchId;
 if(['Tenant Owner','Auditor'].includes(user.role)&&view==='all')return {};
 const branch=options.viewBranch?._id||options.operationBranch?._id||user.branchId;
 if(!OID.test(String(branch||'')))return null;
 if(!['Tenant Owner','Auditor'].includes(user.role)&&String(branch)!==String(user.branchId))return null;
 return {branchId:new Types.ObjectId(String(branch))};
}
async function overview(conn,tenant,user,options={}){
 // Confidential capital and earnings cannot leak through dashboards to staff
 // lacking Treasury/financial permissions.
 if(!hasPermission(user,'treasury.view')||!['Tenant Owner','Branch Manager','Reconciliation Officer','Auditor'].includes(user.role))
  return {available:false,reason:'Financial totals are available to authorized financial supervisors'};
 const scope=branchScope(user,options);
 if(scope===null)return {available:false,reason:'Choose an operating branch'};
 const Account=fundsModels(conn).account;
 const [assets,recognized,moduleEarnings]=await Promise.all([
  Account.find({tenantId:tenant._id,...scope,kind:{$in:ASSET_KINDS},
   status:{$in:['active','held']},openingBalanceMinor:{$ne:null}})
   .select('currency kind moduleKey bookBalanceMinor').limit(1001).lean(),
  postedEarnings(conn,scope,options),
  postedEarningsByModule(conn,tenant,scope,options)
 ]);
 if(assets.length>1000)return {available:false,reason:'Too many capital accounts for one overview. Select a branch.'};
 const visibleAssets=assets.filter(account=>account.moduleKey==='shared'||['Tenant Owner','Auditor'].includes(user.role)||hasModuleForUser(tenant,user,account.moduleKey));
 const assetMap=groupMoney(visibleAssets,'bookBalanceMinor');
 const byModule=new Map();
 for(const account of visibleAssets){
  const key=account.moduleKey||'shared',currency=account.currency;
  if(!byModule.has(key))byModule.set(key,new Map());
  const m=byModule.get(key);
  m.set(currency,(m.get(currency)||0n)+BigInt(String(account.bookBalanceMinor)));
 }
 return {available:true,
  bookAssets:rowsOf(assetMap),
  byModule:[...byModule].sort(([a],[b])=>a.localeCompare(b))
    .map(([moduleKey,totals])=>({moduleKey,totals:rowsOf(totals)})),
  postedIncome:recognized.income,postedExpenses:recognized.expenses,postedNet:recognized.net,
  moduleEarnings:moduleEarnings.filter(entry=>['Tenant Owner','Auditor'].includes(user.role)||hasModuleForUser(tenant,user,entry.moduleKey)),
  // Never present spread or operating assets as realized profit/capital funding.
  forexProfit:{available:false,reason:'Cannot calculate realized Forex profit until purchase cost basis and disposal lots are recorded'},
  capitalDefinition:'Operating cash, float, bank and Forex stock book assets; not invested owner equity or verified provider balances',
  profitDefinition:'Posted net income (recognized income less posted expenses), excluding unmeasured Forex trading spread',
  mixedRegion:Boolean(options.suppressTodayVolumes)};
}
async function postedEarnings(conn,scope,options={}){
 const result={income:[],expenses:[],net:[]};
 if(options.suppressTodayVolumes)return result;
 const {$gte,$lt}=businessTime.dayBounds({},options.timeZone||'UTC',90,options.now||new Date());
 const startEnd={$gte,$lt};
 const accountModel=models.ledgerAccountModel(conn);
 const postings=models.ledgerPostingModel(conn);
 const groups=await postings.aggregate([
  {$match:{...scope,createdAt:startEnd}},
  {$lookup:{from:accountModel.collection.name,localField:'accountId',foreignField:'_id',as:'bookAccount'}},
  {$unwind:'$bookAccount'},
  {$match:{'bookAccount.category':{$in:['income','expense']},
   $expr:{$and:[{$eq:['$bookAccount.branchId','$branchId']},{$eq:['$bookAccount.currency','$currency']}]}}},
  {$group:{_id:{currency:'$currency',category:'$bookAccount.category',side:'$side'},amount:{$sum:'$amountMinor'}}}
 ]).option({maxTimeMS:3500});
 const income=new Map(),expenses=new Map();
 for(const row of groups){
  if(!currencyCodes.includes(row._id.currency))continue;
  const map=row._id.category==='income'?income:expenses;
  const positive=row._id.category==='income'?(row._id.side==='credit'):(row._id.side==='debit');
  const delta=BigInt(String(row.amount))*(positive?1n:-1n);
  map.set(row._id.currency,(map.get(row._id.currency)||0n)+delta);
 }
 const net=new Map(income);
 for(const [currency,value] of expenses)net.set(currency,(net.get(currency)||0n)-value);
 result.income=rowsOf(income);result.expenses=rowsOf(expenses);result.net=rowsOf(net);
 return result;
}
// Journal-to-batch linkage attributes fee/expense postings to the underlying
// module. This is posted LEDGER contribution, not FX dealing profit or margin.
async function postedEarningsByModule(conn,tenant,scope,options={}){
 if(options.suppressTodayVolumes)return [];
 const {$gte,$lt}=businessTime.dayBounds({},options.timeZone||'UTC',90,options.now||new Date());
 const batches=await fundsModels(conn).batch.find({
  tenantId:tenant._id,...scope,sourceType:{$in:MODULES},createdAt:{$gte,$lt}
 }).select('sourceType journalIds').limit(2001).maxTimeMS(2500).lean();
 if(batches.length>2000)throw new Error('TOO_MANY_FINANCIAL_BATCHES');
 const journalModules=new Map(),journalIds=[];
 for(const batch of batches){
  for(const journalId of batch.journalIds||[]){
   const key=String(journalId);
   if(journalModules.has(key)&&journalModules.get(key)!==batch.sourceType)
    throw new Error('UNEXPECTED_JOURNAL_REUSE');
   if(!journalModules.has(key))journalIds.push(journalId);
   journalModules.set(key,batch.sourceType);
  }
 }
 if(!journalIds.length)return [];
 const accounts=models.ledgerAccountModel(conn),Posting=models.ledgerPostingModel(conn);
 const postings=await Posting.aggregate([
  {$match:{journalId:{$in:journalIds},...scope}},
  {$lookup:{from:accounts.collection.name,localField:'accountId',foreignField:'_id',as:'ledgerAccount'}},
  {$unwind:'$ledgerAccount'},
  {$match:{'ledgerAccount.category':{$in:['income','expense']},
    $expr:{$and:[{$eq:['$ledgerAccount.branchId','$branchId']},{$eq:['$ledgerAccount.currency','$currency']}]}}},
  {$group:{_id:{journalId:'$journalId',currency:'$currency',category:'$ledgerAccount.category',side:'$side'},amount:{$sum:'$amountMinor'}}}
 ]).option({maxTimeMS:3500});
 const result=new Map();
 for(const row of postings){
  const moduleKey=journalModules.get(String(row._id.journalId)),currency=row._id.currency;
  if(!MODULES.includes(moduleKey)||!currencyCodes.includes(currency))continue;
  if(!result.has(moduleKey))result.set(moduleKey,{income:new Map(),expenses:new Map()});
  const category=row._id.category,map=result.get(moduleKey)[category==='income'?'income':'expenses'];
  const positive=category==='income'?row._id.side==='credit':row._id.side==='debit';
  const delta=BigInt(String(row.amount))*(positive?1n:-1n);
  map.set(currency,(map.get(currency)||0n)+delta);
 }
 return [...result].sort(([a],[b])=>a.localeCompare(b)).map(([moduleKey,row])=>{
  const net=new Map(row.income);
  for(const [currency,amount] of row.expenses)net.set(currency,(net.get(currency)||0n)-amount);
  return {moduleKey,income:rowsOf(row.income),expenses:rowsOf(row.expenses),net:rowsOf(net)};
 });
}
// Module pages always report their operating branch, not a silent tenant-wide
// mixture of branches or currencies. A failed optional summary must not block
// record entry or successful customer transactions.
async function moduleOverview(conn,tenant,user,branch){
 try{
  return await overview(conn,tenant,user,{
   operationBranch:branch,timeZone:businessTime.forBranch(branch)
  });
 }catch(error){
  console.warn(JSON.stringify({event:'finance.module_overview_unavailable',code:String(error.code||error.name||'UNKNOWN').slice(0,80)}));
  return {available:false,reason:'Financial overview temporarily unavailable; core transactions remain available'};
 }
}
module.exports={ASSET_KINDS,MODULES,groupMoney,rowsOf,branchScope,postedEarnings,postedEarningsByModule,overview,moduleOverview};
