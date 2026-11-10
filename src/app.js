const path = require('path');
const express = require('express');
const session = require('express-session');
const compression = require('compression');
const env = require('./config/env');
const securityHeaders = require('./middleware/securityHeaders');
const { traffic } = require('./middleware/rateLimiter');
const csrfProtection = require('./middleware/csrfProtection');
const requirePlatformAuth = require('./middleware/requirePlatformAuth');
const requireAuth = require('./middleware/requireAuth');
const tenantResolver = require('./middleware/tenantResolver');
const errorHandler = require('./middleware/errorHandler');
const publicRoutes = require('./routes.public');
const platformRoutes = require('./platform/routes');
const tenantRoutes = require('./tenant/routes');
const { canonicalOrigin } = require('./middleware/canonicalOrigin');
const mfaRoutes = require('./platform/routes/mfa.routes');

function createApp({ sessionStore } = {}) {
  if (env.nodeEnv === 'production' && !sessionStore) throw new Error('A persistent session store is mandatory in production');
  const app = express();
  if (env.trustProxy) app.set('trust proxy', env.trustProxy);
  Object.assign(app.locals,require('./config/currencies'));
  app.locals.formatMoneyMinor=require('./tenant/services/mobileMoney.service').formatMoneyMinor;
  app.disable('x-powered-by');
  app.use((req,res,next)=>{ req.requestId = require('crypto').randomUUID(); res.setHeader('X-Request-ID',req.requestId); next(); });
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  app.use(...securityHeaders);
  app.use(canonicalOrigin);
  app.use(compression());
  app.use(express.static(path.join(__dirname, '..', 'public'), {
    index: false, dotfiles: 'deny', maxAge: '1d', immutable: false, fallthrough: true,
    setHeaders(res, filename) {
      if (/[\/]offline-sw\.js$/.test(filename)) {res.setHeader('Cache-Control','no-cache');res.setHeader('Service-Worker-Allowed','/');}
      else if (/\.(png|jpe?g|webp|svg|ico)$/i.test(filename)) res.setHeader('Cache-Control','public, max-age=604800');
      else res.setHeader('Cache-Control','public, max-age=86400');
    }
  }));
  // Update the public workspace resources when deployed assets change.
  // Private snapshots use encrypted IndexedDB, never the service-worker cache.
  app.get('/offline-runtime.js',(req,res)=>{res.setHeader('Cache-Control','no-cache');res.setHeader('Service-Worker-Allowed','/');res.type('application/javascript').send("self.CLASSICFIN_ASSET_VERSION="+JSON.stringify(require('./config/assetVersion'))+";\n"+require('fs').readFileSync(path.join(__dirname,'..','public','offline-sw.js'),'utf8'));});
  // Structured, newline-safe access logs. Never log request query values, bodies,
  // Authorization headers, cookies or user-controlled referrers.
  app.use((req,res,next)=>{
    const began = process.hrtime.bigint();
    res.once('finish',()=>{
      if (req.path === '/health/live' && res.statusCode === 200) return;
      const path = req.path.slice(0,256).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g,'?');
      const durationMs = Number(process.hrtime.bigint() - began) / 1e6;
      console.log(JSON.stringify({ event:'http', requestId:req.requestId, method:req.method,
        path,status:res.statusCode,durationMs:Number(durationMs.toFixed(2)) }));
    });
    next();
  });
  app.get('/health/live', (req, res) => res.json({ status: 'live' }));
  app.get('/health/ready', async (req, res) => {
    try {
      const conn = require('mongoose').connection;
      if (conn.readyState !== 1) throw new Error('Database disconnected');
      const hello = await conn.db.admin().command({ hello: 1, maxTimeMS: 1500 });
      require('./config/mongoTopology').verifyReplicaPrimary(hello);
      res.json({ status:'ready' });
    } catch { res.status(503).json({ status:'unavailable' }); }
  });
  app.use(session({
    name: 'cfh.sid', secret: env.sessionSecret, store: sessionStore,
    resave: false, saveUninitialized: false, rolling: true,
    cookie: { httpOnly: true, sameSite: 'lax', secure: env.nodeEnv === 'production', maxAge: 30 * 60 * 1000 }
  }));
  app.use(traffic);
  // SMS verifies the exact raw bytes before the ordinary body/CSRF parsers.
  app.use('/integrations/sms',require('./integrations/sms.routes'));
  app.use(express.urlencoded({ extended: false, limit: '32kb' }));
  app.use(express.json({ limit: '32kb' }));
  app.use(csrfProtection);
  app.use(require('./middleware/ajaxRedirect').ajaxRedirect);
  const assetVersion = require('./config/assetVersion');
  app.use((req,res,next) => { res.locals.appUrl = env.appUrl; res.locals.assetVersion = assetVersion; res.locals.mfaEnabled = require('./config/mfaPolicy').enabled(); next(); });
  app.use('/', publicRoutes);
  app.use('/mfa', mfaRoutes);
  app.use('/platform', requirePlatformAuth, platformRoutes);
  app.use('/tenant/sms-capture',tenantResolver,requireAuth,require('./tenant/routes/sms.routes'));
  app.use('/tenant', tenantResolver, requireAuth, tenantRoutes);
  app.use((req, res) => { res.setHeader('X-Robots-Tag','noindex'); res.setHeader('Cache-Control','no-store'); res.status(404).send('Page not found'); });
  app.use(errorHandler);
  return app;
}
module.exports = createApp;
