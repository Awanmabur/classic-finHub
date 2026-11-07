#!/usr/bin/env node
const mongoose = require('mongoose');
const { connectPlatformMongo, getTenantConnection } = require('../src/config/mongo');
const PlatformAdmin = require('../src/platform/models/PlatformAdmin');
const AccountIdentity = require('../src/platform/models/AccountIdentity');
const LoginThrottle = require('../src/platform/models/LoginThrottle');
const SecurityEvent = require('../src/platform/models/SecurityEvent');
const PasswordReset = require('../src/platform/models/PasswordReset');
const Tenant = require('../src/platform/models/Tenant');
const OwnerInvite = require('../src/platform/models/OwnerInvite');
const Appointment = require('../src/platform/models/Appointment');
const PlatformAuditLog = require('../src/platform/models/PlatformAuditLog');
const PlanVersion=require('../src/platform/models/PlanVersion');
const PlanDraft=require('../src/platform/models/PlanDraft');
const PlanPublicationLock=require('../src/platform/models/PlanPublicationLock');
const SmsDevice=require('../src/platform/models/SmsDevice');
const SmsUsage=require('../src/platform/models/SmsUsage');
const UsageCounter=require('../src/platform/models/UsageCounter');
const OutboxEvent=require('../src/platform/models/OutboxEvent');
const WorkerHeartbeat=require('../src/platform/models/WorkerHeartbeat');
const ModuleRequest=require('../src/platform/models/ModuleRequest');
const { ensureTenantIndexes } = require('../src/tenant/models');
async function main() {
  await connectPlatformMongo();
  const hello = await mongoose.connection.db.admin().command({hello:1});
  if (!hello.setName) throw new Error('Replica set required');
  for (const model of [AccountIdentity,LoginThrottle,SecurityEvent,PasswordReset,PlatformAdmin,Tenant,OwnerInvite,Appointment,PlatformAuditLog,PlanVersion,PlanDraft,PlanPublicationLock,SmsDevice,SmsUsage,UsageCounter,OutboxEvent,WorkerHeartbeat,ModuleRequest]) await model.createIndexes();
  const tenants = await Tenant.find({}).select('slug').lean();
  for (const t of tenants) {
    const conn = getTenantConnection(t.slug);
    await ensureTenantIndexes(conn);
    await require('../src/tenant/customerAccounts/models').ensureIndexes(conn);
    await require('../src/tenant/models/expenses').ensureExpenseIndexes(conn);
    await require('../src/tenant/workspace/models').ensure(conn);
    await require('../src/tenant/treasury/models').ensure(conn);
    await require('../src/tenant/treasury/funding.models').ensureIndexes(conn);
    await require('../src/tenant/funded/models').ensureIndexes(conn);
  }
  console.log('Indexes verified for platform and',tenants.length,'tenants');
}
main().catch(err=>{console.error('Index creation failed:',err.message);process.exitCode=1;}).finally(()=>mongoose.disconnect().catch(()=>{}));
