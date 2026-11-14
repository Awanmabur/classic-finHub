'use strict';
const assert=require('node:assert/strict');
const mongoose=require('mongoose');
const {randomUUID}=require('node:crypto');
const Tenant=require('../src/platform/models/Tenant');
const core=require('../src/tenant/models');
const treasury=require('../src/tenant/treasury/models');
const payout=require('../src/tenant/pricing/commissionPayoutService');
const {tenantDbNameFromSlug}=require('../src/config/tenantDatabaseName');
const {permissionsFor}=require('../src/config/roles');

async function main(){
 const platformUrl=process.env.MOMO_TEST_PLATFORM_URI||'';
 const mongoUrl=process.env.MOMO_TEST_MONGO_URI||'';
 const slug=process.env.MOMO_TEST_TENANT_SLUG||'';
 const check=(url,prefix)=>{
  const u=new URL(url);
  assert.equal(u.protocol,'mongodb:');
  assert.equal(u.hostname,'classicfin-financial-mongo');
  assert.equal(u.port,'27017');
  assert.equal(u.searchParams.get('replicaSet'),'rs0');
  assert(!u.username&&!u.password);
  assert(u.pathname.slice(1).startsWith(prefix));
 };
 check(platformUrl,'classicfin-momo-platform-test-');
 check(mongoUrl,'classicfin-momo-test-');
 assert(/^mmtest[0-9]{1,8}$/.test(slug));
 assert.equal(process.env.ENABLE_MOMO_COMMISSION_POSTING,'false');
 assert.equal(process.env.MFA_ENABLED,'false');
 await mongoose.connect(platformUrl,{serverSelectionTimeoutMS:15000,autoIndex:false});
 const tenantDb=tenantDbNameFromSlug(slug);
 const base=new URL(mongoUrl);
 base.pathname='/'+tenantDb;
 const conn=await mongoose.createConnection(base.toString(),{serverSelectionTimeoutMS:15000,autoIndex:false}).asPromise();
 const pass=msg=>process.stdout.write('PASS: '+msg+'\n');
 const deny=async(msg,fn)=>{
  let refused=false;try{await fn();}catch(e){refused=true;}
  assert(refused,msg+' was incorrectly accepted');pass(msg);
 };
 try {
  const now=Date.now();
  const tenant=await Tenant.create({
   name:'Disposable Mobile Money Financial Test',slug,dbName:tenantDb,
   email:'sandbox@example.invalid',plan:'testonly',status:'active',enabledModules:['mobile_money'],
   moduleGrants:[{moduleKey:'mobile_money',status:'granted',
    periodStart:new Date(now-86400000),periodEnd:new Date(now+86400000),
    generation:1,priceMonthlyMinor:0,currency:'USD',
    limits:{users:8,branches:3,recordsPerMonth:100}}]
  });
  await Promise.all([core.ensureTenantIndexes(conn),treasury.ensure(conn)]);
  const branchId=new mongoose.Types.ObjectId(),makerId=new mongoose.Types.ObjectId(),checkerId=new mongoose.Types.ObjectId();
  await core.tenantUserModel(conn).create([
   {_id:makerId,name:'Disposable Operator',email:'operator@example.invalid',passwordHash:'not-a-real-login-hash',
    role:'Mobile Money Operator',branchId:String(branchId),allowedModules:['mobile_money'],status:'active'},
   {_id:checkerId,name:'Disposable Reviewer',email:'reviewer@example.invalid',passwordHash:'not-a-real-login-hash',
    role:'Reconciliation Officer',branchId:String(branchId),allowedModules:['mobile_money'],status:'active'}
  ]);
  await core.branchModel(conn).create({_id:branchId,code:'momo-test-branch',name:'Disposable Financial Branch',
   currency:'SSP',currencies:['SSP'],status:'active',createdBy:makerId,updatedBy:makerId});
  const accountId=new mongoose.Types.ObjectId(),ledgerAccountId=new mongoose.Types.ObjectId();
  await treasury.models(conn).account.create({ _id:accountId,tenantId:tenant._id,branchId,
   code:'SSP_TEST_WALLET',name:'Test network commission wallet',kind:'wallet',moduleKey:'mobile_money',
   network:'MTN SSD',currency:'SSP',operatorId:makerId,
   ledgerAccountId,ledgerCode:'TRS_SANDBOX_TEST_WALLET',
   status:'active',openingBalanceMinor:'100000',bookBalanceMinor:'100000',
   openingApprovedAt:new Date(),openingObservedAt:new Date(now-3600000),
   reconciliationState:'matched',feeTreatment:'record_only',createdBy:makerId
  });
  pass('Disposable tenant, branch and role-scoped funds account initialized');
  const operator={id:String(makerId),role:'Mobile Money Operator',branchId:String(branchId),authVersion:0,permissions:permissionsFor('Mobile Money Operator'),allowedModules:['mobile_money']};
  const reviewer={id:String(checkerId),role:'Reconciliation Officer',branchId:String(branchId),authVersion:0,permissions:permissionsFor('Reconciliation Officer'),allowedModules:['mobile_money']};
  const payload={walletAccountId:String(accountId),network:'MTN SSD',currency:'SSP',
   amount:'12.50',grossAmount:'12.50',taxWithheld:'0',providerCost:'0',
   providerReference:'TEST-'+randomUUID(),statementEvidence:'Disposable statement evidence TEST ONLY',
   creditedAt:new Date(now-60000).toISOString().slice(0,16)};
  const saved=await payout.propose(conn,tenant,operator,payload);
  assert.equal(saved.status,'pending_review');
  pass('Actual authorized operator submitted unposted commission evidence');
  await deny('Duplicate statement rejected through real payout service',()=>payout.propose(conn,tenant,operator,payload));
  await deny('Same maker cannot review payout',()=>payout.review(conn,tenant,operator,String(saved._id),{decision:'reject',note:'Independent test rejection'}));
  await deny('Reviewer cannot approve while posting gate is disabled',()=>payout.review(conn,tenant,reviewer,String(saved._id),{decision:'approve',note:'Checked the simulated test evidence'}));
  assert.equal((await payout.list(conn,tenant,reviewer)).records.find(x=>String(x._id)===String(saved._id)).status,'pending_review');
  const before=await treasury.models(conn).account.findById(accountId).lean();
  assert.equal(String(before.bookBalanceMinor),'100000');
  pass('Locked approval preserved evidence and did not modify wallet float');
  const rejected=await payout.review(conn,tenant,reviewer,String(saved._id),{decision:'reject',note:'Unverified sandbox provider statement'});
  assert.equal(rejected.status,'rejected');
  await deny('Replaying reviewer decision cannot mutate final status',()=>payout.review(conn,tenant,reviewer,String(saved._id),{decision:'reject',note:'Repeated review must be blocked'}));
  const after=await treasury.models(conn).account.findById(accountId).lean();
  assert.equal(String(after.bookBalanceMinor),'100000');
  const posted=await payout.summary(conn,tenant,reviewer);
  assert(Array.isArray(posted)&&posted.every(x=>!x.receivedMinor||BigInt(x.receivedMinor)===0n));
  pass('Real reviewer rejection retained original float and excluded commission income');
  process.stdout.write('LOCKED SETTLEMENT SERVICE INTEGRATION PASSED — production posting gate remained off.\n');
 }finally{
  await conn.close();await mongoose.disconnect();
 }
}
main().catch(e=>{process.stderr.write('LOCKED SETTLEMENT SERVICE INTEGRATION FAILED: '+e.stack+'\n');process.exitCode=1;});
