'use strict';
const express = require('express');
const session = require('express-session');
const fs = require('node:fs');
const path = require('node:path');
const { openDatabase } = require('./db/database');
const { SQLiteSessionStore } = require('./db/session-store');
const { createAuthService } = require('./auth/auth-service');
const { requireAuth } = require('./auth/auth-middleware');
const { issueLoginToken, writeBoundary } = require('./auth/csrf');
const { createAuthRoutes } = require('./routes/auth-routes');
const { securityHeaders } = require('./middleware/security');
const { errorHandler } = require('./middleware/error-handler');
const { createBusinessRepositories } = require('./repositories/business-repository');
const { BusinessBackupService } = require('./services/business-backup-service');
const { PackingListTransactionService } = require('./services/packing-list-transaction-service');
const { createBusinessBackupRoutes } = require('./routes/business-backup-routes');
const { createServerDataRoutes } = require('./routes/server-data-routes');
const { BusinessCrudService } = require('./services/business-crud-service');
const { createBusinessCrudRoutes } = require('./routes/business-crud-routes');
const { DocumentSequenceService } = require('./services/document-sequence-service');
const { OrderOperationService } = require('./services/order-operation-service');
const { createBusinessOperationRoutes } = require('./routes/business-operation-routes');
const { UserService } = require('./services/user-service');
const { OwnershipService } = require('./services/ownership-service');
const { AuditService } = require('./services/audit-service');
const { createUserRoutes } = require('./routes/user-routes');
const { createAuditRoutes } = require('./routes/audit-routes');

const root = path.resolve(__dirname, '..');
// Exact allowlist, NEVER express.static(root), node_modules, data, or server directories.
const businessFiles = [
  'css/styles.css',
  'js/core.js',
  'js/api-db.js',
  'js/sample-data.js',
  'js/pdf.js',
  'js/i18n.js',
  'js/app.js',
  'node_modules/jspdf/dist/jspdf.umd.min.js',
  'node_modules/jspdf-autotable/dist/jspdf.plugin.autotable.min.js',
  'node_modules/jszip/dist/jszip.min.js',
];

async function createApp(config) {
  const db = openDatabase(config.databasePath);
  let store;
  try {
    const auth = await createAuthService(db);
    const repositories = createBusinessRepositories(db);
    const auditService = new AuditService(db);
    const ownershipService = new OwnershipService(db, repositories);
    const userService = new UserService(db, {
      passwordMinLength: config.passwordMinLength,
      auditService,
    });
    const sequenceService = new DocumentSequenceService(db, repositories);
    const businessBackupService = new BusinessBackupService(db, repositories, { sequenceService });
    const packingListTransactionService = new PackingListTransactionService(db, repositories);
    const orderOperationService = new OrderOperationService(db, repositories, sequenceService);
    const businessCrudService = new BusinessCrudService(db, repositories, orderOperationService);
    store = new SQLiteSessionStore(db, config);
    const app = express();
    app.disable('x-powered-by');
    app.disable('etag');
    const trustProxy = config.trustProxy || (config.trustProxyLoopback ? 'loopback' : false);
    if (trustProxy) app.set('trust proxy', trustProxy);
    app.use(securityHeaders(config.production));
    app.use((req, res, next) => {
      res.set('Cache-Control', 'no-store');
      if (config.production && !req.secure && req.path !== '/health')
        return res.status(400).json({ error: 'HTTPS required' });
      next();
    });
    app.get('/health', (req, res) => {
      db.prepare('SELECT 1').get();
      res.json({ status: 'ok' });
    });
    for (const filename of ['login.js', 'login.css', 'change-password.js']) {
      app.get(`/login-assets/${filename}`, (req, res) =>
        res.sendFile(path.join(__dirname, 'public-login', filename)),
      );
    }
    app.use(
      session({
        name: config.cookieName,
        secret: config.secret,
        store,
        resave: false,
        saveUninitialized: false,
        rolling: true,
        cookie: {
          path: '/',
          httpOnly: true,
          secure: config.production,
          sameSite: 'lax',
          maxAge: config.idleMs,
        },
      }),
    );
    app.use((req, res, next) => {
      if (req.session.startedAt) {
        const remaining = req.session.startedAt + config.absoluteMs - Date.now();
        if (remaining <= 0)
          return req.session.destroy((err) => {
            if (err) return next(err);
            res.clearCookie(config.cookieName, {
              path: '/',
              httpOnly: true,
              sameSite: 'lax',
              secure: config.production,
            });
            return req.path.startsWith('/api/')
              ? res.status(401).json({ error: '请先登录' })
              : res.redirect(302, '/login');
          });
        req.session.cookie.maxAge = Math.min(config.idleMs, remaining);
      }
      next();
    });
    app.get('/login', (req, res) => {
      // A signed, short-lived pre-login token avoids persisting anonymous sessions.
      const token = issueLoginToken(config.secret);
      const html = fs.readFileSync(path.join(__dirname, 'public-login/login.html'), 'utf8');
      res.type('html').send(html.replace('__CSRF_TOKEN__', token));
    });
    app.use('/api', (req, res, next) => {
      if (req.method === 'POST' && req.path === '/auth/login') return next();
      return requireAuth(auth)(req, res, next);
    });
    // Applied to all /api writes, including future routes and login itself.
    app.use('/api', writeBoundary(config.origin, config.secret));
    app.use(
      '/api/auth',
      express.json({ limit: '8kb', strict: true }),
      createAuthRoutes(auth, config, { userService, auditService }),
    );
    app.use(
      '/api/users',
      express.json({ limit: '32kb', strict: true }),
      createUserRoutes(userService, ownershipService, auditService),
    );
    app.use('/api/audit-logs', createAuditRoutes(auditService));
    app.use(
      '/api/server-backup',
      express.json({ limit: config.businessBackupLimit, strict: true }),
      createBusinessBackupRoutes(businessBackupService, auditService),
    );
    app.use(
      '/api',
      express.json({ limit: config.businessBackupLimit, strict: true }),
      createBusinessOperationRoutes(orderOperationService, businessCrudService, auditService),
    );
    app.use(
      '/api',
      express.json({ limit: config.businessBackupLimit, strict: true }),
      createBusinessCrudRoutes(
        businessCrudService,
        businessBackupService,
        ownershipService,
        auditService,
      ),
    );
    app.use('/api/server-data', createServerDataRoutes(businessBackupService));
    app.use('/api', (req, res) => res.status(404).json({ error: 'API not found' }));
    const pageAuth = requireAuth(auth, { page: true });
    app.get(
      '/change-password',
      requireAuth(auth, { page: true, allowPasswordChange: true }),
      (req, res) => {
        res.sendFile(path.join(__dirname, 'public-login', 'change-password.html'));
      },
    );
    app.get(['/', '/index.html'], pageAuth, (req, res) => {
      const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
      // Server-only shell; on-disk index and local Python workflow remain untouched.
      const shell =
        '<link rel="stylesheet" href="/auth-shell/shell.css"><script defer src="/auth-shell/shell.js"></script>';
      res.type('html').send(html.replace('</head>', `${shell}</head>`));
    });
    for (const file of businessFiles) {
      app.get(`/${file}`, pageAuth, (req, res) => res.sendFile(path.join(root, file)));
    }
    for (const filename of ['shell.js', 'shell.css']) {
      app.get(`/auth-shell/${filename}`, pageAuth, (req, res) =>
        res.sendFile(path.join(__dirname, 'public-app', filename)),
      );
    }
    app.use((req, res) => res.status(404).type('text').send('Not found'));
    app.use(errorHandler);
    return {
      app,
      db,
      store,
      repositories,
      businessBackupService,
      packingListTransactionService,
      businessCrudService,
      sequenceService,
      orderOperationService,
      auditService,
      ownershipService,
      userService,
      close() {
        store.close();
        db.close();
      },
    };
  } catch (err) {
    store?.close();
    db.close();
    throw err;
  }
}
module.exports = { createApp };
