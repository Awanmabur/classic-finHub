#!/usr/bin/env node
'use strict';
/**
 * Real HTTP + MongoDB integration test for the unified account lifecycle.
 * Writes only random probe accounts, one random tenant DB and disposable sessions.
 * Refuses to run against any remote or production MongoDB deployment.
 */
const assert = require('node:assert/strict');
const crypto = require('crypto');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const expressSession = require('express-session');
const { connectPlatformMongo, getTenantConnection } = require('../src/config/mongo');
const { verifyReplicaPrimary } = require('../src/config/mongoTopology');
const { mongoPlatformUri, nodeEnv } = require('../src/config/env');
const Identity = require('../src/platform/models/AccountIdentity');
const Tenant = require('../src/platform/models/Tenant');
const Admin = require('../src/platform/models/PlatformAdmin');
const Reset = require('../src/platform/models/PasswordReset');
const { tenantUserModel, branchModel,ensureTenantIndexes } = require('../src/tenant/models');
const { hashToken } = require('../src/platform/services/passwordRecovery.service');
const createApp = require('../src/app');
const {asPlanVersion,planSnapshot}=require('../src/platform/services/commercial.service');
const {plans}=require('../src/data/store');
const mfa = require('../src/platform/services/mfa.service');

function assertSafeLocal(uriString) {
  if (nodeEnv === 'production') throw new Error('Refusing auth test in NODE_ENV=production');
  const uri = new URL(uriString);
  if (uri.protocol !== 'mongodb:' || !['127.0.0.1','localhost','[::1]'].includes(uri.hostname) || uri.host.includes(',')) {
    throw new Error('Auth integration requires one local MongoDB replica-set node (no remote/Atlas targets)');
  }
}
function csrf(html) {
  const token = html.match(/name="_csrf" value="([a-f0-9]{64})"/);
  if (!token) throw new Error('CSRF token not rendered');
  return token[1];
}
async function main() {
  assertSafeLocal(mongoPlatformUri);
  // Ephemeral, test-only encryption key: never reuse outside this localhost probe.
  if (!process.env.MFA_ENCRYPTION_KEY) process.env.MFA_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
  await connectPlatformMongo();
  verifyReplicaPrimary(await mongoose.connection.db.admin().command({ hello: 1 }));
  for (const Model of [Identity, Admin, Tenant, Reset, require('../src/platform/models/LoginThrottle'), require('../src/platform/models/SecurityEvent')]) await Model.createIndexes();
  const nonce = crypto.randomBytes(7).toString('hex');
  const slug = `probe-${nonce}`;
  const email = suffix => `cfh-probe-${nonce}-${suffix}@example.invalid`;
  const password = 'CFH-Auth-Integration-Test#2026';
  const updatedPassword = 'CFH-Auth-Integration-Rotated#2026';
  const hash = await bcrypt.hash(password, 12);
  const tenantDb = getTenantConnection(slug);
  const User = tenantUserModel(tenantDb);
  let admin = null, tenant = null, server = null;
  const owners = [];
  const mfaSecrets = new Map();
  try {
    await ensureTenantIndexes(tenantDb);
    const platformSecret = mfa.generateSecret();
    mfaSecrets.set('platform', platformSecret);
    admin = await Admin.create({ name: 'Auth Probe Super Admin', email: email('platform'), passwordHash: hash, role: 'Super Admin', status: 'active',
      mfaSecretEncrypted: mfa.encryptSecret(platformSecret), mfaEnabledAt: new Date(), mfaLastCounter: -1 });
    await Identity.create({ email: admin.email, kind: 'platform', accountId: admin._id });
    tenant = await Tenant.create({ name: 'Auth Probe Tenant',slug, dbName: `classicfin_tenant_${slug.replace(/-/g,'_')}_db`,
      owner:'Probe Owner',email:email('owner'), plan:'agent',status:'active',setupStatus:'complete',
      enabledModules:['money_transfer','mobile_money','notifications'],seatsReserved:4,branchCount:1,
      moduleGrants:[{moduleKey:'reports',status:'granted',generation:1,currency:'USD',priceMonthlyMinor:3900,
        periodStart:new Date('2026-01-01'),periodEnd:new Date('2030-01-01'),limits:{users:3,branches:1,recordsPerMonth:0}}],
      subscription:{...planSnapshot({...asPlanVersion(plans.find(p=>p.code==='agent')),status:'published'}),status:'granted',source:'manual_admin_grant',generation:1,periodStart:new Date('2026-01-01'),periodEnd:new Date('2030-01-01')} });
    const branch=await branchModel(tenantDb).create({name:'Probe main',code:'probe-main',currency:'UGX',createdBy:admin._id,updatedBy:admin._id});
    for (const [suffix,role] of [['owner','Tenant Owner'],['operator','Mobile Money Operator'],['auditor','Auditor'],['reviewer','Reconciliation Officer']]) {
      const secret = ['auditor','reviewer'].includes(suffix) ? mfa.generateSecret() : null;
      if (secret) mfaSecrets.set(suffix, secret);
      const account = await User.create({ name: `Probe ${role}`, email:email(suffix), passwordHash:hash, role, status:'active',...(role==='Tenant Owner'?{}:{branchId:String(branch._id),allowedModules:['mobile_money',...(['auditor','reviewer'].includes(suffix)?['reports']:[])]}),
        ...(secret ? { mfaSecretEncrypted:mfa.encryptSecret(secret),mfaEnabledAt:new Date(),mfaLastCounter:-1 } : {}) });
      await Identity.create({ email: account.email, kind:'tenant', tenantId:tenant._id, accountId:account._id });
      owners.push({suffix,role,account});
    }
    server = await new Promise(resolve => {
      const srv = createApp({ sessionStore:new expressSession.MemoryStore() }).listen(0, () => resolve(srv));
    });
    const base=`http://127.0.0.1:${server.address().port}`;
    async function signIn(who, pw=password, extras='') {
      const page = await fetch(`${base}/signin`);
      assert.equal(page.status,200);
      const cookie = page.headers.get('set-cookie').split(';')[0];
      const token = csrf(await page.text());
      const params = new URLSearchParams({email:email(who),password:pw,_csrf:token});
      if (extras) params.set('side',extras); // Spoofed UI field must have no effect.
      const response=await fetch(`${base}/signin`,{method:'POST',redirect:'manual',headers:{cookie,'content-type':'application/x-www-form-urlencoded'},body:params.toString()});
      return {response, cookie:response.headers.get('set-cookie')?.split(';')[0] || cookie};
    }
    async function finishMfa(who, first, mode) {
      assert.equal(first.response.headers.get('location'), `/mfa/${mode}`, `${who} must complete MFA`);
      let cookie=first.cookie;
      const page=await fetch(`${base}/mfa/${mode}`,{headers:{cookie},redirect:'manual'});
      assert.equal(page.status,200);
      cookie=page.headers.get('set-cookie')?.split(';')[0] || cookie;
      const html=await page.text();
      const secret=mode==='setup' ? html.match(/<strong>([A-Z2-7]{32})<\/strong>/)?.[1] : mfaSecrets.get(who);
      assert(secret,`TOTP secret unavailable for ${who}`);
      const code=mfa.counterCode(secret,Math.floor(Date.now()/30000));
      const result=await fetch(`${base}/mfa/${mode}`,{method:'POST',headers:{cookie,'content-type':'application/x-www-form-urlencoded'},
        body:new URLSearchParams({_csrf:csrf(html),code}).toString(),redirect:'manual'});
      assert.equal(result.status,303,`MFA ${who}: ${result.status}`);
      assert.equal(result.headers.get('location'),who==='platform'?'/platform/dashboard':'/tenant/dashboard');
      return {cookie:result.headers.get('set-cookie')?.split(';')[0]||cookie};
    }
    const unauth = await fetch(`${base}/platform/dashboard`,{redirect:'manual'});
    assert.equal(unauth.status,303);
    const platform=await signIn('platform',password,'tenant');
    assert.equal(platform.response.status,303);
    assert.equal((await fetch(`${base}/platform/dashboard`,{headers:{cookie:platform.cookie},redirect:'manual'})).status,303, 'password-only platform session must be denied');
    const platformFull=await finishMfa('platform',platform,'challenge');
    const pDashboard=await fetch(`${base}/platform/dashboard`,{headers:{cookie:platformFull.cookie}});
    assert.equal(pDashboard.status,200);assert.match(await pDashboard.text(),/Create tenant/);
    assert.equal((await fetch(`${base}/tenant/dashboard`,{headers:{cookie:platformFull.cookie},redirect:'manual'})).status,303);
    const owner=await signIn('owner',password,'platform');
    assert.equal((await fetch(`${base}/tenant/dashboard`,{headers:{cookie:owner.cookie},redirect:'manual'})).status,303);
    const ownerFull=await finishMfa('owner',owner,'setup');
    const oDashboard=await fetch(`${base}/tenant/dashboard`,{headers:{cookie:ownerFull.cookie}});
    assert.equal(oDashboard.status,200);
    const ownerDashboardHtml=await oDashboard.text();
    assert.match(ownerDashboardHtml,/Admins, tellers &amp; users/);
    assert.match(ownerDashboardHtml,/href="\/tenant\/users"/,'owner sees the authorized staff directory');
    assert.match(ownerDashboardHtml,/Roles &amp; permissions/);
    assert.equal((await fetch(`${base}/platform/dashboard`,{headers:{cookie:ownerFull.cookie},redirect:'manual'})).status,303);
    const operator=await signIn('operator');
    assert.equal(operator.response.headers.get('location'),'/tenant/dashboard');
    const tDashboard=await fetch(`${base}/tenant/dashboard`,{headers:{cookie:operator.cookie}});
    assert.equal(tDashboard.status,200);
    const operatorDashboardHtml=await tDashboard.text();
    assert.doesNotMatch(operatorDashboardHtml,/Admins, tellers &amp; users/);
    assert.doesNotMatch(operatorDashboardHtml,/href="\/tenant\/users"/,'operator cannot receive staff management navigation');
    assert.equal((await fetch(`${base}/tenant/users`,{headers:{cookie:operator.cookie}})).status,403,'direct staff management access remains denied');
    assert.equal((await fetch(`${base}/tenant/reports`,{headers:{cookie:operator.cookie}})).status,403);
    const moneyPage=await fetch(`${base}/tenant/mobile-money`,{headers:{cookie:operator.cookie}});
    assert.equal(moneyPage.status,200);
    const moneyHtml=await moneyPage.text();
    const ref=`INT-${nonce}`;
    const recordFields={idempotencyKey:crypto.randomUUID(),customer:'Auth Probe Customer',network:'MTN',networkReference:ref,
      currency:'UGX',amount:'120000',fee:'100'};
    const post=(route,cookie,token,fields)=>fetch(`${base}${route}`,{method:'POST',redirect:'manual',
      headers:{cookie,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({_csrf:token,...fields}).toString()});
    // Physical cash recording requires an independently verified opening count.
    // Exercise the real HTTP workflow instead of bypassing the cash controls in a fixture.
    const beforeOpening=await post('/tenant/mobile-money/cash-in',operator.cookie,csrf(moneyHtml),recordFields);
    assert.equal(beforeOpening.status,409,'recording without an open cash shift must fail');
    assert.equal(await require('../src/tenant/models').mobileTransactionModel(tenantDb).countDocuments({networkReference:ref}),0);
    const opened=await post('/tenant/mobile-money/shifts/open',operator.cookie,csrf(moneyHtml),{openingCash:'0'});
    assert.equal(opened.status,303);
    const shift=await require('../src/tenant/models').cashSessionModel(tenantDb).findOne({operatorId:owners.find(o=>o.suffix==='operator').account._id,status:'pending_open'}).lean();
    assert(shift,'opening must await independent verification');
    const beforeVerification=await post('/tenant/mobile-money/cash-in',operator.cookie,csrf(moneyHtml),recordFields);
    assert.equal(beforeVerification.status,409,'an unverified opening must not allow recording');
    const ownerShifts=await fetch(`${base}/tenant/mobile-money/shifts`,{headers:{cookie:ownerFull.cookie}});
    assert.equal(ownerShifts.status,200);
    const approved=await post(`/tenant/mobile-money/shifts/${shift._id}/verify-opening`,ownerFull.cookie,csrf(await ownerShifts.text()),
      {decision:'approve',note:'Independent opening count checked by owner'});
    assert.equal(approved.status,303);
    const record=await post('/tenant/mobile-money/cash-in',operator.cookie,csrf(moneyHtml),recordFields);
    assert.equal(record.status,303);
    const created=await require('../src/tenant/models').mobileTransactionModel(tenantDb).findOne({networkReference:ref}).lean();
    assert(created); assert.equal(created.status,'pending_verification');
    const reviewer=await signIn('reviewer');
    const reviewerFull=await finishMfa('reviewer',reviewer,'challenge');
    const reviewPage=await fetch(`${base}/tenant/mobile-money`,{headers:{cookie:reviewerFull.cookie}});
    assert.equal(reviewPage.status,200);
    const reviewHtml=await reviewPage.text();
    assert.match(reviewHtml,/Independent internal review/);
    const reviewPost=await fetch(`${base}/tenant/mobile-money/${created._id}/review`,{method:'POST',redirect:'manual',
      headers:{cookie:reviewerFull.cookie,'content-type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams({_csrf:csrf(reviewHtml),decision:'accepted',note:'Evidence checked by different staff member'}).toString()});
    assert.equal(reviewPost.status,303);
    const finalRecord=await require('../src/tenant/models').mobileTransactionModel(tenantDb).findById(created._id).lean();
    assert.equal(finalRecord.reviewState,'accepted');
    assert.equal(finalRecord.status,'pending_verification');
    const report=await fetch(`${base}/tenant/reports/export.csv`,{headers:{cookie:reviewerFull.cookie}});
    assert.equal(report.status,200);
    const csv=await report.text();
    assert(csv.replace(/^\uFEFF/,'').startsWith('"Module","Activity","Status","Currency","Count",'),'reports exports use the current aggregate contract');
    assert.match(csv,/pending_verification \/ accepted \/ none/,'reviewed operation is present in the authorized source aggregate');
    assert.doesNotMatch(csv,/Auth Probe Customer/,'aggregate reports must not expose customer identities');
    assert.equal((await fetch(`${base}/tenant/audit`,{headers:{cookie:reviewerFull.cookie}})).status,200);
    const auditor=await signIn('auditor');
    const auditorFull=await finishMfa('auditor',auditor,'challenge');
    const auditDashboard=await fetch(`${base}/tenant/dashboard`,{headers:{cookie:auditorFull.cookie}});
    assert.equal(auditDashboard.status,200);
    const auditorDashboardHtml=await auditDashboard.text();
    assert.match(auditorDashboardHtml,/Operation Reports/);
    assert.match(auditorDashboardHtml,/href="\/tenant\/reports\/daily"/,'auditor receives the approved daily report navigation');
    const wrong=await signIn('platform','invalid-password');
    assert.equal(wrong.response.status,303);assert.equal(wrong.response.headers.get('location'),'/signin');
    const resetToken=crypto.randomBytes(32).toString('hex');
    const operatorId = (await Identity.findOne({email:email('operator')}))._id;
    await Reset.create({identityId:operatorId,tokenHash:hashToken(resetToken),expiresAt:new Date(Date.now()+15*60*1000)});
    const resetPage=await fetch(`${base}/reset-password`);
    const resetCookie=resetPage.headers.get('set-cookie').split(';')[0];
    const resetResponse=await fetch(`${base}/reset-password`,{method:'POST',redirect:'manual',headers:{cookie:resetCookie,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({
      _csrf:csrf(await resetPage.text()),token:resetToken,password:updatedPassword,confirmPassword:updatedPassword
    }).toString()});
    assert.equal(resetResponse.status,303);assert.equal(resetResponse.headers.get('location'),'/signin');
    assert.equal((await fetch(`${base}/tenant/dashboard`,{headers:{cookie:operator.cookie}})).status,401,'password rotation revokes existing sessions');
    assert.equal((await signIn('operator',password)).response.headers.get('location'),'/signin','old password rejected');
    assert.equal((await signIn('operator',updatedPassword)).response.headers.get('location'),'/tenant/dashboard','new password works');
    assert.equal(await Reset.countDocuments({identityId:operatorId}),0,'one-time reset tokens consumed');
    console.log('PASS: HTTP+Mongo two-field sign-in, privileged tenant/platform MFA, automatic dashboards, tenant boundaries, reset and session revocation');
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    // Only delete probe records with the random nonce; never drop the platform DB.
    if (admin) await Admin.deleteOne({ _id:admin._id, email:email('platform') });
    if (tenant) { await Tenant.deleteOne({ _id:tenant._id,slug }); await require('../src/platform/models/UsageCounter').deleteMany({tenantId:tenant._id}); }
    const probeIds = await Identity.find({ email:{$in:['platform','owner','operator','auditor','reviewer'].map(email)} }).distinct('_id');
    if (probeIds.length) await Reset.deleteMany({ identityId:{$in:probeIds} });
    await Identity.deleteMany({ email:{$in:['platform','owner','operator','auditor','reviewer'].map(email)} });
    if (tenant && /^probe-[0-9a-f]{14}$/.test(slug)) {
      await tenantDb.db.dropDatabase();
    }
    await mongoose.disconnect();
  }
}
main().catch(err => { console.error('Auth integration FAILED:', err.stack || err.message); process.exitCode = 1; mongoose.disconnect().catch(()=>{}); });
