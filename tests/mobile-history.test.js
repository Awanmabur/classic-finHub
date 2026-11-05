'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {Types}=require('mongoose');
const ejs=require('ejs');
const path=require('node:path');
const mobile=require('../src/tenant/services/mobileMoney.service');
const branchId='507f1f77bcf86cd799439011',operatorId='507f1f77bcf86cd799439012',recordId='507f1f77bcf86cd799439013';
test('history cursor is bounded and invalid or forged values fail validation',()=>{
  const cursor=mobile.encodeCursor({createdAt:new Date('2026-11-03T10:00:00Z'),_id:recordId});
  assert.deepEqual(mobile.decodeCursor(cursor),{at:new Date('2026-11-03T10:00:00Z'),id:recordId});
  for(const bad of ['not-valid','a'.repeat(300),Buffer.from(JSON.stringify(['garbage',recordId])).toString('base64url'),
    Buffer.from(JSON.stringify(['2026-11-03T10:00:00.000Z','badid'])).toString('base64url')]){
    assert.throws(()=>mobile.decodeCursor(bad),{status:400});
  }
});
test('paginated history reapplies operator and branch scope even when a cursor is supplied',async()=>{
  const old=new Date('2026-11-03T10:00:00Z');
  const cursor=mobile.encodeCursor({createdAt:old,_id:recordId});
  let query,sort,limit;
  const m={find(q){query=q;return {sort(s){sort=s;return this;},limit(n){limit=n;return this;},lean:async()=>Array.from({length:3},(_,i)=>({
    _id:new Types.ObjectId(),createdAt:new Date(old.getTime()-i*1000),network:'MTN'}))};}};
  const result=await mobile.getTransactionPage({models:{SecureMobileTransaction:m}},
    {branchId,operatorId,from:'2026-11-01',to:'2026-11-03',cursor,limit:2});
  assert.equal(String(query.branchId),branchId);
  assert.equal(String(query.operatorId),operatorId);
  assert.equal(query.$or[0].createdAt.$lt.toISOString(),old.toISOString());
  assert.equal(String(query.$or[1]._id.$lt),recordId);
  assert.deepEqual(sort,{createdAt:-1,_id:-1});
  assert.equal(limit,3);
  assert.equal(result.items.length,2);
  assert(result.nextCursor);
  await assert.rejects(mobile.getTransactionPage({models:{SecureMobileTransaction:m}},
    {from:'2026-01-01',to:'2026-11-03'}),{status:400});
});
test('record detail query always retains branch and operator filter',async()=>{
  let query;
  const m={findOne(q){query=q;return {lean:async()=>null};}};
  await assert.rejects(mobile.getRecordDetails({models:{SecureMobileTransaction:m}},recordId,{branchId,operatorId}),{status:404});
  assert.equal(String(query.branchId),branchId);
  assert.equal(String(query.operatorId),operatorId);
  assert.equal(String(query._id),recordId);
});
test('history and details render without exposing unescaped financial notes',async()=>{
  const row={_id:recordId,createdAt:new Date('2026-11-03T12:00:00Z'),network:'MTN',networkReference:'MM-123456',
    operation:'cash_in',currency:'UGX',amountMinor:'10000',feeMinor:'0',status:'voided_internal',
    reviewState:'accepted',correctionState:'voided',correctionHistory:[{at:new Date(),action:'approved',note:'<script>alert(1)</script>'}]};
  const data={records:{items:[row],from:'2026-11-01',to:'2026-11-03',nextCursor:'abc'}};
  const render=(f,d)=>ejs.renderFile(path.join(__dirname,'../src/views/tenant/mobile-money',f),{
    data:d,csrfToken:'csrf-token',money:(currency,amount)=>`${currency} ${amount}`,amountFromMinor:mobile.fromMinor});
  const list=await render('history.ejs',data);
  assert.match(list,/Next page/);
  assert.match(list,/voided internal/);
  const detail=await render('detail.ejs',{record:row});
  assert.match(detail,/Correction decisions/);
  const actionable=await render('detail.ejs',{record:row,canRequestCorrection:true});
  assert.match(actionable,/Submit void request/);
  assert.match(actionable,/name="_csrf" value="csrf-token"/);
  assert.doesNotMatch(detail,/<script>/);
  assert.match(detail,/&lt;script&gt;/);
});
