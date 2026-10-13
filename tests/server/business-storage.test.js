'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers');
const { ConflictError } = require('../../server/db/errors');
const Database = require('better-sqlite3');
const path = require('node:path');
const { openDatabase } = require('../../server/db/database');
const { TEST_IMAGE, TEST_ATTACHMENT, complexOrder } = require('./business-fixtures');
let f;
before(async () => { f = await fixture(); });
after(async () => { await f.cleanup(); });

test('004 multi-user migration creates business, identity and audit tables', () => {
  const names = f.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(x => x.name);
  assert.deepEqual(names, ['audit_logs', 'company', 'customers', 'document_sequences', 'meta', 'orders', 'packing_lists', 'products', 'restore_points', 'schema_migrations', 'sessions', 'user_login_identifiers', 'users']);
  for (const table of ['company', 'meta', 'restore_points']) assert.deepEqual(f.db.prepare(`PRAGMA table_info(${table})`).all().map(x => x.name), ['id', 'payload_json', 'row_version', 'updated_at']);
  assert.deepEqual(f.db.prepare('SELECT version FROM schema_migrations ORDER BY version').all(), [{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }]);
});
test('004 upgrades the sole legacy user to ADMIN and intentionally expires legacy sessions', () => {
  const filename = path.join(f.directory, 'phase1-upgrade.sqlite');
  let db = new Database(filename);
  db.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
    CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE sessions (sid TEXT PRIMARY KEY, payload TEXT NOT NULL, expires_at INTEGER NOT NULL, absolute_expires_at INTEGER NOT NULL);
    CREATE INDEX sessions_expiry ON sessions(expires_at);`);
  db.prepare('INSERT INTO schema_migrations VALUES (1, ?)').run(1);
  db.prepare('INSERT INTO users VALUES (?, ?, ?, ?)').run('upgrade-user', 'test-upgrade', '$argon2id$TEST-HASH', 1);
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run('test-session-digest', '{"TEST":true}', 9999999999999, 9999999999999);
  db.close(); db = openDatabase(filename);
  try {
    const user=db.prepare('SELECT * FROM users').get();
    assert.equal(user.id,'upgrade-user'); assert.equal(user.username,'test-upgrade'); assert.equal(user.password_hash,'$argon2id$TEST-HASH');
    assert.equal(user.role,'ADMIN'); assert.equal(user.status,'ACTIVE'); assert.equal(user.auth_version,1);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM sessions').get().n,0);
    assert.deepEqual(db.prepare('SELECT version FROM schema_migrations ORDER BY version').all(), [{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }]);
  } finally { db.close(); }
});
test('Fresh server business database is empty and contains no Demo data', () => {
  for (const name of ['company', 'customers', 'products', 'orders', 'packingLists', 'meta', 'restorePoints']) assert.deepEqual(f.repositories[name].list(), []);
});
test('Company JSON round-trips without field reconstruction', () => {
  const value = { id: 'main', englishName: 'TEST Company', nested: { unknown: [1, 'x'] } };
  assert.deepEqual(f.repositories.company.put(value, 0).payload, value);
});
test('Customer JSON round-trips', () => {
  const value = { id: 'customer-roundtrip', buyerName: 'TEST Customer', optional: null };
  assert.deepEqual(f.repositories.customers.put(value, 0).payload, value);
});
test('Product JSON round-trips', () => {
  const value = { id: 'product-roundtrip', englishName: 'TEST Product', defaultPrice: 12.34 };
  assert.deepEqual(f.repositories.products.put(value, 0).payload, value);
});
test('Complex order JSON round-trips without recalculation or regenerated snapshots', () => {
  const value = complexOrder('order-roundtrip');
  assert.deepEqual(f.repositories.orders.put(value, 0).payload, value);
});
test('Independent Packing List JSON round-trips', () => {
  const value = { id: 'pl-roundtrip', orderId: 'order-roundtrip', cartons: 7, cbm: 1.234, unknown: 'TEST' };
  assert.deepEqual(f.repositories.packingLists.put(value, 0).payload, value);
});
test('Unknown nested fields remain byte-for-byte JSON values', () => {
  const value = { id: 'meta-roundtrip', unknown: { array: [null, false, 1.25, 'TEST'], object: { x: 'y' } } };
  assert.deepEqual(f.repositories.meta.put(value, 0).payload, value);
});
test('Signature canonical and legacy aliases survive unchanged', () => {
  const value = { id: 'signature-roundtrip', signatureImage: TEST_IMAGE, signature: `${TEST_IMAGE}LEGACY` };
  assert.deepEqual(f.repositories.company.put(value, 0).payload, value);
});
test('Stamp canonical and legacy aliases survive unchanged', () => {
  const value = { id: 'stamp-roundtrip', companyStampImage: TEST_IMAGE, stamp: `${TEST_IMAGE}LEGACY` };
  assert.deepEqual(f.repositories.company.put(value, 0).payload, value);
});
test('Logo Data URL survives unchanged', () => {
  const value = { id: 'logo-roundtrip', logo: TEST_IMAGE };
  assert.equal(f.repositories.company.put(value, 0).payload.logo, TEST_IMAGE);
});
test('Order attachment Base64 survives unchanged', () => {
  const value = complexOrder('attachment-roundtrip');
  assert.equal(f.repositories.orders.put(value, 0).payload.attachments[0].data, TEST_ATTACHMENT);
});
test('Payment slip Base64 survives unchanged', () => {
  const value = complexOrder('slip-roundtrip');
  assert.equal(f.repositories.orders.put(value, 0).payload.paymentRecords[0].paymentSlip.data, TEST_ATTACHMENT);
});
test('Successful expectedVersion update increments server metadata only', () => {
  const original = { id: 'version-test', name: 'TEST V1' };
  const one = f.repositories.customers.put(original, 0);
  const two = f.repositories.customers.put({ ...original, name: 'TEST V2' }, one.rowVersion);
  assert.equal(one.rowVersion, 1); assert.equal(two.rowVersion, 2);
  assert.deepEqual(two.payload, { id: 'version-test', name: 'TEST V2' }); assert.equal('row_version' in two.payload, false);
});
test('Stale expectedVersion throws Conflict and cannot overwrite newer data', () => {
  assert.throws(() => f.repositories.customers.put({ id: 'version-test', name: 'STALE' }, 1), ConflictError);
  assert.equal(f.repositories.customers.get('version-test').payload.name, 'TEST V2');
});
