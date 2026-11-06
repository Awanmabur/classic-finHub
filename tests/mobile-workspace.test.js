'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {Types}=require('mongoose');
const workspace=require('../src/tenant/services/mobileMoneyWorkspace.service');
const mobile=require('../src/tenant/services/mobileMoney.service');
const {permissionsFor}=require('../src/config/roles');
const actor={id:String(new Types.ObjectId()),branchId:String(new Types.ObjectId()),role:'Mobile Money Operator'};
test('workspace filters reject query objects, unknown sources and invalid dates',()=>{
 for(const input of [{network:{$ne:'MTN'}},{currency:['UGX']},{operation:'transfer'},{entrySource:'provider'},
  {from:'2026-02-30',to:'2026-03-01'},{from:'2026-01-01',to:'2026-12-01'}])assert.throws(()=>workspace.filters(input),{status:400});
 assert.equal(workspace.filters({operation:'cash_out'},'cash_in').operation,'cash_in');
 assert.equal(workspace.filters({network:'Africell'}).network,'Africell');
 const scoped=workspace.readScope(actor);assert.equal(String(scoped.branchId),actor.branchId);assert.equal(String(scoped.operatorId),actor.id);
 assert.deepEqual(workspace.readScope({...actor,role:'Tenant Owner'}),{});
 assert.equal(String(workspace.readScope({...actor,role:'Viewer',branchId:null}).operatorId),actor.id);
 assert.throws(()=>workspace.readScope({...actor,branchId:'forged'}),{status:403});
});
test('currency-safe exact aggregates separate noncash methods, voids and physical cash signs',()=>{
 const group=(currency,operation,amount,paymentMethod='Cash',voided=false)=>({_id:{currency,network:'MTN',operation,paymentMethod,voided,source:'manual'},count:1,amountMinor:amount,feeMinor:'1'});
 const result=workspace.summarize([group('KES','cash_in','9007199254740993'),group('KES','cash_out','123'),
  group('KES','cash_in','999','Bank'),group('KES','cash_out','555','Cash',true),group('UGX','cash_out','2')]);
 assert.equal(result.summary.total,5);assert.equal(result.summary.activeCount,4);assert.equal(result.summary.voidedCount,1);
 const kes=result.summary.byCurrency.find(row=>row.currency==='KES');
 assert.equal(kes.cashImpactMinor,'9007199254740870');assert.equal(kes.volumeMinor,'9007199254742115');
 assert.equal(kes.formatted.cashImpact,'KES 90,071,992,547,408.70');assert.equal(kes.feesMinor,'3');
 assert.equal(result.summary.byCurrency.find(row=>row.currency==='UGX').cashImpactMinor,'-2');
 assert.equal(result.networks.length,2);
});
test('module report uses existing fixed read/export capabilities without a Reports addon',()=>{
 for(const role of ['Tenant Owner','Branch Manager','Reconciliation Officer','Auditor'])assert(workspace.canReport({permissions:permissionsFor(role)}));
 assert(workspace.canReport({permissions:permissionsFor('Mobile Money Operator')}));
 assert(!workspace.canReport({permissions:permissionsFor('Viewer')}));
 assert(workspace.canExport({permissions:permissionsFor('Branch Manager')}));
 assert(workspace.canExport({permissions:permissionsFor('Auditor')}));
 assert(workspace.canReport({permissions:['mobile_money.report']}));
});
test('receipt metadata is validated and CSV preserves exact money and neutralizes spreadsheet formulae',()=>{
 const input={customer:'Customer',customerPhone:'+256 (700) 123-456',customerNote:'=HYPERLINK("bad")',paymentMethod:'Wallet Balance',
  network:'Africell',networkReference:'REAL-12345',currency:'KES',amount:'10.01',fee:'0.01',idempotencyKey:require('node:crypto').randomUUID()};
 const values=mobile.validate(input,'cash_in');assert.equal(values.customerPhone,'+256700123456');assert.equal(values.paymentMethod,'Wallet Balance');
 assert.throws(()=>mobile.validate({...input,customerPhone:'fakephone'},'cash_in'),{status:400});
 assert.throws(()=>mobile.validate({...input,paymentMethod:'settled'},'cash_in'),{status:400});
 assert.throws(()=>mobile.validate({...input,customerNote:'x'.repeat(401)},'cash_in'),{status:400});
 const csv=workspace.toCsv([{...values,createdAt:new Date('2026-11-05T10:00:00Z'),amountMinor:'9007199254740993',feeMinor:'1',status:'pending_verification'}]);
 assert.match(csv,/90071992547409\.93/);assert.match(csv,/'=HYPERLINK/);assert.match(csv,/'\+256700123456/);assert.match(csv,/"Wallet Balance","manual"/);assert.match(csv,/,"0\.00"\r\n$/);
});
