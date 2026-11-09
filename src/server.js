const mongoose = require('mongoose');
const { createSessionStore } = require('./config/sessionStore');
const createApp = require('./app');
const env = require('./config/env');
const { connectPlatformMongo } = require('./config/mongo');
const { verifyReplicaPrimary } = require('./config/mongoTopology');
const { loadDevelopmentMfaKey } = require('./config/developmentMfaKey');
async function boot() {
  // dotenv has already populated explicit configuration through config/env.
  // Reuse a retained local key without creating or replacing encryption keys.
  loadDevelopmentMfaKey();
  // Fail closed: never serve financial dashboards when storage is unavailable.
  await connectPlatformMongo();
  const hello = await mongoose.connection.db.admin().command({ hello: 1 });
  verifyReplicaPrimary(hello);
  // Unique global email identity index is a prerequisite for safe auto-routing.
  for (const Model of [require('./platform/models/AccountIdentity'),require('./platform/models/LoginThrottle'),require('./platform/models/SecurityEvent'),require('./platform/models/PasswordReset'),require('./platform/models/PlanVersion'),require('./platform/models/PlanDraft'),require('./platform/models/PlanPublicationLock'),require('./platform/models/SmsDevice'),require('./platform/models/SmsUsage'),require('./platform/models/UsageCounter'),require('./platform/models/OutboxEvent'),require('./platform/models/WorkerHeartbeat')]) await Model.createIndexes();
  const store = await createSessionStore({ client: mongoose.connection.getClient(), dbName: mongoose.connection.name });
  const app = createApp({ sessionStore: store });
  const server = app.listen(env.port, () => {
    console.log(`ClassicFin Hub listening on ${env.port} (MongoDB replica set: ${hello.setName})`);
    const policy=require('./config/mfaPolicy').status();
    console.log(JSON.stringify({event:'app.ready',version:require('../package.json').version,mfa:policy.mode,mfaSource:policy.source}));
  });
  server.headersTimeout = 15000;
  server.requestTimeout = 30000;
  server.keepAliveTimeout = 5000;
  let closing = false;
  async function shutdown(signal) {
    if (closing) return;
    closing = true;
    console.log(`Received ${signal}, draining HTTP connections`);
    const force = setTimeout(() => server.closeAllConnections(), 20000);
    force.unref();
    server.close(async err => {
      clearTimeout(force);
      try { await mongoose.disconnect(); } catch (disconnectError) { console.error('Mongo shutdown:', disconnectError.message); }
      process.exit(err ? 1 : 0);
    });
    server.closeIdleConnections();
  }
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}
boot().catch(err => { console.error('Startup aborted:', err.message); process.exitCode = 1; mongoose.disconnect().catch(() => {}); });
