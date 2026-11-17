'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const posting=require('../src/tenant/settlements/mobileMoneyPosting');
const preview=require('../src/tenant/settlements/preview');
const treasury=require('../src/tenant/treasury/service');
const ids={tenant:'507f1f77bcf86cd799439010',branch:'507f1f77bcf86cd799439011',
 actor:'507f1f77bcf86cd799439012',wallet:'507f1f77bcf86cd799439013',
 cash:'507f1f77bcf86cd799439014',counterSsp:'507f1f77bcf86cd799439015',
 counterUgx:'507f1f77bcf86cd799439016',batch:'507f1f77bcf86cd799439017'};
const auth={tenant:{_id:ids.tenant},actor:{id:ids.actor,role:'Tenant Owner',
 permissions:['*'],branchId:ids.branch}};
const branch={_id:ids.branch,currency:'SSP'};
const values={paymentMethod:'Cash',operation:'cash_out',idempotencyKey:'f3b0b7a6-1254-4d58-a824-57f916b010ba',
 networkReference:'TEST-FX-12345',network:'MTN',currency:'UGX',
 amountMinor:100000n,feeMinor:0n,feeTreatment:'record_only',
 walletAccountId:ids.wallet,paymentAccountId:ids.cash,cashCurrency:'SSP',
 fxRateId:'507f1f77bcf86cd799439018'};
const quote={channel:'mobile_money',operation:'cash_out',branchId:ids.branch,
 providerCurrency:'UGX',cashCurrency:'SSP',providerPrincipalMinor:'100000',actualCashMinor:'-9000000',
 rateSnapshot:{rateId:values.fxRateId,side:'buy',fromCurrency:'UGX',toCurrency:'SSP',
 rateDecimal:'0.9',approvedBy:ids.actor,expiresAt:'2030-01-01T00:00:00.000Z'},
 custodyLegs:[{accountId:ids.wallet,kind:'wallet',currency:'UGX',deltaMinor:'100000'},
 {accountId:ids.cash,kind:'cash',currency:'SSP',deltaMinor:'-9000000'}]};
test('cross currency entry demands actual physical cash confirmation and no speculative fees',()=>{
 assert.throws(()=>posting.assertRecording(values,false),{status:400});
 assert.throws(()=>posting.assertRecording({...values,feeMinor:'1'},true),{status:409});
 assert.throws(()=>posting.assertRecording({...values,feeTreatment:'wallet_commission'},true),{status:409});
 assert.doesNotThrow(()=>posting.assertRecording(values,true));
});
test('atomic posting uses exactly one real wallet and one existing SSP drawer with independent balanced currencies',async t=>{
 t.mock.method(preview,'mobileMoney',async()=>({quote}));
 t.mock.method(preview,'wallet',async()=>({_id:ids.wallet,network:'MTN',currency:'UGX',feeTreatment:'record_only'}));
 t.mock.method(preview,'ownDrawer',async()=>({_id:ids.cash,currency:'SSP'}));
 t.mock.method(treasury,'ensureCounterAccount',async(_,__,request)=>({ledgerAccountId:request.currency==='UGX'?ids.counterUgx:ids.counterSsp}));
 let last=null;
 t.mock.method(treasury,'applyMovements',async(_conn,session,authorization,input)=>{
  assert.equal(session.inTransaction(),true);
  assert.equal(authorization.tenant._id,ids.tenant);
  last=input;
  return {batch:{_id:ids.batch},movements:[{accountId:ids.wallet,balanceAfterMinor:'100050000'}],journalIds:['507f1f77bcf86cd799439020','507f1f77bcf86cd799439021']};
 });
 const out=await posting.apply({}, {inTransaction:()=>true},auth,branch,values,{cashHandoverConfirmed:true});
 assert.equal(last.sourceType,'mobile_money');
 assert.equal(last.sourceRef,'MM:'+values.idempotencyKey);
 assert.equal(last.branchId,ids.branch);
 assert.deepEqual(last.legs,[{accountId:ids.wallet,deltaMinor:'100000'},{accountId:ids.cash,deltaMinor:'-9000000'}]);
 assert.deepEqual(last.ledgerLines,[
  {currency:'UGX',accountId:ids.counterUgx,side:'credit',amountMinor:'100000'},
  {currency:'SSP',accountId:ids.counterSsp,side:'debit',amountMinor:'9000000'}
 ]);
 assert.equal(out.funding.walletBalanceBeforeMinor,'99950000');
 assert.equal(out.funding.walletBalanceAfterMinor,'100050000');
 assert.equal(out.funding.physicalCashMovementMinor,'-9000000');
 assert.equal(out.funding.cashCurrency,'SSP');
 assert.equal(out.funding.fundingState,'book_recorded');
 assert.equal(out.funding.fxRateSide,'buy');
 assert.match(out.evidenceDigest,/^[a-f0-9]{64}$/);
});
test('posting cannot execute outside the Mongo transaction or without cashier handover',async()=>{
 await assert.rejects(posting.apply({}, {inTransaction:()=>false},auth,branch,values,
  {cashHandoverConfirmed:true}),{status:409});
 await assert.rejects(posting.apply({}, {inTransaction:()=>true},auth,branch,values,
  {cashHandoverConfirmed:false}),{status:400});
});
