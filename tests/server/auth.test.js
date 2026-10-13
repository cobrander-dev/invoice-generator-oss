'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { fixture, TEST_USERNAME, TEST_PASSWORD } = require('./helpers');
const { initializeAdmin } = require('../../server/auth/auth-service');
let f;
before(async () => {
  f = await fixture();
});
after(async () => {
  await f.cleanup();
});

test('GET /login returns a real form and signed pre-login CSRF token', async () => {
  const c = f.client(),
    r = await c.request('/login');
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /type="password"/);
  assert.match(html, /name="csrf-token" content="[a-f0-9]{112}"/);
  assert.match(html, /Server mode enabled/);
  assert.match(html, /受保护API存储到SQLite/);
});
test('Unauthenticated root redirects to login', async () => {
  const r = await f.client().request('/');
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/login');
});
test('Unauthenticated me and future APIs return 401', async () => {
  const c = f.client();
  for (const route of ['/api/auth/me', '/api/orders', '/api/auth/csrf'])
    assert.equal((await c.request(route)).status, 401);
});
test('Correct administrator logs in and me returns safe role/profile fields only', async () => {
  const c = f.client();
  assert.equal((await c.login()).status, 200);
  const r = await c.request('/api/auth/me');
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), {
    id: f.user.id,
    username: TEST_USERNAME,
    email: '',
    displayName: TEST_USERNAME,
    role: 'ADMIN',
    status: 'ACTIVE',
    mustChangePassword: false,
    passwordMinLength: 8,
  });
});
test('Wrong username and wrong password have identical responses', async () => {
  const a = await f.client().login('unknown-test-user');
  const b = await f.client().login(TEST_USERNAME, 'WRONG-TEST-password');
  assert.equal(a.status, 401);
  assert.equal(b.status, 401);
  assert.deepEqual(await a.json(), await b.json());
});
test('Auth DB stores Argon2id, no plaintext password, and only expected server tables', () => {
  const row = f.db.prepare('SELECT * FROM users').get();
  assert.match(row.password_hash, /^\$argon2id\$/);
  assert.notEqual(row.password_hash, TEST_PASSWORD);
  assert.equal(JSON.stringify(row).includes(TEST_PASSWORD), false);
  assert.equal(fs.readFileSync(f.config.databasePath).includes(Buffer.from(TEST_PASSWORD)), false);
  const tables = f.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((x) => x.name);
  assert.deepEqual(tables, [
    'audit_logs',
    'company',
    'customers',
    'document_sequences',
    'meta',
    'orders',
    'packing_lists',
    'products',
    'restore_points',
    'schema_migrations',
    'sessions',
    'user_login_identifiers',
    'users',
  ]);
});
test('Explicit initialization refuses to overwrite an existing administrator', async () => {
  const before = f.db.prepare('SELECT * FROM users').all();
  await assert.rejects(
    initializeAdmin(f.db, 'other-test-admin', 'ANOTHER-TEST-passphrase-0000'),
    /already exists/,
  );
  assert.deepEqual(f.db.prepare('SELECT * FROM users').all(), before);
});
test('Authenticated root serves existing app with server-only banner script', async () => {
  const c = f.client();
  await c.login();
  const r = await c.request('/');
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /js\/api-db.js/);
  assert.doesNotMatch(html, /js\/db.js/);
  assert.match(html, /auth-shell\/shell.js/);
  assert.match(html, /page-content/);
});
test('Authenticated static allowlist serves original JS and PDF dependencies', async () => {
  const c = f.client();
  await c.login();
  for (const file of [
    '/js/app.js',
    '/js/core.js',
    '/js/api-db.js',
    '/js/pdf.js',
    '/css/styles.css',
    '/node_modules/jspdf/dist/jspdf.umd.min.js',
  ]) {
    const r = await c.request(file);
    assert.equal(r.status, 200);
    await r.arrayBuffer();
  }
  assert.equal((await c.request('/js/db.js')).status, 404);
});
