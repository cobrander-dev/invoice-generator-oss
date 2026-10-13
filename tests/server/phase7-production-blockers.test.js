'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const C = require('../../js/core.js');
const { fixture, TEST_USERNAME, TEST_PASSWORD } = require('./helpers');
const { ConflictError } = require('../../server/db/errors');
const { issueLoginToken, verifyLoginToken, LOGIN_TOKEN_TTL_MS } = require('../../server/auth/csrf');

const root = path.resolve(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const update = read('deploy/update.sh');
const install = read('deploy/install.sh');
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
    ['-c', '. deploy/lib/environment.sh; valid_admin_password "$TEST_PASSWORD" "$TEST_MINIMUM"'],
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
test('Phase 7: existing env content and SESSION_SECRET survive permission tightening', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-phase7-env-')),
    envFile = path.join(directory, '.env');
  const content = 'NODE_ENV=production\nSESSION_SECRET=TEST-secret-preserve-000000000000000000\n';
  fs.writeFileSync(envFile, content, { mode: 0o644 });
  const result = spawnSync(
    'bash',
    ['-c', '. deploy/lib/environment.sh; secure_env_file "$TEST_ENV" "$(id -u)"'],
    { cwd: root, env: { ...process.env, TEST_ENV: envFile }, encoding: 'utf8' },
  );
  try {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(envFile, 'utf8'), content);
    assert.match(fs.readFileSync(envFile, 'utf8'), /SESSION_SECRET=TEST-secret-preserve/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
test('Phase 7: existing env mode becomes 0600 and stays 0600 on rerun', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-phase7-mode-')),
    envFile = path.join(directory, '.env');
  fs.writeFileSync(envFile, 'TEST=1\n', { mode: 0o644 });
  const command = '. deploy/lib/environment.sh; secure_env_file "$TEST_ENV" "$(id -u)"';
  try {
    assert.equal(
      spawnSync('bash', ['-c', command], { cwd: root, env: { ...process.env, TEST_ENV: envFile } })
        .status,
      0,
    );
    assert.equal(fs.statSync(envFile).mode & 0o777, 0o600);
    assert.equal(
      spawnSync('bash', ['-c', command], { cwd: root, env: { ...process.env, TEST_ENV: envFile } })
        .status,
      0,
    );
    assert.equal(fs.statSync(envFile).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
test('Phase 7: existing env symlink is rejected instead of chmod-followed', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-phase7-link-')),
    target = path.join(directory, 'target'),
    link = path.join(directory, '.env');
  fs.writeFileSync(target, 'TEST=1\n', { mode: 0o644 });
  fs.symlinkSync(target, link);
  try {
    const result = spawnSync(
      'bash',
      ['-c', '. deploy/lib/environment.sh; secure_env_file "$TEST_ENV" "$(id -u)"'],
      { cwd: root, env: { ...process.env, TEST_ENV: link } },
    );
    assert.notEqual(result.status, 0);
    assert.equal(fs.statSync(target).mode & 0o777, 0o644);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Phase 7: updater requires exactly one full immutable SHA', () =>
  assert.match(update, /\^\[0-9a-f\]\{40\}\$/));
test('Phase 7: updater does not deploy mutable origin branch heads', () =>
  assert.doesNotMatch(update, /merge --ff-only "origin\/\$branch"/));
test('Phase 7: updater verifies target existence and origin reachability', () => {
  assert.match(update, /cat-file -e/);
  assert.match(update, /for-each-ref --contains=.*refs\/remotes\/origin/);
});
test('Phase 7: updater rejects non-fast-forward targets', () =>
  assert.match(update, /merge-base --is-ancestor "\$old_head" "\$target_commit"/));
test('Phase 7: candidate build uses an exact detached target worktree', () => {
  assert.match(update, /worktree add --detach "\$candidate_source" "\$target_commit"/);
  assert.match(update, /docker build --pull -t "\$candidate_image" "\$candidate_source"/);
});
test('Phase 7: candidate uses isolated database name and volume', () => {
  assert.match(update, /DATABASE_PATH=\/app\/data\/candidate\.sqlite/);
  assert.match(update, /candidate_volume/);
  assert.match(update, /candidate-source\.sqlite/);
});
test('Phase 7: candidate has no network and never mounts Production app_data', () => {
  const candidateRun = update.slice(
    update.indexOf('candidate_container="$(docker run'),
    update.indexOf('unset candidate_secret'),
  );
  assert.match(candidateRun, /--network none/);
  assert.match(candidateRun, /\$candidate_volume:\/app\/data/);
  assert.doesNotMatch(candidateRun, /app_data:\/app\/data|docker compose up/);
});
test('Phase 7: consistent SQLite backups bracket candidate and promotion', () => {
  assert.ok(update.indexOf('candidate-source-') < update.indexOf('git fetch'));
  const promotion = update.slice(update.lastIndexOf('promotion_started=true'));
  assert.ok(
    promotion.indexOf('stop caddy') <
      promotion.indexOf('BACKUP_PATH="/app/data/backups/pre-update-'),
  );
  assert.ok(
    promotion.indexOf('BACKUP_PATH="/app/data/backups/pre-update-') < promotion.indexOf('stop app'),
  );
  assert.match(update, /npm run db:backup/g);
});
test('Phase 7: candidate failure path leaves Production unpromoted', () => {
  assert.ok(
    update.indexOf('promotion_started=false') < update.indexOf('trap rollback_production ERR'),
  );
  assert.match(
    update,
    /candidate preflight failed \(\$reason\); Production code, image and SQLite were not changed/,
  );
});
test('Phase 7: promotion failure restores matching database and old image', () => {
  assert.match(update, /\$rollback_seed:\/rollback\.sqlite:ro/);
  assert.match(update, /compose run --rm --no-deps --user node/);
  assert.doesNotMatch(update, /compose run --rm --no-deps --user 0/);
  assert.match(update, /chmod 644 "\$rollback_seed"/);
  assert.match(update, /chmod 600 "\$rollback_seed"/);
  assert.match(update, /cp '\/rollback\.sqlite'/);
  assert.match(update, /foreign-trade-invoice-generator:\$rollback_tag/);
  assert.match(update, /restore_checkout/);
  const rollback = update.slice(update.indexOf('rollback_production'));
  assert.ok(rollback.indexOf('restore_checkout') < rollback.indexOf('compose stop caddy'));
  assert.ok(rollback.indexOf('compose stop caddy') < rollback.indexOf('compose stop app'));
  assert.match(rollback, /deployment_mode.*BUNDLED_CADDY[\s\S]*compose stop caddy/);
  assert.match(update, /wait_healthy "\$restored_container"/);
});
test('Phase 7: public proxy starts only after application promotion is committed', () => {
  const promotion = update.slice(update.lastIndexOf('promotion_started=true'));
  assert.ok(
    promotion.indexOf('compose up -d --no-build app\n') <
      promotion.indexOf('wait_healthy "$container_id"'),
  );
  assert.ok(promotion.indexOf('production-commit') < promotion.indexOf('promotion_started=false'));
  assert.ok(
    promotion.indexOf('promotion_started=false') <
      promotion.indexOf('compose up -d --no-build caddy'),
  );
  assert.match(promotion, /deployment_mode.*BUNDLED_CADDY[\s\S]*compose up -d --no-build caddy/);
});
test('Phase 7: updater records the exact running commit outside health output', () => {
  assert.match(update, /production-commit/);
  assert.match(update, /printf '%s\\n' '\$target_commit'/);
});
test('Phase 7: updater contains no destructive volume or history rewrite commands', () => {
  for (const forbidden of [
    /down\s+-v/,
    /volume prune/,
    /system prune/,
    /reset --hard/,
    /push --force/,
  ])
    assert.doesNotMatch(update, forbidden);
});
test('Phase 7: old Docker validation limitation wording is removed', () =>
  assert.doesNotMatch(limitations, /Production镜像仍须在Docker能力可用后/));
test('Phase 7: GitHub Actions validation is documented as completed without claiming VPS certification', () => {
  assert.match(limitations, /GitHub Actions Ubuntu Runner通过/);
  assert.match(limitations, /Production Release Candidate/);
  assert.match(limitations, /真实VPS验收/);
});
test('Phase 7: install and update scripts pass static validation', () => {
  assert.equal(
    spawnSync(
      'bash',
      ['-n', 'deploy/install.sh', 'deploy/update.sh', 'deploy/lib/environment.sh'],
      { cwd: root },
    ).status,
    0,
  );
  assert.equal(spawnSync('bash', ['deploy/install.sh', '--check'], { cwd: root }).status, 0);
  assert.equal(spawnSync('bash', ['deploy/update.sh', '--check'], { cwd: root }).status, 0);
  assert.match(install, /valid_admin_password/);
});
