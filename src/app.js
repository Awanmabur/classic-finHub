const path = require('path');
const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const compression = require('compression');
const morgan = require('morgan');
const methodOverride = require('method-override');
const env = require('./config/env');
const securityHeaders = require('./middleware/securityHeaders');
const rateLimiter = require('./middleware/rateLimiter');
const csrfProtection = require('./middleware/csrfProtection');
const requirePlatformAuth = require('./middleware/requirePlatformAuth');
const requireAuth = require('./middleware/requireAuth');
const tenantResolver = require('./middleware/tenantResolver');
const requireSetupComplete = require('./middleware/requireSetupComplete');
const errorHandler = require('./middleware/errorHandler');
const publicRoutes = require('./routes.public');
const platformRoutes = require('./platform/routes');
const tenantRoutes = require('./tenant/routes');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(securityHeaders);
app.use(rateLimiter);
app.use(compression());
app.use(morgan(env.nodeEnv === 'production' ? 'combined' : 'dev'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());
app.use(methodOverride('_method'));
app.use(session({ secret: env.sessionSecret, resave: false, saveUninitialized: false, cookie: { httpOnly: true, sameSite: 'lax', secure: env.nodeEnv === 'production' } }));
app.use(csrfProtection);
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use('/', publicRoutes);
app.use('/platform', requirePlatformAuth, platformRoutes);
app.use('/tenant', tenantResolver, requireAuth, requireSetupComplete, tenantRoutes);

app.use((req, res) => {
  res.status(404).render('layouts/public', {
    title: 'Page not found | ClassicFin Hub',
    view: '../public/error',
    flash: null,
    data: { error: { status: 404, message: 'The page you requested does not exist.' } },
    currentPath: req.path,
    modules: [], plans: [], tenants: [], appointments: []
  });
});
app.use(errorHandler);

module.exports = app;
