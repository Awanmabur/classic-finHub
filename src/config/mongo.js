const mongoose = require('mongoose');
const env = require('./env');
const {NAME,tenantDbNameFromSlug}=require('./tenantDatabaseName');

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
  return mongoose.connection.useDb(tenantDbNameFromSlug(slug), { useCache: true });
}
module.exports = { connectPlatformMongo, getTenantConnection, tenantDbNameFromSlug, NAME };
