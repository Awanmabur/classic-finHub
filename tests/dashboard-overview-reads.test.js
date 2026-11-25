'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {entitledTenant}=require('./helpers/entitlement');
const {overview}=require('../src/tenant/services/dashboardOverview.service');
const snapshots=require('../src/tenant/services/workspaceSnapshot.service');
const branch='507f1f77bcf86cd799439011',account='507f1f77bcf86cd799439012';
function query(rows,calls){return filter=>{const call={filter};calls.push(call);return{select(fields){call.fields=fields;return this;},sort(order){call.order=order;return this;},limit(count){call.limit=count;return this;},maxTimeMS(){return this;},lean:async()=>typeof rows==='function'?rows(filter):rows};};}
function stubEmptyFunds(t){
 t.mock.method(require('../src/tenant/treasury/models'),'models',()=>({account:{find:query([],[])}}));
 t.mock.method(require('../src/tenant/services/financeOverview.service'),'overview',async()=>({available:false}));
}
test('overview reads bounded recent rows without building reports, summaries or review queues',async t=>{
 const tenant=entitledTenant({plan:'enterprise'}),actor={id:account,role:'Tenant Owner',permissions:['*'],branchId:branch,viewBranchId:branch};
 const calls=[],conn={models:Object.fromEntries(['SecureMobileTransaction','BankingRequestV1','ForexQuoteV1','TransferOrderV1'].map(name=>[name,{find:query([],calls)}]))};
 stubEmptyFunds(t);
 t.mock.method(snapshots,'snapshot',async()=>({todayTransactionCount:1,notificationUnread:0}));
 t.mock.method(require('../src/tenant/services/mobileMoneyFunds.service'),'context',async(_conn,_tenant,_actor,_branch,options)=>{
  assert.deepEqual(options,{booksOnly:true});
  return {wallets:[{network:'MTN',currency:'UGX',expectedMinor:'200000'}],
   paymentAccounts:[{currency:'UGX',expectedMinor:'50000'}]};
 });
 for(const [name,method]of[['mobileMoney.service','getSummary'],['banking.service','list'],['forex.service','listQuotes'],['moneyTransfer.service','list'],['approvals.service','list'],['operationsReports.service','generate']])t.mock.method(require('../src/tenant/services/'+name),method,()=>assert.fail('Unrendered data must not block overview'));
 const data=await overview(conn,tenant,actor,{operationBranch:{_id:branch,currency:'UGX'}});
 assert.equal(calls.length,4);assert(calls.every(call=>call.limit===14&&call.fields&&call.order.createdAt===-1));
 assert.equal(data.workspaceSnapshot.todayTransactionCount,1);
 assert.equal(data.workspaceSnapshot.recentActivity.length,0);
 assert.equal(data.mobileBookTotals.float[0].formatted,'UGX 200,000');
 assert.equal(data.mobileBookTotals.cash[0].formatted,'UGX 50,000');
});
test('transfer recent activity preserves incoming paid transfer scope and minimizes party fields',async()=>{
 const calls=[],conn={models:{TransferOrderV1:{find:query([],calls)}}},tenant=entitledTenant({plan:'enterprise'}),actor={id:account,role:'Money Transfer Operator',permissions:['money_transfer.view'],allowedModules:['money_transfer'],branchId:branch};
 await require('../src/tenant/services/moneyTransfer.service').recent(conn,tenant,actor);
 const filter=calls[0].filter;assert.equal(filter.$or[0].branchId,branch);assert.equal(filter.$or[0].createdBy,account);
 assert.equal(filter.$or[1].destinationBranchId,branch);assert.deepEqual(filter.$or[1].status.$in,['collected_manual','paid_out_manual']);
 assert(!calls[0].fields.includes('phone'));assert(!calls[0].fields.includes('sender'));
 await assert.rejects(require('../src/tenant/services/moneyTransfer.service').recent(conn,{...tenant,enabledModules:[],subscription:null},actor),error=>error.status===403);
});

test('main dashboard fund totals add only approved real book values within each currency',()=>{
 const {groupedBookTotals}=require('../src/tenant/services/dashboardOverview.service');
 const {formatMoneyMinor}=require('../src/tenant/services/mobileMoney.service');
 const amounts=groupedBookTotals([
  {kind:'cash',currency:'UGX',expectedMinor:'120000'},
  {kind:'cash',currency:'UGX',expectedMinor:'25000'},
  {kind:'cash',currency:'SSP',expectedMinor:'7500'},
  {kind:'cash',currency:'UGX',expectedMinor:null},
  {kind:'cash',currency:'UGX',expectedMinor:'not_approved'},
  {kind:'cash',currency:'EUR',expectedMinor:'800'}
 ]);
 assert.equal(amounts.length,2,'separate currency groups, never a misleading combined amount');
 assert.deepEqual(amounts.find(a=>a.currency==='UGX'),{currency:'UGX',formatted:formatMoneyMinor(145000n,'UGX')});
 assert.deepEqual(amounts.find(a=>a.currency==='SSP'),{currency:'SSP',formatted:formatMoneyMinor(7500n,'SSP')});
 assert.deepEqual(groupedBookTotals([{currency:'UGX',expectedMinor:null}]),[]);
});

test('owner cash and float cards follow selected viewing branch; all-branch view never mislabels operating branch totals',async t=>{
 const tenant=entitledTenant({plan:'enterprise'});
 const owner={id:account,role:'Tenant Owner',permissions:['*'],branchId:branch};
 const second={_id:'507f1f77bcf86cd799439088',currency:'SSP',currencies:['SSP']};
 const operation={_id:branch,currency:'UGX'};
 const calls=[],conn={models:Object.fromEntries(['SecureMobileTransaction','BankingRequestV1','ForexQuoteV1','TransferOrderV1'].map(name=>[name,{find:query([],calls)}]))};
 stubEmptyFunds(t);
 t.mock.method(snapshots,'snapshot',async()=>({todayByCurrency:{}}));
 let resolved=null;
 t.mock.method(require('../src/tenant/services/mobileMoneyFunds.service'),'context',async(_conn,_tenant,_user,chosen)=>{resolved=chosen;return {wallets:[],paymentAccounts:[]};});
 const selected=await overview(conn,tenant,owner,{operationBranch:operation,viewBranchId:String(second._id),viewBranch:second});
 assert.equal(resolved,second);
 assert.deepEqual(selected.mobileBookTotals,{cash:[],float:[]});
 resolved=null;
 const all=await overview(conn,tenant,owner,{operationBranch:operation,viewBranchId:'all',viewBranch:null});
 assert.equal(resolved,null,'all-branch view must not silently use the operating branch');
 assert.deepEqual(all.mobileBookTotals,{cash:[],float:[]});
});

test('dashboard statistics use the viewed branch setup while transaction choices use the operating branch',async t=>{
 const tenant=entitledTenant({plan:'enterprise',enabledModules:['mobile_money','forex','banking','money_transfer']});
 const other='507f1f77bcf86cd799439088';
 const owner={id:account,role:'Tenant Owner',permissions:['*'],branchId:branch,viewBranchId:other};
 const budget=[],configReads=[],conn={models:Object.fromEntries(['SecureMobileTransaction','BankingRequestV1','ForexQuoteV1','TransferOrderV1'].map(name=>[name,{find:query([],budget)}]))};
 const row=(kind,moduleKey,currency,extra={})=>({kind,moduleKey,currency,status:'active',reconciliationState:'matched',...extra});
 t.mock.method(require('../src/tenant/treasury/models'),'models',()=>({account:{find:query(filter=>String(filter.branchId)===other?
  [row('bank','shared','UGX'),row('forex_stock','forex','USD')]:
  [row('wallet','mobile_money','UGX'),row('cash','shared','UGX',{operatorId:account})],configReads)}}));
 t.mock.method(require('../src/tenant/services/mobileMoneyFunds.service'),'context',async()=>({wallets:[],paymentAccounts:[]}));
 t.mock.method(require('../src/tenant/services/financeOverview.service'),'overview',async()=>({available:false}));
 t.mock.method(snapshots,'snapshot',async()=>({todayByCurrency:{}}));
 const data=await overview(conn,tenant,owner,{operationBranch:{_id:branch,currency:'UGX'},viewBranchId:other,viewBranch:{_id:other,currency:'USD'}});
 assert.deepEqual(data.dashboardTransactionModules,['mobile_money']);
 assert.deepEqual(data.visibleDashboardModules,['forex']);
 assert.equal(configReads.length,2);
});

test('a configured cross-currency Mobile Money pair works without a standalone Forex assignment',()=>{
 const {configuredModules}=require('../src/tenant/services/dashboardOverview.service');
 const accounts=[{kind:'wallet',currency:'UGX'},{kind:'cash',currency:'SSP'}];
 assert.deepEqual(configuredModules(accounts,[],{mobile_money:true},{crossCurrencyMobileMoney:true}),['mobile_money']);
 assert.deepEqual(configuredModules(accounts,[],{mobile_money:true},{crossCurrencyMobileMoney:false}),[]);
});
