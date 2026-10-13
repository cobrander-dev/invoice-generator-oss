'use strict';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { fixture } = require('./helpers');
const { backupA, backupB, TEST_IMAGE, TEST_ATTACHMENT } = require('./business-fixtures');
const { BusinessBackupService } = require('../../server/services/business-backup-service');
const { PackingListTransactionService } = require('../../server/services/packing-list-transaction-service');
const { openDatabase } = require('../../server/db/database');
const { createBusinessRepositories } = require('../../server/repositories/business-repository');
let f;
beforeEach(async () => { f = await fixture(); });
afterEach(async () => { await f.cleanup(); });
const collections = data => Object.fromEntries(['company', 'customers', 'products', 'orders', 'packingLists', 'meta'].map(key => [key, data[key] || []]));

test('Server export has compatible version 2 top-level format', () => {
  const data = f.businessBackupService.exportAllBusinessData();
  assert.deepEqual(Object.keys(data), ['version', 'createdAt', 'exportedAt', 'company', 'customers', 'products', 'orders', 'packingLists', 'meta']);
  assert.equal(data.version, 2); assert.ok(data.createdAt); assert.ok(data.exportedAt);
});
test('Business export excludes all authentication and restore metadata', () => {
  const text = JSON.stringify(f.businessBackupService.exportAllBusinessData());
  for (const forbidden of ['users', 'sessions', 'password_hash', 'schema_migrations', 'row_version', 'restore_points', 'csrfToken']) assert.equal(text.includes(forbidden), false);
});
test('Valid v2 backup is accepted', () => assert.equal(f.businessBackupService.validateBusinessBackup(backupA()), true));
test('Legacy v1 backup without packingLists is accepted', () => assert.equal(f.businessBackupService.validateBusinessBackup(backupA(1)), true));
test('Invalid versions and missing arrays are rejected without writes', () => {
  const invalid = backupA(); invalid.version = 99; delete invalid.orders;
  assert.throws(() => f.businessBackupService.replaceAllBusinessData(invalid), /version|orders/);
  assert.deepEqual(f.businessBackupService.exportAllBusinessData().orders, []);
});
test('Duplicate IDs are rejected instead of silently deduplicated', () => {
  const invalid = backupA(); invalid.customers.push({ ...invalid.customers[0] });
  assert.throws(() => f.businessBackupService.validateBusinessBackup(invalid), /duplicate/);
});
test('Inspect returns safe and correct counts without sensitive payloads', () => {
  const summary = f.businessBackupService.inspectBackup(backupA());
  assert.deepEqual(summary, { version: 2, createdAt: '2026-01-01T00:00:00.000Z', exportedAt: '2026-01-01T00:00:00.000Z', company: 1,
    accounts: 1, customers: 1, products: 1, orders: 1, packingLists: 1, piHistory: 1, ci: 1, payments: 1, attachments: 2 });
  const text = JSON.stringify(summary); assert.equal(text.includes(TEST_IMAGE), false); assert.equal(text.includes(TEST_ATTACHMENT), false); assert.equal(text.includes('accountNumber'), false);
});
test('Import performs complete replacement', () => {
  f.businessBackupService.replaceAllBusinessData(backupA());
  f.businessBackupService.replaceAllBusinessData(backupB());
  assert.deepEqual(collections(f.businessBackupService.exportAllBusinessData()), collections(backupB()));
});
test('Import is replacement, never merge or append', () => {
  f.businessBackupService.replaceAllBusinessData(backupA()); f.businessBackupService.replaceAllBusinessData(backupB());
  assert.equal(f.repositories.customers.get('customer-test-1'), null); assert.equal(f.repositories.customers.list().length, 2);
});
test('Import atomically creates restore_points/latest containing pre-import data', () => {
  f.businessBackupService.replaceAllBusinessData(backupA(), false);
  f.businessBackupService.replaceAllBusinessData(backupB(), true);
  const point = f.repositories.restorePoints.get('latest').payload;
  assert.equal(point.id, 'latest'); assert.ok(point.createdAt); assert.deepEqual(collections(point.data), collections(backupA()));
});
test('Restore Latest returns complete pre-import business data', () => {
  f.businessBackupService.replaceAllBusinessData(backupA(), false); f.businessBackupService.replaceAllBusinessData(backupB(), true);
  f.businessBackupService.restoreLatestBusinessData();
  assert.deepEqual(collections(f.businessBackupService.exportAllBusinessData()), collections(backupA()));
});
test('Restore does not modify administrator records', () => {
  const users = f.db.prepare('SELECT * FROM users').all();
  f.businessBackupService.replaceAllBusinessData(backupA(), false); f.businessBackupService.replaceAllBusinessData(backupB(), true); f.businessBackupService.restoreLatestBusinessData();
  assert.deepEqual(f.db.prepare('SELECT * FROM users').all(), users);
});
test('Clear creates latest restore point with prior business data', () => {
  f.businessBackupService.replaceAllBusinessData(backupA(), false); f.businessBackupService.clearAllBusinessData(true);
  assert.deepEqual(collections(f.repositories.restorePoints.get('latest').payload.data), collections(backupA()));
});
test('Clear empties only business collections and preserves auth/session/schema', async () => {
  const c = f.client(); await c.login(); const auth = { users: f.db.prepare('SELECT COUNT(*) n FROM users').get().n, sessions: f.db.prepare('SELECT COUNT(*) n FROM sessions').get().n, migrations: f.db.prepare('SELECT COUNT(*) n FROM schema_migrations').get().n };
  f.businessBackupService.replaceAllBusinessData(backupA(), false); f.businessBackupService.clearAllBusinessData(true);
  assert.deepEqual(collections(f.businessBackupService.exportAllBusinessData()), collections({}));
  assert.deepEqual({ users: f.db.prepare('SELECT COUNT(*) n FROM users').get().n, sessions: f.db.prepare('SELECT COUNT(*) n FROM sessions').get().n, migrations: f.db.prepare('SELECT COUNT(*) n FROM schema_migrations').get().n }, auth);
});
test('Simulated replace failure rolls back old data, new data and restore point together', () => {
  f.businessBackupService.replaceAllBusinessData(backupA(), false);
  const failing = new BusinessBackupService(f.db, f.repositories, { onStep: step => { if (step === 'after-clear') throw new Error('TEST failure'); } });
  assert.throws(() => failing.replaceAllBusinessData(backupB(), true), /TEST failure/);
  assert.deepEqual(collections(f.businessBackupService.exportAllBusinessData()), collections(backupA())); assert.equal(f.repositories.restorePoints.get('latest'), null);
});
test('Simulated restore failure rolls back and keeps current imported data intact', () => {
  f.businessBackupService.replaceAllBusinessData(backupA(), false); f.businessBackupService.replaceAllBusinessData(backupB(), true);
  const point = f.repositories.restorePoints.get('latest').payload;
  const failing = new BusinessBackupService(f.db, f.repositories, { onStep: step => { if (step === 'after-clear') throw new Error('TEST restore failure'); } });
  assert.throws(() => failing.restoreLatestBusinessData(), /TEST restore failure/);
  assert.deepEqual(collections(f.businessBackupService.exportAllBusinessData()), collections(backupB())); assert.deepEqual(f.repositories.restorePoints.get('latest').payload, point);
});
test('Order and independent PL second-step failure rolls back both writes', () => {
  const oldOrder = { id: 'pair-order', value: 'OLD' }, oldPl = { id: 'pair-pl', orderId: 'pair-order', value: 'OLD' };
  f.repositories.orders.put(oldOrder, 0); f.repositories.packingLists.put(oldPl, 0);
  const service = new PackingListTransactionService(f.db, f.repositories, { onStep: step => { if (step === 'after-order-write') throw new Error('TEST PL failure'); } });
  assert.throws(() => service.saveOrderAndPackingList({ order: { ...oldOrder, value: 'NEW' }, packingList: { ...oldPl, value: 'NEW' }, expectedOrderVersion: 1, expectedPackingListVersion: 1 }), /TEST PL failure/);
  assert.deepEqual(f.repositories.orders.get('pair-order').payload, oldOrder); assert.deepEqual(f.repositories.packingLists.get('pair-pl').payload, oldPl);
});
test('Order and independent PL save successfully in one transaction', () => {
  const order = { id: 'pair-success-order', packingListDocument: { id: 'pair-success-pl', marker: 'TEST same operation' } };
  const packingList = { id: 'pair-success-pl', orderId: order.id, marker: 'TEST same operation' };
  const result = f.packingListTransactionService.saveOrderAndPackingList({ order, packingList, expectedOrderVersion: 0, expectedPackingListVersion: 0 });
  assert.deepEqual(result.order.payload, order); assert.deepEqual(result.packingList.payload, packingList);
  assert.deepEqual(f.repositories.orders.get(order.id).payload.packingListDocument, order.packingListDocument);
});
test('Large TEST Base64 payload is not truncated through import/export/restore', () => {
  const large = backupA(), marker = Buffer.alloc(2 * 1024 * 1024, 84).toString('base64');
  large.orders[0].attachments[0].data = `data:application/octet-stream;base64,${marker}`;
  f.businessBackupService.replaceAllBusinessData(large, false); const exported = f.businessBackupService.exportAllBusinessData();
  assert.equal(exported.orders[0].attachments[0].data, large.orders[0].attachments[0].data);
  f.businessBackupService.replaceAllBusinessData(backupB(), true); f.businessBackupService.restoreLatestBusinessData();
  assert.equal(f.businessBackupService.exportAllBusinessData().orders[0].attachments[0].data, large.orders[0].attachments[0].data);
});
test('JSON import/export preserves all six business collections deeply', () => {
  const input = backupA(); f.businessBackupService.replaceAllBusinessData(input, false);
  assert.deepEqual(collections(f.businessBackupService.exportAllBusinessData()), collections(input));
});
test('Business SQLite remains present after database close and reopen', () => {
  const filename = path.join(f.directory, 'restart-business.sqlite'); let db = openDatabase(filename), repos = createBusinessRepositories(db);
  repos.orders.put({ id: 'restart-order', value: 'TEST persistent' }, 0); db.close();
  db = openDatabase(filename); repos = createBusinessRepositories(db);
  try { assert.deepEqual(repos.orders.get('restart-order').payload, { id: 'restart-order', value: 'TEST persistent' }); }
  finally { db.close(); }
});
