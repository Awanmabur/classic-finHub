'use strict';
// The approved overview renders recent activity, today's posted volumes and
// cash. Full reports and review queues are built on their own pages only.
const {hasModuleForUser,hasPermission}=require('./moduleAccess.service');
const snapshot=require('./workspaceSnapshot.service');
const businessTime=require('../../utils/businessTime');
const branchCurrency=require('./branchCurrency.service');
// Never add currencies together or use today transaction volume as a balance.
// Only real funds books with approved openings contribute to these totals.
function groupedBookTotals(accounts=[]){
 const groups=new Map();
 for(const account of accounts){
  if(!account||account.expectedMinor===null||account.expectedMinor===undefined||!/^-?\d+$/.test(String(account.expectedMinor)))continue;
  const currency=String(account.currency||'');
  if(!['UGX','USD','SSP','KES'].includes(currency))continue;
  groups.set(currency,(groups.get(currency)||0n)+BigInt(account.expectedMinor));
 }
 const format=require('./mobileMoney.service').formatMoneyMinor;
 return [...groups].sort(([a],[b])=>a.localeCompare(b)).map(([currency,minor])=>({currency,formatted:format(minor,currency)}));
}
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
 if(!branch)return {modules:[],drawers:[]};
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
  return {modules,drawers:accounts.filter(account=>account.kind==='cash')};
 }catch(error){
  console.warn(JSON.stringify({event:'dashboard.configuration_unavailable',code:String(error.code||error.name||'UNKNOWN').slice(0,80)}));
  return {modules:[],drawers:[]};
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
  hasMobileMoney&&fundsBranch?require('./mobileMoneyFunds.service').context(conn,tenant,user,fundsBranch):null,
  operatingConfiguration(conn,tenant,user,options.operationBranch),
  differentView?operatingConfiguration(conn,tenant,user,fundsBranch):null
 ]);
 const marketService=require('./mobileMoneyMarket.service');
 const mobileMarkets=marketService.markets(mobileFunds?.wallets||[]);
 const mobileMarket=mobileMarkets[0]||null;
 // Use the provider's actual currency in Mobile Money, independently of the
 // currency selected for unrelated Money Transfer, Banking and Forex cards.
 const overviewOptions={...options,mobileMarket,totalsCurrency:options.currency,cashDayCurrency:options.currency||options.operationBranch?.currency,
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
 // The first configured Mobile Money market is the default viewing currency
 // even when this tenant also subscribes to Money Transfer or other modules.
 // An explicit user-selected dashboard currency still wins for those modules;
 // MoMo volume remains independently scoped to its network currency.
 if(mobileMarket&&!options.currency)
  overviewOptions.currency=mobileMarket.currency;
 const [workspaceSnapshot,financeOverview]=await Promise.all([
  snapshot.snapshot(conn,tenant,user,flags,options.operationBranch,overviewOptions),
  require('./financeOverview.service').overview(conn,tenant,user,{
   ...overviewOptions,operationBranch:options.operationBranch,viewBranch:options.viewBranch,scopeToAssignedModules:true
  }).catch(error=>{
   console.warn(JSON.stringify({event:'finance.overview_unavailable',errorCode:String(error.code||error.name||'UNKNOWN').slice(0,80)}));
   return {available:false,reason:'Financial totals temporarily unavailable. Check Treasury and reports.'};
  })
 ]);
 // Use all authorized accounts, not merely the first Mobile Money market.
 // Deduplicate physical cash drawers shared by several provider wallets.
 const uniqueById=accounts=>[...new Map((accounts||[]).filter(Boolean).map(a=>[String(a.id),a])).values()];
 const displayWallets=uniqueById(mobileFunds?.wallets);
 const displayCash=uniqueById((mobileFunds?.paymentAccounts||[]).filter(a=>a.kind==='cash'));
 const {requiresMapping:cashMappingRequired}=marketService.cashForMarket(mobileFunds||{},mobileMarket);
 const mobileBookTotals={cash:groupedBookTotals(displayCash),float:groupedBookTotals(displayWallets)};
 const moduleActivity={mobile_money:mobileRows,money_transfer:transferRows,banking:bankingRows,forex:forexRows};
 const configuredInView=(viewedConfiguration||configuration).modules;
 const visibleDashboardModules=Object.keys(moduleFlags).filter(key=>flags[moduleFlags[key]]&&
  (configuredInView.includes(key)||moduleActivity[key].length||(workspaceSnapshot.todayByCurrency?.[key]||[]).length));
 const cashDay=workspaceSnapshot.cashDay;
 const dashboardCashAvailable=Boolean(cashDay&&(cashDay.status||
  configuration.drawers.some(drawer=>drawer.currency===cashDay.currency)));
 const data={...flags,financeOverview,mobileFunds,mobileMarkets,mobileMarket,cashMappingRequired,
  visibleDashboardModules,dashboardTransactionModules:configuration.modules,dashboardCashAvailable,
  dashboardCurrency:typeof options.currency==='string'?options.currency:'',
  mobileDisplayCashIds:displayCash.map(a=>a.id),mobileBookTotals,mobileFundsState:!hasMobileMoney?'unavailable':wideRead&&options.viewBranchId==='all'?'all_branches':fundsBranch?'resolved':'branch_required',summary:{recent:mobileRows},bankingRecords:{items:bankingRows},forexRecords:{items:forexRows},transferRecords:{items:transferRows}};
 return {...data,workspaceSnapshot:{...workspaceSnapshot,...snapshot.activity(data)}};
}
module.exports={overview,mobileScope,groupedBookTotals,configuredModules};
