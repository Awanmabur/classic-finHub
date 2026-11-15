'use strict';
// The approved overview renders recent activity, today's posted volumes and
// cash. Full reports and review queues are built on their own pages only.
const {hasModuleForUser,hasPermission}=require('./moduleAccess.service');
const snapshot=require('./workspaceSnapshot.service');
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
 const [mobileRows,bankingRows,forexRows,transferRows,workspaceSnapshot,mobileFunds]=await Promise.all([
  hasMobileMoney?require('./mobileMoney.service').recent(conn,mobileScope(user)):[],
  hasBanking?require('./banking.service').recent(conn,tenant,user):[],
  hasForex?require('./forex.service').recent(conn,tenant,user):[],
  hasTransfer?require('./moneyTransfer.service').recent(conn,tenant,user):[],
  snapshot.snapshot(conn,tenant,user,flags,options.operationBranch,options),
  hasMobileMoney&&options.operationBranch?require('./mobileMoneyFunds.service').context(conn,tenant,user,options.operationBranch):null
 ]);
 const mobileBookTotals={cash:groupedBookTotals((mobileFunds?.paymentAccounts||[]).filter(a=>a.kind==='cash')),float:groupedBookTotals(mobileFunds?.wallets||[])};
 const data={...flags,mobileFunds,mobileBookTotals,mobileFundsState:!hasMobileMoney?'unavailable':options.operationBranch?'resolved':'branch_required',summary:{recent:mobileRows},bankingRecords:{items:bankingRows},forexRecords:{items:forexRows},transferRecords:{items:transferRows}};
 return {...data,workspaceSnapshot:{...workspaceSnapshot,...snapshot.activity(data)}};
}
module.exports={overview,mobileScope,groupedBookTotals};
