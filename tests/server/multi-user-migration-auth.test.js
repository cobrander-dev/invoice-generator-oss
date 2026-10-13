'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { fixture } = require('./helpers');
const { openDatabase } = require('../../server/db/database');
const { hashPassword, verifyPassword } = require('../../server/auth/password');
const { createAuthService } = require('../../server/auth/auth-service');
const { resetAdminPassword } = require('../../server/scripts/reset-admin-password');

const TEMP_A = 'TEST-temp-employee-A-0001',
  PASS_A = 'TEST-employee-A-new-0001';
async function body(response) {
  let value = {};
  try {
    value = await response.json();
  } catch {}
  return value;
}

function createV3Schema(db) {
  db.exec(`CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at INTEGER NOT NULL);
    CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT NOT NULL UNIQUE,password_hash TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE TABLE sessions(sid TEXT PRIMARY KEY,payload TEXT NOT NULL,expires_at INTEGER NOT NULL,absolute_expires_at INTEGER NOT NULL);
    CREATE INDEX sessions_expiry ON sessions(expires_at);
    CREATE TABLE document_sequences(kind TEXT NOT NULL,period TEXT NOT NULL,next_value INTEGER NOT NULL CHECK(next_value >= 1),updated_at INTEGER NOT NULL,PRIMARY KEY(kind,period));`);
  for (const table of [
    'company',
    'customers',
    'products',
    'orders',
    'packing_lists',
    'meta',
    'restore_points',
  ]) {
    db.exec(
      `CREATE TABLE ${table}(id TEXT PRIMARY KEY,payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),row_version INTEGER NOT NULL DEFAULT 1 CHECK(row_version >= 1),updated_at INTEGER NOT NULL)`,
    );
  }
  db.prepare('INSERT INTO schema_migrations VALUES(1,1),(2,2),(3,3)').run();
}

function insertBusinessRow(db, table, id, payloadJson, rowVersion, updatedAt) {
  db.prepare(`INSERT INTO ${table}(id,payload_json,row_version,updated_at) VALUES(?,?,?,?)`).run(
    id,
    payloadJson,
    rowVersion,
    updatedAt,
  );
}

test('rich Production-shaped v3 database migrates losslessly, assigns sole ADMIN ownership, clears sessions, and authenticates', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-multi-migration-rich-')),
    filename = path.join(dir, 'legacy-v3.sqlite');
  const adminPassword = 'TEST-legacy-admin-password-0001';
  const adminHash = await hashPassword(adminPassword);
  const company = {
    id: 'main',
    documentMode: 'Production',
    englishName: 'Example Legacy Testing Co., Ltd.',
    chineseName: '示例测试出口有限公司',
    address: '123 TEST Export Road, Test City, Testland',
    telephone: '+1 000 000 0000',
    email: 'legacy-admin@example.invalid',
    taxId: 'TEST-TAX-ID-0001',
    authorizedSignatoryName: 'TEST Authorized Signatory',
    authorizedSignatoryTitle: 'TEST Export Director',
    signatureImage: 'data:image/png;base64,VEVTVF9TSUdOQVRVUkU=',
    companyStampImage: 'data:image/png;base64,VEVTVF9TVEFNUA==',
    logo: 'data:image/png;base64,VEVTVF9MT0dP',
    accounts: [
      {
        id: 'test-usd',
        currency: 'USD',
        bankName: 'Example Test Bank',
        accountNumber: '000000000000',
        achRoutingNumber: '000000000',
        wireRoutingNumber: '000000000',
        swift: 'TESTBANKXXX',
      },
    ],
  };
  const customers = [
    {
      id: 'customer-a',
      companyName: 'Sample Buyer Testing A Ltd.',
      buyerName: 'Sample Buyer Testing A Ltd.',
      country: 'Testland',
      email: 'buyer-a@example.invalid',
    },
    {
      id: 'customer-b',
      companyName: 'Sample Buyer Testing B Ltd.',
      buyerName: 'Sample Buyer Testing B Ltd.',
      country: 'Examplestan',
      email: 'buyer-b@example.invalid',
    },
  ];
  const products = [
    {
      id: 'product-a',
      name: 'TEST Shower Product A',
      description: 'TEST Product A',
      model: 'TEST-A',
      sku: 'TEST-SKU-A',
      unit: 'PCS',
      hsCode: '00000000',
    },
    {
      id: 'product-b',
      name: 'TEST Shower Product B',
      description: 'TEST Product B',
      model: 'TEST-B',
      sku: 'TEST-SKU-B',
      unit: 'SETS',
      hsCode: '11111111',
    },
  ];
  const finalPiSnapshot = {
    revision: 0,
    displayNumber: 'PI-TEST-202609-001',
    createdAt: '2026-09-01T00:00:00.000Z',
    data: {
      seller: {
        englishName: company.englishName,
        signatureImage: company.signatureImage,
        companyStampImage: company.companyStampImage,
      },
      buyer: { companyName: customers[0].companyName },
      items: [{ id: 'line-a', description: 'TEST Shower Product A', quantity: 10, unitPrice: 25 }],
      totalAmount: 250,
    },
    signing: {
      mode: 'Electronic',
      signatureImage: company.signatureImage,
      companyStampImage: company.companyStampImage,
    },
  };
  const ciSnapshot = {
    id: 'ci-a',
    number: 'CI-TEST-202609-001',
    status: 'Final',
    relatedPiNumber: 'PI-TEST-202609-001',
    relatedPiRevision: 0,
    data: {
      actualShipmentDate: '2026-09-05',
      actualTransportMethod: 'Sea Freight',
      items: [
        {
          id: 'line-a',
          description: 'TEST Shower Product A',
          quantity: 10,
          ciQuantity: 10,
          unitPrice: 25,
        },
      ],
      totalAmount: 250,
    },
    finalSnapshot: {
      number: 'CI-TEST-202609-001',
      signedAt: '2026-09-05T08:00:00.000Z',
      signingMode: 'Electronic',
    },
  };
  const packingSnapshot = {
    id: 'packing-a',
    number: 'PL-TEST-202609-001',
    status: 'Final',
    orderId: 'order-a',
    relatedPiNumber: 'PI-TEST-202609-001',
    relatedCiNumber: 'CI-TEST-202609-001',
    data: {
      items: [
        {
          id: 'line-a',
          description: 'TEST Shower Product A',
          packingQuantity: 10,
          cartonQty: 2,
          netWeightPerCarton: 20,
          grossWeightPerCarton: 22,
          cartonLength: 50,
          cartonWidth: 40,
          cartonHeight: 30,
        },
      ],
      totalCartons: 2,
      totalNetWeight: 40,
      totalGrossWeight: 44,
      totalCBM: 0.12,
    },
    finalSnapshot: { number: 'PL-TEST-202609-001', signedAt: '2026-09-06T08:00:00.000Z' },
  };
  const orders = [
    {
      id: 'order-a',
      customerId: 'customer-a',
      orderNumber: 'ORD-TEST-202609-001',
      piNumber: 'PI-TEST-202609-001',
      ciNumber: 'CI-TEST-202609-001',
      packingListNumber: 'PL-TEST-202609-001',
      items: [
        {
          id: 'line-a',
          productId: 'product-a',
          description: 'TEST Shower Product A',
          quantity: 10,
          ciQuantity: 10,
          unitPrice: 25,
        },
      ],
      paymentRecords: [
        {
          id: 'payment-a',
          amount: 100,
          currency: 'USD',
          status: 'Confirmed',
          paymentDate: '2026-09-02',
          attachment: {
            name: 'TEST-payment-slip.txt',
            data: 'data:text/plain;base64,VEVTVF9QQVlNRU5UX1NMSVA=',
          },
        },
      ],
      amountPaid: 100,
      outstandingAmount: 150,
      piHistory: [finalPiSnapshot],
      activePiRevision: 0,
      piDocument: { status: 'Final', number: 'PI-TEST-202609-001' },
      ciDocument: ciSnapshot,
      packingListDocument: packingSnapshot,
    },
    {
      id: 'order-b',
      customerId: 'customer-b',
      orderNumber: 'ORD-TEST-202609-002',
      piNumber: 'PI-TEST-202609-002',
      items: [
        {
          id: 'line-b',
          productId: 'product-b',
          description: 'TEST Shower Product B',
          quantity: 4,
          unitPrice: 50,
        },
      ],
      paymentRecords: [],
      piHistory: [],
    },
  ];
  const restorePoint = {
    id: 'latest',
    version: 2,
    createdAt: '2026-08-31T00:00:00.000Z',
    company: [company],
    customers,
    products,
    orders,
    packingLists: [packingSnapshot],
    meta: [{ id: 'documentMode', value: 'Production' }],
  };
  const payloads = {
    company: { main: JSON.stringify(company, null, 2) },
    customers: Object.fromEntries(
      customers.map((value, index) => [value.id, JSON.stringify(value, index + 1)]),
    ),
    products: Object.fromEntries(
      products.map((value, index) => [value.id, JSON.stringify(value, index + 1)]),
    ),
    orders: Object.fromEntries(
      orders.map((value, index) => [value.id, JSON.stringify(value, index + 1)]),
    ),
    packing_lists: { [packingSnapshot.id]: JSON.stringify(packingSnapshot, null, 2) },
    meta: {
      documentMode: JSON.stringify({
        id: 'documentMode',
        value: 'Production',
        updatedBy: 'TEST legacy app',
      }),
    },
    restore_points: { latest: JSON.stringify(restorePoint, null, 2) },
  };
  const rowMetadata = {
    company: [7, 1700000000001],
    customers: [8, 1700000000002],
    products: [9, 1700000000003],
    orders: [10, 1700000000004],
    packing_lists: [11, 1700000000005],
    meta: [12, 1700000000006],
    restore_points: [13, 1700000000007],
  };
  let db = new Database(filename);
  try {
    createV3Schema(db);
    db.prepare('INSERT INTO users VALUES(?,?,?,?)').run(
      'legacy-admin',
      'legacy-admin',
      adminHash,
      1699999999000,
    );
    db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(
      'old-session-a',
      '{"cookie":{"originalMaxAge":28800000},"userId":"legacy-admin"}',
      9999999999999,
      9999999999999,
    );
    db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(
      'old-session-b',
      '{"userId":"legacy-admin","csrfSecret":"TEST-CSRF"}',
      9999999999998,
      9999999999999,
    );
    for (const [table, rows] of Object.entries(payloads)) {
      const [rowVersion, updatedAt] = rowMetadata[table];
      for (const [id, payloadJson] of Object.entries(rows))
        insertBusinessRow(db, table, id, payloadJson, rowVersion, updatedAt);
    }
    const sequences = [
      { kind: 'ORDER', period: '20260901', next_value: 3, updated_at: 1700000000101 },
      { kind: 'PI', period: '202609', next_value: 3, updated_at: 1700000000102 },
      { kind: 'CI', period: '202609', next_value: 2, updated_at: 1700000000103 },
      { kind: 'PL', period: '202609', next_value: 2, updated_at: 1700000000104 },
    ];
    const insertSequence = db.prepare(
      'INSERT INTO document_sequences(kind,period,next_value,updated_at) VALUES(@kind,@period,@next_value,@updated_at)',
    );
    for (const sequence of sequences) insertSequence.run(sequence);
    db.close();

    db = openDatabase(filename);
    const admin = db.prepare('SELECT * FROM users').get();
    assert.equal(admin.id, 'legacy-admin');
    assert.equal(admin.username, 'legacy-admin');
    assert.equal(admin.password_hash, adminHash);
    assert.equal(admin.role, 'ADMIN');
    assert.equal(admin.status, 'ACTIVE');
    assert.equal(admin.display_name, 'legacy-admin');
    assert.equal(admin.must_change_password, 0);
    assert.equal(admin.auth_version, 1);
    assert.deepEqual(db.prepare('SELECT version FROM schema_migrations ORDER BY version').all(), [
      { version: 1 },
      { version: 2 },
      { version: 3 },
      { version: 4 },
    ]);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 0);
    assert.deepEqual(
      db
        .prepare('SELECT kind,period,next_value,updated_at FROM document_sequences ORDER BY kind')
        .all(),
      sequences.slice().sort((a, b) => a.kind.localeCompare(b.kind)),
    );

    for (const [table, rows] of Object.entries(payloads)) {
      const [rowVersion, updatedAt] = rowMetadata[table];
      for (const [id, payloadJson] of Object.entries(rows)) {
        const row = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);
        assert.equal(
          row.payload_json,
          payloadJson,
          `${table}/${id} payload_json must remain byte-for-byte unchanged`,
        );
        assert.equal(row.row_version, rowVersion);
        assert.equal(row.updated_at, updatedAt);
      }
    }
    assert.deepEqual(
      JSON.parse(db.prepare("SELECT payload_json FROM company WHERE id='main'").get().payload_json),
      company,
    );
    assert.equal(
      JSON.parse(db.prepare("SELECT payload_json FROM company WHERE id='main'").get().payload_json)
        .accounts[0].accountNumber,
      '000000000000',
    );
    assert.equal(
      JSON.parse(db.prepare("SELECT payload_json FROM company WHERE id='main'").get().payload_json)
        .signatureImage,
      company.signatureImage,
    );
    assert.equal(
      JSON.parse(db.prepare("SELECT payload_json FROM company WHERE id='main'").get().payload_json)
        .companyStampImage,
      company.companyStampImage,
    );
    assert.deepEqual(
      JSON.parse(
        db.prepare("SELECT payload_json FROM orders WHERE id='order-a'").get().payload_json,
      ),
      orders[0],
    );
    assert.deepEqual(
      JSON.parse(
        db.prepare("SELECT payload_json FROM restore_points WHERE id='latest'").get().payload_json,
      ),
      restorePoint,
    );
    assert.deepEqual(
      db.prepare('SELECT id,owner_user_id,lifecycle_state FROM customers ORDER BY id').all(),
      customers.map((value) => ({
        id: value.id,
        owner_user_id: 'legacy-admin',
        lifecycle_state: 'ACTIVE',
      })),
    );
    assert.deepEqual(
      db
        .prepare('SELECT id,owner_user_id,customer_id,lifecycle_state FROM orders ORDER BY id')
        .all(),
      orders.map((value) => ({
        id: value.id,
        owner_user_id: 'legacy-admin',
        customer_id: value.customerId,
        lifecycle_state: 'ACTIVE',
      })),
    );
    assert.deepEqual(db.prepare('SELECT id,owner_user_id,order_id FROM packing_lists').all(), [
      { id: 'packing-a', owner_user_id: 'legacy-admin', order_id: 'order-a' },
    ]);
    const authService = await createAuthService(db);
    const authenticated = await authService.authenticate(' LEGACY-ADMIN ', adminPassword);
    assert.equal(authenticated?.id, 'legacy-admin');
    assert.equal(authenticated?.role, 'ADMIN');
    assert.equal(await authService.authenticate('legacy-admin', 'TEST-wrong-password'), null);
  } finally {
    if (db?.open) db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('v3 to v4 migration failure rolls back completely and leaves the old schema usable', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-multi-migration-rollback-')),
    filename = path.join(dir, 'legacy-v3-failure.sqlite');
  const sharedHash = await hashPassword('TEST-legacy-password-rollback-0001');
  let db = new Database(filename);
  try {
    createV3Schema(db);
    db.prepare('INSERT INTO users VALUES(?,?,?,?)').run(
      'legacy-user-a',
      'legacy-user-a',
      sharedHash,
      1700000010001,
    );
    db.prepare('INSERT INTO users VALUES(?,?,?,?)').run(
      'legacy-user-b',
      'legacy-user-b',
      sharedHash,
      1700000010002,
    );
    db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(
      'legacy-session',
      '{"userId":"legacy-user-a","marker":"TEST_KEEP_SESSION"}',
      9999999999999,
      9999999999999,
    );
    const customerJson = JSON.stringify({
      id: 'rollback-customer',
      companyName: 'TEST Rollback Buyer',
      marker: 'TEST_KEEP_CUSTOMER',
    });
    const orderJson = JSON.stringify({
      id: 'rollback-order',
      customerId: 'rollback-customer',
      orderNumber: 'ORD-TEST-ROLLBACK-001',
      piHistory: [{ revision: 0, displayNumber: 'PI-TEST-ROLLBACK-001' }],
    });
    insertBusinessRow(db, 'customers', 'rollback-customer', customerJson, 5, 1700000010101);
    insertBusinessRow(db, 'orders', 'rollback-order', orderJson, 6, 1700000010102);
    db.prepare("INSERT INTO document_sequences VALUES('PI','TEST-ROLLBACK',9,1700000010103)").run();
    const before = {
      migrations: db.prepare('SELECT * FROM schema_migrations ORDER BY version').all(),
      users: db.prepare('SELECT * FROM users ORDER BY id').all(),
      sessions: db.prepare('SELECT * FROM sessions ORDER BY sid').all(),
      customers: db.prepare('SELECT * FROM customers ORDER BY id').all(),
      orders: db.prepare('SELECT * FROM orders ORDER BY id').all(),
      sequences: db.prepare('SELECT * FROM document_sequences ORDER BY kind,period').all(),
      tables: db
        .prepare("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name")
        .all(),
    };
    db.close();

    assert.throws(() => openDatabase(filename), /at most one legacy administrator/);
    db = new Database(filename);
    assert.deepEqual(
      db.prepare('SELECT * FROM schema_migrations ORDER BY version').all(),
      before.migrations,
    );
    assert.equal(
      db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version,
      3,
    );
    assert.deepEqual(
      db
        .prepare('PRAGMA table_info(users)')
        .all()
        .map((column) => column.name),
      ['id', 'username', 'password_hash', 'created_at'],
    );
    assert.deepEqual(
      db
        .prepare('PRAGMA table_info(customers)')
        .all()
        .map((column) => column.name),
      ['id', 'payload_json', 'row_version', 'updated_at'],
    );
    assert.equal(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name IN ('audit_logs','user_login_identifiers')",
        )
        .get().count,
      0,
    );
    assert.deepEqual(db.prepare('SELECT * FROM users ORDER BY id').all(), before.users);
    assert.deepEqual(db.prepare('SELECT * FROM sessions ORDER BY sid').all(), before.sessions);
    assert.deepEqual(db.prepare('SELECT * FROM customers ORDER BY id').all(), before.customers);
    assert.deepEqual(db.prepare('SELECT * FROM orders ORDER BY id').all(), before.orders);
    assert.deepEqual(
      db.prepare('SELECT * FROM document_sequences ORDER BY kind,period').all(),
      before.sequences,
    );
    assert.deepEqual(
      db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name").all(),
      before.tables,
    );

    const oldSchemaCustomer = JSON.stringify({
      id: 'rollback-new-customer',
      companyName: 'TEST Old Schema Still Writable',
    });
    insertBusinessRow(
      db,
      'customers',
      'rollback-new-customer',
      oldSchemaCustomer,
      1,
      1700000010201,
    );
    assert.equal(
      db.prepare("SELECT payload_json FROM customers WHERE id='rollback-new-customer'").get()
        .payload_json,
      oldSchemaCustomer,
    );
    db.prepare('UPDATE orders SET row_version=row_version+1 WHERE id=?').run('rollback-order');
    assert.equal(
      db.prepare("SELECT row_version FROM orders WHERE id='rollback-order'").get().row_version,
      7,
    );
    db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(
      'legacy-session-after-failure',
      '{"marker":"TEST_OLD_SCHEMA_USABLE"}',
      9999999999997,
      9999999999998,
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 2);
  } finally {
    if (db?.open) db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('multi-user authentication, password lifecycle and single ADMIN rules', async (t) => {
  const f = await fixture({ loginPairLimit: 100, loginUserLimit: 100, loginIpLimit: 100 });
  try {
    await t.test('database and service cannot create or promote a second ADMIN', async () => {
      await f.userService.createEmployee({
        username: 'employee-a',
        email: 'employee-a@example.invalid',
        displayName: 'Employee A',
        temporaryPassword: TEMP_A,
      });
      assert.throws(
        () =>
          f.db
            .prepare(
              "INSERT INTO users(id,username,password_hash,created_at,role,status,display_name,auth_version) VALUES('admin-2','admin-2','x',1,'ADMIN','ACTIVE','Admin 2',1)",
            )
            .run(),
        /UNIQUE/,
      );
      const employee = f.db.prepare("SELECT * FROM users WHERE username='employee-a'").get();
      assert.throws(
        () => f.db.prepare("UPDATE users SET role='ADMIN' WHERE id=?").run(employee.id),
        /role is immutable/,
      );
    });
    await t.test('weak passwords and duplicate username/email are rejected', async () => {
      await assert.rejects(
        f.userService.createEmployee({
          username: 'weak-user',
          displayName: 'Weak',
          temporaryPassword: '12345678',
        }),
        /weak/i,
      );
      await assert.rejects(
        f.userService.createEmployee({
          username: 'employee-a',
          displayName: 'Duplicate',
          temporaryPassword: 'TEST-pass-duplicate-0001',
        }),
        /already in use/i,
      );
      await assert.rejects(
        f.userService.createEmployee({
          username: 'employee-other',
          email: 'EMPLOYEE-A@example.invalid',
          displayName: 'Duplicate Email',
          temporaryPassword: 'TEST-pass-duplicate-0002',
        }),
        /already in use/i,
      );
    });
    await t.test('username and normalized email both authenticate the same Employee', async () => {
      const byName = f.client(),
        byEmail = f.client();
      assert.equal((await byName.login(' Employee-A ', TEMP_A)).status, 200);
      assert.equal((await byEmail.login(' EMPLOYEE-A@EXAMPLE.INVALID ', TEMP_A)).status, 200);
      assert.equal((await body(await byName.request('/api/auth/me'))).role, 'EMPLOYEE');
      assert.equal((await body(await byEmail.request('/api/auth/me'))).username, 'employee-a');
    });
    await t.test(
      'temporary password session is gated until required change is completed',
      async () => {
        const c = f.client();
        await c.login('employee-a', TEMP_A);
        assert.equal((await c.request('/api/customers')).status, 403);
        assert.equal((await c.request('/')).status, 302);
        assert.equal((await c.request('/')).headers.get('location'), '/change-password');
        let r = await c.write('/api/auth/change-password', {
          body: { currentPassword: 'wrong', newPassword: PASS_A, confirmPassword: PASS_A },
        });
        assert.equal(r.status, 400);
        r = await c.write('/api/auth/change-password', {
          body: { currentPassword: TEMP_A, newPassword: PASS_A, confirmPassword: PASS_A },
        });
        assert.equal(r.status, 200);
        assert.equal((await body(r)).user.mustChangePassword, false);
        assert.equal((await c.request('/api/customers')).status, 200);
        assert.equal((await f.client().login('employee-a', TEMP_A)).status, 401);
        assert.equal((await f.client().login('employee-a', PASS_A)).status, 200);
      },
    );
    await t.test(
      'changing password invalidates other sessions but safely renews the current session',
      async () => {
        const current = f.client(),
          other = f.client();
        await current.login('employee-a', PASS_A);
        await other.login('employee-a', PASS_A);
        const next = 'TEST-employee-A-next-0002';
        const r = await current.write('/api/auth/change-password', {
          body: { currentPassword: PASS_A, newPassword: next, confirmPassword: next },
        });
        assert.equal(r.status, 200);
        assert.equal((await current.request('/api/auth/me')).status, 200);
        assert.equal((await other.request('/api/auth/me')).status, 401);
        assert.equal((await f.client().login('employee-a', PASS_A)).status, 401);
        assert.equal((await f.client().login('employee-a', next)).status, 200);
      },
    );
    await t.test(
      'ADMIN reset sets temporary-password gate and invalidates every Employee session',
      async () => {
        const before = f.client();
        await before.login('employee-a', 'TEST-employee-A-next-0002');
        const employee = f.db.prepare("SELECT id FROM users WHERE username='employee-a'").get();
        await f.userService.resetEmployeePassword(employee.id, 'TEST-reset-A-0003');
        assert.equal((await before.request('/api/auth/me')).status, 401);
        const fresh = f.client();
        assert.equal((await fresh.login('employee-a', 'TEST-reset-A-0003')).status, 200);
        assert.equal((await body(await fresh.request('/api/auth/me'))).mustChangePassword, true);
      },
    );
    await t.test(
      'disable invalidates only that Employee sessions; enable permits login again',
      async () => {
        const employee = f.db.prepare("SELECT id FROM users WHERE username='employee-a'").get(),
          c = f.client();
        await c.login('employee-a', 'TEST-reset-A-0003');
        f.userService.setStatus(employee.id, 'DISABLED');
        assert.equal((await c.request('/api/auth/me')).status, 401);
        assert.equal((await f.client().login('employee-a', 'TEST-reset-A-0003')).status, 401);
        f.userService.setStatus(employee.id, 'ACTIVE');
        assert.equal((await f.client().login('employee-a', 'TEST-reset-A-0003')).status, 200);
      },
    );
  } finally {
    await f.cleanup();
  }
});

test('local ADMIN CLI reset changes only the sole ADMIN password and invalidates its sessions', async () => {
  const f = await fixture();
  try {
    const c = f.client();
    await c.login();
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM sessions').get().n, 1);
    const next = 'TEST-new-admin-cli-0001';
    await resetAdminPassword(f.db, next, 8);
    assert.equal((await c.request('/api/auth/me')).status, 401);
    assert.equal((await f.client().login()).status, 401);
    assert.equal((await f.client().login(f.user.username, next)).status, 200);
    const row = f.db.prepare("SELECT password_hash FROM users WHERE role='ADMIN'").get();
    assert.equal(await verifyPassword(row.password_hash, next), true);
    assert.ok(
      f.db.prepare("SELECT 1 FROM audit_logs WHERE action='ADMIN_CLI_RESET_PASSWORD'").get(),
    );
  } finally {
    await f.cleanup();
  }
});
