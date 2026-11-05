const crypto = require('crypto');
const mongoose = require('mongoose');
const Tenant = require('../models/Tenant');
const OwnerInvite = require('../models/OwnerInvite');
const AccountIdentity = require('../models/AccountIdentity');
const PlatformAuditLog=require('../models/PlatformAuditLog');
const { plans } = require('../../data/store');
const {latestPublished,planSnapshot}=require('./commercial.service');
const { tenantDbNameFromSlug, getTenantConnection, NAME } = require('../../config/mongo');
const { appUrl } = require('../../config/env');
const { MAX_SLUG_LENGTH } = require('../../config/tenantDatabaseName');
const { normalizeEmail } = require('./authentication.service');

function invalid(message) { return Object.assign(new Error(message), { status: 400 }); }
function text(value) { return typeof value === 'string' ? value.trim() : ''; }
function checkPayload(payload = {}) {
  const name = text(payload.name);
  const requestedSlug = text(payload.slug).toLowerCase();
  const slug = requestedSlug || name.toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '').slice(0, MAX_SLUG_LENGTH).replace(/-+$/g, '');
  const owner = text(payload.owner);
  const email = normalizeEmail(payload.email);
  const phone = text(payload.phone);
  const plan = plans.find(p => p.code === payload.plan);
  if (!name || name.length > 150) throw invalid('Enter a tenant name of 1–150 characters.');
  if (!NAME.test(slug)) throw invalid('Enter a slug of 3–42 letters, numbers or hyphens, beginning and ending with a letter or number.');
  if (!owner || owner.length > 120) throw invalid('Enter an owner name of 1–120 characters.');
  if (!email) throw invalid('Enter a valid owner email of at most 254 characters.');
  if (phone.length > 40 || !/^[+0-9 ()-]*$/.test(phone)) throw invalid('Enter a valid phone number of at most 40 characters.');
  if (!plan) throw invalid('Choose an available published plan.');
  // Cannot grant modules outside the agreed plan merely by manipulating POST payload.
  const enabledModules = plan.modules.filter(m => require('../../data/store').modules.some(mod => mod.key === m));
  return { name, slug, owner, email, phone, plan: plan.code, enabledModules };
}
async function provisionTenant(payload, adminId) {
  const valid = checkPayload(payload);
  if (await Tenant.exists({slug: valid.slug})) {
    throw Object.assign(new Error('This tenant slug is already in use. Choose a different slug.'), {status:409});
  }
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);
  const dbName = tenantDbNameFromSlug(valid.slug);
  const published=await latestPublished(valid.plan);
  if(!published){const e=new Error('This plan has not been published to the database. Run the catalog publication step first.');e.status=409;throw e;}
  const snapshot=planSnapshot(published);
  const startedAt=new Date();
  const trialEndsAt=new Date(startedAt);
  trialEndsAt.setUTCMonth(trialEndsAt.getUTCMonth()+published.trialMonths);
  if(trialEndsAt<=startedAt)throw Object.assign(new Error('This plan has no self-service trial. Use a supervised manual subscription grant.'),{status:409});
  // Provision the tenant database and its unique financial indexes BEFORE publishing
  // a tenant/invitation. A failed index build must not leave an accessible but unsafe
  // workspace. A failed platform transaction can leave an empty indexed database,
  // which is preferable to publishing a partially provisioned financial tenant.
  await require('../../tenant/models').ensureTenantIndexes(getTenantConnection(valid.slug));
  const session = await mongoose.startSession();
  let tenant;
  try {
    await session.withTransaction(async () => {
      if (await AccountIdentity.exists({ email: valid.email }).session(session)) {
        const err = new Error('Owner email already has an account. Use a different address.'); err.status = 409; throw err;
      }
      [tenant] = await Tenant.create([{
        ...valid, enabledModules:snapshot.modules, dbName, status: 'trial', setupStatus: 'invited', trialEndsAt,
        subscription:{...snapshot,status:'trial',source:'new_tenant_trial',periodStart:startedAt,periodEnd:trialEndsAt,generation:1}
      }], { session });
      await OwnerInvite.create([{ tenantId: tenant._id, email: valid.email, name: valid.owner,
        tokenHash, expiresAt, createdBy: adminId }], { session });
      await PlatformAuditLog.create([{actorId:String(adminId),action:'tenant.created',moduleKey:'tenants',recordId:String(tenant._id),after:{name:valid.name,plan:valid.plan,enabledModules:snapshot.modules}}],{session});
    });
  } catch (error) {
    if (error.code === 11000 && error.keyPattern?.slug) {
      throw Object.assign(new Error('This tenant slug is already in use. Choose a different slug.'), {status:409});
    }
    throw error;
  } finally { await session.endSession(); }
  return { tenant, inviteUrl: `${appUrl}/accept-invite#token=${encodeURIComponent(token)}` };
}
module.exports = { provisionTenant, checkPayload };
