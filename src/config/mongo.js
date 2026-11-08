const mongoose = require('mongoose');
const env = require('./env');
const {NAME,tenantDbNameFromSlug}=require('./tenantDatabaseName');
const {tenantUriFromSlug}=require('./mongoUris');

async function connectPlatformMongo() {
  mongoose.set('strictQuery', true);
  await mongoose.connect(env.mongoPlatformUri, {
    serverSelectionTimeoutMS: 7000, maxPoolSize: Number(process.env.MONGO_POOL_MAX || 30),
    autoIndex: env.nodeEnv !== 'production', retryWrites: true
  });
  return mongoose.connection;
}
// Logical DBs reuse one bounded connection pool. Never accept DB names from a request.
function getTenantConnection(slug) {
  if (mongoose.connection.readyState !== 1) throw new Error('Database unavailable');
  const database=tenantDbNameFromSlug(slug);
  if(database.toLowerCase()===mongoose.connection.name.toLowerCase())throw new Error('Tenant and platform database names must be distinct');
  return mongoose.connection.useDb(database, { useCache: true });
}
// Server-side connection-link derivation only. Never send this credential-bearing
// value to tenant pages, exports, logs or API responses. Runtime uses useDb above.
function getTenantUri(slug){return tenantUriFromSlug(slug,{MONGO_PLATFORM_URI:env.mongoPlatformUri,MONGO_URI_BASE:env.mongoUriBase});}
module.exports = { connectPlatformMongo, getTenantConnection, getTenantUri, tenantDbNameFromSlug, NAME };
