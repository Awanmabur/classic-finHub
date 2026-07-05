async function createRedisClient() {
  if (!process.env.REDIS_URL || process.env.MOCK_REDIS === 'true') return null;
  const { createClient } = require('redis');
  const client = createClient({ url: process.env.REDIS_URL });
  client.on('error', (err) => console.warn('Redis warning:', err.message));
  await client.connect();
  return client;
}
module.exports = { createRedisClient };
