require('dotenv').config();
module.exports = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 3000),
  appUrl: process.env.APP_URL || 'http://localhost:3000',
  sessionSecret: process.env.SESSION_SECRET || 'classicfin-dev-secret',
  mongoPlatformUri: process.env.MONGO_PLATFORM_URI || 'mongodb://127.0.0.1:27017/classicfin_platform_db',
  mongoTenantBaseUri: process.env.MONGO_TENANT_BASE_URI || 'mongodb://127.0.0.1:27017',
  redisUrl: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
  trialGraceDays: Number(process.env.TRIAL_GRACE_DAYS || 7),
  defaultTrialMonths: Number(process.env.DEFAULT_TRIAL_MONTHS || 2)
};
