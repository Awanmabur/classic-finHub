'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { createAuthenticator, normalizeEmail } = require('../src/platform/services/authentication.service');
const { checkIdentityPlan, mappingMatches } = require('../scripts/migrate-login-identities');
const { bucketId, WINDOW_MS } = require('../src/platform/services/loginThrottle.service');
const pwd = 'Secure-OnlyAccount#2495';
const lookup = result => ({ findOne: () => ({ lean: async () => result }) });
const create = ({ identity, admin, tenant, tenantUser }) => createAuthenticator({
  Identity: lookup(identity), Admin: lookup(admin), TenantModel: lookup(tenant),
  tenantConnection: slug => ({ slug }),
  getUserModel: conn => { assert.equal(conn.slug, tenant?.slug); return lookup(tenantUser); }
});

test('unified email sign-in resolves only a real Super Admin (ignores supplied side/slug/role)', async () => {
  const passwordHash = await bcrypt.hash(pwd, 4);
  const authenticate = create({identity:{_id:'identity-1',kind:'platform',accountId:'admin-1',tenantId:null},
    admin:{_id:'admin-1',email:'admin@example.com',role:'Super Admin',status:'active',passwordHash,authVersion:2}});
  const session = await authenticate({ email:' ADMIN@EXAMPLE.COM ',password:pwd,side:'tenant',slug:'attacker',role:'Viewer' });
  assert.deepEqual(session, { platformId:'admin-1',identityId:'identity-1',authVersion:2 });
  assert.equal(await authenticate({ email:'admin@example.com',password:'wrong' }),null);
  assert.equal(normalizeEmail(' INVALID '),'');
});
test('tenant accounts route through the stored global tenant ID, never a submitted slug', async () => {
  const passwordHash = await bcrypt.hash(pwd, 4);
  const authenticate = create({identity:{_id:'identity-2',kind:'tenant',accountId:'user-10',tenantId:'tenant-7'},
    tenant:{_id:'tenant-7',slug:'real-tenant',status:'active'},
    tenantUser:{_id:'user-10',email:'user@example.com',role:'Viewer',status:'active',passwordHash,authVersion:0}});
  assert.deepEqual(await authenticate({email:'USER@example.com',password:pwd,side:'platform',slug:'another-company'}),
    {tenantId:'tenant-7',tenantUserId:'user-10',identityId:'identity-2',authVersion:0,mfaRequired:false,mfaEnrolled:false});
  assert.equal(await authenticate({email:'user@example.com',password:'incorrect'}),null);
});
test('invalid directory mappings, disabled accounts, bad role, and suspended tenants fail closed', async () => {
  const passwordHash = await bcrypt.hash(pwd, 4);
  const opts={ identity:{_id:'identity-1',kind:'platform',accountId:'admin-1',tenantId:null},
    admin:{_id:'admin-1',email:'admin@example.com',role:'Viewer',status:'active',passwordHash} };
  assert.equal(await create(opts)({ email:'admin@example.com',password:pwd }),null);
  assert.equal(await create({...opts,identity:null})({ email:'admin@example.com',password:pwd }),null);
  assert.equal(await create({...opts,admin:{...opts.admin,role:'Super Admin',status:'disabled'}})({ email:'admin@example.com',password:pwd }),null);
  const tenantOpts={identity:{_id:'identity-2',kind:'tenant',accountId:'user-10',tenantId:'tenant-7'},
    tenant:{_id:'tenant-7',slug:'real-tenant',status:'suspended'}, tenantUser:{_id:'user-10',status:'active',passwordHash}};
  assert.equal(await create(tenantOpts)({ email:'user@example.com',password:pwd }),null);
});
test('migration detects duplicate emails across platform and tenants before making writes',()=>{
  const rows=[{kind:'platform',accountId:'ad1',tenantId:null,email:'same@example.com'},
    {kind:'tenant',accountId:'u1',tenantId:'t1',email:'same@example.com'}];
  assert.throws(()=>checkIdentityPlan(rows),/Ambiguous email/);
  assert.throws(()=>checkIdentityPlan([{...rows[0],email:'UPPER@example.com'}]),/unnormalized/);
  assert.deepEqual(checkIdentityPlan([rows[0]]),[rows[0]]);
  assert.equal(mappingMatches(rows[0],{...rows[0]}),true);
  assert.equal(mappingMatches(rows[0],{...rows[0],accountId:'ad2'}),false);
});
test('shared database login rate keys protect emails across IPs and rotate by 15-minute bucket',()=>{
  const when=Date.UTC(2026,10,3,12);
  assert.equal(bucketId('email','user@example.com',when),bucketId('email','user@example.com',when));
  assert.notEqual(bucketId('email','user@example.com',when),bucketId('email','other@example.com',when));
  assert.notEqual(bucketId('email','user@example.com',when),bucketId('email','user@example.com',when+WINDOW_MS));
  assert(!bucketId('email','user@example.com',when).includes('user@example.com'));
});

test('authenticated sessions have an absolute lifetime and cannot be revived by rolling cookies',()=>{
  const {validAuthAge,ABSOLUTE_AUTH_MS}=require('../src/middleware/authSessionExpiry');
  const now=Date.UTC(2026,10,3,12);
  assert.equal(validAuthAge(now-1,now),true);
  assert.equal(validAuthAge(now-ABSOLUTE_AUTH_MS,now),false);
  assert.equal(validAuthAge(now+1,now),false);
  assert.equal(validAuthAge(undefined,now),false);
});
test('identity schema refuses platform-tenant mapping confusion',async()=>{
  const Model=require('../src/platform/models/AccountIdentity');
  const id='507f1f77bcf86cd799439011';
  await assert.rejects(new Model({email:'x@example.com',kind:'tenant',accountId:id}).validate());
  await assert.rejects(new Model({email:'x@example.com',kind:'platform',accountId:id,tenantId:id}).validate());
  await new Model({email:'x@example.com',kind:'platform',accountId:id}).validate();
});

test('privileged tenant accounts require MFA, while ordinary operators retain two-field login', async()=>{
  const passwordHash=await bcrypt.hash(pwd,4);
  for(const [role,requires] of [['Tenant Owner',true],['Reconciliation Officer',true],['Auditor',true],['Mobile Money Operator',false]]) {
    const authenticate=create({identity:{_id:'id',kind:'tenant',accountId:'u',tenantId:'t'},tenant:{_id:'t',slug:'real-tenant',status:'active'},
      tenantUser:{_id:'u',email:'priv@example.com',role,status:'active',passwordHash,mfaEnabledAt: requires ? new Date() : null}});
    const result=await authenticate({email:'priv@example.com',password:pwd});
    assert.equal(result.mfaRequired,requires,role);
    assert.equal(result.mfaEnrolled,requires,role);
  }
});
