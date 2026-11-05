'use strict';
const crypto=require('crypto');
const mongoose=require('mongoose');
const {plans,modules}=require('../../data/store');
const PlanVersion=require('../models/PlanVersion');
const Tenant=require('../models/Tenant');
const UsageCounter=require('../models/UsageCounter');
const PlatformAuditLog=require('../models/PlatformAuditLog');
const outbox=require('./outbox.service');
const transition=require('./subscriptionTransition.policy');
const moduleKeys=new Set(modules.map(m=>m.key));
const BASIC_KEYS=new Set(['customers','receipts','reports']);
function err(message,status=400){const e=new Error(message);e.status=status;return e;}
function asPlanVersion(plan,version=1){
  return {code:plan.code,version,name:plan.name,description:plan.description,
    currency:plan.currency,priceMonthlyMinor:Math.round(plan.priceMonthly*100),priceYearlyMinor:Math.round(plan.priceYearly*100),
    trialMonths:plan.trialMonths,modules:[...plan.modules],limits:{...plan.limits}};
}
function checksum(data){return crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');}
async function publishCatalog({apply=false,Model=PlanVersion}={}){
  const results=[],missing=[];
  // Check all four plans before making ANY mutation. Published revisions cannot
  // be rewritten; a mismatched catalogue is a release conflict, not an upgrade.
  for(const plan of plans){
    const doc=asPlanVersion(plan);
    if(doc.modules.some(m=>!moduleKeys.has(m)&&!BASIC_KEYS.has(m)))throw err('Unknown plan module');
    const sourceHash=checksum(doc);
    const existing=await Model.findOne({code:doc.code,version:doc.version}).lean();
    if(existing){
      if(existing.sourceHash!==sourceHash)throw err(`Published ${doc.code} v${doc.version} conflicts with catalogue; publish a new version, never rewrite history`,409);
      results.push({code:doc.code,version:doc.version,state:'already-published'});
    }else{
      missing.push({...doc,sourceHash,publishedAt:new Date(),status:'published'});
      results.push({code:doc.code,version:doc.version,state:apply?'published':'would-publish'});
    }
  }
  if(apply && missing.length){
    const session=await mongoose.startSession();
    try{await session.withTransaction(async()=>{
      // MongoDB sessions cannot run parallel writes inside one transaction.
      await Model.create(missing,{session,ordered:true});
      // Local deployment operators may publish but cannot hide a catalogue
      // mutation: keep the audit entry in the same database transaction.
      await PlatformAuditLog.create([{actorId:'system:catalog-operator',action:'catalog.initial_published',moduleKey:'billing',
        recordId:'initial-catalogue',after:{plans:missing.map(p=>({code:p.code,version:p.version,sourceHash:p.sourceHash}))}}],{session});
    });}catch(e){if(e.code===11000)throw err('Concurrent catalogue publish. Inspect existing versions and retry.',409);throw e;}
    finally{await session.endSession();}
  }
  return results;
}

function validateNewVersion(raw){
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw err('Plan document must be an object');
  const expected=['code','name','description','currency','priceMonthlyMinor','priceYearlyMinor','trialMonths','modules','limits'];
  if(Object.keys(raw).some(k=>!expected.includes(k))||expected.some(k=>!Object.hasOwn(raw,k)))throw err('Plan file has unexpected or missing fields');
  if(!plans.some(p=>p.code===raw.code)||raw.currency!=='USD'||
    typeof raw.name!=='string'||raw.name.trim().length<3||raw.name.length>100||
    typeof raw.description!=='string'||raw.description.trim().length<10||raw.description.length>1000||
    ![raw.priceMonthlyMinor,raw.priceYearlyMinor].every(n=>Number.isSafeInteger(n)&&n>=0&&n<=100000000)||
    !Number.isSafeInteger(raw.trialMonths)||raw.trialMonths<0||raw.trialMonths>3||
    !Array.isArray(raw.modules)||raw.modules.length>20||new Set(raw.modules).size!==raw.modules.length||
    raw.modules.some(m=>typeof m!=='string'||(!moduleKeys.has(m)&&!BASIC_KEYS.has(m))))throw err('Invalid plan identity, prices, or modules');
  const keys=['users','branches','transactionsPerMonth','smsPerMonth','storageMb'];
  if(!raw.limits||typeof raw.limits!=='object'||Array.isArray(raw.limits)||
    Object.keys(raw.limits).length!==keys.length||keys.some(k=>!Number.isSafeInteger(raw.limits[k])||raw.limits[k]<(k==='users'||k==='branches'?1:0)||raw.limits[k]>100000000))throw err('Invalid plan limits');
  return {...raw,modules:[...raw.modules],limits:{...raw.limits}};
}
async function publishNextVersion(raw,reason,{apply=false}={}){
  const values=validateNewVersion(raw);
  if(typeof reason!=='string'||reason.trim().length<20||reason.trim().length>600)throw err('Publication requires a change justification of 20–600 characters');
  const current=await latestPublished(values.code);
  if(!current)throw err('Initial plan catalogue must be published first',409);
  const version=current.version+1;
  const doc={...values,version};
  const sourceHash=checksum(doc);
  if(apply){
    const session=await mongoose.startSession();
    try{await session.withTransaction(async()=>{
      await PlanVersion.create([{...doc,sourceHash,status:'published',publishedAt:new Date()}],{session});
      await PlatformAuditLog.create([{actorId:'system:catalog-operator',action:'catalog.plan_version_published',moduleKey:'billing',
        recordId:values.code,after:{version,sourceHash,reason:reason.trim()}}],{session});
    });}catch(e){if(e.code===11000)throw err('Plan was published concurrently. Inspect versions before retrying.',409);throw e;}
    finally{await session.endSession();}
  }
  return {code:values.code,version,sourceHash,action:apply?'published':'would-publish',previousVersion:current.version};
}

function planSnapshot(doc){
  if(!doc||doc.status!=='published'||!Number.isSafeInteger(doc.version)||doc.version<1)throw err('Published plan unavailable',409);
  const limits=doc.limits||{};
  if(!Array.isArray(doc.modules)||doc.modules.some(k=>!moduleKeys.has(k)&&!BASIC_KEYS.has(k))||
    !['users','branches','transactionsPerMonth','smsPerMonth','storageMb'].every(k=>Number.isSafeInteger(limits[k])&&limits[k]>=0))throw err('Published plan is malformed',409);
  return {planCode:doc.code,planVersion:doc.version,planName:doc.name,currency:doc.currency,
    priceMonthlyMinor:doc.priceMonthlyMinor,priceYearlyMinor:doc.priceYearlyMinor,
    modules:doc.modules.filter(m=>moduleKeys.has(m)),limits:{users:limits.users,branches:limits.branches,
      transactionsPerMonth:limits.transactionsPerMonth,smsPerMonth:limits.smsPerMonth,storageMb:limits.storageMb}};
}
function effectiveSubscription(tenant,now=new Date()){
  const s=tenant?.subscription;
  if(!tenant||!s||!['trial','granted'].includes(s.status)||!['trial','active'].includes(tenant.status)||
    !s.periodEnd||!(new Date(s.periodEnd)>now)||!(new Date(s.periodStart)<=now)||
    !Number.isSafeInteger(s.generation)||s.generation<1||s.planCode!==tenant.plan||
    !Number.isSafeInteger(s.planVersion)||!Array.isArray(s.modules)||!s.limits||
    !Number.isSafeInteger(s.limits.users)||s.limits.users<1||
    !Number.isSafeInteger(s.limits.branches)||s.limits.branches<1||
    !Number.isSafeInteger(s.limits.transactionsPerMonth)||s.limits.transactionsPerMonth<0||
    !Array.isArray(tenant.enabledModules)||s.modules.some(k=>!moduleKeys.has(k)))return null;
  return s;
}
function limitsFor(tenant){
  const plan=effectiveSubscription(tenant);
  const extra=require('./moduleSubscriptions.service').activeGrants(tenant);
  if(!plan&&!extra.length)return null;
  return {users:Math.max(plan?.limits?.users||0,...extra.map(g=>g.limits.users)),
    branches:Math.max(plan?.limits?.branches||0,...extra.map(g=>g.limits.branches)),
    transactionsPerMonth:plan?.limits?.transactionsPerMonth||0,
    smsPerMonth:plan?.limits?.smsPerMonth||0,storageMb:plan?.limits?.storageMb||0};
}
function planForTenant(tenant){const s=effectiveSubscription(tenant);return s?{code:s.planCode,name:s.planName,currency:s.currency,priceMonthly:s.priceMonthlyMinor/100,priceYearly:s.priceYearlyMinor/100,modules:s.modules,limits:s.limits}:null;}
async function publishedPlans(){return PlanVersion.find({status:'published'}).sort({code:1,version:-1}).lean();}
async function latestPublished(code){return PlanVersion.findOne({code,status:'published'}).sort({version:-1}).lean();}
function grantInput(input){
  const planCode=String(input.planCode||'');const days=Number(input.days);
  const reason=String(input.reason||'').trim();
  if(!/^[a-z][a-z0-9_]{1,40}$/.test(planCode)||!Number.isSafeInteger(days)||days<1||days>366||reason.length<20||reason.length>600)
    throw err('Choose a published plan, a 1–366-day term and a 20–600-character justification');
  return {planCode,days,reason};
}
function computeGrantPeriod(previous,snapshot,days,now=new Date()){
  const same=previous && previous.status==='granted' && previous.planCode===snapshot.planCode &&
    previous.planVersion===snapshot.planVersion && new Date(previous.periodEnd)>now;
  const start=same?new Date(previous.periodStart):now;
  const base=same?new Date(previous.periodEnd):now;
  const end=new Date(base.getTime()+days*86400000);
  if(end.getTime()-now.getTime()>366*86400000)throw err('A subscription term cannot extend beyond 366 days from today',409);
  // Same published plan extensions preserve the current usage allocation.
  return {start,end,generation:same?previous.generation:(previous?.generation||0)+1,extension:Boolean(same)};
}
function actorCheck(actor){if(!actor?.id||!actor.permissions?.includes('*'))throw err('Super Admin required',403);}
function validateCapacity(tenant,version){
  // Standalone subscriptions may provide seats and branches in excess of the
  // base-plan limits. Do not reject a valid downgrade that retains that capacity.
  // A manual grant also reactivates a past-due workspace. Evaluate the
  // capacities that will exist after that transition, not the suspended view.
  const grants=require('./moduleSubscriptions.service').activeGrants({...tenant,status:'active'});
  const limits=transition.combinedCapacity(version.limits,grants);
  if(tenant.seatsReserved>limits.users||tenant.branchCount>limits.branches)
    throw err('Cannot apply a plan below combined staff seats or branch capacity. Reduce usage first.',409);
}
async function grantTenantSubscription(tenantId,actor,input){
  actorCheck(actor);if(!mongoose.isValidObjectId(tenantId))throw err('Tenant not found',404);
  const {planCode,days,reason}=grantInput(input);
  const version=await latestPublished(planCode);
  if(!version)throw err('Plan is not published. Publish the catalogue first.',409);
  const snapshot=planSnapshot(version);
  const session=await mongoose.startSession();let updated;
  const notificationKey=`subscription.granted:${crypto.randomUUID()}`;
  try{await session.withTransaction(async()=>{
    const prior=await Tenant.findById(tenantId).session(session);
    if(!prior)throw err('Tenant not found',404);
    if(prior.status==='suspended')throw err('Suspended tenants require separate administrative reactivation before granting a subscription',409);
    validateCapacity(prior,snapshot);
    const {start,end,generation,extension}=computeGrantPeriod(prior.subscription,snapshot,days);
    // Removing a base-plan entitlement must not remove a staff assignment
    // covered by an independent, active module grant.
    const independentGrants=require('./moduleSubscriptions.service').activeGrants({...prior.toObject(),status:'active'});
    const removed=transition.modulesLost(prior.enabledModules||[],snapshot.modules,independentGrants);
    const previous=prior.subscription?.status?{planCode:prior.subscription.planCode,planVersion:prior.subscription.planVersion,
      status:prior.subscription.status,periodEnd:prior.subscription.periodEnd}:null;
    const subscription={...snapshot,status:'granted',source:'manual_admin_grant',periodStart:start,periodEnd:end,generation};
    updated=await Tenant.findOneAndUpdate({_id:tenantId,__v:prior.__v},{
      $set:{plan:planCode,status:'active',subscription,enabledModules:snapshot.modules,trialEndsAt:null},$inc:{__v:1}
    },{session,new:true});
    if(!updated)throw err('Concurrent subscription change. Refresh and retry.',409);
    if(removed.length){
      const conn=require('../../config/mongo').getTenantConnection(prior.slug);
      const tenantModels=require('../../tenant/models');
      // A downgrade must not leave unfinished internal reviews inaccessible.
      if(removed.includes('mobile_money')){
        const pending=await tenantModels.mobileTransactionModel(conn).exists({reviewState:{$in:['awaiting_review',null]},status:'pending_verification'}).session(session);
        if(pending)throw err('Resolve pending internal Mobile Money reviews before removing that module',409);
      }
      // Contract stored staff and unaccepted invitation grants atomically with
      // the tenant subscription; revoke sessions holding former permissions.
      await tenantModels.tenantUserModel(conn).updateMany({allowedModules:{$in:removed}},
        {$pull:{allowedModules:{$in:removed}},$inc:{authVersion:1}},{session});
      await tenantModels.staffInviteModel(conn).updateMany({status:'pending',allowedModules:{$in:removed}},
        {$pull:{allowedModules:{$in:removed}}},{session});
      await tenantModels.auditEventModel(conn).create([{action:'subscription.modules_contracted',actorId:actor.id,
        targetId:prior._id,metadata:{removed,planCode,snapshotVersion:snapshot.planVersion}}],{session});
    }
    await PlatformAuditLog.create([{actorId:String(actor.id),actorName:String(actor.name||''),action:'subscription.manual_grant',
      moduleKey:'billing',recordId:String(tenantId),before:previous,after:{planCode,version:snapshot.planVersion,days,periodEnd:end,reason,extension,removedModules:removed,source:'manual_admin_grant'}}],{session});
    await outbox.enqueue({key:notificationKey,type:'subscription.granted',tenantId:prior._id,
      payload:{to:prior.email,tenantName:prior.name,planName:snapshot.planName,expiresAt:end},session});
  });return updated;
  }finally{await session.endSession();}
}
async function revokeTenantSubscription(tenantId,actor,input){
  actorCheck(actor);if(!mongoose.isValidObjectId(tenantId))throw err('Tenant not found',404);
  const reason=String(input?.reason||'').trim();if(reason.length<20||reason.length>600)throw err('A 20–600-character revocation reason is required');
  const session=await mongoose.startSession();let updated;
  const notificationKey=`subscription.revoked:${crypto.randomUUID()}`;
  try{await session.withTransaction(async()=>{
    const prior=await Tenant.findById(tenantId).session(session);
    if(!prior?.subscription||!['trial','granted'].includes(prior.subscription.status))throw err('No active manual/trial entitlement to revoke',409);
    updated=await Tenant.findOneAndUpdate({_id:tenantId,__v:prior.__v},{$set:{'subscription.status':'revoked'},$inc:{__v:1}},{new:true,session});
    if(!updated)throw err('Concurrent change. Refresh and retry.',409);
    await PlatformAuditLog.create([{actorId:String(actor.id),actorName:String(actor.name||''),action:'subscription.revoked',
      moduleKey:'billing',recordId:String(tenantId),before:{status:prior.subscription.status},after:{status:'revoked',reason}}],{session});
    await outbox.enqueue({key:notificationKey,type:'subscription.revoked',tenantId:prior._id,
      payload:{to:prior.email,tenantName:prior.name,planName:prior.subscription.planName},session});
  });return updated;
  }finally{await session.endSession();}
}
function periodKey(now=new Date()){return now.toISOString().slice(0,7);}
// Reserve usage in the SAME MongoDB session as the business record. MongoDB's
// unique counter and conditional increment prevent exceeding the quota even
// with multiple application replicas. Abort the transaction to refund usage.
async function reserveUsage(tenant,metric,session,now=new Date(),Model=UsageCounter){
  const s=effectiveSubscription(tenant,now);
  // Prefer base-plan allocation when it covers this module. Standalone add-ons
  // use their own generation so plan changes cannot silently reset quota.
  const moduleName={mobile_money_records:'mobile_money',money_transfer_requests:'money_transfer',banking_requests:'banking',forex_quotes:'forex'}[metric];
  if(!moduleName)throw err('Unknown usage metric',403);
  const usePlan=s && s.modules.includes(moduleName) && tenant.enabledModules?.includes(moduleName);
  const grant=!usePlan
    ? require('./moduleSubscriptions.service').effectiveModuleGrant(tenant,moduleName,now) : null;
  if(!usePlan&&!grant)throw err('This module has no active subscription',403);
  const limit=usePlan?s.limits.transactionsPerMonth:grant?.limits.recordsPerMonth;
  if(!Number.isSafeInteger(limit))throw err('Usage metric is unavailable',403);
  if(limit===0)throw err('Monthly transaction allocation exhausted',429);
  const filter={tenantId:tenant._id,generation:usePlan?s.generation:1000000000+grant.generation,period:periodKey(now),metric:usePlan?metric:`addon_${metric}`};
  try{
    const result=await Model.findOneAndUpdate({...filter,quantity:{$lt:limit}},{$inc:{quantity:1},$setOnInsert:{...filter}},
      {upsert:true,new:true,session});
    if(!result||result.quantity>limit)throw err('Monthly transaction allocation exhausted',429);
    return result;
  }catch(e){if(e.code===11000)throw err('Monthly transaction allocation exhausted',429);throw e;}
}
module.exports={err,asPlanVersion,checksum,publishCatalog,planSnapshot,effectiveSubscription,limitsFor,planForTenant,
  publishedPlans,latestPublished,validateNewVersion,publishNextVersion,grantInput,computeGrantPeriod,validateCapacity,grantTenantSubscription,revokeTenantSubscription,periodKey,reserveUsage};
