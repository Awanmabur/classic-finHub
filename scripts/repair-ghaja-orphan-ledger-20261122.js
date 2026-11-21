'use strict';
/*
 * One-time, evidence-fenced reconstruction of a missing 2026-11-21 opening
 * journal for a specific tenant. Default is read-only. Run against the web
 * database principal only after independently verifying a restorable backup.
 * The transaction never edits balances, approved observations or movements.
 */
const mongoose=require('mongoose');
const {connectPlatformMongo,getTenantConnection}=require('../src/config/mongo');
const Tenant=require('../src/platform/models/Tenant');
const core=require('../src/tenant/models');
const treasury=require('../src/tenant/treasury/models');
const ledger=require('../src/tenant/services/ledger.service');
const {Types}=mongoose;
const A=Types.ObjectId;
const EXPECT={
 slug:'ghaja',
 database:'classicfin_tenant_ghaja_db',
 account:'6b01ebb985879b148eb41172',
 observation:'6b01ec0f85879b148eb41196',
 journal:'6b01ec3f85879b148eb41218',
 branch:'6af8e0b9b09b676ef3c65289',
 currency:'USD',opening:'100000'
};
function deny(message){throw Error('REFUSED: '+message);}
const id=x=>new A(x);
const equals=(a,b)=>String(a)===String(b);
async function verify(conn,session){
 const Account=treasury.models(conn).account;
 const obsModel=treasury.models(conn).observation;
 const counterModel=treasury.models(conn).counter;
 const a=await Account.findById(EXPECT.account).session(session).lean();
 const obs=await obsModel.findById(EXPECT.observation).session(session).lean();
 const counter=await counterModel.findOne({branchId:id(EXPECT.branch),currency:EXPECT.currency,purpose:'opening_equity'}).session(session).lean();
 const audit=await core.auditEventModel(conn).findOne({action:'ledger.journal.posted',targetId:id(EXPECT.journal)}).session(session).lean();
 const approved=await core.auditEventModel(conn).findOne({action:'treasury.observation.approved',targetId:id(EXPECT.observation)}).session(session).lean();
 if(!a||!obs||!counter||!audit||!approved)deny('surviving approved opening and both original audit events are required');
 if(!equals(a.branchId,EXPECT.branch)||a.kind!=='cash'||a.currency!==EXPECT.currency||a.status!=='active'||
    !equals(a.openingObservationId,obs._id)||!equals(obs.accountId,a._id)||
    !equals(obs.openingJournalId,EXPECT.journal)||obs.status!=='approved'||obs.kind!=='opening'||
    !equals(obs.reviewedBy,audit.actorId)||!equals(approved.actorId,audit.actorId)||
    !equals(counter.branchId,a.branchId)||!equals(counter.tenantId,a.tenantId)||
    String(obs.actualMinor)!==EXPECT.opening||String(a.openingBalanceMinor)!==EXPECT.opening||
    String(a.bookBalanceMinor)!==EXPECT.opening||a.sequence!==0||
    !equals(audit.metadata?.branchId,EXPECT.branch)||
    audit.metadata?.sourceRef!=='TRS:OPEN:'+EXPECT.observation||
    audit.metadata?.sourceType!=='treasury')deny('historical opening evidence is inconsistent');
 if(!a.openingApprovedAt||!a.openingObservedAt||!a.createdBy||!counter.ledgerAccountId)deny('historical chart metadata is incomplete');
 const AccountLedger=core.ledgerAccountModel(conn),Journal=core.ledgerJournalModel(conn),Posting=core.ledgerPostingModel(conn);
 const [mapping,equity,journal,priorRef,postingCount,movementCount,otherPosting,otherJournal]=await Promise.all([
   AccountLedger.findById(a.ledgerAccountId).session(session).lean(),
   AccountLedger.findById(counter.ledgerAccountId).session(session).lean(),
   Journal.findById(EXPECT.journal).session(session).lean(),
   Journal.findOne({sourceType:'treasury',sourceRef:'TRS:OPEN:'+EXPECT.observation}).session(session).lean(),
   Posting.countDocuments({journalId:id(EXPECT.journal)}).session(session),
   treasury.models(conn).movement.countDocuments({accountId:a._id}).session(session),
   Posting.countDocuments({accountId:{$in:[a.ledgerAccountId,counter.ledgerAccountId]}}).session(session),
   Journal.countDocuments({branchId:a.branchId,sourceType:'treasury',currency:EXPECT.currency}).session(session)
 ]);
 if(movementCount!==0)deny('there are posted movements; this utility only handles zero-movement openings');
 if(mapping||equity||journal||priorRef||postingCount||otherPosting||otherJournal)deny('partial or conflicting ledger evidence exists; investigate manually');
 const lines=[
   {accountCode:a.ledgerCode,side:'debit',amountMinor:EXPECT.opening},
   {accountCode:counter.ledgerCode,side:'credit',amountMinor:EXPECT.opening}
 ];
 const validated=ledger.validateJournal({
   branchId:EXPECT.branch,actorId:String(audit.actorId),sourceType:'treasury',
   sourceRef:'TRS:OPEN:'+EXPECT.observation,currency:EXPECT.currency,lines
 });
 return {a,obs,counter,audit,validated};
}
async function run(){
 const apply=process.argv.includes('--apply');
 if(process.argv.some(x=>x!=='--apply'))deny('only --apply is supported');
 if(process.env.NODE_ENV!=='production')deny('this narrowly scoped repair requires the production environment');
 if(apply&&process.env.CLASSICFIN_REPAIR_BACKUP_VERIFIED!=='RESTORABLE_BACKUP_CONFIRMED')
   deny('verify an independent restorable database backup before --apply');
 await connectPlatformMongo();
 try {
  const tenant=await Tenant.findOne({slug:EXPECT.slug,dbName:EXPECT.database,status:{$in:['active','trial']}}).lean();
  if(!tenant)deny('expected tenant identity was not found');
  const conn=getTenantConnection(tenant.slug);
  if(conn.name!==EXPECT.database)deny('tenant database name mismatch');
  if(!apply){
   const evidence=await verify(conn,null);
   console.log(JSON.stringify({mode:'dry-run',eligible:true,account:String(evidence.a._id),
     expectedLedgerJournal:EXPECT.journal,reason:'original signed-off opening survives but its ledger graph is absent'}));
   return;
  }
  const session=await conn.startSession();
  try{
   await session.withTransaction(async()=>{
    const v=await verify(conn,session);
    const a=v.a,c=v.counter;
    const AccountLedger=core.ledgerAccountModel(conn),Journal=core.ledgerJournalModel(conn),Posting=core.ledgerPostingModel(conn);
    await AccountLedger.create([
      {_id:a.ledgerAccountId,branchId:a.branchId,code:a.ledgerCode,name:a.name,
       currency:a.currency,category:'asset',createdBy:a.createdBy,createdAt:a.createdAt},
      {_id:c.ledgerAccountId,branchId:a.branchId,code:c.ledgerCode,
       name:'Treasury opening equity ('+a.currency+')',currency:a.currency,
       category:'equity',createdBy:v.audit.actorId,createdAt:v.audit.createdAt}
    ],{session,ordered:true});
    await Journal.create([{_id:id(EXPECT.journal),branchId:a.branchId,currency:a.currency,
      sourceType:'treasury',sourceRef:v.validated.sourceRef,
      fingerprint:v.validated.fingerprint,actorId:v.audit.actorId,createdAt:v.audit.createdAt}],{session});
    const byCode=new Map([[a.ledgerCode,a.ledgerAccountId],[c.ledgerCode,c.ledgerAccountId]]);
    await Posting.create(v.validated.lines.map((line,lineNo)=>({
      journalId:id(EXPECT.journal),branchId:a.branchId,currency:a.currency,
      accountId:byCode.get(line.accountCode),lineNo,side:line.side,
      amountMinor:line.amountMinor,createdAt:v.audit.createdAt
    })),{session,ordered:true});
    await require('../src/tenant/treasury/service').assertBookIntegrity(conn,session,a);
    await core.auditEventModel(conn).create([{action:'treasury.opening_ledger.reconstructed',
      actorId:v.audit.actorId,targetId:a._id,
      metadata:{branchId:String(a.branchId),observationId:EXPECT.observation,
        originalJournalId:EXPECT.journal,
        basis:'Original approved opening and ledger.journal.posted audit survived; missing documents reconstructed atomically',
        preservesBookBalance:true}}],{session});
   },{readConcern:{level:'snapshot'},writeConcern:{w:'majority'}});
   console.log(JSON.stringify({mode:'apply',reconstructed:true,account:EXPECT.account,
     journal:EXPECT.journal,balancesChanged:false}));
  }finally{await session.endSession();}
 }finally{await mongoose.disconnect();}
}
run().catch(error=>{
 console.error(JSON.stringify({repair:'stopped',message:String(error.message||'').startsWith('REFUSED:')?error.message:'Unverified condition or database operation failed; no changes should be assumed'}));
 process.exitCode=1;
});
