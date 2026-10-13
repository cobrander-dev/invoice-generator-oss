'use strict';
const { createHmac, randomBytes, timingSafeEqual } = require('node:crypto');
const LOGIN_TOKEN_TTL_MS = 10 * 60 * 1000;
function issueToken(req) {
  if (!req.session.startedAt) req.session.startedAt = Date.now();
  if (!req.session.csrfToken) req.session.csrfToken = randomBytes(32).toString('hex');
  return req.session.csrfToken;
}
function issueLoginToken(secret, now = Date.now()) {
  const payload = `${now.toString(16).padStart(16, '0')}${randomBytes(16).toString('hex')}`;
  const signature = createHmac('sha256', secret).update(payload).digest('hex');
  return `${payload}${signature}`;
}
function verifyLoginToken(token, secret, now = Date.now()) {
  if (typeof token !== 'string' || !/^[a-f0-9]{112}$/.test(token)) return false;
  const payload = token.slice(0, 48), supplied = Buffer.from(token.slice(48), 'hex');
  const issuedAt = Number.parseInt(payload.slice(0, 16), 16);
  if (!Number.isSafeInteger(issuedAt) || issuedAt > now + 30000 || now - issuedAt > LOGIN_TOKEN_TTL_MS) return false;
  const expected = createHmac('sha256', secret).update(payload).digest();
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
function writeBoundary(origin, secret) {
  return (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (req.get('Origin') !== origin) return res.status(403).json({ error: '请求来源不受信任' });
    const supplied = req.get('X-CSRF-Token');
    if (req.path === '/auth/login') {
      if (!verifyLoginToken(supplied, secret)) return res.status(403).json({ error: '安全令牌无效，请刷新后重试' });
      return next();
    }
    const expected = req.session.csrfToken;
    if (!expected || typeof supplied !== 'string' || !/^[a-f0-9]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
      return res.status(403).json({ error: '安全令牌无效，请刷新后重试' });
    }
    next();
  };
}
module.exports = { issueToken, issueLoginToken, verifyLoginToken, writeBoundary, LOGIN_TOKEN_TTL_MS };
