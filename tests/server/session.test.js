'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers');
const { SQLiteSessionStore } = require('../../server/db/session-store');
const { createApp } = require('../../server/app');
const { once } = require('node:events');
let f;
before(async () => {
  f = await fixture();
});
after(async () => {
  await f.cleanup();
});
const current = () => f.db.prepare('SELECT * FROM sessions ORDER BY rowid DESC LIMIT 1').get();

test('Successful login establishes a fresh ID and any pre-login cookie stays unauthenticated', async () => {
  const c = f.client();
  await c.csrf();
  const old = c.cookie;
  await c.login();
  assert.notEqual(c.cookie, old);
  const stale = f.client();
  stale.cookie = old;
  assert.equal((await stale.request('/api/auth/me')).status, 401);
  assert.equal((await c.request('/api/auth/me')).status, 200);
});
test('Cookie is HttpOnly SameSite=Lax path=/ and non-Secure only in development', async () => {
  const r = await f.client().login();
  const cookie = r.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Path=\//);
  assert.doesNotMatch(cookie, /; Secure/);
});
test('Refresh preserves the authenticated session in SQLite', async () => {
  const c = f.client();
  await c.login();
  const row = current();
  assert.equal(JSON.parse(row.payload).userId, f.user.id);
  for (let i = 0; i < 2; i++) assert.equal((await c.request('/')).status, 200);
  assert.ok(f.db.prepare('SELECT * FROM sessions WHERE sid=?').get(row.sid));
});
test('Logout deletes session, clears cookie, and old cookie cannot be replayed', async () => {
  const c = f.client();
  await c.login();
  const old = c.cookie,
    sid = current().sid;
  const r = await c.write('/api/auth/logout');
  assert.equal(r.status, 204);
  assert.match(r.headers.get('set-cookie'), /Expires=Thu, 01 Jan 1970/);
  assert.equal(f.db.prepare('SELECT * FROM sessions WHERE sid=?').get(sid), undefined);
  assert.equal((await c.request('/')).status, 302);
  c.cookie = old;
  assert.equal((await c.request('/api/auth/me')).status, 401);
});
test('GET logout cannot modify session state', async () => {
  const c = f.client();
  await c.login();
  assert.equal((await c.request('/api/auth/logout')).status, 404);
  assert.equal((await c.request('/api/auth/me')).status, 200);
});
test('Server rejects expired idle sessions even if browser keeps the cookie', async () => {
  const c = f.client();
  await c.login();
  f.db.prepare('UPDATE sessions SET expires_at=? WHERE sid=?').run(Date.now() - 1, current().sid);
  assert.equal((await c.request('/api/auth/me')).status, 401);
});
test('Server rejects absolute-expired sessions even with fresh idle deadline', async () => {
  const c = f.client();
  await c.login();
  f.db
    .prepare('UPDATE sessions SET absolute_expires_at=?, expires_at=? WHERE sid=?')
    .run(Date.now() - 1, Date.now() + 60000, current().sid);
  assert.equal((await c.request('/api/auth/me')).status, 401);
});
test('Authenticated requests refresh idle but never extend absolute deadline', async () => {
  const c = f.client();
  await c.login();
  const row = current();
  f.db.prepare('UPDATE sessions SET expires_at=? WHERE sid=?').run(Date.now() + 10000, row.sid);
  assert.equal((await c.request('/api/auth/me')).status, 200);
  const after = f.db.prepare('SELECT * FROM sessions WHERE sid=?').get(row.sid);
  assert.equal(after.absolute_expires_at, row.absolute_expires_at);
  assert.ok(after.expires_at > Date.now() + 10000);
});
test('A newly constructed session store can read persisted sessions', async () => {
  const c = f.client();
  await c.login();
  const row = current();
  const fresh = new SQLiteSessionStore(f.db, f.config);
  try {
    // Decode signed cookie without printing it; extract opaque ID before signature.
    const signed = decodeURIComponent(c.cookie.slice(c.cookie.indexOf('=') + 1));
    const id = signed.slice(2, signed.lastIndexOf('.'));
    const value = await new Promise((resolve, reject) =>
      fresh.get(id, (err, v) => (err ? reject(err) : resolve(v))),
    );
    assert.equal(value.userId, f.user.id);
    assert.equal(fresh.key(id), row.sid);
    assert.notEqual(row.sid, id);
  } finally {
    fresh.close();
  }
});
test('A new application and SQLite connection accept persisted cookie without resetting administrator', async () => {
  const c = f.client();
  await c.login();
  const before = f.db.prepare('SELECT * FROM users').all();
  const reopened = await createApp(f.config);
  const server = reopened.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/me`, {
      headers: { Cookie: c.cookie },
      redirect: 'manual',
    });
    assert.equal(r.status, 200);
    const me = await r.json();
    assert.deepEqual(me, {
      id: f.user.id,
      username: f.user.username,
      email: f.user.email,
      displayName: f.user.displayName,
      role: f.user.role,
      status: f.user.status,
      mustChangePassword: f.user.mustChangePassword,
      passwordMinLength: 8,
    });
    assert.deepEqual(reopened.db.prepare('SELECT * FROM users').all(), before);
  } finally {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
    reopened.close();
  }
});
