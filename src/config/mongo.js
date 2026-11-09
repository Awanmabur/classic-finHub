const mongoose = require('mongoose');
const env = require('./env');
const {NAME,tenantDbNameFromSlug}=require('./tenantDatabaseName');
const {tenantUriFromSlug}=require('./mongoUris');

async function connectPlatformMongo() {
  mongoose.set('strictQuery', true);
  mongoose.set('bufferCommands', false);
  await mongoose.connect(env.mongoPlatformUri,require('./mongoOptions').options(process.env));
  return mongoose.connection;
}
// Logical DBs reuse one bounded connection pool. Never accept DB names from a request.
function getTenantConnection(slug) {
  if (mongoose.connection.readyState !== 1) throw Object.assign(new Error('Database unavailable'),{code:'STORAGE_UNAVAILABLE',status:503});
  const database=tenantDbNameFromSlug(slug);
  if(database.toLowerCase()===mongoose.connection.name.toLowerCase())throw new Error('Tenant and platform database names must be distinct');
  const connection=mongoose.connection.useDb(database, { useCache: true });
  // Provisioning and mutation services explicitly await their index preflights.
  // Compiling a model during a read must not start background DDL on Atlas.
  connection.config.autoIndex=false;
  connection.config.autoCreate=false;
  return connection;
}
// Server-side connection-link derivation only. Never send this credential-bearing
// value to tenant pages, exports, logs or API responses. Runtime uses useDb above.
function getTenantUri(slug){
 const resolvedAuthSource=mongoose.connection.readyState===1?mongoose.connection.getClient().options.credentials?.source:undefined;
 return tenantUriFromSlug(slug,{MONGO_PLATFORM_URI:env.mongoPlatformUri,MONGO_URI_BASE:env.mongoUriBase},{resolvedAuthSource});
}
module.exports = { connectPlatformMongo, getTenantConnection, getTenantUri, tenantDbNameFromSlug, NAME };
