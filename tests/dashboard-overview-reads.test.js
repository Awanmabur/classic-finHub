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
 for(const [name,method]of[['mobileMoney.service','getSummary'],['banking.service','list'],['forex.service','listQuotes'],['moneyTransfer.service','list'],['approvals.service','list'],['operationsReports.service','generate']])t.mock.method(require('../src/tenant/services/'+name),method,()=>assert.fail('Unrendered data must not block overview'));
 const data=await overview(conn,tenant,actor,{operationBranch:{_id:branch,currency:'UGX'}});
 assert.equal(calls.length,4);assert(calls.every(call=>call.limit===14&&call.fields&&call.order.createdAt===-1));
 assert.equal(data.workspaceSnapshot.todayVolumes.money_transfer.amountMinor,'123');assert.equal(data.workspaceSnapshot.cash[0].expectedFormatted,'UGX 50');
 assert.equal(data.workspaceSnapshot.recentActivity.length,0);
});
test('transfer recent activity preserves incoming paid transfer scope and minimizes party fields',async()=>{
 const calls=[],conn={models:{TransferOrderV1:{find:query([],calls)}}},tenant=entitledTenant({plan:'enterprise'}),actor={id:account,role:'Money Transfer Operator',permissions:['money_transfer.view'],allowedModules:['money_transfer'],branchId:branch};
 await require('../src/tenant/services/moneyTransfer.service').recent(conn,tenant,actor);
 const filter=calls[0].filter;assert.equal(filter.$or[0].branchId,branch);assert.equal(filter.$or[0].createdBy,account);
 assert.equal(filter.$or[1].destinationBranchId,branch);assert.deepEqual(filter.$or[1].status.$in,['collected_manual','paid_out_manual']);
 assert(!calls[0].fields.includes('phone'));assert(!calls[0].fields.includes('sender'));
 await assert.rejects(require('../src/tenant/services/moneyTransfer.service').recent(conn,{...tenant,enabledModules:[],subscription:null},actor),error=>error.status===403);
});
