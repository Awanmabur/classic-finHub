'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {entitledTenant}=require('./helpers/entitlement');
const {overview}=require('../src/tenant/services/dashboardOverview.service');
const snapshots=require('../src/tenant/services/workspaceSnapshot.service');
const branch='507f1f77bcf86cd799439011',account='507f1f77bcf86cd799439012';
function query(rows,calls){return filter=>{const call={filter};calls.push(call);return{select(fields){call.fields=fields;return this;},sort(order){call.order=order;return this;},limit(count){call.limit=count;return this;},lean:async()=>rows};};}
test('overview reads bounded recent rows without building reports, summaries or review queues',async t=>{
 const tenant=entitledTenant({plan:'enterprise'}),actor={id:account,role:'Tenant Owner',permissions:['*'],branchId:branch,viewBranchId:branch};
 const calls=[],conn={models:Object.fromEntries(['SecureMobileTransaction','BankingRequestV1','ForexQuoteV1','TransferOrderV1'].map(name=>[name,{find:query([],calls)}]))};
 t.mock.method(snapshots,'snapshot',async()=>({todayVolumes:{money_transfer:{amountMinor:'123',formatted:'UGX 123'}},cash:[{currency:'UGX',expectedFormatted:'UGX 50'}]}));
 t.mock.method(require('../src/tenant/services/mobileMoneyFunds.service'),'context',async()=>({wallets:[{name:'MTN Uganda wallet',kind:'wallet',network:'MTN',currency:'UGX',expected:'UGX 200,000'}],paymentAccounts:[{name:'Agent drawer',kind:'cash',currency:'UGX',expected:'UGX 50,000'}],customerAccounts:[]}));
 for(const [name,method]of[['mobileMoney.service','getSummary'],['banking.service','list'],['forex.service','listQuotes'],['moneyTransfer.service','list'],['approvals.service','list'],['operationsReports.service','generate']])t.mock.method(require('../src/tenant/services/'+name),method,()=>assert.fail('Unrendered data must not block overview'));
 const data=await overview(conn,tenant,actor,{operationBranch:{_id:branch,currency:'UGX'}});
 assert.equal(calls.length,4);assert(calls.every(call=>call.limit===14&&call.fields&&call.order.createdAt===-1));
 assert.equal(data.workspaceSnapshot.todayVolumes.money_transfer.amountMinor,'123');assert.equal(data.workspaceSnapshot.cash[0].expectedFormatted,'UGX 50');
 assert.equal(data.workspaceSnapshot.recentActivity.length,0);
 assert.equal(data.mobileFunds.wallets[0].expected,'UGX 200,000');
 assert.equal(data.mobileFunds.paymentAccounts[0].expected,'UGX 50,000');
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
