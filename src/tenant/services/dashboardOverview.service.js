'use strict';
// The approved overview renders recent activity, today's posted volumes and
// cash. Full reports and review queues are built on their own pages only.
const {hasModuleForUser,hasPermission}=require('./moduleAccess.service');
const snapshot=require('./workspaceSnapshot.service');
const businessTime=require('../../utils/businessTime');
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
 const [mobileRows,bankingRows,forexRows,transferRows,mobileFunds]=await Promise.all([
  hasMobileMoney?require('./mobileMoney.service').recent(conn,mobileScope(user)):[],
  hasBanking?require('./banking.service').recent(conn,tenant,user):[],
  hasForex?require('./forex.service').recent(conn,tenant,user):[],
  hasTransfer?require('./moneyTransfer.service').recent(conn,tenant,user):[],
  hasMobileMoney&&fundsBranch?require('./mobileMoneyFunds.service').context(conn,tenant,user,fundsBranch):null
 ]);
 const marketService=require('./mobileMoneyMarket.service');
 const mobileMarkets=marketService.markets(mobileFunds?.wallets||[]);
 const mobileMarket=mobileMarkets[0]||null;
 // Use the provider's actual currency in Mobile Money, independently of the
 // currency selected for unrelated Money Transfer, Banking and Forex cards.
 const overviewOptions={...options,mobileMarket,cashDayCurrency:options.currency||options.operationBranch?.currency,
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
   ...overviewOptions,operationBranch:options.operationBranch,viewBranch:options.viewBranch
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
 const data={...flags,financeOverview,mobileFunds,mobileMarkets,mobileMarket,cashMappingRequired,
  dashboardCurrency:typeof options.currency==='string'?options.currency:'',
  mobileDisplayCashIds:displayCash.map(a=>a.id),mobileBookTotals,mobileFundsState:!hasMobileMoney?'unavailable':wideRead&&options.viewBranchId==='all'?'all_branches':fundsBranch?'resolved':'branch_required',summary:{recent:mobileRows},bankingRecords:{items:bankingRows},forexRecords:{items:forexRows},transferRecords:{items:transferRows}};
 return {...data,workspaceSnapshot:{...workspaceSnapshot,...snapshot.activity(data)}};
}
module.exports={overview,mobileScope,groupedBookTotals};
