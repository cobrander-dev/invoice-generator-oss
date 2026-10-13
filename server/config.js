'use strict';
const path = require('node:path');
const { passwordMinimum } = require('./auth/password-policy');

function loadConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  if (production && !env.APP_ORIGIN)
    throw new Error('Production requires explicit HTTPS APP_ORIGIN');
  const origin = env.APP_ORIGIN || `http://127.0.0.1:${port}`;
  const parsed = new URL(origin);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin)
    throw new Error('APP_ORIGIN must be an exact HTTP(S) origin');
  if (production && parsed.protocol !== 'https:')
    throw new Error('Production requires HTTPS APP_ORIGIN');
  const secret = env.SESSION_SECRET || '';
  if (Buffer.byteLength(secret) < 32 || /change-me|replace-me/i.test(secret))
    throw new Error('SESSION_SECRET must contain at least 32 bytes of random secret material');
  const configuredDatabasePath = env.DATABASE_PATH || env.AUTH_DB_PATH;
  if (production && !configuredDatabasePath)
    throw new Error('Production requires explicit DATABASE_PATH');
  let trustProxy = false;
  if (env.TRUST_PROXY_HOPS !== undefined && env.TRUST_PROXY_HOPS !== '') {
    const hops = Number(env.TRUST_PROXY_HOPS);
    if (!Number.isInteger(hops) || hops !== 1)
      throw new Error('TRUST_PROXY_HOPS must be exactly 1');
    trustProxy = hops;
  } else if (env.TRUST_PROXY_LOOPBACK === 'true') trustProxy = 'loopback';
  return Object.freeze({
    production,
    port,
    origin,
    secret,
    host: env.HOST || '127.0.0.1',
    databasePath: path.resolve(configuredDatabasePath || './data/invoice-generator.sqlite'),
    trustProxy,
    cookieName: production ? '__Host-ft.sid' : 'ft.sid',
    idleMs: 30 * 60 * 1000,
    absoluteMs: 12 * 60 * 60 * 1000,
    loginWindowMs: 15 * 60 * 1000,
    loginIpLimit: 60,
    loginPairLimit: 10,
    loginUserLimit: 30,
    businessBackupLimit: env.BUSINESS_BACKUP_LIMIT || '64mb',
    passwordMinLength: passwordMinimum(env.PASSWORD_MIN_LENGTH),
  });
}
module.exports = { loadConfig };
