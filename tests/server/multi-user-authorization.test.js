'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers');

const TEMP = 'TEST-temporary-pass-0001';
const COMPANY = {
  id: 'main',
  documentMode: 'Test',
  testMode: true,
  englishName: 'Example Enterprise Testing Co., Ltd.',
  address: '123 Test Street',
  signatureImage: 'TEST_SIGNATURE',
  companyStampImage: 'TEST_STAMP',
  accounts: [
    { id: 'test-bank', currency: 'USD', accountNumber: '000000000000', swift: 'TESTBANKXXX' },
  ],
};
const customer = (id, name) => ({
  id,
  buyerType: 'Company',
  companyName: name,
  buyerName: name,
  country: 'Testland',
  consigneeName: `${name} Consignee`,
  consigneeAddress: '456 Test Buyer Road',
  consigneeCountry: 'Testland',
});
const order = (id, customerId) => ({
  id,
  customerId,
  createdDate: '2026-09-11',
  testMode: true,
  paymentAccountId: 'test-bank',
  namedPlace: 'Test Port, Testland',
  namedPlaceConfirmed: true,
  actualShipmentDate: '2026-09-12',
  shipmentDate: '2026-09-12',
  actualTransportMethod: 'Sea Freight',
  actualTransportConfirmed: true,
  portOfLoading: 'Test Port, Testland',
  portOfDischarge: 'Sample Port, Testland',
  items: [
    {
      id: `line-${id}`,
      description: 'TEST Product',
      quantity: 10,
      ciQuantity: 10,
      packingQuantity: 10,
      unit: 'PCS',
      unitPrice: 10,
      netWeight: 1,
      grossWeight: 2,
      cartonQty: 2,
      quantityPerCarton: 5,
      cartonLength: 10,
      cartonWidth: 10,
      cartonHeight: 10,
    },
  ],
});
async function json(r) {
  let value = {};
  try {
    value = await r.json();
  } catch {}
  return value;
}
async function api(f, c, method, route, data, headers = {}) {
  let token = '';
  if (!['GET', 'HEAD'].includes(method))
    token = (await json(await c.request('/api/auth/csrf'))).csrfToken;
  return c.request(route, {
    method,
    headers: {
      ...(!['GET', 'HEAD'].includes(method)
        ? { Origin: f.config.origin, 'X-CSRF-Token': token }
        : {}),
      ...(data === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
}
async function employee(f, name) {
  const password = `TEST-${name}-ready-0001`;
  await f.userService.createEmployee({
    username: name,
    email: `${name}@example.invalid`,
    displayName: name.toUpperCase(),
    temporaryPassword: TEMP,
  });
  const c = f.client();
  assert.equal((await c.login(name, TEMP)).status, 200);
  assert.equal(
    (
      await c.write('/api/auth/change-password', {
        body: { currentPassword: TEMP, newPassword: password, confirmPassword: password },
      })
    ).status,
    200,
  );
  return {
    client: c,
    password,
    user: f.db.prepare('SELECT * FROM users WHERE username=?').get(name),
  };
}

test('server-authoritative role, ownership, shared product and document permissions', async (t) => {
  const f = await fixture();
  try {
    const admin = f.client();
    await admin.login();
    const a = await employee(f, 'employee-a'),
      b = await employee(f, 'employee-b');
    await api(f, admin, 'PUT', '/api/company/main', COMPANY, { 'If-Match': '0' });

    await t.test(
      'ADMIN user endpoints create Employee only and never expose password/hash',
      async () => {
        const r = await api(f, admin, 'POST', '/api/users', {
          username: 'employee-c',
          email: 'employee-c@example.invalid',
          displayName: 'EMPLOYEE C',
          temporaryPassword: 'TEST-employee-C-0001',
          role: 'ADMIN',
        });
        assert.equal(r.status, 201);
        const value = await json(r),
          text = JSON.stringify(value);
        assert.equal('passwordHash' in value.data, false);
        assert.equal('password_hash' in value.data, false);
        assert.doesNotMatch(text, /TEST-employee-C-0001/i);
        assert.equal(
          f.db.prepare("SELECT role FROM users WHERE username='employee-c'").get().role,
          'EMPLOYEE',
        );
        assert.equal((await api(f, a.client, 'GET', '/api/users')).status, 403);
      },
    );
    await t.test(
      'Employee can read but cannot modify company, accounts, signature or stamp',
      async () => {
        const read = await api(f, a.client, 'GET', '/api/company/main');
        assert.equal(read.status, 200);
        assert.deepEqual((await json(read)).data, COMPANY);
        for (const changed of [
          { ...COMPANY, englishName: 'FORGED' },
          { ...COMPANY, accounts: [] },
          { ...COMPANY, signatureImage: 'FORGED' },
          { ...COMPANY, companyStampImage: 'FORGED' },
        ])
          assert.equal(
            (await api(f, a.client, 'PUT', '/api/company/main', changed, { 'If-Match': '1' }))
              .status,
            403,
          );
        assert.deepEqual(f.repositories.company.get('main').payload, COMPANY);
      },
    );
    await t.test(
      'Employee-created Customers receive current owner and remain mutually invisible',
      async () => {
        assert.equal(
          (
            await api(
              f,
              a.client,
              'POST',
              '/api/customers',
              customer('customer-a', 'Sample Buyer A Testing Ltd.'),
            )
          ).status,
          201,
        );
        assert.equal(
          (
            await api(
              f,
              b.client,
              'POST',
              '/api/customers',
              customer('customer-b', 'Sample Buyer B Testing Ltd.'),
            )
          ).status,
          201,
        );
        assert.equal(f.repositories.customers.get('customer-a').owner_user_id, a.user.id);
        assert.equal(f.repositories.customers.get('customer-b').owner_user_id, b.user.id);
        assert.deepEqual(
          (await json(await api(f, a.client, 'GET', '/api/customers'))).data.map((x) => x.id),
          ['customer-a'],
        );
        assert.equal((await api(f, b.client, 'GET', '/api/customers/customer-a')).status, 404);
        assert.equal(
          (
            await api(
              f,
              b.client,
              'PUT',
              '/api/customers/customer-a',
              customer('customer-a', 'FORGED'),
              { 'If-Match': '1' },
            )
          ).status,
          404,
        );
      },
    );
    await t.test(
      'duplicate Customer warning is generic, nonblocking and contains no owner information',
      async () => {
        const r = await api(
          f,
          b.client,
          'POST',
          '/api/customers',
          customer('customer-duplicate', 'Sample Buyer A Testing Ltd.'),
        );
        assert.equal(r.status, 201);
        const value = await json(r);
        assert.equal(value.meta.possibleDuplicate, true);
        assert.equal(value.data.id, 'customer-duplicate');
        const text = JSON.stringify(value);
        assert.doesNotMatch(text, new RegExp(a.user.id));
        assert.doesNotMatch(text, /employee-a/i);
      },
    );
    await t.test(
      'ADMIN sees every Customer and can assign an Employee owner at creation',
      async () => {
        const r = await api(
          f,
          admin,
          'POST',
          '/api/customers',
          customer('customer-admin-assigned', 'Admin Assigned TEST'),
          { 'X-Owner-User-Id': a.user.id },
        );
        assert.equal(r.status, 201);
        assert.equal(
          f.repositories.customers.get('customer-admin-assigned').owner_user_id,
          a.user.id,
        );
        const ids = (await json(await api(f, admin, 'GET', '/api/customers'))).data.map(
          (x) => x.id,
        );
        assert.ok(ids.includes('customer-a'));
        assert.ok(ids.includes('customer-b'));
      },
    );
    await t.test(
      'Products are company-shared across Employees with rowVersion protection',
      async () => {
        let r = await api(f, a.client, 'POST', '/api/products', {
          id: 'product-shared',
          englishName: 'TEST Shared Product',
          sku: 'TEST-SKU',
        });
        assert.equal(r.status, 201);
        let list = await json(await api(f, b.client, 'GET', '/api/products'));
        assert.ok(list.data.some((x) => x.id === 'product-shared'));
        const version = list.meta.rowVersions['product-shared'];
        r = await api(
          f,
          b.client,
          'PUT',
          '/api/products/product-shared',
          { id: 'product-shared', englishName: 'TEST Shared Product Updated', sku: 'TEST-SKU' },
          { 'If-Match': String(version) },
        );
        assert.equal(r.status, 200);
        assert.equal(
          (await json(await api(f, a.client, 'GET', '/api/products/product-shared'))).data
            .englishName,
          'TEST Shared Product Updated',
        );
      },
    );
    await t.test(
      'Order inherits Customer owner and cross-owner read/action return 404',
      async () => {
        const created = await json(
          await api(f, a.client, 'POST', '/api/orders', order('order-a', 'customer-a')),
        );
        assert.equal(created.meta.ownerUserId, a.user.id);
        assert.equal(f.repositories.orders.get('order-a').owner_user_id, a.user.id);
        assert.equal(f.repositories.orders.get('order-a').customer_id, 'customer-a');
        assert.equal((await api(f, b.client, 'GET', '/api/orders/order-a')).status, 404);
        assert.equal(
          (
            await api(
              f,
              b.client,
              'POST',
              '/api/orders/order-a/finalize-pi',
              {},
              { 'If-Match': String(created.meta.rowVersion) },
            )
          ).status,
          404,
        );
        assert.ok(
          (await json(await api(f, admin, 'GET', '/api/orders'))).data.some(
            (x) => x.id === 'order-a',
          ),
        );
      },
    );
    await t.test(
      'Employee can Final PI, revise, CI, PL and Payment only on own Order',
      async () => {
        let response = await api(f, a.client, 'GET', '/api/orders/order-a'),
          value = await json(response),
          version = value.meta.rowVersion;
        value = await json(
          await api(
            f,
            a.client,
            'POST',
            '/api/orders/order-a/finalize-pi',
            { signingMode: 'Electronic' },
            { 'If-Match': String(version) },
          ),
        );
        version = value.meta.rowVersion;
        assert.equal(value.data.piDocument.status, 'Final');
        value = await json(
          await api(
            f,
            a.client,
            'PUT',
            '/api/orders/order-a',
            { ...value.data, freight: 5 },
            { 'If-Match': String(version) },
          ),
        );
        version = value.meta.rowVersion;
        value = await json(
          await api(
            f,
            a.client,
            'POST',
            '/api/orders/order-a/revise-pi',
            {},
            { 'If-Match': String(version) },
          ),
        );
        version = value.meta.rowVersion;
        assert.equal(value.data.activePiRevision, 1);
        value = await json(
          await api(
            f,
            a.client,
            'POST',
            '/api/orders/order-a/generate-ci',
            {},
            { 'If-Match': String(version) },
          ),
        );
        version = value.meta.rowVersion;
        assert.ok(value.data.ciDocument);
        value = await json(
          await api(
            f,
            a.client,
            'PUT',
            '/api/orders/order-a',
            {
              ...value.data,
              actualShipmentDate: '2026-09-12',
              shipmentDate: '2026-09-12',
              actualTransportMethod: 'Sea Freight',
              actualTransportConfirmed: true,
              portOfLoading: 'Test Port, Testland',
              portOfDischarge: 'Sample Port, Testland',
            },
            { 'If-Match': String(version) },
          ),
        );
        version = value.meta.rowVersion;
        value = await json(
          await api(
            f,
            a.client,
            'POST',
            '/api/orders/order-a/finalize-ci',
            { signingMode: 'Electronic' },
            { 'If-Match': String(version) },
          ),
        );
        version = value.meta.rowVersion;
        assert.equal(value.data.ciVersion, 'Final');
        let pl = await json(
          await api(
            f,
            a.client,
            'POST',
            '/api/orders/order-a/generate-packing-list',
            { expectedPackingListVersion: 0 },
            { 'If-Match': String(version) },
          ),
        );
        version = pl.meta.orderRowVersion;
        let plVersion = pl.meta.packingListRowVersion;
        assert.ok(pl.data.packingList.id);
        pl = await json(
          await api(
            f,
            a.client,
            'POST',
            '/api/orders/order-a/finalize-packing-list',
            {
              packingList: pl.data.packingList,
              expectedPackingListVersion: plVersion,
              signingMode: 'Electronic',
              includeSigningBlock: true,
            },
            { 'If-Match': String(version) },
          ),
        );
        version = pl.meta.orderRowVersion;
        assert.equal(pl.data.order.plVersion, 'Final');
        value = await json(
          await api(
            f,
            a.client,
            'POST',
            '/api/orders/order-a/payment-tracking',
            {
              paymentRecords: [{ id: 'pay-a', amount: 30, currency: 'USD', status: 'Confirmed' }],
              currentPaymentStage: 'Deposit Requested',
            },
            { 'If-Match': String(version) },
          ),
        );
        assert.equal(value.data.amountPaid, 30);
        assert.equal(
          (
            await api(
              f,
              b.client,
              'GET',
              `/api/packing-lists/${encodeURIComponent(pl.data.packingList.id)}`,
            )
          ).status,
          404,
        );
      },
    );
    await t.test('archive/void never physically delete Customer, Product or Order', async () => {
      const c = await json(
        await api(
          f,
          a.client,
          'POST',
          '/api/customers',
          customer('archive-customer', 'Archive TEST'),
        ),
      );
      assert.equal(
        (
          await api(f, a.client, 'DELETE', '/api/customers/archive-customer', undefined, {
            'If-Match': String(c.meta.rowVersion),
          })
        ).status,
        200,
      );
      assert.ok(f.repositories.customers.get('archive-customer'));
      assert.equal(f.repositories.customers.get('archive-customer').lifecycle_state, 'ARCHIVED');
      const p = await json(
        await api(f, a.client, 'POST', '/api/products', {
          id: 'archive-product',
          englishName: 'Archive TEST',
        }),
      );
      await api(f, b.client, 'DELETE', '/api/products/archive-product', undefined, {
        'If-Match': String(p.meta.rowVersion),
      });
      assert.ok(f.repositories.products.get('archive-product'));
      assert.equal(f.repositories.products.get('archive-product').lifecycle_state, 'ARCHIVED');
      const current = await json(await api(f, a.client, 'GET', '/api/orders/order-a'));
      const voided = await json(
        await api(f, a.client, 'DELETE', '/api/orders/order-a', undefined, {
          'If-Match': String(current.meta.rowVersion),
        }),
      );
      assert.ok(f.repositories.orders.get('order-a'));
      assert.equal(f.repositories.orders.get('order-a').lifecycle_state, 'VOID');
      assert.ok(f.repositories.packingLists.list().length);
      assert.equal(
        (
          await api(
            f,
            a.client,
            'PUT',
            '/api/orders/order-a',
            { ...voided.data, freight: 999 },
            { 'If-Match': String(voided.meta.rowVersion) },
          )
        ).status,
        409,
      );
    });
    await t.test(
      'ADMIN ownership transfer atomically moves Customer, Order and Packing List access',
      async () => {
        const before = f.repositories.orders.get('order-a'),
          pl = f.repositories.packingLists.list().find((x) => x.order_id === 'order-a');
        const r = await api(
          f,
          admin,
          'POST',
          `/api/users/${a.user.id}/transfer-customer/customer-a`,
          { ownerUserId: b.user.id },
        );
        assert.equal(r.status, 200);
        assert.equal(f.repositories.customers.get('customer-a').owner_user_id, b.user.id);
        assert.equal(f.repositories.orders.get('order-a').owner_user_id, b.user.id);
        assert.equal(f.repositories.packingLists.get(pl.payload.id).owner_user_id, b.user.id);
        assert.ok(f.repositories.orders.get('order-a').rowVersion > before.rowVersion);
        assert.equal((await api(f, a.client, 'GET', '/api/orders/order-a')).status, 404);
        assert.equal((await api(f, b.client, 'GET', '/api/orders/order-a')).status, 200);
      },
    );
    await t.test(
      'Employee cannot use ADMIN backup, restore, clear or server summary APIs',
      async () => {
        for (const [method, path, data] of [
          ['GET', '/api/server-backup/export'],
          [
            'POST',
            '/api/server-backup/inspect',
            {
              version: 2,
              company: [],
              customers: [],
              products: [],
              orders: [],
              packingLists: [],
              meta: [],
            },
          ],
          ['POST', '/api/server-backup/restore', {}],
          ['POST', '/api/server-backup/clear', { confirmation: '清空数据' }],
          ['GET', '/api/server-data/summary'],
          ['GET', '/api/meta/last-full-backup'],
        ])
          assert.equal((await api(f, a.client, method, path, data)).status, 403);
      },
    );
    await t.test(
      'Audit is immutable business history; ADMIN sees all and Employee sees only self',
      async () => {
        const adminLogs = (await json(await api(f, admin, 'GET', '/api/audit-logs'))).data,
          aLogs = (await json(await api(f, a.client, 'GET', '/api/audit-logs'))).data;
        assert.ok(adminLogs.some((x) => x.userId === a.user.id));
        assert.ok(adminLogs.some((x) => x.userId === b.user.id));
        assert.ok(aLogs.length);
        assert.ok(aLogs.every((x) => x.userId === a.user.id));
        assert.ok(adminLogs.some((x) => x.action === 'FINALIZE_PI'));
        assert.ok(adminLogs.some((x) => x.action === 'UPDATE_PAYMENT_TRACKING'));
        assert.ok(adminLogs.some((x) => x.action === 'TRANSFER_OWNERSHIP'));
        assert.doesNotMatch(
          JSON.stringify(adminLogs),
          /TEST-temporary-pass|password_hash|SESSION_SECRET/i,
        );
      },
    );
  } finally {
    await f.cleanup();
  }
});
