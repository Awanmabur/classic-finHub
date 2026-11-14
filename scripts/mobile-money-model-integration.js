'use strict';
// Database-backed integration against ACTUAL Classic FinHub Mongoose models.
// Refuses non-disposable target names; no connection to any production URI.
const assert=require('node:assert/strict');
const mongoose=require('mongoose');
const tariffs=require('../src/tenant/pricing/networkTariffModels');
const tariffService=require('../src/tenant/pricing/networkTariffService');
const payouts=require('../src/tenant/pricing/commissionPayoutModels');
const treasury=require('../src/tenant/treasury/models');
const {randomUUID}=require('node:crypto');

async function main(){
 const url=process.env.MOMO_TEST_MONGO_URI||'';
 const parsed=new URL(url);
 if(parsed.protocol!=='mongodb:'||!/^(?:classicfin-momo-test-[a-z0-9-]+)$/.test(parsed.pathname.slice(1))||
   parsed.hostname!=='classicfin-financial-mongo'||
   parsed.port!=='27017'||parsed.searchParams.get('replicaSet')!=='rs0'||parsed.username||parsed.password||
   parsed.searchParams.has('authSource')||parsed.searchParams.has('tlsAllowInvalidCertificates')){
   throw new Error('Refusing non-disposable or unexpected MongoDB target');
 }
 const conn=await mongoose.createConnection(url,{serverSelectionTimeoutMS:15000,autoIndex:false}).asPromise();
 const a=new mongoose.Types.ObjectId(),b=new mongoose.Types.ObjectId(),branch=new mongoose.Types.ObjectId();
 const maker=new mongoose.Types.ObjectId(),checker=new mongoose.Types.ObjectId();
 const account=new mongoose.Types.ObjectId(),wallet=new mongoose.Types.ObjectId();
 const T=tariffs.model(conn),P=payouts.model(conn),A=treasury.models(conn).account;
 let checks=0;
 const pass=msg=>{checks++;process.stdout.write('PASS: '+msg+'\n');};
 async function rejected(label,action){
  let caught=false;try{await action();}catch(e){caught=true;}
  assert(caught,label+' unexpectedly succeeded');pass(label);
 }
 const base={
  tenantId:a,branchId:branch,network:'MTN SSD',currency:'SSP',operation:'cash_in',
  scheduleKind:'agent_commission',version:1,status:'draft',
  effectiveFrom:new Date('2026-11-01T00:00:00Z'),
  evidenceReference:'Test-only provider reference, no real contract',
  createdBy:maker,tiers:[{minMinor:'100',maxMinor:'10000',rate:{kind:'flat',value:'125'}}]
 };
 try{
  assert.equal((await conn.db.admin().command({hello:1})).isWritablePrimary,true);
  await Promise.all([tariffs.ensure(conn),payouts.ensure(conn),treasury.ensure(conn)]);
  pass('Real tariff, payout and treasury collections/indexes initialized');
  await T.create(base);
  pass('Real agent commission tariff schema accepts branch-scoped draft');
  await rejected('Duplicate draft blocked by actual unique database index',()=>T.create({...base,version:2}));
  await T.create({...base,tenantId:b});
  pass('Second tenant can store independent provider tariff');
  await T.create({...base,network:'MTN',currency:'UGX'});
  pass('Uganda MTN and South Sudan MTN use distinct market identities');
  await T.updateOne({tenantId:a,network:'MTN SSD',version:1},{$set:{status:'approved',approvedBy:checker,approvedAt:new Date()}});
  await rejected('Concurrent second approved tariff blocked',async()=>{
   const session=await conn.startSession();
   try{
    await session.withTransaction(async()=>{
     await T.updateOne({tenantId:a,network:'MTN SSD',version:1},{$set:{status:'retired'}},{session});
     await T.create([{...base,version:2,status:'approved',approvedBy:checker,approvedAt:new Date()}],{session});
     await T.create([{...base,version:3,status:'approved',approvedBy:checker,approvedAt:new Date()}],{session});
    });
   }finally{await session.endSession();}
  });
  assert.equal((await T.findOne({tenantId:a,network:'MTN SSD',version:1}).lean()).status,'approved');
  assert.equal(await T.countDocuments({tenantId:a,network:'MTN SSD',status:'approved'}),1);
  pass('Failed replacement transaction preserved original approved tariff');
  const estimate=await tariffService.transactionEstimates(conn,{_id:a},{_id:branch},{
   network:'MTN SSD',currency:'SSP',operation:'cash_in',amountMinor:'1000',
   at:new Date('2026-11-14T10:00:00Z')});
  assert.equal(estimate.agentCommissionEstimate.amountMinor,'125');
  assert.equal(estimate.agentCommissionEstimate.version,1);
  assert.equal(estimate.customerNetworkFeeEstimate,null);
  pass('Real service resolves approved SSP commission without inventing customer fee');
  const other=await tariffService.transactionEstimates(conn,{_id:b},{_id:branch},{
   network:'MTN SSD',currency:'SSP',operation:'cash_in',amountMinor:'1000',
   at:new Date('2026-11-14T10:00:00Z')});
  assert.equal(other.agentCommissionEstimate,null);
  pass('Actual service cannot read another tenant approved tariff');
  const payout={tenantId:a,branchId:branch,walletAccountId:wallet,network:'MTN SSD',currency:'SSP',
   providerReference:'SSPTEST-'+randomUUID(),statementEvidence:'Disposable test statement reference only',
   creditedAt:new Date(),amountMinor:'500',grossMinor:'500',
   taxWithheldMinor:'0',providerCostMinor:'0',createdBy:maker};
  await P.create(payout);
  pass('Real payout model accepts gross/net/evidence fields');
  await rejected('Duplicate payout protected by actual compound index',()=>P.create(payout));
  await P.create({...payout,tenantId:b});
  pass('Payout reference namespace isolated between tenants');
  const session=await conn.startSession();
  try{
   await session.startTransaction();
   await P.create([{...payout,providerReference:'ABORT-'+randomUUID()}],{session});
   await session.abortTransaction();
  }finally{await session.endSession();}
  assert.equal(await P.countDocuments({tenantId:a}),1);
  pass('Rolled-back payout evidence cannot leave a partial record');
  const validAccount={tenantId:a,branchId:branch,code:'TEST_WALLET',name:'Test agent float',
   kind:'wallet',moduleKey:'mobile_money',network:'MTN SSD',currency:'SSP',
   ledgerAccountId:account,ledgerCode:'TEST_LEDGER',createdBy:maker,
   status:'active',openingBalanceMinor:'250000',bookBalanceMinor:'250000',
   openingApprovedAt:new Date(),openingObservedAt:new Date('2026-11-01T00:00:00Z'),reconciliationState:'matched'};
  await A.create(validAccount);
  const stored=await A.findOne({tenantId:a,code:'TEST_WALLET'}).lean();
  assert.equal(String(stored.bookBalanceMinor),'250000');
  pass('Actual treasury wallet model retains exact SSP float principal');
  assert.equal(process.env.ENABLE_MOMO_COMMISSION_POSTING,'false');
  pass('Live commission posting explicitly disabled in isolated runner');
  process.stdout.write('MODEL INTEGRATION PASSED: '+checks+' checks. No production records accessed.\n');
 }finally{await conn.close();}
}
main().catch(e=>{process.stderr.write('MODEL INTEGRATION FAILED: '+e.stack+'\n');process.exitCode=1;});
