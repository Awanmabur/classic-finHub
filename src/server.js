const app = require('./app');
const env = require('./config/env');
const { connectPlatformMongo } = require('./config/mongo');
const { createRedisClient } = require('./config/redis');

async function boot() {
  if (process.env.SKIP_EXTERNAL_SERVICES !== 'true') {
    try { await connectPlatformMongo(); console.log('Mongo platform connection ready'); } catch (err) { console.warn('Mongo skipped:', err.message); }
    try { await createRedisClient(); console.log('Redis connection ready'); } catch (err) { console.warn('Redis skipped:', err.message); }
  }
  app.listen(env.port, () => console.log(`ClassicFin Hub running on port ${env.port}`));
}
boot();
