'use strict';
// Read-only financial overview. This deliberately distinguishes recorded cash/
// float/assets from paid-in capital, and posted net income from FX trading P&L.
// No foreign currencies are summed or translated without a cost basis.
const {Types}=require('mongoose');
const models=require('../models');
const {models:fundsModels}=require('../treasury/models');
const {currencyCodes}=require('../../config/currencies');
const {hasPermission}=require('./moduleAccess.service');
const businessTime=require('../../utils/businessTime');
const format=require('./mobileMoney.service').formatMoneyMinor;
const OID=/^[a-f0-9]{24}$/i;
const ASSET_KINDS=['cash','wallet','bank','forex_stock'];
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
 return {branchId:new Types.ObjectId(String(branch))};
}
async function overview(conn,tenant,user,options={}){
 // Confidential capital and earnings cannot leak through dashboards to staff
 // lacking Treasury/financial permissions.
 if(!hasPermission(user,'treasury.view'))return {available:false,reason:'Treasury access required'};
 const scope=branchScope(user,options);
 if(scope===null)return {available:false,reason:'Choose an operating branch'};
 const Account=fundsModels(conn).account;
 const [assets,recognized]=await Promise.all([
  Account.find({tenantId:tenant._id,...scope,kind:{$in:ASSET_KINDS},
   status:{$in:['active','held']},openingBalanceMinor:{$ne:null}})
   .select('currency kind moduleKey bookBalanceMinor').limit(1000).lean(),
  postedEarnings(conn,scope,options)
 ]);
 const assetMap=groupMoney(assets,'bookBalanceMinor');
 const byModule=new Map();
 for(const account of assets){
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
  // Never present spread or operating assets as realized profit/capital funding.
  forexProfit:{available:false,reason:'Cannot calculate realized Forex profit until purchase cost basis and disposal lots are recorded'},
  capitalDefinition:'Operating cash, float, bank and Forex stock book assets; not invested owner equity or verified provider balances',
  profitDefinition:'Posted net income (recognized income less posted expenses), excluding unmeasured Forex trading spread',
  mixedRegion:Boolean(options.suppressTodayVolumes)};
}
async function postedEarnings(conn,scope,options={}){
 const result={income:[],expenses:[],net:[]};
 if(options.suppressTodayVolumes)return result;
 const startEnd=businessTime.dayBounds({},options.timeZone||'UTC',90,options.now||new Date());
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
module.exports={ASSET_KINDS,groupMoney,rowsOf,branchScope,postedEarnings,overview};
