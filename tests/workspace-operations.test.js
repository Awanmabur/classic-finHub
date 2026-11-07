'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const operations=require('../src/tenant/workspace/operations');
const commerce=require('../src/platform/services/commercial.service');
const {permissionsFor}=require('../src/config/roles');
const id=n=>n.toString(16).padStart(24,'0');
function fixture(){
 const modules=['money_transfer'];
 const terms=commerce.planSnapshot({...commerce.asPlanVersion({...require('../src/data/store').plans.find(plan=>plan.code==='enterprise'),code:'workspace_test',modules}),status:'published'});
 const tenant={status:'active',plan:terms.planCode,enabledModules:modules,subscription:{...terms,status:'granted',generation:1,periodStart:new Date(Date.now()-60000),periodEnd:new Date(Date.now()+86400000)}};
 const actor={id:id(1),role:'Tenant Owner',permissions:['*'],viewBranchId:id(10)};
 const allBranches=[{_id:id(10),name:'Main',currency:'UGX'},{_id:id(11),name:'East',currency:'UGX'}];
 const people=[{_id:actor.id,role:'Tenant Owner',branchId:id(10),mfaEnabledAt:new Date()},{_id:id(2),role:'Money Transfer Operator',branchId:id(10),allowedModules:modules},{_id:id(3),role:'Branch Manager',branchId:id(10),allowedModules:modules,mfaEnabledAt:new Date()}];
 const account=(n,kind,operatorId=null)=>({_id:id(n),branchId:id(10),kind,moduleKey:kind==='transfer_clearing'?'money_transfer':'shared',currency:'UGX',operatorId,status:'active',openingBalanceMinor:'1000',openingApprovedAt:new Date(),reconciliationState:'matched'});
 const accounts=[account(20,'cash',id(2)),account(21,'transfer_clearing'),account(22,'bank')];
 const shifts=[{branchId:id(10),operatorId:id(2),status:'open',openingVerifiedAt:new Date(),treasuryAccountId:id(20)}];
 return {tenant,actor,allBranches,people,accounts,shifts};
}
test('a new workspace reports missing real setup rather than manufactured readiness',()=>{
 const input=fixture(),report=operations.build({...input,allBranches:[],people:input.people.slice(0,1),accounts:[],shifts:[]});
 assert.equal(report.state,'blocked');assert.equal(report.branches,0);assert(report.checks.some(row=>row.id==='branches'&&row.state==='blocked'));assert.equal(report.funds.ready,0);assert.equal(report.waiting,0);
});
test('reviewed transfer funds and own verified cash shift complete setup without saved contacts',()=>{
 const report=operations.build(fixture());
 assert.equal(report.state,'ready');assert.equal(report.label,'Setup checks complete');assert.equal(report.modules[0].operators,1,'owner wildcard alone does not turn an administrator into a daily teller');assert.equal(report.modules[0].preparedOperators,1);assert.equal(report.cash.verified,1);
});
test('transfer collection accounts alone do not imply the teller can pay out cash',()=>{
 for(const change of [input=>{input.shifts=[];},input=>{input.accounts[0].operatorId=null;},input=>{input.accounts[1].operatorId=id(2);},input=>{input.accounts.forEach(account=>{account.currency='USD';});},input=>{input.accounts[0].status='held';}]){
  const input=fixture();change(input);const report=operations.build(input);assert.equal(report.state,'blocked');assert.equal(report.modules[0].preparedOperators,0);
 }
});
test('tenant read view narrows every module and queue snapshot without changing operating assignments',()=>{
 const input=fixture();assert.equal(operations.build(input).modules.length,1);
 const all=operations.build({...input,actor:{...input.actor,viewBranchId:'all'}});assert.equal(all.modules.length,2);assert.equal(all.state,'blocked');assert(all.modules.some(row=>row.branch==='East'&&row.state==='blocked'));
 const selected=operations.build(input);assert.equal(selected.state,'ready');assert.equal(selected.scope,'Main');assert.equal(input.people[1].branchId,id(10));
 const noLicense=operations.build({...input,tenant:{...input.tenant,enabledModules:[]}});assert.equal(noLicense.modules.length,0);assert.equal(noLicense.queues.length,0);assert.equal(noLicense.sms,null);assert.equal(noLicense.state,'blocked');
});
test('real pending work and unknown openings produce attention with a working next action',()=>{
 const input=fixture(),pending=operations.build({...input,queueCounts:{money_transfer:2},queueLinks:{money_transfer:'/tenant/funded/'+id(40)}});
 assert.equal(pending.state,'attention');assert.equal(pending.waiting,2);assert.equal(pending.queues.find(row=>row.id==='money_transfer').href,'/tenant/funded/'+id(40));
 const unknown=operations.build({...input,accounts:[...input.accounts,{_id:id(30),branchId:id(10),kind:'bank',moduleKey:'shared',currency:'USD',status:'uninitialized',openingBalanceMinor:null,reconciliationState:'unknown'}]});
 assert.equal(unknown.state,'attention');assert.equal(unknown.funds.unknown,1);assert.equal(unknown.next.href,'/tenant/treasury');
});
test('automatic account resolution accepts a sole choice and flags ambiguous groups per operator',()=>{
 const input=fixture(),one=input.accounts.filter(account=>account.kind==='bank');assert.equal(operations.defaultIssues(one,input.people.slice(1,2),input.tenant),0);
 const two=[...one,{...one[0],_id:id(99)}];assert.equal(operations.defaultIssues(two,input.people.slice(1,2),input.tenant),1);two[0].selectionKey='default';assert.equal(operations.defaultIssues(two,input.people.slice(1,2),input.tenant),0);
});
test('banking setup needs a real internal customer liability account and access, not only funds',()=>{
 const input=fixture();input.tenant.enabledModules.push('banking','accounts');input.tenant.subscription.modules.push('banking','accounts');input.people[1]={...input.people[1],role:'Banking Operator',allowedModules:['banking','accounts']};input.people[2].allowedModules.push('banking','accounts');input.actor.permissions=permissionsFor('Tenant Owner');
 const noAccount=operations.build(input).modules.find(row=>row.key==='banking');assert.equal(noAccount.state,'blocked');assert(noAccount.problems.some(problem=>problem.includes('internal customer account')));
 const configured=operations.build({...input,customerAccounts:[{branchId:id(10),currency:'UGX'}]}).modules.find(row=>row.key==='banking');assert.equal(configured.state,'ready');
});
