'use strict';
const express = require('express');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { createHash } = require('node:crypto');
const { normalizeUsername } = require('../auth/auth-service');
const { issueToken } = require('../auth/csrf');

function createAuthRoutes(auth, config, { userService, auditService } = {}) {
  const router = express.Router();
  const digest = (value) => createHash('sha256').update(value).digest('hex');
  const limiter = (limit, keyGenerator) => {
    const middleware = rateLimit({
      windowMs: config.loginWindowMs,
      limit,
      keyGenerator,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      handler: (req, res) => {
        auditService?.write({
          username: normalizeUsername(req.body?.username),
          action: 'LOGIN_RATE_LIMITED',
          entityType: 'AUTH',
          ipAddress: req.ip,
          result: 'FAILURE',
        });
        res.status(429).json({ error: '登录尝试过多，请稍后重试' });
      },
    });
    return middleware;
  };
  const ipKey = (req) => ipKeyGenerator(req.ip);
  const userKey = (req) => digest(normalizeUsername(req.body?.username).slice(0, 128));
  router.post(
    '/login',
    limiter(config.loginIpLimit, ipKey),
    limiter(config.loginPairLimit, (req) => `${ipKey(req)}:${userKey(req)}`),
    limiter(config.loginUserLimit, userKey),
    async (req, res, next) => {
      try {
        const user = await auth.authenticate(req.body?.username, req.body?.password);
        if (!user) {
          auditService?.write({
            username: normalizeUsername(req.body?.username),
            action: 'LOGIN_FAILED',
            entityType: 'AUTH',
            ipAddress: req.ip,
            result: 'FAILURE',
          });
          return res.status(401).json({ error: '用户名或密码错误' });
        }
        const loggedInUser = auditService.perform(
          {
            actor: user,
            action: 'LOGIN_SUCCESS',
            entityType: 'AUTH',
            entityId: user.id,
            ipAddress: req.ip,
          },
          () => auth.markLogin(user.id),
        );
        await new Promise((resolve, reject) =>
          req.session.regenerate((err) => (err ? reject(err) : resolve())),
        );
        req.session.userId = loggedInUser.id;
        req.session.authVersion = loggedInUser.authVersion;
        req.session.startedAt = Date.now();
        issueToken(req);
        await new Promise((resolve, reject) =>
          req.session.save((err) => (err ? reject(err) : resolve())),
        );
        res.json({ user: loggedInUser });
      } catch (err) {
        next(err);
      }
    },
  );
  router.get('/me', (req, res) =>
    res.json({
      id: req.user.id,
      username: req.user.username,
      email: req.user.email,
      displayName: req.user.displayName,
      role: req.user.role,
      status: req.user.status,
      mustChangePassword: req.user.mustChangePassword,
      passwordMinLength: config.passwordMinLength,
    }),
  );
  router.get('/csrf', (req, res) => res.json({ csrfToken: issueToken(req) }));
  router.post('/logout', (req, res, next) => {
    auditService?.write({
      actor: req.user,
      action: 'LOGOUT',
      entityType: 'AUTH',
      entityId: req.user.id,
      ipAddress: req.ip,
    });
    req.session.destroy((err) => {
      if (err) return next(err);
      res.clearCookie(config.cookieName, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: config.production,
      });
      res.status(204).end();
    });
  });
  router.post('/change-password', async (req, res, next) => {
    try {
      if (req.body?.newPassword !== req.body?.confirmPassword)
        throw Object.assign(new Error('New password confirmation does not match'), {
          statusCode: 400,
          expose: true,
        });
      const changed = await userService.changePassword(
        req.user.id,
        req.body?.currentPassword,
        req.body?.newPassword,
        {
          actor: req.user,
          action: 'CHANGE_PASSWORD',
          entityType: 'USER',
          entityId: req.user.id,
          ipAddress: req.ip,
        },
      );
      await new Promise((resolve, reject) =>
        req.session.regenerate((err) => (err ? reject(err) : resolve())),
      );
      req.session.userId = changed.id;
      req.session.authVersion = changed.authVersion;
      req.session.startedAt = Date.now();
      issueToken(req);
      await new Promise((resolve, reject) =>
        req.session.save((err) => (err ? reject(err) : resolve())),
      );
      res.json({ changed: true, user: changed });
    } catch (err) {
      next(err);
    }
  });
  return router;
}
module.exports = { createAuthRoutes };
