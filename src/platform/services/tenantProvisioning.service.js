const crypto = require('crypto');
const mongoose = require('mongoose');
const Tenant = require('../models/Tenant');
const OwnerInvite = require('../models/OwnerInvite');
const AccountIdentity = require('../models/AccountIdentity');
const PlatformAuditLog=require('../models/PlatformAuditLog');
const PlatformAdmin=require('../models/PlatformAdmin');
const {latestPublished,planSnapshot}=require('./commercial.service');
const { tenantDbNameFromSlug, getTenantConnection, NAME } = require('../../config/mongo');
const { appUrl } = require('../../config/env');
const { MAX_SLUG_LENGTH } = require('../../config/tenantDatabaseName');
const { normalizeEmail } = require('./authentication.service');

function invalid(message) { return Object.assign(new Error(message), { status: 400 }); }
function text(value) { return typeof value === 'string' ? value.trim() : ''; }
function rejected(message,status=403){return Object.assign(new Error(message),{status});}
async function authorizeAdmin(actor,session){
  if(!actor?.id||!actor.permissions?.includes('*')||!/^[a-f0-9]{24}$/i.test(String(actor.id)))throw rejected('Active platform Super Admin access is required. Sign in again.');
  const version=actor.authVersion||0;
  const filter={_id:actor.id,status:'active',role:'Super Admin',authVersion:version===0?{$in:[0,null]}:version,
    ...(require('../../config/mfaPolicy').enabled()?{mfaEnabledAt:{$ne:null}}:{})};
  // The transaction write fences revocation while provisioning was preparing DBs.
  const account=await (session?PlatformAdmin.findOneAndUpdate(filter,{$inc:{__v:1}},{new:true,session}):PlatformAdmin.findOne(filter)).lean();
  if(!account||!await AccountIdentity.exists({kind:'platform',accountId:account._id,email:account.email,tenantId:null}).session(session||null))throw rejected('Active platform Super Admin access is required. Sign in again.');
  return account;
}
function storageFailure(error){
  let message='MongoDB could not prepare this tenant database. Check tenant database access and Atlas collection/index limits, then retry. No tenant was created.';
  let status=503,code='TENANT_STORAGE_SETUP_FAILED';
  if(error?.code===13||error?.codeName==='Unauthorized'){
    status=403;code='TENANT_STORAGE_PERMISSION_REQUIRED';
    message='The database user can access the platform but cannot prepare tenant storage. In Atlas Database Access, grant the web database user permission to create collections and indexes in this tenant database, then retry. No tenant was created.';
  }else if(error?.code===18||error?.codeName==='AuthenticationFailed'){
    code='TENANT_STORAGE_AUTHENTICATION_FAILED';message='MongoDB authentication failed while preparing tenant storage. Check the database credentials and restart the application before retrying. No tenant was created.';
  }else if([85,86,11000].includes(error?.code)){
    status=409;code='TENANT_STORAGE_INDEX_CONFLICT';message='The tenant database contains conflicting indexes or duplicate records. Review the existing database and index migration before retrying. No tenant was created.';
  }else if(['MongoNetworkError','MongoNetworkTimeoutError','MongoServerSelectionError','MongooseServerSelectionError'].includes(error?.name)||['ECONNREFUSED','ETIMEDOUT','ENOTFOUND'].includes(error?.code)){
    code='TENANT_STORAGE_UNAVAILABLE';message='MongoDB became unavailable while preparing the workspace. Check connectivity and retry when the database is ready. No tenant was created.';
  }
  return Object.assign(new Error(message,{cause:error}),{status,code,provisioningError:true});
}
async function prepareTenantStorage(connection){
  // Index creation below is explicit and awaited. Avoid racing it with a second
  // automatic development build of every newly compiled tenant model.
  connection.config.autoIndex=false;
  try{
    // These independent schema groups share the same awaited preflight barrier.
    // No tenant or invitation is published until every group has succeeded.
    await Promise.all([
      require('../../tenant/models').ensureTenantIndexes(connection),
      require('../../tenant/customerAccounts/models').ensureIndexes(connection),
      require('../../tenant/models/expenses').ensureExpenseIndexes(connection),
      require('../../tenant/workspace/models').ensure(connection),
      require('../../tenant/treasury/models').ensure(connection),
      require('../../tenant/treasury/funding.models').ensureIndexes(connection),
      require('../../tenant/funded/models').ensureIndexes(connection),
      require('../../tenant/pricing/models').ensure(connection)
    ]);
  }catch(error){throw storageFailure(error);}
}
function checkPayload(payload = {}) {
  const name = text(payload.name);
  const requestedSlug = text(payload.slug).toLowerCase();
  const slug = requestedSlug || name.toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '').slice(0, MAX_SLUG_LENGTH).replace(/-+$/g, '');
  const owner = text(payload.owner);
  const email = normalizeEmail(payload.email);
  const phone = text(payload.phone);
  const plan = text(payload.plan);
  if (!name || name.length > 150) throw invalid('Enter a tenant name of 1–150 characters.');
  if (!NAME.test(slug) || Buffer.byteLength(tenantDbNameFromSlug(slug))>38) throw invalid('Enter a tenant slug of 3–17 letters, numbers or hyphens. Atlas Free database names cannot exceed 38 bytes.');
  if (!owner || owner.length > 120) throw invalid('Enter an owner name of 1–120 characters.');
  if (!email) throw invalid('Enter a valid owner email of at most 254 characters.');
  if (phone.length > 40 || !/^[+0-9 ()-]*$/.test(phone)) throw invalid('Enter a valid phone number of at most 40 characters.');
  if (!/^[a-z][a-z0-9_]{1,40}$/.test(plan)) throw invalid('Choose an available published plan.');
  // Entitlements come only from the persisted published version below, never
  // from POST fields or the static starter catalogue.
  return { name, slug, owner, email, phone, plan, enabledModules: [] };
}
async function provisionTenant(payload, actor) {
  const valid = checkPayload(payload);
  await authorizeAdmin(actor);
  if (await Tenant.exists({slug: valid.slug})) {
    throw Object.assign(new Error('This tenant slug is already in use. Open the existing tenant from the tenant list, or choose a different slug for a different workspace.'), {status:409});
  }
  if(await AccountIdentity.exists({email:valid.email}))throw rejected('Owner email already has an account. Use a different address.',409);
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);
  const dbName = tenantDbNameFromSlug(valid.slug);
  const published=await latestPublished(valid.plan);
  if(!published){const e=new Error('This plan has not been published to the database. Run the catalog publication step first.');e.status=409;throw e;}
  if(published.availableForNewTenants===false)throw Object.assign(new Error('This plan is no longer available for new tenants. Choose another published plan.'),{status:409});
  const snapshot=planSnapshot(published);
  const startedAt=new Date();
  const trialEndsAt=new Date(startedAt);
  trialEndsAt.setUTCMonth(trialEndsAt.getUTCMonth()+published.trialMonths);
  const hasTrial=trialEndsAt>startedAt;
  // Provision the tenant database and its unique financial indexes BEFORE publishing
  // a tenant/invitation. A failed index build must not leave an accessible but unsafe
  // workspace. A failed platform transaction can leave an empty indexed database,
  // which is preferable to publishing a partially provisioned financial tenant.
  const tenantConnection=getTenantConnection(valid.slug);
  await prepareTenantStorage(tenantConnection);
  const session = await mongoose.startSession();
  let tenant;
  try {
    await session.withTransaction(async () => {
      const admin=await authorizeAdmin(actor,session);
      if (await AccountIdentity.exists({ email: valid.email }).session(session)) {
        const err = new Error('Owner email already has an account. Use a different address.'); err.status = 409; throw err;
      }
      [tenant] = await Tenant.create([{
        ...valid, enabledModules:hasTrial?snapshot.modules:[], dbName, status:hasTrial?'trial':'past_due', setupStatus:'invited',trialEndsAt:hasTrial?trialEndsAt:null,
        ...(hasTrial?{subscription:{...snapshot,status:'trial',source:'new_tenant_trial',periodStart:startedAt,periodEnd:trialEndsAt,generation:1}}:{})
      }], { session });
      await OwnerInvite.create([{ tenantId: tenant._id, email: valid.email, name: valid.owner,
        tokenHash, expiresAt, createdBy: admin._id }], { session });
      await PlatformAuditLog.create([{actorId:String(admin._id),action:'tenant.created',moduleKey:'tenants',recordId:String(tenant._id),after:{name:valid.name,plan:valid.plan,enabledModules:snapshot.modules}}],{session});
    });
  } catch (error) {
    if (error.code === 11000 && error.keyPattern?.slug) {
      throw Object.assign(new Error('This tenant slug is already in use. Open the existing tenant from the tenant list, or choose a different slug for a different workspace.'), {status:409});
    }
    throw error;
  } finally { await session.endSession(); }
  return { tenant, inviteUrl: `${appUrl}/accept-invite#token=${encodeURIComponent(token)}` };
}
async function regenerateOwnerInvite(tenantId,actor,input={}){
  if(!/^[a-f0-9]{24}$/i.test(String(tenantId||'')))throw rejected('Tenant not found',404);
  const revision=Number(input.revision),reason=text(input.reason);
  if(!/^(?:0|[1-9]\d{0,9})$/.test(String(input.revision??''))||!Number.isSafeInteger(revision)||reason.length<12||reason.length>400)throw invalid('Refresh the tenant profile and provide a reason of 12–400 characters.');
  const token=crypto.randomBytes(32).toString('hex'),tokenHash=crypto.createHash('sha256').update(token).digest('hex'),now=new Date(),expiresAt=new Date(now.getTime()+48*60*60*1000);
  const session=await mongoose.startSession();let tenant;
  try{await session.withTransaction(async()=>{
    const admin=await authorizeAdmin(actor,session);
    const prior=await Tenant.findById(tenantId).session(session).lean();
    if(!prior)throw rejected('Tenant not found',404);
    if(prior.setupStatus!=='invited')throw rejected('The owner account is already activated. Use the account recovery flow.',409);
    if(!['trial','active','past_due'].includes(prior.status))throw rejected('Reactivate this tenant before issuing an owner activation link.',409);
    if((prior.__v||0)!==revision)throw rejected('The tenant changed. Refresh its profile before requesting another activation link.',409);
    if(await AccountIdentity.exists({email:prior.email}).session(session))throw rejected('The owner email already has an account. Use the existing account recovery flow.',409);
    tenant=await Tenant.findOneAndUpdate({_id:tenantId,setupStatus:'invited',__v:revision===0?{$in:[0,null]}:revision},{$inc:{__v:1}},{new:true,session});
    if(!tenant)throw rejected('The tenant changed. Refresh its profile before requesting another activation link.',409);
    await OwnerInvite.updateMany({tenantId:tenant._id,usedAt:null},{$set:{expiresAt:new Date(now.getTime()-1)}},{session});
    await OwnerInvite.create([{tenantId:tenant._id,email:tenant.email,name:tenant.owner,tokenHash,expiresAt,createdBy:admin._id}],{session});
    await PlatformAuditLog.create([{actorId:String(admin._id),action:'tenant.invitation_regenerated',moduleKey:'tenants',recordId:String(tenant._id),after:{reason,expiresAt}}],{session});
  });}finally{await session.endSession();}
  return {tenant,inviteUrl:`${appUrl}/accept-invite#token=${encodeURIComponent(token)}`,regenerated:true};
}
module.exports = { provisionTenant, checkPayload, regenerateOwnerInvite };
