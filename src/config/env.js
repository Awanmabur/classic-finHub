require('dotenv').config();
const crypto = require('crypto');
const production = process.env.NODE_ENV === 'production';
const sessionSecret = process.env.SESSION_SECRET || (production ? '' : crypto.randomBytes(48).toString('hex'));
if (production && (sessionSecret.length < 32 || /classicfin-dev|changeme|replace.?me/i.test(sessionSecret))) {
  throw new Error('Production requires a unique SESSION_SECRET of at least 32 characters');
}
const appUrl = process.env.APP_URL || 'http://localhost:3000';
const parsedUrl = new URL(appUrl);
if (parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash || parsedUrl.pathname !== '/' || !['http:','https:'].includes(parsedUrl.protocol)) throw new Error('APP_URL must be an origin, without paths, credentials, queries or fragments');
if (production && !/^https:\/\//i.test(appUrl)) throw new Error('Production APP_URL must be HTTPS');
if (production && (!Number.isInteger(Number(process.env.TRUST_PROXY)) || Number(process.env.TRUST_PROXY) < 1 || Number(process.env.TRUST_PROXY) > 2)) throw new Error('Production TRUST_PROXY must explicitly identify the number of trusted reverse proxy hops (1 or 2)');
if (production && !/^[a-f0-9]{64}$/i.test(process.env.MFA_ENCRYPTION_KEY || '')) throw new Error('Production requires MFA_ENCRYPTION_KEY (64 hexadecimal characters)');
const portValue = process.env.PORT || '3000';
if (!/^\d+$/.test(portValue) || !Number.isSafeInteger(Number(portValue)) || Number(portValue) < (production ? 1 : 0) || Number(portValue) > 65535) throw new Error('PORT must be an integer between '+(production ? '1' : '0')+' and 65535');
const {mongoPlatformUri,mongoUriBase}=require('./mongoUris').resolveMongoConfiguration(process.env);
// Receiver SMS is a separate outbound transport; never inherit the MFA key.
require('../tenant/transferSms/config').validateConfig();
if (process.env.REAL_MONEY_ENABLED === 'true') throw new Error('Real money features are not yet certified or implemented');
module.exports = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: Number(portValue),
  appUrl: appUrl.replace(/\/$/, ''),
  sessionSecret,
  mongoPlatformUri,
  mongoUriBase,
  trustProxy: Number(process.env.TRUST_PROXY || 0),
  indexingEnabled: production && process.env.SEO_INDEXING_ENABLED !== 'false'
};
