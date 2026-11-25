'use strict';
// The dashboard reads recent activity and compact native-currency totals.
const {hasModuleForUser,hasPermission}=require('./moduleAccess.service');
const snapshot=require('./workspaceSnapshot.service');
const businessTime=require('../../utils/businessTime');
const branchCurrency=require('./branchCurrency.service');
function mobileScope(user){
 if(['Tenant Owner','Auditor'].includes(user.role))return require('./branchView.service').readScope(user);
 return {...(user.role==='Mobile Money Operator'?{operatorId:user.id}:{}),...(user.branchId?{branchId:user.branchId}:{})};
}
const moduleFlags={mobile_money:'hasMobileMoney',money_transfer:'hasTransfer',banking:'hasBanking',forex:'hasForex'};
const paymentKinds=['cash','bank','wallet'];
function configuredModules(accounts,customerCurrencies,enabled,{crossCurrencyMobileMoney=process.env.CLASSICFIN_MOMO_FX_POSTING_ENABLED==='true'}={}){
 const payments=accounts.filter(account=>paymentKinds.includes(account.kind));
 const clearing=accounts.filter(account=>account.kind==='transfer_clearing');
 const stock=accounts.filter(account=>account.kind==='forex_stock');
 const wallets=accounts.filter(account=>account.kind==='wallet');
 const payable=currency=>payments.some(account=>account.currency===currency);
 const canBank=customerCurrencies.some(payable)||(enabled.forex&&customerCurrencies.length>1);
 return Object.entries({
  mobile_money:wallets.some(wallet=>payments.some(payment=>
   payment.kind!=='wallet'&&(payment.currency===wallet.currency||crossCurrencyMobileMoney&&payment.kind==='cash'))),
  money_transfer:clearing.some(account=>payable(account.currency)),
  banking:canBank,
  forex:stock.some(account=>payments.some(payment=>payment.currency!==account.currency)),
  expenses:payments.length>0
 }).filter(([key,configured])=>configured&&enabled[key]).map(([key])=>key);
}
async function operatingConfiguration(conn,tenant,user,branch){
 if(!branch)return [];
 const enabled=Object.fromEntries([...Object.keys(moduleFlags),'expenses','customers','accounts'].map(key=>
  [key,hasModuleForUser(tenant,user,key)&&hasPermission(user,key+'.view')]));
 try{
  const directory=require('../customerAccounts/models');
  const scope={branchId:branch._id,status:'active'};
  const currenciesInBranch=branchCurrency.supported(branch);
  const [rows,currencies,customer]=await Promise.all([
   hasPermission(user,'treasury.view')?require('../treasury/models').models(conn).account.find({
    tenantId:tenant._id,branchId:branch._id,operatorId:{$in:[null,user.id]},
    currency:{$in:currenciesInBranch},status:{$in:['active','held']},
    openingApprovedAt:{$ne:null},openingBalanceMinor:{$ne:null}
   }).select('kind moduleKey currency operatorId status reconciliationState').limit(1001).maxTimeMS(2000).lean():[],
   enabled.banking&&enabled.accounts?directory.accountModel(conn).distinct('currency',{
    ...scope,currency:{$in:currenciesInBranch},ledgerAccountId:{$type:'objectId'}
   }).maxTimeMS(2000):[],
   enabled.accounts?directory.customerModel(conn).exists(scope).maxTimeMS(2000):null
  ]);
  const accounts=rows.filter(account=>(account.moduleKey==='shared'||enabled[account.moduleKey])&&
   (account.kind!=='cash'||String(account.operatorId)===String(user.id)));
  const usable=accounts.filter(account=>account.status==='active'&&account.reconciliationState==='matched');
  const modules=configuredModules(usable,currencies,enabled);
  if(enabled.customers)modules.push('customers');
  if(enabled.accounts&&customer)modules.push('accounts');
  return modules;
 }catch(error){
  console.warn(JSON.stringify({event:'dashboard.configuration_unavailable',code:String(error.code||error.name||'UNKNOWN').slice(0,80)}));
  return [];
 }
}
async function overview(conn,tenant,user,options={}){
 const hasMobileMoney=hasModuleForUser(tenant,user,'mobile_money')&&hasPermission(user,'mobile_money.view');
 const hasTransfer=hasModuleForUser(tenant,user,'money_transfer')&&hasPermission(user,'money_transfer.view');
 const hasBanking=hasModuleForUser(tenant,user,'banking')&&hasPermission(user,'banking.view');
 const hasForex=hasModuleForUser(tenant,user,'forex')&&hasPermission(user,'forex.view');
 const flags={hasMobileMoney,hasTransfer,hasBanking,hasForex};
 // Owner/auditor viewing scope controls dashboard balance cards. An "all"
 // viewing scope must not silently display a single operating branch as if total.
 const wideRead=['Tenant Owner','Auditor'].includes(user.role)&&options.viewBranchId!==undefined&&options.viewBranchId!==null;
 const fundsBranch=wideRead?(options.viewBranchId==='all'?null:options.viewBranch||null):options.operationBranch;
 const differentView=Boolean(fundsBranch&&String(fundsBranch._id)!==String(options.operationBranch?._id));
 const [mobileRows,bankingRows,forexRows,transferRows,mobileFunds,configuration,viewedConfiguration]=await Promise.all([
  hasMobileMoney?require('./mobileMoney.service').recent(conn,mobileScope(user)):[],
  hasBanking?require('./banking.service').recent(conn,tenant,user):[],
  hasForex?require('./forex.service').recent(conn,tenant,user):[],
  hasTransfer?require('./moneyTransfer.service').recent(conn,tenant,user):[],
  hasMobileMoney&&fundsBranch?require('./mobileMoneyFunds.service').context(conn,tenant,user,fundsBranch,{booksOnly:true}):null,
  operatingConfiguration(conn,tenant,user,options.operationBranch),
  differentView?operatingConfiguration(conn,tenant,user,fundsBranch):null
 ]);
 const mobileMarkets=require('./mobileMoneyMarket.service').markets(mobileFunds?.wallets||[]);
 const overviewOptions={...options,
  timeZone:businessTime.forBranch(options.viewBranch||options.operationBranch)};
 if(options.viewBranchId==='all'){
  // The trusted branch-view middleware already resolved active branches.
  // Reuse its read-only list rather than making an extra database query.
  const zones=[...new Set((options.viewBranches||[]).map(branch=>businessTime.forBranch(branch)))];
  // No single local 'today' exists across branches in different timezones.
  // Keep the dashboard responsive, but never fabricate a comparable daily total.
  if(zones.length>1)overviewOptions.suppressTodayVolumes=true;
  else if(zones.length===1)overviewOptions.timeZone=zones[0];
 }
 const [workspaceSnapshot,financeOverview]=await Promise.all([
  snapshot.snapshot(conn,tenant,user,flags,options.operationBranch,overviewOptions),
  require('./financeOverview.service').overview(conn,tenant,user,{
   ...overviewOptions,scopeToAssignedModules:true,includeModuleDetails:false
  }).catch(error=>{
   console.warn(JSON.stringify({event:'finance.overview_unavailable',errorCode:String(error.code||error.name||'UNKNOWN').slice(0,80)}));
   return {available:false,reason:'Financial totals temporarily unavailable. Check Treasury and reports.'};
  })
 ]);
 const moduleActivity={mobile_money:mobileRows,money_transfer:transferRows,banking:bankingRows,forex:forexRows};
 const configuredInView=viewedConfiguration||configuration;
 const visibleDashboardModules=Object.keys(moduleFlags).filter(key=>flags[moduleFlags[key]]&&
  (configuredInView.includes(key)||moduleActivity[key].length||(workspaceSnapshot.todayByCurrency?.[key]||[]).length));
 const dashboardStatCurrencies=[...new Set([
  ...[...(mobileFunds?.paymentAccounts||[]),...(mobileFunds?.wallets||[])]
   .filter(account=>account.expectedMinor!=null).map(account=>account.currency),
  ...(financeOverview.bookAssets||[]).map(row=>row.currency),
  ...(financeOverview.postedNet||[]).map(row=>row.currency),
  ...(visibleDashboardModules.length&&fundsBranch?.currency?[fundsBranch.currency]:[])
 ])];
 const activity=snapshot.activity({...flags,summary:{recent:mobileRows},bankingRecords:{items:bankingRows},
  forexRecords:{items:forexRows},transferRecords:{items:transferRows}});
 return {...flags,financeOverview,mobileMarkets,mobileMarket:mobileMarkets[0]||null,dashboardStatCurrencies,
  visibleDashboardModules,dashboardTransactionModules:configuration,
  dashboardCurrency:typeof options.currency==='string'?options.currency:'',
  workspaceSnapshot:{...workspaceSnapshot,...activity}};
}
module.exports={overview,mobileScope,configuredModules};
