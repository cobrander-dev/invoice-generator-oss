'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const C = require('../../js/core.js');
const { fixture, TEST_USERNAME, TEST_PASSWORD } = require('./helpers');
const { ConflictError } = require('../../server/db/errors');
const { issueLoginToken, verifyLoginToken, LOGIN_TOKEN_TTL_MS } = require('../../server/auth/csrf');

const root = path.resolve(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const limitations = read('KNOWN_LIMITATIONS.md');
const clone = (value) => JSON.parse(JSON.stringify(value));
let f;

test.before(async () => {
  f = await fixture();
});
test.after(async () => {
  await f.cleanup();
});
test.beforeEach(() => {
  for (const name of [
    'company',
    'customers',
    'products',
    'orders',
    'packingLists',
    'meta',
    'restorePoints',
  ])
    f.repositories[name].clear();
  f.sequenceService.clear();
});

const company = {
  id: 'main',
  documentMode: 'Test',
  testMode: true,
  englishName: 'Example Phase Seven Testing Co., Ltd.',
  address: '123 Test Street, Test City, Testland',
  signatureImage: 'TEST_SIGNATURE',
  companyStampImage: 'TEST_STAMP',
  accounts: [
    { id: 'test-bank', currency: 'USD', accountNumber: '000000000000', swift: 'TESTBANKXXX' },
  ],
};
const customer = {
  id: 'phase7-buyer',
  companyName: 'Sample Phase Seven Buyer Ltd.',
  buyerName: 'Sample Phase Seven Buyer Ltd.',
  country: 'Testland',
  consigneeName: 'TEST Consignee',
  consigneeAddress: '456 Test Road',
};
function seedContext() {
  f.repositories.company.put(company, 0);
  f.repositories.customers.put(customer, 0);
}
function generatedPackingList(id = 'phase7-order') {
  seedContext();
  let row = f.orderOperationService.createOrder({
    id,
    createdDate: '2026-09-09',
    testMode: true,
    customerId: customer.id,
    paymentAccountId: 'test-bank',
    namedPlace: 'TEST Port',
    namedPlaceConfirmed: true,
    items: [
      {
        id: 'phase7-line',
        description: 'TEST Product',
        quantity: 10,
        ciQuantity: 10,
        packingQuantity: 10,
        unit: 'PCS',
        unitPrice: 10,
        cartonQty: 2,
        quantityPerCarton: 5,
        cartonLength: 10,
        cartonWidth: 10,
        cartonHeight: 10,
        netWeightPerCarton: 5,
        grossWeightPerCarton: 6,
      },
    ],
  });
  row = f.orderOperationService.action(
    'finalize-pi',
    id,
    { signingMode: 'Electronic' },
    row.rowVersion,
  );
  row = f.orderOperationService.action('generate-ci', id, {}, row.rowVersion);
  row = f.orderOperationService.updateOrder(
    id,
    {
      ...row.payload,
      actualShipmentDate: '2026-09-09',
      shipmentDate: '2026-09-09',
      actualTransportMethod: 'Sea Freight',
      actualTransportConfirmed: true,
      portOfLoading: 'TEST Loading Port',
      portOfDischarge: 'TEST Discharge Port',
    },
    row.rowVersion,
  );
  return f.orderOperationService.packingAction('generate-packing-list', id, {}, row.rowVersion, 0);
}

test('Phase 7: Draft Packing List saves normal editable data', () => {
  const result = generatedPackingList(),
    proposed = clone(result.packingList.payload);
  proposed.data.shippingMark = 'TEST SHIPPING MARK';
  const saved = f.orderOperationService.packingAction(
    'save-packing-list',
    result.order.payload.id,
    { packingList: proposed },
    result.order.rowVersion,
    result.packingList.rowVersion,
  );
  assert.equal(saved.packingList.payload.data.shippingMark, 'TEST SHIPPING MARK');
  assert.equal(saved.packingList.payload.status, 'Draft');
});
test('Phase 7: ordinary save rejects forged Final status', () => {
  const result = generatedPackingList(),
    proposed = { ...clone(result.packingList.payload), status: 'Final' };
  assert.throws(
    () =>
      f.orderOperationService.packingAction(
        'save-packing-list',
        result.order.payload.id,
        { packingList: proposed },
        result.order.rowVersion,
        result.packingList.rowVersion,
      ),
    ConflictError,
  );
});
test('Phase 7: ordinary save rejects forged signed timestamp', () => {
  const result = generatedPackingList(),
    proposed = clone(result.packingList.payload);
  proposed.data.plSignedAt = 'FORGED';
  assert.throws(
    () =>
      f.orderOperationService.packingAction(
        'save-packing-list',
        result.order.payload.id,
        { packingList: proposed },
        result.order.rowVersion,
        result.packingList.rowVersion,
      ),
    ConflictError,
  );
});
test('Phase 7: ordinary save rejects forged signing snapshot', () => {
  const result = generatedPackingList(),
    proposed = clone(result.packingList.payload);
  proposed.data.plSigningSnapshot = { signatureImage: 'FORGED' };
  assert.throws(
    () =>
      f.orderOperationService.packingAction(
        'save-packing-list',
        result.order.payload.id,
        { packingList: proposed },
        result.order.rowVersion,
        result.packingList.rowVersion,
      ),
    ConflictError,
  );
});
test('Phase 7: ordinary save rejects a changed server Packing List number', () => {
  const result = generatedPackingList(),
    proposed = clone(result.packingList.payload);
  proposed.number = 'PL-FAKE';
  assert.throws(
    () =>
      f.orderOperationService.packingAction(
        'save-packing-list',
        result.order.payload.id,
        { packingList: proposed },
        result.order.rowVersion,
        result.packingList.rowVersion,
      ),
    ConflictError,
  );
});
test('Phase 7: finalize action creates the authoritative Final state', () => {
  const result = generatedPackingList();
  const final = f.orderOperationService.packingAction(
    'finalize-packing-list',
    result.order.payload.id,
    {
      packingList: result.packingList.payload,
      signingMode: 'Electronic',
      includeSigningBlock: true,
    },
    result.order.rowVersion,
    result.packingList.rowVersion,
  );
  assert.equal(final.order.payload.plVersion, 'Final');
  assert.equal(final.packingList.payload.status, 'Final');
  assert.ok(final.packingList.payload.data.plSignedAt);
});
test('Phase 7: ordinary save cannot alter an existing Final Packing List', () => {
  const result = generatedPackingList();
  const final = f.orderOperationService.packingAction(
    'finalize-packing-list',
    result.order.payload.id,
    { packingList: result.packingList.payload },
    result.order.rowVersion,
    result.packingList.rowVersion,
  );
  assert.throws(
    () =>
      f.orderOperationService.packingAction(
        'save-packing-list',
        final.order.payload.id,
        { packingList: final.packingList.payload },
        final.order.rowVersion,
        final.packingList.rowVersion,
      ),
    ConflictError,
  );
});
test('Phase 7: stale finalize remains a conflict', () => {
  const result = generatedPackingList();
  assert.throws(
    () =>
      f.orderOperationService.packingAction(
        'finalize-packing-list',
        result.order.payload.id,
        { packingList: result.packingList.payload },
        result.order.rowVersion - 1,
        result.packingList.rowVersion,
      ),
    ConflictError,
  );
});
test('Phase 7: repeated finalize produces only one legal Final', () => {
  const result = generatedPackingList();
  const final = f.orderOperationService.packingAction(
    'finalize-packing-list',
    result.order.payload.id,
    { packingList: result.packingList.payload },
    result.order.rowVersion,
    result.packingList.rowVersion,
  );
  assert.throws(
    () =>
      f.orderOperationService.packingAction(
        'finalize-packing-list',
        final.order.payload.id,
        { packingList: final.packingList.payload },
        final.order.rowVersion,
        final.packingList.rowVersion,
      ),
    ConflictError,
  );
  assert.equal(
    f.repositories.packingLists.list().filter((row) => row.payload.status === 'Final').length,
    1,
  );
});
test('Phase 7: order and standalone Packing List stay transactionally identical', () => {
  const result = generatedPackingList(),
    proposed = clone(result.packingList.payload);
  proposed.data.packingRemarks = 'TEST transaction consistency';
  const saved = f.orderOperationService.packingAction(
    'save-packing-list',
    result.order.payload.id,
    { packingList: proposed },
    result.order.rowVersion,
    result.packingList.rowVersion,
  );
  assert.deepEqual(saved.order.payload.packingListDocument, saved.packingList.payload);
});
test('Phase 7: ordinary order updates cannot rewrite an embedded Final Packing List', () => {
  const result = generatedPackingList();
  const final = f.orderOperationService.packingAction(
    'finalize-packing-list',
    result.order.payload.id,
    { packingList: result.packingList.payload },
    result.order.rowVersion,
    result.packingList.rowVersion,
  );
  const snapshot = clone(final.order.payload.packingListDocument);
  const updated = f.orderOperationService.updateOrder(
    final.order.payload.id,
    { ...final.order.payload, internalNotes: 'TEST order-only change' },
    final.order.rowVersion,
  );
  assert.deepEqual(updated.payload.packingListDocument, snapshot);
  assert.deepEqual(f.repositories.packingLists.get(snapshot.id).payload, snapshot);
});
test('Phase 7: other order actions cannot rewrite an embedded Final Packing List', () => {
  const result = generatedPackingList();
  const final = f.orderOperationService.packingAction(
    'finalize-packing-list',
    result.order.payload.id,
    { packingList: result.packingList.payload },
    result.order.rowVersion,
    result.packingList.rowVersion,
  );
  const snapshot = clone(final.order.payload.packingListDocument);
  const mutableOrder = clone(final.order.payload);
  mutableOrder.shippingMark = 'CHANGED AFTER FINAL';
  const changed = f.repositories.orders.put(mutableOrder, final.order.rowVersion);
  const acted = f.orderOperationService.action(
    'confirm-ci-differences',
    changed.payload.id,
    {},
    changed.rowVersion,
  );
  assert.deepEqual(acted.payload.packingListDocument, snapshot);
  assert.deepEqual(f.repositories.packingLists.get(snapshot.id).payload, snapshot);
});

test('Phase 7: GET login remains available without creating a session', async () => {
  f.db.prepare('DELETE FROM sessions').run();
  const response = await f.client().request('/login');
  assert.equal(response.status, 200);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM sessions').get().n, 0);
});
test('Phase 7: one hundred anonymous login views do not persist sessions', async () => {
  f.db.prepare('DELETE FROM sessions').run();
  for (let index = 0; index < 100; index++)
    await (await f.client().request('/login')).arrayBuffer();
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM sessions').get().n, 0);
});
test('Phase 7: failed logins do not persist pre-authentication sessions', async () => {
  f.db.prepare('DELETE FROM sessions').run();
  for (let index = 0; index < 3; index++)
    assert.equal((await f.client().login(TEST_USERNAME, 'WRONG-TEST-password')).status, 401);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM sessions').get().n, 0);
});
test('Phase 7: signed login CSRF token is accepted', async () => {
  f.db.prepare('DELETE FROM sessions').run();
  assert.equal((await f.client().login()).status, 200);
});
test('Phase 7: malformed login CSRF token is rejected', async () => {
  const response = await f.client().request('/api/auth/login', {
    method: 'POST',
    headers: {
      Origin: f.config.origin,
      'X-CSRF-Token': '0'.repeat(112),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ username: TEST_USERNAME, password: TEST_PASSWORD }),
  });
  assert.equal(response.status, 403);
});
test('Phase 7: expired signed login CSRF token is rejected', () => {
  const issuedAt = Date.now() - LOGIN_TOKEN_TTL_MS - 1;
  assert.equal(
    verifyLoginToken(issueLoginToken(f.config.secret, issuedAt), f.config.secret),
    false,
  );
});
test('Phase 7: wrong Origin remains rejected before authentication', async () => {
  const client = f.client(),
    token = await client.csrf();
  const response = await client.request('/api/auth/login', {
    method: 'POST',
    headers: {
      Origin: 'https://attacker.example.invalid',
      'X-CSRF-Token': token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ username: TEST_USERNAME, password: TEST_PASSWORD }),
  });
  assert.equal(response.status, 403);
});
test('Phase 7: successful login creates one authenticated persistent session', async () => {
  f.db.prepare('DELETE FROM sessions').run();
  const client = f.client();
  assert.equal((await client.login()).status, 200);
  const rows = f.db.prepare('SELECT payload FROM sessions').all();
  assert.equal(rows.length, 1);
  assert.equal(JSON.parse(rows[0].payload).userId, f.user.id);
});
test('Phase 7: authenticated session works after login', async () => {
  const client = f.client();
  await client.login();
  assert.equal((await client.request('/api/auth/me')).status, 200);
});
test('Phase 7: logout destroys the authenticated session', async () => {
  f.db.prepare('DELETE FROM sessions').run();
  const client = f.client();
  await client.login();
  assert.equal((await client.write('/api/auth/logout')).status, 204);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM sessions').get().n, 0);
});

function passwordCheck(password, minimum = '8') {
  return spawnSync(
    'bash',
    [
      '-c',
      '. installer/bundle/lib/validate.sh; valid_admin_password "$TEST_PASSWORD" "$TEST_MINIMUM"',
    ],
    {
      cwd: root,
      env: { ...process.env, TEST_PASSWORD: password, TEST_MINIMUM: minimum },
      encoding: 'utf8',
    },
  );
}
test('Phase 7: default minimum accepts non-weak 8+ passwords and rejects shorter values', () => {
  assert.equal(passwordCheck('TEST-008').status, 0);
  assert.notEqual(passwordCheck('TEST-07').status, 0);
});
test('Phase 7: configured minimum can raise the policy to 16 characters', () => {
  assert.notEqual(passwordCheck('TEST-pass-0015', '16').status, 0);
  assert.equal(passwordCheck('TEST-password-0000', '16').status, 0);
});
test('Phase 7: installer accepts 1024 characters and rejects 1025', () => {
  assert.equal(passwordCheck('A'.repeat(1024)).status, 0);
  assert.notEqual(passwordCheck('A'.repeat(1025)).status, 0);
});
test('Phase 7: installer rejects placeholder passwords consistently with server rules', () =>
  assert.notEqual(passwordCheck('TEST-change-me-password').status, 0));
test('Phase 7: old Docker validation limitation wording is removed', () =>
  assert.doesNotMatch(limitations, /Production镜像仍须在Docker能力可用后/));
test('Phase 7: GitHub Actions validation is documented as completed without claiming VPS certification', () => {
  assert.match(limitations, /GitHub Actions Ubuntu Runner通过/);
  assert.match(limitations, /Production Release Candidate/);
  assert.match(limitations, /真实VPS验收/);
});
