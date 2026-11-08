#!/usr/bin/env node
'use strict';
// Real financial transactions, mocked provider only. Random loopback scratch DBs.
require('dotenv').config();
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const configured=new URL(process.env.MONGO_PLATFORM_URI||'mongodb://127.0.0.1:27018/classicfin_platform_db?replicaSet=rs0&directConnection=true');
if(process.env.NODE_ENV==='production'||configured.protocol!=='mongodb:'||!['localhost','127.0.0.1','[::1]'].includes(configured.hostname)||configured.host.includes(',')||configured.username||configured.password)throw Error('Transfer SMS integration requires one unauthenticated loopback replica set');
const nonce=crypto.randomBytes(8).toString('hex'),platformName=`cfh_tenant_backup_${nonce}`,slug=`tenant-backup-${nonce}`;
configured.pathname='/'+platformName;process.env.MONGO_PLATFORM_URI=configured.toString();process.env.NODE_ENV='test';
process.env.MFA_ENCRYPTION_KEY=crypto.randomBytes(32).toString('hex');process.env.TRANSFER_SMS_ENCRYPTION_KEY=crypto.randomBytes(32).toString('hex');process.env.TRANSFER_SMS_PROVIDER='twilio';
// No real transport credentials are used. Every processOne below has a mock.
delete process.env.TWILIO_ACCOUNT_SID;delete process.env.TWILIO_AUTH_TOKEN;delete process.env.TWILIO_FROM_NUMBER;delete process.env.TWILIO_MESSAGING_SERVICE_SID;
const mongoose=require('mongoose'),core=require('../src/tenant/models'),Tenant=require('../src/platform/models/Tenant');
const {connectPlatformMongo,getTenantConnection}=require('../src/config/mongo');
const funded=require('../src/tenant/services/fundedOperations.service'),fundedModels=require('../src/tenant/funded/models'),pin=require('../src/tenant/funded/pin');
const transfer=require('../src/tenant/services/moneyTransfer.service'),treasury=require('../src/tenant/treasury/service'),cash=require('../src/tenant/services/cashDrawer.service');
const sms=require('../src/tenant/transferSms/service'),smsModels=require('../src/tenant/transferSms/models'),smsCrypto=require('../src/tenant/transferSms/crypto');
const commerce=require('../src/platform/services/commercial.service'),{permissionsFor}=require('../src/config/roles');
const {transferQueueCounts}=require('./notification-doctor');
let conn;
const fs=require('node:fs/promises'),backup=require('../src/tenant/backups/service'),backupModels=require('../src/tenant/backups/models'),archiveSnapshot=require('../src/tenant/backups/snapshot');
const backupDir='/tmp/cfh-business-backup-'+nonce;
process.env.TENANT_BACKUPS_ENABLED='true';process.env.TENANT_BACKUP_ENCRYPTION_KEY=crypto.randomBytes(32).toString('hex');process.env.TENANT_BACKUP_DIR=backupDir;process.env.APP_URL='http://localhost:3000';process.env.GOOGLE_DRIVE_CLIENT_ID='1234567890-test.apps.googleusercontent.com';process.env.GOOGLE_DRIVE_CLIENT_SECRET='test_google_secret_contract_only';
const oid=()=>String(new mongoose.Types.ObjectId()),owner={id:oid(),role:'Tenant Owner',permissions:['*'],allowedModules:['money_transfer'],authVersion:0},teller={id:oid(),role:'Money Transfer Operator',permissions:permissionsFor('Money Transfer Operator'),allowedModules:['money_transfer'],authVersion:0};
const decision={decision:'approve',note:'Independent source evidence and actual counted funds reviewed'};
const input=()=>({idempotencyKey:crypto.randomUUID(),evidenceReference:'ACTUAL-COUNT-'+nonce,note:'Actual collected cash and signed transfer instruction inspected'});
const delivered=[];
const transport=async value=>{delivered.push(value);return {status:'accepted',messageId:'SM'+'a'.repeat(32),providerState:'queued'};};
function workerCredentials(){process.env.TWILIO_ACCOUNT_SID='AC'+'1'.repeat(32);process.env.TWILIO_AUTH_TOKEN='2'.repeat(32);process.env.TWILIO_FROM_NUMBER='+256700999000';}
async function main(){
 await connectPlatformMongo();require('../src/config/mongoTopology').verifyReplicaPrimary(await mongoose.connection.db.admin().command({hello:1}));
 await Tenant.createIndexes();await require('../src/platform/models/LoginThrottle').createIndexes();conn=getTenantConnection(slug);await funded.prepareIndexes(conn);
 const terms=commerce.planSnapshot({...commerce.asPlanVersion({...require('../src/data/store').plans.find(plan=>plan.code==='enterprise'),code:'transfer_sms_probe',modules:['money_transfer']}),status:'published'});
 const tenant=await Tenant.create({name:'SMS transfer proof',slug,dbName:conn.name,owner:'Owner',email:`${nonce}@example.invalid`,plan:terms.planCode,status:'active',setupStatus:'complete',enabledModules:['money_transfer'],seatsReserved:2,branchCount:1,subscription:{...terms,status:'granted',source:'manual_admin_grant',generation:1,periodStart:new Date(Date.now()-60000),periodEnd:new Date(Date.now()+86400000)}});
 const branch=await core.branchModel(conn).create({name:'Main payout office',code:'main',currency:'UGX',createdBy:owner.id,updatedBy:owner.id});
 owner.branchId=teller.branchId=String(branch._id);
 for(const actor of [owner,teller])await core.tenantUserModel(conn).create({_id:actor.id,name:actor.role,email:`${actor.id}@example.invalid`,passwordHash:'isolated-test-only',role:actor.role,branchId:branch._id,allowedModules:['money_transfer'],authVersion:0,...(actor===owner?{mfaEnabledAt:new Date()}: {})});
 async function opened(kind,code,balance,operatorId){const account=await treasury.createAccount(conn,tenant,owner,{kind,code,name:code,currency:'UGX',isDefault:true,...(operatorId?{operatorId}:{})});const observation=await treasury.requestObservation(conn,tenant,teller,account._id,{kind:'opening',actualBalance:balance,observedAt:new Date(Date.now()-1000).toISOString(),evidenceType:kind==='cash'?'cash_count':'transfer_register',evidenceReference:'OPEN-'+code,note:'Actual original balances independently counted before operating',idempotencyKey:crypto.randomUUID()});await treasury.reviewObservation(conn,tenant,owner,observation.observation._id,decision);return account;}
 const drawer=await opened('cash','TELLER_CASH','1000000',teller.id),payable=await opened('transfer_clearing','TRANSFER_PAYABLE','0');
 const shift=await cash.open(conn,tenant,teller,{openingCash:'1000000'});await cash.decideOpening(conn,tenant,owner,shift._id,decision);
 async function request(){const source=(await transfer.createRequest(conn,tenant,teller,{senderName:'Typed Sender',senderPhone:'+256700111222',senderCountry:'UG',receiverName:'Typed Receiver',receiverPhone:'+256700123456',receiverCountry:'UG',currency:'UGX',amount:'10000',fee:'100',transferMethod:'Cash',idempotencyKey:crypto.randomUUID()})).order;const collection=(await funded.request(conn,tenant,teller,'money_transfer',source._id,input())).execution;return {source,collection};}

 const view=await backup.overview(conn,tenant,owner),policy=view.policy;assert.equal(policy.scopeKey,'tenant');assert.equal(view.googleConfigured,true);
 await assert.rejects(backup.overview(conn,tenant,teller),{status:403});
 await backup.requestBackup(conn,tenant,owner);const first=await backup.processPolicy(conn,tenant,policy._id);assert.equal(first.state,'complete');assert.equal(first.target,'fallback');
 let archives=await backupModels.models(conn).archive.find({policyId:policy._id}).lean();assert.equal(archives.length,1);
 const downloaded=await backup.readArchive(conn,tenant,owner,String(archives[0]._id));assert(!downloaded.body.includes(Buffer.from('scratch-not-a-real-password')));const verifyResult=require('node:child_process').spawnSync(process.execPath,['scripts/tenant-archive.js','verify','--file',backupDir+'/'+tenant._id+'/'+archives[0].filename],{encoding:'utf8',env:process.env});assert.equal(verifyResult.status,0,verifyResult.stderr);assert.equal(JSON.parse(verifyResult.stdout).verified,true);
 assert.equal(backup.archiveMetadata(downloaded.body).tenantId,String(tenant._id));
 const decoded=backup.verify(downloaded.body,tenant,policy,archives[0].digest),text=JSON.stringify(decoded);
 for(const forbidden of ['passwordHash','mfaSecretEncrypted','pinEncrypted','pinHash','refreshEncrypted','verificationDigest'])assert(!text.includes('"'+forbidden+'"'),forbidden);
 assert.equal(decoded.data.tables.fundAccounts.length,2);assert(decoded.data.tables.ledgerPostings.length>0);
 const localFile=backupDir+'/'+tenant._id+'/'+archives[0].filename,temporarilyMoved=localFile+'.probe';
 await fs.rename(localFile,temporarilyMoved);try{await assert.rejects(backup.readArchive(conn,tenant,owner,String(archives[0]._id)),error=>error.status===503&&error.code==='BACKUP_ARCHIVE_UNAVAILABLE');}finally{await fs.rename(temporarilyMoved,localFile);}
 const damaged=Buffer.from(downloaded.body);damaged[damaged.length-1]^=1;await fs.writeFile(localFile,damaged);try{await assert.rejects(backup.readArchive(conn,tenant,owner,String(archives[0]._id)),error=>error.status===503&&error.code==='BACKUP_VERIFICATION_FAILED');}finally{await fs.writeFile(localFile,downloaded.body);}
 const snapshot1=await archiveSnapshot.capture(conn,tenant,policy);await backup.requestBackup(conn,tenant,owner);assert.equal((await backup.processPolicy(conn,tenant,policy._id)).state,'no_changes');assert.equal(await backupModels.models(conn).archive.countDocuments(),1);
 const snapshot2=await archiveSnapshot.capture(conn,tenant,policy);assert.equal(snapshot1.digest,snapshot2.digest,'backup metadata and audit writes do not manufacture business changes');
 const tampered=Buffer.from(downloaded.body);tampered[tampered.length-1]^=1;assert.throws(()=>backup.verify(tampered,tenant,policy,archives[0].digest));assert.throws(()=>backup.verify(downloaded.body,tenant,{...policy,scopeKey:'branch_'+branch._id},archives[0].digest));
 const fakeSession={};const authorize=new URL(await backup.startConnect(conn,tenant,owner,fakeSession));assert.equal(authorize.origin,'https://accounts.google.com');assert.equal(authorize.searchParams.get('scope'),'https://www.googleapis.com/auth/drive.appdata');assert.equal(authorize.searchParams.get('code_challenge_method'),'S256');
 await assert.rejects(backup.finishConnect(conn,tenant,owner,fakeSession,{state:'0'.repeat(64),code:'invalid-code'}),{status:400});
 await backup.startConnect(conn,tenant,owner,fakeSession);const state=fakeSession.googleBackup.state;
 const fetcher=async(url,options)=>{assert.equal(url,'https://oauth2.googleapis.com/token');assert.equal(options.redirect,'error');assert(new URLSearchParams(options.body).get('code_verifier'));return new Response(JSON.stringify({token_type:'Bearer',access_token:'access_token_test_only_123456789',refresh_token:'refresh_token_test_only_123456789',scope:'https://www.googleapis.com/auth/drive.appdata'}),{status:200,headers:{'Content-Type':'application/json'}});};
 await backup.finishConnect(conn,tenant,owner,fakeSession,{state,code:'mock-code-only'}, {fetcher});assert.equal(fakeSession.googleBackup,undefined);assert.equal((await backupModels.models(conn).policy.findById(policy._id).lean()).refreshEncrypted,undefined);
 const encryptedPolicy=await backupModels.models(conn).policy.findById(policy._id).select('+refreshEncrypted').lean();assert(!encryptedPolicy.refreshEncrypted.includes('refresh_token_test_only'));
 const fullDrive=async()=>{throw Object.assign(Error('Simulated Drive quota'),{code:'BACKUP_GOOGLE_QUOTA_OR_ACCESS'});};assert.equal((await backup.processPolicy(conn,tenant,policy._id,{upload:fullDrive})).target,'fallback');assert.equal((await backupModels.models(conn).policy.findById(policy._id)).failureCode,'BACKUP_GOOGLE_QUOTA_OR_ACCESS');
 await backup.requestBackup(conn,tenant,owner);let uploads=0;const upload=async(refresh,archive,body)=>{uploads++;assert.equal(refresh,'refresh_token_test_only_123456789');backup.verify(body,tenant,policy,archive.digest);return {fileId:'mock_drive_id_'+String(archive._id)};};
 const copies=await Promise.all([backup.processPolicy(conn,tenant,policy._id,{upload}),backup.processPolicy(conn,tenant,policy._id,{upload})]);assert.equal(copies.filter(Boolean).length,1);assert.equal(uploads,1);assert.equal(copies.find(Boolean).target,'drive');
 // New and changed business rows are detected; both are full snapshots.
 await core.branchModel(conn).updateOne({_id:branch._id},{$set:{address:'Updated business address'}});await backup.requestBackup(conn,tenant,owner);assert.equal((await backup.processPolicy(conn,tenant,policy._id,{upload})).state,'complete');assert.equal(await backupModels.models(conn).archive.countDocuments(),2);
 const other=await core.branchModel(conn).create({name:'Private other office',code:'other',currency:'UGX',createdBy:owner.id,updatedBy:owner.id}),manager={id:oid(),role:'Branch Manager',branchId:String(branch._id),authVersion:0,permissions:permissionsFor('Branch Manager'),allowedModules:['money_transfer']};
 await core.tenantUserModel(conn).create({_id:manager.id,name:'Scoped Manager',email:manager.id+'@example.invalid',passwordHash:'must-not-export',role:manager.role,branchId:manager.branchId,status:'active',authVersion:0,mfaEnabledAt:new Date(),allowedModules:manager.allowedModules});
 const managerPolicy=(await backup.overview(conn,tenant,manager)).policy;const branchSnapshot=await archiveSnapshot.capture(conn,tenant,managerPolicy);assert.equal(branchSnapshot.data.tables.branches.length,1);assert(!JSON.stringify(branchSnapshot).includes('Private other office'));assert.equal(branchSnapshot.data.tables.workspaceProfile,undefined);
 await assert.rejects(backup.readArchive(conn,tenant,manager,String(archives[0]._id)),{status:404});
 await backup.updateSettings(conn,tenant,owner,{closingTime:'18:00',timezone:'Africa/Juba',autoEnabled:'true'});const schedule=await backupModels.models(conn).policy.findById(policy._id).lean();assert.equal(backup.scheduledDay(schedule,new Date('2026-11-08T16:29:00Z')),null);assert.equal(backup.scheduledDay(schedule,new Date('2026-11-08T16:30:00Z')),'2026-11-08');assert.equal(backup.scheduledDay({...schedule,closingTime:'23:45'},new Date('2026-11-08T22:15:00Z')),'2026-11-08');
 await backup.schedule(conn,tenant,new Date('2026-11-08T16:31:00Z'));assert.equal((await backupModels.models(conn).policy.findById(policy._id)).lastScheduledDay,'2026-11-08');await backup.processPolicy(conn,tenant,policy._id,{upload});const repeated=await backup.schedule(conn,tenant,new Date('2026-11-08T16:32:00Z'));assert.equal(repeated,0);
 await core.tenantUserModel(conn).updateOne({_id:owner.id},{$set:{status:'disabled'},$inc:{authVersion:1}});await assert.rejects(backup.requestBackup(conn,tenant,owner),{status:403});
 console.log('PASS: consistent encrypted business snapshots; no auth/PIN payloads; branch-manager isolation; durable fallback; change detection and no-change dedup; OAuth PKCE/state; encrypted refresh token; Drive quota/recovery; worker leases; closing + 30 minutes and revoked access. Google calls mocked; no live Drive connection.');
}
async function cleanup(){if(mongoose.connection.readyState===1&&mongoose.connection.name===platformName&&/^cfh_tenant_backup_[a-f0-9]{16}$/.test(platformName)){if(conn?.name===require('../src/config/tenantDatabaseName').tenantDbNameFromSlug(slug))await conn.db.dropDatabase();await mongoose.connection.db.dropDatabase();}await mongoose.disconnect();if(/^\/tmp\/cfh-business-backup-[a-f0-9]{16}$/.test(backupDir))await fs.rm(backupDir,{recursive:true,force:true});}
main().catch(error=>{console.error('TENANT BACKUP INTEGRATION FAILED:',error.stack||error.message);process.exitCode=1;}).finally(()=>cleanup().catch(error=>{console.error('Transfer SMS scratch cleanup failed:',error.message);process.exitCode=1;}));
