'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const nodePath=require('node:path');
const ejs=require('ejs');
const receipt=require('../src/tenant/services/receiptPrint.service');
const oid='507f1f77bcf86cd799439011',other='507f1f77bcf86cd799439012';
const file=p=>fs.readFileSync(nodePath.resolve(__dirname,'..',p),'utf8');

test('new Mobile Money receipt only follows funded, journal-posted and non-duplicate operation',()=>{
 const good={created:{_id:oid,status:'recorded',fundingState:'book_recorded',fundJournalIds:[other]},duplicate:false};
 assert.equal(receipt.mobile(good),'/tenant/mobile-money/'+oid+'/acknowledgement?autoPrint=1');
 for(const v of [{...good,duplicate:true},{...good,created:{...good.created,status:'pending_verification'}},
  {...good,created:{...good.created,fundingState:'pending'}},
  {...good,created:{...good.created,fundJournalIds:[]}},
  {created:{...good.created,_id:'not-an-id'}}])assert.equal(receipt.mobile(v),null);
 assert.equal(receipt.mobile({mobile:good.created,duplicate:false}),'/tenant/mobile-money/'+oid+'/acknowledgement?autoPrint=1');
});
test('loan repayment and airtime sale only print after a journal-backed unique posting',()=>{
 const loan={payment:{_id:oid,loanId:other,batchId:other},duplicate:false};
 assert.equal(receipt.loan(loan),'/tenant/loans/'+other+'/repayments/'+oid+'/receipt?autoPrint=1');
 assert.equal(receipt.loan({...loan,duplicate:true}),null);
 assert.equal(receipt.loan({payment:{...loan.payment,batchId:null}}),null);
 const sale={record:{_id:oid,type:'sale',batchId:other},duplicate:false};
 assert.equal(receipt.airtime(sale),'/tenant/airtime/'+oid+'/receipt?autoPrint=1');
 assert.equal(receipt.airtime({...sale,record:{...sale.record,type:'purchase'}}),null);
 assert.equal(receipt.airtime({...sale,duplicate:true}),null);
});
test('manual transfer/banking/forex printing is forbidden until posted and audited',()=>{
 const posted={execution:{_id:oid,status:'posted_manual',journalIds:[other]},duplicate:false};
 assert.equal(receipt.funded(posted),'/tenant/funded/'+oid+'/receipt?autoPrint=1');
 assert.equal(receipt.funded({...posted,execution:{...posted.execution,status:'pending_review'}}),null);
 assert.equal(receipt.funded({...posted,execution:{...posted.execution,status:'rejected'}}),null);
 assert.equal(receipt.funded({...posted,execution:{...posted.execution,journalIds:[]}}),null);
 assert.equal(receipt.funded({...posted,duplicate:true}),null);
});
test('every receipt retains safe branding and thermal paper controls and no fake native bluetooth writes',()=>{
 for(const path of [
  'src/views/tenant/mobile-money/acknowledgement.ejs',
  'src/views/tenant/money-transfer/acknowledgement.ejs',
  'src/views/tenant/retailFinance/acknowledgement.ejs']){
  const html=file(path);
  assert.doesNotThrow(()=>ejs.compile(html,{filename:nodePath.resolve(__dirname,'..',path)}));
  assert.match(html,/receipt-print-options/);
  assert.match(html,/receipt-print\.js/);
  assert.match(html,/thermal-receipt\.css/);
 }
 const css=file('public/css/thermal-receipt.css'),js=file('public/js/receipt-print.js');
 assert.match(css,/receipt-paper="58"/);assert.match(css,/receipt-paper="80"/);
 assert.match(js,/window\.print\(\)/);assert.match(js,/sessionStorage/);
 assert.match(js,/data\.receiptAuto/);
 assert.doesNotMatch(js,/navigator\.bluetooth|SerialPort|connectBluetooth|printSucceeded/);
 assert.match(file('src/tenant/routes/index.js'),/receiptPrint\.mobile\(result\)/);
 assert.match(file('src/tenant/retailFinance/routes.js'),/receiptPrint\.service'\)\.loan\(result\)/);
 assert.match(file('src/tenant/routes/fundedOperations.routes.js'),/receiptPrint\.funded\(result\)/);
});
test('manual posted receipt builder rejects pending and rejected source without querying branch',async()=>{
 const builder=require('../src/tenant/funded/receipt.service');
 await assert.rejects(builder.fromDetail(null,null,{execution:{status:'pending_review',journalIds:[other],sourceSnapshot:{amountMinor:'100'}}}),{status:409});
 await assert.rejects(builder.fromDetail(null,null,{execution:{status:'posted_manual',journalIds:[],sourceSnapshot:{amountMinor:'100'}}}),{status:409});
});
