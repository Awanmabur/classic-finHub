const mongoose = require('mongoose');
const env = require('./env');
const tenantConnections = new Map();

async function connectPlatformMongo() {
  if (process.env.MOCK_DB === 'true') return null;
  mongoose.set('strictQuery', true);
  return mongoose.connect(env.mongoPlatformUri, { autoIndex: env.nodeEnv !== 'production' });
}

function tenantDbNameFromSlug(slug) {
  return `classicfin_tenant_${String(slug).toLowerCase().replace(/[^a-z0-9]+/g, '_')}_db`;
}

function getTenantConnection(slug) {
  const dbName = tenantDbNameFromSlug(slug);
  if (tenantConnections.has(dbName)) return tenantConnections.get(dbName);
  const uri = `${env.mongoTenantBaseUri.replace(/\/$/, '')}/${dbName}`;
  const conn = mongoose.createConnection(uri, { autoIndex: env.nodeEnv !== 'production' });
  tenantConnections.set(dbName, conn);
  return conn;
}

module.exports = { connectPlatformMongo, getTenantConnection, tenantDbNameFromSlug };
