#!/usr/bin/env node
'use strict';
/**
 * One-time, repeatable, fail-closed migration for existing admins and tenants.
 * Default mode audits only. --apply builds the global directory AFTER detecting
 * malformed/duplicate emails. Never guesses which workspace should win.
 */
const mongoose = require('mongoose');
const { connectPlatformMongo, getTenantConnection } = require('../src/config/mongo');
const { verifyReplicaPrimary } = require('../src/config/mongoTopology');
const Identity = require('../src/platform/models/AccountIdentity');
const Admin = require('../src/platform/models/PlatformAdmin');
const Tenant = require('../src/platform/models/Tenant');
const { tenantUserModel } = require('../src/tenant/models');
const { normalizeEmail } = require('../src/platform/services/authentication.service');

function checkIdentityPlan(rows) {
  const seen = new Map();
  for (const row of rows) {
    const normalized = normalizeEmail(row.email);
    if (!normalized || normalized !== row.email) throw new Error(`Invalid or unnormalized email on ${row.kind} account ${row.accountId}`);
    if (seen.has(normalized)) {
      const original = seen.get(normalized);
      throw new Error(`Ambiguous email ${normalized}: ${original.kind}/${original.accountId} and ${row.kind}/${row.accountId}. Resolve accounts manually before migration.`);
    }
    seen.set(normalized, row);
  }
  return Array.from(seen.values());
}
function mappingMatches(a, b) {
  return a.email === b.email && a.kind === b.kind && String(a.accountId) === String(b.accountId) &&
    String(a.tenantId || '') === String(b.tenantId || '');
}
async function main() {
  const apply = process.argv.includes('--apply');
  if (process.argv.some(a => a.startsWith('--') && a !== '--apply')) throw new Error('Only --apply is supported');
  await connectPlatformMongo();
  verifyReplicaPrimary(await mongoose.connection.db.admin().command({ hello: 1 }));
  const rows = [];
  for await (const admin of Admin.find({}).select('_id email').lean().cursor())
    rows.push({ email: admin.email, kind: 'platform', accountId: admin._id, tenantId: null });
  for await (const tenant of Tenant.find({}).select('_id slug').lean().cursor()) {
    const Users = tenantUserModel(getTenantConnection(tenant.slug));
    for await (const user of Users.find({}).select('_id email').lean().cursor())
      rows.push({ email: user.email, kind: 'tenant', accountId: user._id, tenantId: tenant._id });
  }
  const planned = checkIdentityPlan(rows);
  if (apply) await Identity.createIndexes();
  const existing = await Identity.find({}).lean();
  const plannedByEmail = new Map(planned.map(row => [row.email, row]));
  for (const record of existing) {
    const target = plannedByEmail.get(record.email);
    if (!target || !mappingMatches(record, target)) throw new Error(`Stale/conflicting directory mapping: ${record.email}. Investigate and repair manually.`);
  }
  console.log(`Scanned ${planned.length} accounts: ${existing.length} already mapped; ${planned.length - existing.length} missing.`);
  if (!apply) { console.log('Dry run only. Re-run: npm run auth:migrate -- --apply'); return; }
  let inserted = 0;
  for (const row of planned) {
    const result = await Identity.updateOne({ email: row.email }, { $setOnInsert: row }, { upsert: true });
    if (result.upsertedCount) inserted++;
    const persisted = await Identity.findOne({ email: row.email }).lean();
    if (!mappingMatches(persisted, row)) throw new Error(`Identity conflict during migration: ${row.email}`);
  }
  console.log(`Email-only sign-in directory completed: ${inserted} inserted. No account passwords changed.`);
}
if (require.main === module) main().catch(e => { console.error('Migration stopped:', e.message); process.exitCode = 1; }).finally(() => mongoose.disconnect().catch(() => {}));
module.exports = { checkIdentityPlan, mappingMatches };
