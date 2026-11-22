'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const ejs=require('ejs');
const {Types}=require('mongoose');
const workspace=require('../src/tenant/services/operationWorkspace.service');
const loanAdapter=require('../src/tenant/reporting/adapters/loans');
const airtimeAdapter=require('../src/tenant/reporting/adapters/airtime');
const oid='507f1f77bcf86cd799439011';
const another='507f1f77bcf86cd799439012';
const period={$gte:new Date('2026-11-01T00:00:00Z'),$lt:new Date('2026-12-01T00:00:00Z')};
function aggregator(sink,rows=[]){
 return {aggregate(pipeline){sink.push(pipeline);return {option(){return Promise.resolve(rows);}};}};
}
test('Forex final summary reads posted treasury executions, not quoted status',async()=>{
 const captured=[];
 const conn={models:{FundedExecutionV1:aggregator(captured,[{
  _id:{day:'2026-11-22',kind:'buy',currency:'USD',targetCurrency:'SSP'},
  count:2,volume:{toString:()=> '25000'},target:{toString:()=> '13500000'}
 }])}};
 const actor={id:oid,role:'Forex Operator',branchId:another};
 const filters={dateBounds:period,status:'',currency:'',kind:''};
 const result=await workspace.finalizedForexRows(conn,actor,filters,'Africa/Juba');
 assert.equal(result.length,1);assert.equal(result[0].count,2);
 assert.equal(result[0].kind,'buy');assert.equal(result[0].volumeMinor,'25000');
 assert.equal(captured[0][0].$match.status,'posted_manual');
 assert.equal(captured[0][0].$match.sourceType,'forex');
 assert.equal(String(captured[0][0].$match.createdBy),oid);
 assert.equal(String(captured[0][0].$match.branchId),another);
 assert.deepEqual(await workspace.finalizedForexRows(conn,actor,{...filters,status:'cancelled'},'Africa/Juba'),[]);
 assert.deepEqual(await workspace.finalizedForexRows(conn,actor,{...filters,kind:'quote'},'Africa/Juba'),[]);
 assert.equal(captured.length,1,'unposted and quote-only filters must never query final trade turnover');
});
test('Loan module reporting enforces branch and operator on each lifecycle source',async()=>{
 const loan=[],payment=[],correction=[];
 const conn={models:{
  LoanProductV1:aggregator([]),LoanCaseV1:aggregator(loan),LoanPaymentV1:aggregator(payment),LoanCorrectionV1:aggregator(correction)
 }};
 const rows=await loanAdapter.rows({conn,scope:{branchId:another,operatorId:oid},dateRange:period});
 assert.deepEqual(rows,[]);
 assert.equal(loan.length,2);assert.equal(payment.length,1);assert.equal(correction.length,1);
 assert.equal(String(loan[0][0].$match.requestedBy),oid);
 assert.equal(String(loan[1][0].$match.disbursedBy),oid);
 assert.equal(String(payment[0][0].$match.createdBy),oid);
 assert.equal(String(correction[0][0].$match.createdBy),oid);
 for(const pipeline of [...loan,...payment,...correction])
  assert.equal(String(pipeline[0].$match.branchId),another);
});
test('Airtime module report scopes both recorded sales and compensating corrections',async()=>{
 const record=[],correction=[];
 const conn={models:{AirtimeProductV1:aggregator([]),AirtimeInventoryV1:aggregator([]),AirtimeRecordV1:aggregator(record),AirtimeCorrectionV1:aggregator(correction)}};
 assert.deepEqual(await airtimeAdapter.rows({conn,scope:{branchId:another,operatorId:oid},dateRange:period}),[]);
 assert.equal(String(record[0][0].$match.createdBy),oid);
 assert.equal(String(correction[0][0].$match.createdBy),oid);
 assert.equal(String(record[0][0].$match.branchId),another);
 assert.equal(String(correction[0][0].$match.branchId),another);
});
test('module summary and final transaction forms compile without relying on Reports subscription',()=>{
 for(const name of ['src/views/tenant/retailFinance/module-report.ejs',
  'src/views/tenant/operation-workspace.ejs','src/views/tenant/funded/prepare.ejs','src/views/tenant/funded/detail.ejs']){
  const file=path.join(__dirname,'..',name),source=fs.readFileSync(file,'utf8');
  assert.doesNotThrow(()=>ejs.compile(source,{filename:file}),name);
 }
 const prepare=fs.readFileSync(path.join(__dirname,'../src/views/tenant/funded/prepare.ejs'),'utf8');
 assert.match(prepare,/confirmFinalMovement/);
 assert.doesNotMatch(prepare,/Record for independent review/);
});
