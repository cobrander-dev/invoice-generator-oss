'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers');
const { backupA, backupB } = require('./business-fixtures');
let f;
before(async () => { f = await fixture(); });
after(async () => { await f.cleanup(); });

test('All server data and backup APIs require authentication', async () => {
  const c = f.client();
  for (const route of ['/api/server-data/summary', '/api/server-backup/export']) assert.equal((await c.request(route)).status, 401);
  for (const route of ['/api/server-backup/inspect', '/api/server-backup/import', '/api/server-backup/restore']) assert.equal((await c.write(route, { body: backupA() })).status, 401);
});
test('Backup POST without CSRF is rejected', async () => {
  const c = f.client(); await c.login(); assert.equal((await c.write('/api/server-backup/import', { csrf: false, body: backupA() })).status, 403);
});
test('Backup POST with wrong Origin is rejected', async () => {
  const c = f.client(); await c.login(); assert.equal((await c.write('/api/server-backup/inspect', { origin: 'https://attacker.example.invalid', body: backupA() })).status, 403);
});
test('Authenticated inspect and summary expose counts, not full sensitive payloads', async () => {
  const c = f.client(); await c.login(); let r = await c.write('/api/server-backup/inspect', { body: backupA() });
  assert.equal(r.status, 200); const inspect = await r.json(); assert.equal(inspect.orders, 1); assert.equal('signatureImage' in inspect, false);
  f.businessBackupService.replaceAllBusinessData(backupA(), false); r = await c.request('/api/server-data/summary');
  assert.equal(r.status, 200); assert.equal((await r.json()).customers, 1);
});
test('Authenticated export and import keep compatible JSON and exclude authentication data', async () => {
  const c = f.client(); await c.login(); let r = await c.write('/api/server-backup/import', { body: backupA() }); assert.equal(r.status, 200);
  r = await c.request('/api/server-backup/export'); assert.equal(r.status, 200); const data = await r.json();
  assert.deepEqual(data.company, backupA().company); assert.equal(data.users, undefined); assert.equal(data.sessions, undefined); assert.equal(data.restore_points, undefined);
});
test('Authenticated restore endpoint restores the pre-import dataset', async () => {
  const c = f.client(); await c.login(); await c.write('/api/server-backup/import', { body: backupA() }); await c.write('/api/server-backup/import', { body: backupB() });
  const r = await c.write('/api/server-backup/restore'); assert.equal(r.status, 200); assert.equal((await r.json()).restored, true);
  assert.equal(f.businessBackupService.exportAllBusinessData().company[0].englishName, backupA().company[0].englishName);
});
test('Authenticated HTTP import accepts a multi-megabyte TEST attachment without truncation', async () => {
  const c = f.client(); await c.login(); const data = backupA();
  const marker = Buffer.alloc(2 * 1024 * 1024, 65).toString('base64');
  data.orders[0].attachments[0].data = `data:application/octet-stream;base64,${marker}`;
  const imported = await c.write('/api/server-backup/import', { body: data }); assert.equal(imported.status, 200);
  const exported = await c.request('/api/server-backup/export'); assert.equal(exported.status, 200);
  assert.equal((await exported.json()).orders[0].attachments[0].data, data.orders[0].attachments[0].data);
});
test('Invalid HTTP import returns 400 and leaves existing server business data intact', async () => {
  const c = f.client(); await c.login(); f.businessBackupService.replaceAllBusinessData(backupA(), false);
  const invalid = backupB(); invalid.orders.push({ ...invalid.orders[0] });
  const r = await c.write('/api/server-backup/import', { body: invalid }); assert.equal(r.status, 400);
  assert.deepEqual(f.businessBackupService.exportAllBusinessData().company, backupA().company);
});
