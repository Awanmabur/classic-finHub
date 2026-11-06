'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const funds=require('../src/tenant/services/mobileMoneyFunds.service');
const treasury=require('../src/tenant/treasury/service'),models=require('../src/tenant/treasury/models');
const oid=()=>crypto.randomBytes(12).toString('hex');

test('manual Mobile Money keeps provider funds, actually collected fees and physical cash distinct',async()=>{
 const original={ensure:models.ensure,models:models.models,apply:treasury.applyMovements,counter:treasury.ensureCounterAccount};
 const walletId=oid(),cashId=oid(),bankId=oid(),feeId=oid(),actorId=oid(),branchId=oid(),tenantId=oid();
 const accounts=new Map([
  [walletId,{_id:walletId,name:'Actual provider wallet',kind:'wallet',network:'MTN',currency:'KES',operatorId:actorId,status:'active',openingBalanceMinor:'500000',bookBalanceMinor:'500000'}],
  [cashId,{_id:cashId,name:'Verified drawer',kind:'cash',currency:'KES',operatorId:actorId,status:'active',openingBalanceMinor:'500000',bookBalanceMinor:'500000'}],
  [bankId,{_id:bankId,name:'Verified bank',kind:'bank',currency:'KES',operatorId:null,status:'active',openingBalanceMinor:'500000',bookBalanceMinor:'500000'}]
 ]);
 let captured,counterCalls;
 models.ensure=async()=>{};
 models.models=()=>({account:{findOne:query=>({session:()=>({lean:async()=>accounts.get(String(query._id))})})}});
 treasury.applyMovements=async(_conn,_session,_authorization,payload)=>{captured=payload;return {journalIds:['actual-balanced-journal']};};
 treasury.ensureCounterAccount=async()=>{counterCalls++;return {ledgerAccountId:feeId};};
 try{
  for(const operation of ['cash_in','cash_out'])for(const feeTreatment of ['record_only','wallet_commission','payment_collected'])for(const paymentMethod of ['Cash','Bank Transfer']){
   const amount=10000n,fee=125n,sign=operation==='cash_in'?-1n:1n;
   const walletDelta=sign*amount+(feeTreatment==='wallet_commission'?fee:0n),paymentDelta=-sign*amount+(feeTreatment==='payment_collected'?fee:0n);
   counterCalls=0;
   const result=await funds.apply({}, {}, {tenant:{_id:tenantId},actor:{id:actorId}}, {
    branchId,currency:'KES',operation,network:'MTN',networkReference:'ACTUAL-PROVIDER-REFERENCE',amountMinor:String(amount),feeMinor:String(fee),feeTreatment,paymentMethod,
    walletAccountId:walletId,paymentAccountId:paymentMethod==='Cash'?cashId:bankId,idempotencyKey:crypto.randomUUID()
   });
   assert.deepEqual(captured.legs,[{accountId:walletId,deltaMinor:String(walletDelta)},{accountId:paymentMethod==='Cash'?cashId:bankId,deltaMinor:String(paymentDelta)}]);
   assert.deepEqual(captured.ledgerLines,feeTreatment==='record_only'?[]:[{currency:'KES',accountId:feeId,side:'credit',amountMinor:String(fee)}]);
   assert.equal(walletDelta+paymentDelta,feeTreatment==='record_only'?0n:fee,'all actual fund movements balance the explicit fee-income counterparty');
   assert.equal(counterCalls,feeTreatment==='record_only'?0:1);
   assert.equal(result.physicalCashMovementMinor,paymentMethod==='Cash'?String(paymentDelta):'0',`${operation}/${feeTreatment}/${paymentMethod} physical drawer effect`);
   assert.equal(result.walletBalanceBeforeMinor,'500000');assert.equal(result.walletBalanceAfterMinor,String(500000n+walletDelta));
   assert.equal(result.fundingState,'book_recorded');assert.deepEqual(result.fundJournalIds,['actual-balanced-journal']);
  }
 }finally{models.ensure=original.ensure;models.models=original.models;treasury.applyMovements=original.apply;treasury.ensureCounterAccount=original.counter;}
});

test('fund summaries expose exact display amounts and last four only without invented opening balances',()=>{
 const fullReference='9876543210123456',row={_id:oid(),name:'Actual wallet',kind:'wallet',network:'MTN',currency:'UGX',
  openingBalanceMinor:'900719925474099312',bookBalanceMinor:'900719925474099312',lastObservedMinor:'900719925474099300',lastVarianceMinor:'-12',
  status:'held',reconciliationState:'mismatch',accountReference:fullReference,tenantId:oid(),operatorId:oid(),evidenceReference:'PRIVATE-STATEMENT-REFERENCE',providerToken:'PRIVATE-GATEWAY-SECRET'};
 const output=funds.summary(row),serialized=JSON.stringify(output);
 assert.equal(output.expected,'UGX 900,719,925,474,099,312');assert.equal(output.expectedMinor,'900719925474099312');assert.equal(output.lastFour,'3456');
 assert.equal(output.observed,'UGX 900,719,925,474,099,300');assert.equal(output.variance,'UGX -12');assert.equal(output.state,'held');
 for(const privateValue of [fullReference,row.tenantId,row.operatorId,row.evidenceReference,row.providerToken])assert(!serialized.includes(privateValue),'private account identity and provider evidence must not leak in a fund picker');
 const unopened=funds.summary({...row,openingBalanceMinor:null,lastObservedMinor:null,lastVarianceMinor:null});
 assert.equal(unopened.expected,null);assert.equal(unopened.expectedMinor,null);assert.equal(unopened.observed,null);assert.equal(unopened.variance,null);
});

test('wallet evidence uses the movement source time and delegates discrepancy holds to Treasury',async()=>{
 const original={ensure:models.ensure,models:models.models,apply:treasury.applyMovements,observation:treasury.requestObservationInSession};
 const walletId=oid(),bankId=oid(),actorId=oid(),branchId=oid(),tenantId=oid(),observationId=oid();
 const accounts=new Map([
  [walletId,{_id:walletId,kind:'wallet',network:'MTN',currency:'UGX',operatorId:actorId,status:'active',openingBalanceMinor:'500000',bookBalanceMinor:'500000'}],
  [bankId,{_id:bankId,kind:'bank',currency:'UGX',operatorId:null,status:'active',openingBalanceMinor:'500000',bookBalanceMinor:'500000'}]
 ]);
 let movement,checkpoint,directHoldWrites=0;
 models.ensure=async()=>{};
 models.models=()=>({account:{findOne:query=>({session:()=>({lean:async()=>accounts.get(String(query._id))})}),updateOne:()=>{directHoldWrites++;throw new Error('Only Treasury may decide whether historical evidence holds the current account');}}});
 treasury.applyMovements=async(_conn,_session,_authorization,payload)=>{movement=payload;return {journalIds:[]};};
 treasury.requestObservationInSession=async(_conn,_session,_authorization,accountId,payload)=>{
  assert.equal(String(accountId),walletId);checkpoint=payload;
  // A historical discrepancy can coexist with newer matching evidence. The
  // Treasury boundary decides account state using its observation chronology.
  return {observation:{_id:observationId,varianceMinorAtRequest:'-100'}};
 };
 try{
  const base={branchId,currency:'UGX',operation:'cash_in',network:'MTN',networkReference:'DATED-PROVIDER-REFERENCE',amountMinor:'10000',feeMinor:'0',feeTreatment:'record_only',paymentMethod:'Bank',walletAccountId:walletId,paymentAccountId:bankId,observedWalletBalance:'489900',observationEvidenceReference:'SOURCE-STATEMENT'};
  const sourceTime=new Date(Date.now()-2*3600000).toISOString();
  const sms=await funds.apply({}, {}, {tenant:{_id:tenantId},actor:{id:actorId}}, {...base,idempotencyKey:crypto.randomUUID()},{receivedAt:sourceTime,requireObservation:true});
  assert.equal(new Date(movement.occurredAt).toISOString(),sourceTime);
  assert.equal(checkpoint.observedAt,sourceTime,'A delayed SMS balance must be compared against the book at the SMS time');
  assert.equal(checkpoint.evidenceType,'provider_sms');assert.equal(checkpoint.actualBalance,'489900');assert.equal(checkpoint.evidenceReference,'SOURCE-STATEMENT');
  assert.equal(sms.walletObservationId,observationId);assert.equal(directHoldWrites,0);
  const before=Date.now();
  const manual=await funds.apply({}, {}, {tenant:{_id:tenantId},actor:{id:actorId}}, {...base,idempotencyKey:crypto.randomUUID()},{requireObservation:true});
  const after=Date.now(),observed=Date.parse(checkpoint.observedAt);
  assert(observed>=before&&observed<=after,'Manual evidence is dated at the recorded operation time');
  assert.equal(checkpoint.observedAt,new Date(movement.occurredAt).toISOString());assert.equal(checkpoint.evidenceType,'provider_app');
  assert.equal(manual.walletObservationId,observationId);assert.equal(directHoldWrites,0,'No unconditional hold may bypass Treasury chronology checks');
 }finally{models.ensure=original.ensure;models.models=original.models;treasury.applyMovements=original.apply;treasury.requestObservationInSession=original.observation;}
});

test('customer wallet payments require the transaction phone to identify the selected account owner',async()=>{
 const directory=require('../src/tenant/customerAccounts/models'),core=require('../src/tenant/models');
 const original={ensure:models.ensure,models:models.models,apply:treasury.applyMovements,account:directory.accountModel,customer:directory.customerModel,ledger:core.ledgerAccountModel,postings:core.ledgerPostingModel};
 const walletId=oid(),customerAccountId=oid(),customerId=oid(),liabilityId=oid(),actorId=oid(),branchId=oid(),tenantId=oid();
 const wallet={_id:walletId,kind:'wallet',network:'MTN',currency:'UGX',operatorId:actorId,status:'active',openingBalanceMinor:'500000',bookBalanceMinor:'500000'};
 const authorization={tenant:{_id:tenantId,status:'active',moduleGrants:[{moduleKey:'accounts',status:'granted',generation:1,periodStart:new Date(Date.now()-86400000),periodEnd:new Date(Date.now()+86400000),limits:{users:10,branches:2,recordsPerMonth:1000}}]},actor:{id:actorId,role:'Mobile Money Operator',permissions:['accounts.view'],allowedModules:['accounts']}};
 let postings=0,ledgerReads=0,movement;
 models.ensure=async()=>{};models.models=()=>({account:{findOne:()=>({session:()=>({lean:async()=>wallet})})}});
 directory.accountModel=()=>({findOneAndUpdate:()=>({lean:async()=>({_id:customerAccountId,customerId,ledgerAccountId:liabilityId})})});
 directory.customerModel=()=>({findOneAndUpdate:()=>({lean:async()=>({_id:customerId,phone:'+256700123456'})})});
 core.ledgerAccountModel=()=>({findOne:()=>{ledgerReads++;return {session:()=>({lean:async()=>({_id:liabilityId})})};}});
 core.ledgerPostingModel=()=>({aggregate:()=>({session:async()=>[{amount:'100000'}]})});
 treasury.applyMovements=async(_conn,_session,_authorization,payload)=>{postings++;movement=payload;return {journalIds:[]};};
 try{
  const base={branchId,currency:'UGX',operation:'cash_in',network:'MTN',networkReference:'CUSTOMER-WALLET-REF',amountMinor:'10000',feeMinor:'0',feeTreatment:'record_only',paymentMethod:'Wallet Balance',walletAccountId:walletId,customerAccountId};
  for(const customerPhone of ['+256700999999','',undefined]){
   await assert.rejects(()=>funds.apply({}, {},authorization,{...base,customerPhone,idempotencyKey:crypto.randomUUID()}),error=>error.status===400&&/wallet must belong to the phone/.test(error.message));
  }
  assert.equal(postings,0,'A different customer wallet must never be charged');assert.equal(ledgerReads,0,'Identity mismatch must fail before consulting or posting the customer balance');
  const matched=await funds.apply({}, {},authorization,{...base,customerPhone:'+256 (700) 123-456',idempotencyKey:crypto.randomUUID()});
  assert.equal(postings,1);assert.equal(matched.customerAccountId,customerAccountId);assert.equal(matched.paymentAccountId,null);
  assert.deepEqual(movement.ledgerLines,[{currency:'UGX',accountId:liabilityId,side:'debit',amountMinor:'10000'}]);
  assert.deepEqual(movement.legs,[{accountId:walletId,deltaMinor:'-10000'}]);
 }finally{models.ensure=original.ensure;models.models=original.models;treasury.applyMovements=original.apply;directory.accountModel=original.account;directory.customerModel=original.customer;core.ledgerAccountModel=original.ledger;core.ledgerPostingModel=original.postings;}
});
