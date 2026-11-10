'use strict';
// The approved overview renders recent activity, today's posted volumes and
// cash. Full reports and review queues are built on their own pages only.
const {hasModuleForUser,hasPermission}=require('./moduleAccess.service');
const snapshot=require('./workspaceSnapshot.service');
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
 const [mobileRows,bankingRows,forexRows,transferRows,workspaceSnapshot]=await Promise.all([
  hasMobileMoney?require('./mobileMoney.service').recent(conn,mobileScope(user)):[],
  hasBanking?require('./banking.service').recent(conn,tenant,user):[],
  hasForex?require('./forex.service').recent(conn,tenant,user):[],
  hasTransfer?require('./moneyTransfer.service').recent(conn,tenant,user):[],
  snapshot.snapshot(conn,tenant,user,flags,options.operationBranch,options)
 ]);
 const data={...flags,summary:{recent:mobileRows},bankingRecords:{items:bankingRows},forexRecords:{items:forexRows},transferRecords:{items:transferRows}};
 return {...data,workspaceSnapshot:{...workspaceSnapshot,...snapshot.activity(data)}};
}
module.exports={overview,mobileScope};
