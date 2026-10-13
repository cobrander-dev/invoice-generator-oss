'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, TEST_USERNAME, TEST_PASSWORD } = require('./helpers');
const { loadConfig } = require('../../server/config');
const { randomBytes } = require('node:crypto');
let f;
before(async () => {
  f = await fixture();
});
after(async () => {
  await f.cleanup();
});

test('Health exposes only status and does not create a session', async () => {
  const r = await f.client().request('/health');
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { status: 'ok' });
  assert.equal(r.headers.get('set-cookie'), null);
});
test('Environment, SQLite, source maps, server source, tests and dependency directories are never static', async () => {
  const c = f.client();
  await c.login();
  for (const file of [
    '/.env',
    '/.env.example',
    '/data/auth.sqlite',
    '/data/auth.sqlite-wal',
    '/server/config.js',
    '/package.json',
    '/tests/server/auth.test.js',
    '/node_modules/express/package.json',
    '/js/../server/config.js',
    '/%2eenv',
    '/js/app.js.map',
  ]) {
    assert.equal((await c.request(file)).status, 404, file);
  }
});
test('Direct index.html and protected assets cannot bypass authentication', async () => {
  for (const file of [
    '/index.html',
    '/index.html?bypass=1',
    '/js/app.js',
    '/css/styles.css',
    '/auth-shell/shell.js',
  ]) {
    const r = await f.client().request(file);
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), '/login');
  }
});
test('Authenticated write without CSRF is refused and session remains valid', async () => {
  const c = f.client();
  await c.login();
  assert.equal((await c.write('/api/auth/logout', { csrf: false })).status, 403);
  assert.equal((await c.request('/api/auth/me')).status, 200);
});
test('Wrong or missing Origin is refused even with valid CSRF', async () => {
  const c = f.client();
  await c.login();
  for (const origin of ['https://attacker.example.invalid', 'null', null])
    assert.equal((await c.write('/api/auth/logout', { origin })).status, 403);
});
test('CSRF token from another session is rejected', async () => {
  const c = f.client(),
    other = f.client();
  await c.login();
  const foreign = await other.csrf();
  const r = await c.request('/api/auth/logout', {
    method: 'POST',
    headers: { Origin: f.config.origin, 'X-CSRF-Token': foreign },
  });
  assert.equal(r.status, 403);
});
test('Login itself requires valid pre-session token and same Origin', async () => {
  const c = f.client(),
    token = await c.csrf();
  const base = { 'Content-Type': 'application/json' };
  for (const headers of [
    { ...base, Origin: f.config.origin },
    { ...base, Origin: 'https://attacker.example.invalid', 'X-CSRF-Token': token },
  ]) {
    const r = await c.request('/api/auth/login', {
      method: 'POST',
      headers,
      body: JSON.stringify({ username: TEST_USERNAME, password: TEST_PASSWORD }),
    });
    assert.equal(r.status, 403);
  }
});
test('Malformed CSRF token returns 403, not a timingSafeEqual exception', async () => {
  const c = f.client();
  await c.login();
  const r = await c.request('/api/auth/logout', {
    method: 'POST',
    headers: { Origin: f.config.origin, 'X-CSRF-Token': 'z'.repeat(64) },
  });
  assert.equal(r.status, 403);
});
test('Security headers block scripts/frames while supporting data images and blob PDF', async () => {
  const r = await f.client().request('/login');
  const csp = r.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self'/);
  assert.doesNotMatch(csp, /unsafe-eval|\*/);
  assert.match(csp, /img-src 'self' data: blob:/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(r.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal(r.headers.get('cache-control'), 'no-store');
});
test('Rate limit blocks repeated login attempts despite new pre-login sessions', async () => {
  const limited = await fixture({ loginPairLimit: 2 });
  try {
    for (let i = 0; i < 2; i++)
      assert.equal(
        (await limited.client().login(TEST_USERNAME, 'WRONG-TEST-passphrase')).status,
        401,
      );
    const r = await limited.client().login(TEST_USERNAME, 'WRONG-TEST-passphrase');
    assert.equal(r.status, 429);
    assert.ok(Number(r.headers.get('retry-after')) > 0);
  } finally {
    await limited.cleanup();
  }
});
test('IP limit also blocks username rotation', async () => {
  const limited = await fixture({ loginIpLimit: 2 });
  try {
    for (const name of ['test-one', 'test-two'])
      assert.equal((await limited.client().login(name)).status, 401);
    assert.equal((await limited.client().login('test-three')).status, 429);
  } finally {
    await limited.cleanup();
  }
});
test('Username-wide limit survives source IP changes', async () => {
  const limited = await fixture({ loginUserLimit: 2, trustProxyLoopback: true });
  try {
    for (let i = 1; i <= 3; i++) {
      const c = limited.client(),
        token = await c.csrf();
      const r = await c.request('/api/auth/login', {
        method: 'POST',
        headers: {
          'X-Forwarded-For': `198.51.100.${i}`,
          Origin: limited.config.origin,
          'Content-Type': 'application/json',
          'X-CSRF-Token': token,
        },
        body: JSON.stringify({ username: TEST_USERNAME, password: 'WRONG-TEST-password' }),
      });
      assert.equal(r.status, i === 3 ? 429 : 401);
    }
  } finally {
    await limited.cleanup();
  }
});
test('Production cookie uses Secure and __Host name with trusted loopback TLS proxy only', async () => {
  const tls = await fixture({
    production: true,
    cookieName: '__Host-ft.sid',
    origin: 'https://invoice.example.invalid',
    trustProxyLoopback: true,
  });
  try {
    const r = await tls.client().login();
    assert.equal(r.status, 200);
    const cookie = r.headers.get('set-cookie');
    assert.match(cookie, /^__Host-ft.sid=/);
    assert.match(cookie, /; Secure/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    assert.doesNotMatch(cookie, /Domain=/);
    assert.equal(
      (await tls.client().request('/login', { headers: { 'X-Forwarded-Proto': 'http' } })).status,
      400,
    );
  } finally {
    await tls.cleanup();
  }
});
test('Production does not trust forged forwarded TLS by default', async () => {
  const tls = await fixture({ production: true, origin: 'https://invoice.example.invalid' });
  try {
    assert.equal((await tls.client().request('/login')).status, 400);
  } finally {
    await tls.cleanup();
  }
});
test('Configuration rejects placeholder secret and insecure production origin', () => {
  assert.throws(() => loadConfig({ SESSION_SECRET: 'change-me' }), /SESSION_SECRET/);
  assert.throws(
    () => loadConfig({ NODE_ENV: 'production', SESSION_SECRET: randomBytes(32).toString('hex') }),
    /HTTPS/,
  );
  assert.throws(
    () =>
      loadConfig({
        SESSION_SECRET: randomBytes(32).toString('hex'),
        APP_ORIGIN: 'http://localhost:3000/path',
      }),
    /exact/,
  );
});
test('Invalid or oversized JSON never exposes request payload in errors', async () => {
  const c = f.client();
  const token = await c.csrf();
  for (const [body, expected] of [
    ['{invalid-json', 400],
    [JSON.stringify({ password: 'x'.repeat(9000) }), 413],
  ]) {
    const r = await c.request('/api/auth/login', {
      method: 'POST',
      headers: {
        Origin: f.config.origin,
        'X-CSRF-Token': token,
        'Content-Type': 'application/json',
      },
      body,
    });
    assert.equal(r.status, expected);
    const data = await r.json();
    assert.deepEqual(Object.keys(data), ['error']);
    assert.ok(data.error.length < 80);
  }
});
