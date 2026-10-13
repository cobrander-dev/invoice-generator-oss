'use strict';
// Archive, restore and permanent deletion of customers, products and orders: permissions,
// tenant isolation, association protection and the audit trail.
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers');

const TEMP = 'TEST-temporary-pass-0001';
const CONFIRM = '永久删除';
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
    { id: 'spare-bank', currency: 'USD', accountNumber: '000000000001', swift: 'TESTBANKXXX' },
  ],
};
const customer = (id, name) => ({
  id,
  buyerType: 'Company',
  companyName: name,
  buyerName: name,
  country: 'Testland',
});
const product = (id, sku) => ({ id, englishName: `TEST ${sku}`, sku, unit: 'PCS' });
const order = (id, customerId, productId = '') => ({
  id,
  customerId,
  createdDate: '2026-09-11',
  testMode: true,
  paymentAccountId: 'test-bank',
  namedPlace: 'Test Port, Testland',
  namedPlaceConfirmed: true,
  items: [
    {
      id: `line-${id}`,
      productId,
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
    },
  ],
});

async function json(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}
async function api(f, c, method, route, data, headers = {}) {
  const write = !['GET', 'HEAD'].includes(method);
  const token = write ? (await json(await c.request('/api/auth/csrf'))).csrfToken : '';
  return c.request(route, {
    method,
    headers: {
      ...(write ? { Origin: f.config.origin, 'X-CSRF-Token': token } : {}),
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
  const changed = await c.write('/api/auth/change-password', {
    body: { currentPassword: TEMP, newPassword: password, confirmPassword: password },
  });
  assert.equal(changed.status, 200);
  return { client: c, user: f.db.prepare('SELECT * FROM users WHERE username=?').get(name) };
}
const version = (f, repository, id) => String(f.repositories[repository].get(id).rowVersion);
const permanentDelete = (f, c, path, id, ifMatch, confirmation = CONFIRM) =>
  api(
    f,
    c,
    'POST',
    `/api/${path}/${id}/permanent-delete`,
    { confirmation },
    { 'If-Match': ifMatch },
  );
const auditActions = (f, entityId) =>
  f.db
    .prepare(
      'SELECT action, result, metadata_json FROM audit_logs WHERE entity_id=? ORDER BY created_at',
    )
    .all(entityId);

test('permanent deletion, archive and restore are server-enforced and isolated', async (t) => {
  const f = await fixture();
  try {
    const admin = f.client();
    await admin.login();
    const a = await employee(f, 'employee-a'),
      b = await employee(f, 'employee-b');
    assert.equal(
      (await api(f, admin, 'PUT', '/api/company/main', COMPANY, { 'If-Match': '0' })).status,
      200,
    );
    for (const [c, id, name] of [
      [a.client, 'customer-a', 'Sample Buyer A Testing Ltd.'],
      [a.client, 'customer-a-unused', 'Unused Buyer A Testing Ltd.'],
      [b.client, 'customer-b', 'Sample Buyer B Testing Ltd.'],
    ])
      assert.equal((await api(f, c, 'POST', '/api/customers', customer(id, name))).status, 201);
    for (const [id, sku] of [
      ['product-used', 'TEST-USED'],
      ['product-unused', 'TEST-UNUSED'],
    ])
      assert.equal((await api(f, admin, 'POST', '/api/products', product(id, sku))).status, 201);
    assert.equal(
      (
        await api(
          f,
          a.client,
          'POST',
          '/api/orders',
          order('order-a', 'customer-a', 'product-used'),
        )
      ).status,
      201,
    );
    assert.equal(
      (await api(f, b.client, 'POST', '/api/orders', order('order-b', 'customer-b'))).status,
      201,
    );

    await t.test(
      'archive hides a customer, the archived view lists it and restore returns it',
      async () => {
        const archived = await api(
          f,
          a.client,
          'POST',
          '/api/customers/customer-a-unused/archive',
          {},
          {
            'If-Match': version(f, 'customers', 'customer-a-unused'),
          },
        );
        assert.equal(archived.status, 200);
        assert.equal((await json(archived)).meta.lifecycleState, 'ARCHIVED');
        const active = await json(await api(f, a.client, 'GET', '/api/customers'));
        assert.deepEqual(
          active.data.map((x) => x.id),
          ['customer-a'],
        );
        const list = await json(await api(f, a.client, 'GET', '/api/customers?view=archived'));
        assert.deepEqual(
          list.data.map((x) => x.id),
          ['customer-a-unused'],
        );
        assert.equal(list.meta.lifecycle['customer-a-unused'], 'ARCHIVED');
        // Employee B never sees A's archived customers.
        const other = await json(await api(f, b.client, 'GET', '/api/customers?view=archived'));
        assert.deepEqual(other.data, []);
        const restored = await api(
          f,
          a.client,
          'POST',
          '/api/customers/customer-a-unused/restore',
          {},
          {
            'If-Match': version(f, 'customers', 'customer-a-unused'),
          },
        );
        assert.equal(restored.status, 200);
        assert.equal(f.repositories.customers.get('customer-a-unused').lifecycle_state, 'ACTIVE');
        assert.equal(
          (
            await api(
              f,
              a.client,
              'POST',
              '/api/customers/customer-a-unused/restore',
              {},
              {
                'If-Match': version(f, 'customers', 'customer-a-unused'),
              },
            )
          ).status,
          409,
        );
        assert.deepEqual(
          auditActions(f, 'customer-a-unused').map((x) => x.action),
          ['CREATE_CUSTOMER', 'ARCHIVE_CUSTOMER', 'RESTORE_CUSTOMER'],
        );
      },
    );

    await t.test('legacy DELETE still archives and never removes the row', async () => {
      assert.equal(
        (
          await api(f, a.client, 'DELETE', '/api/customers/customer-a-unused', undefined, {
            'If-Match': version(f, 'customers', 'customer-a-unused'),
          })
        ).status,
        200,
      );
      assert.equal(f.repositories.customers.get('customer-a-unused').lifecycle_state, 'ARCHIVED');
    });

    await t.test(
      'permanent delete requires the confirmation phrase and the current version',
      async () => {
        const current = version(f, 'customers', 'customer-a-unused');
        assert.equal(
          (await permanentDelete(f, a.client, 'customers', 'customer-a-unused', current, 'delete'))
            .status,
          400,
        );
        assert.equal(
          (
            await permanentDelete(
              f,
              a.client,
              'customers',
              'customer-a-unused',
              String(Number(current) - 1),
            )
          ).status,
          409,
        );
        assert.equal(
          (
            await api(f, a.client, 'POST', '/api/customers/customer-a-unused/permanent-delete', {
              confirmation: CONFIRM,
            })
          ).status,
          400,
        );
        assert.ok(f.repositories.customers.get('customer-a-unused'));
      },
    );

    await t.test(
      'another employee cannot check, delete or restore a customer it does not own',
      async () => {
        const current = version(f, 'customers', 'customer-a-unused');
        assert.equal(
          (await api(f, b.client, 'GET', '/api/customers/customer-a-unused/deletion-check')).status,
          404,
        );
        assert.equal(
          (await permanentDelete(f, b.client, 'customers', 'customer-a-unused', current)).status,
          404,
        );
        assert.equal(
          (
            await api(
              f,
              b.client,
              'POST',
              '/api/customers/customer-a-unused/restore',
              {},
              {
                'If-Match': current,
              },
            )
          ).status,
          404,
        );
        assert.ok(f.repositories.customers.get('customer-a-unused'));
      },
    );

    await t.test(
      'an archived customer without orders is permanently deleted by its owner',
      async () => {
        const check = await json(
          await api(f, a.client, 'GET', '/api/customers/customer-a-unused/deletion-check'),
        );
        assert.deepEqual(check.data, { id: 'customer-a-unused', deletable: true, blockers: [] });
        const response = await permanentDelete(
          f,
          a.client,
          'customers',
          'customer-a-unused',
          version(f, 'customers', 'customer-a-unused'),
        );
        assert.equal(response.status, 200);
        assert.deepEqual(await json(response), {
          data: { id: 'customer-a-unused' },
          meta: { deleted: true },
        });
        assert.equal(f.repositories.customers.get('customer-a-unused'), null);
        const last = auditActions(f, 'customer-a-unused').at(-1);
        assert.equal(last.action, 'PERMANENT_DELETE_CUSTOMER');
        assert.equal(last.result, 'SUCCESS');
        assert.deepEqual(JSON.parse(last.metadata_json), { label: 'Unused Buyer A Testing Ltd.' });
        assert.equal(
          (await api(f, a.client, 'GET', '/api/customers/customer-a-unused')).status,
          404,
        );
      },
    );

    await t.test('a customer with orders cannot be deleted, even when archived', async () => {
      const check = await json(
        await api(f, a.client, 'GET', '/api/customers/customer-a/deletion-check'),
      );
      assert.equal(check.data.deletable, false);
      assert.deepEqual(
        check.data.blockers.map((x) => [x.code, x.count]),
        [['CUSTOMER_HAS_ORDERS', 1]],
      );
      await api(
        f,
        a.client,
        'POST',
        '/api/customers/customer-a/archive',
        {},
        {
          'If-Match': version(f, 'customers', 'customer-a'),
        },
      );
      const response = await permanentDelete(
        f,
        a.client,
        'customers',
        'customer-a',
        version(f, 'customers', 'customer-a'),
      );
      assert.equal(response.status, 409);
      const body = await json(response);
      assert.equal(body.code, 'DELETE_BLOCKED');
      assert.equal(body.blockers[0].code, 'CUSTOMER_HAS_ORDERS');
      assert.match(body.error, /1 个订单/);
      assert.ok(f.repositories.customers.get('customer-a'));
      assert.ok(f.repositories.orders.get('order-a'));
      await api(
        f,
        a.client,
        'POST',
        '/api/customers/customer-a/restore',
        {},
        {
          'If-Match': version(f, 'customers', 'customer-a'),
        },
      );
    });

    await t.test(
      'products: only the administrator deletes, and used products are protected',
      async () => {
        assert.equal(
          (await api(f, a.client, 'GET', '/api/products/product-unused/deletion-check')).status,
          403,
        );
        assert.equal(
          (
            await permanentDelete(
              f,
              a.client,
              'products',
              'product-unused',
              version(f, 'products', 'product-unused'),
            )
          ).status,
          403,
        );
        assert.ok(f.repositories.products.get('product-unused'));
        const used = await permanentDelete(
          f,
          admin,
          'products',
          'product-used',
          version(f, 'products', 'product-used'),
        );
        assert.equal(used.status, 409);
        assert.deepEqual(
          (await json(used)).blockers.map((x) => [x.code, x.count]),
          [['PRODUCT_USED_BY_ORDERS', 1]],
        );
        assert.ok(f.repositories.products.get('product-used'));
        assert.equal(
          (
            await permanentDelete(
              f,
              admin,
              'products',
              'product-unused',
              version(f, 'products', 'product-unused'),
            )
          ).status,
          200,
        );
        assert.equal(f.repositories.products.get('product-unused'), null);
        assert.equal(auditActions(f, 'product-unused').at(-1).action, 'PERMANENT_DELETE_PRODUCT');
        // Employees may still archive and restore shared products.
        for (const action of ['archive', 'restore'])
          assert.equal(
            (
              await api(
                f,
                a.client,
                'POST',
                `/api/products/product-used/${action}`,
                {},
                {
                  'If-Match': version(f, 'products', 'product-used'),
                },
              )
            ).status,
            200,
          );
      },
    );

    await t.test('orders with a Final PI or payment records can only be voided', async () => {
      let response = await api(
        f,
        a.client,
        'POST',
        '/api/orders/order-a/payment-tracking',
        {
          paymentRecords: [{ id: 'pay-a', amount: 30, currency: 'USD', status: 'Confirmed' }],
          currentPaymentStage: 'Deposit Requested',
        },
        { 'If-Match': version(f, 'orders', 'order-a') },
      );
      assert.equal(response.status, 200);
      let check = await json(await api(f, a.client, 'GET', '/api/orders/order-a/deletion-check'));
      assert.deepEqual(
        check.data.blockers.map((x) => x.code),
        ['ORDER_HAS_PAYMENTS'],
      );
      response = await api(
        f,
        a.client,
        'POST',
        '/api/orders/order-a/finalize-pi',
        {
          signingMode: 'Electronic',
        },
        { 'If-Match': version(f, 'orders', 'order-a') },
      );
      assert.equal(response.status, 200);
      check = await json(await api(f, a.client, 'GET', '/api/orders/order-a/deletion-check'));
      assert.deepEqual(
        check.data.blockers.map((x) => x.code),
        ['ORDER_HAS_FINAL_PI', 'ORDER_HAS_PAYMENTS'],
      );
      const voided = await api(
        f,
        a.client,
        'POST',
        '/api/orders/order-a/archive',
        {},
        {
          'If-Match': version(f, 'orders', 'order-a'),
        },
      );
      assert.equal((await json(voided)).meta.lifecycleState, 'VOID');
      const before = JSON.stringify(f.repositories.orders.get('order-a').payload);
      response = await permanentDelete(
        f,
        a.client,
        'orders',
        'order-a',
        version(f, 'orders', 'order-a'),
      );
      assert.equal(response.status, 409);
      assert.equal(JSON.stringify(f.repositories.orders.get('order-a').payload), before);
      const list = await json(await api(f, a.client, 'GET', '/api/orders?view=archived'));
      assert.deepEqual(
        list.data.map((x) => x.id),
        ['order-a'],
      );
      assert.equal(
        (
          await api(
            f,
            a.client,
            'POST',
            '/api/orders/order-a/restore',
            {},
            {
              'If-Match': version(f, 'orders', 'order-a'),
            },
          )
        ).status,
        200,
      );
      assert.equal(f.repositories.orders.get('order-a').lifecycle_state, 'ACTIVE');
    });

    await t.test(
      'a draft order is deleted by its owner only and other data stays intact',
      async () => {
        const others = {
          customers: f.repositories.customers.list().length,
          products: f.repositories.products.list().length,
          orderB: JSON.stringify(f.repositories.orders.get('order-b')),
        };
        assert.equal(
          (await permanentDelete(f, a.client, 'orders', 'order-b', version(f, 'orders', 'order-b')))
            .status,
          404,
        );
        const number = f.repositories.orders.get('order-b').payload.orderNumber;
        const response = await permanentDelete(
          f,
          b.client,
          'orders',
          'order-b',
          version(f, 'orders', 'order-b'),
        );
        assert.equal(response.status, 200);
        assert.equal(f.repositories.orders.get('order-b'), null);
        assert.deepEqual(JSON.parse(auditActions(f, 'order-b').at(-1).metadata_json), {
          label: number,
        });
        assert.equal(f.repositories.customers.list().length, others.customers);
        assert.equal(f.repositories.products.list().length, others.products);
        assert.ok(f.repositories.orders.get('order-a'));
        // Document numbers are never reused after a deletion.
        const next = await json(
          await api(f, b.client, 'POST', '/api/orders', order('order-b2', 'customer-b')),
        );
        assert.notEqual(next.data.orderNumber, number);
        // The customer is deletable again once its only order is gone.
        await permanentDelete(f, b.client, 'orders', 'order-b2', version(f, 'orders', 'order-b2'));
        assert.equal(
          (
            await permanentDelete(
              f,
              b.client,
              'customers',
              'customer-b',
              version(f, 'customers', 'customer-b'),
            )
          ).status,
          200,
        );
      },
    );

    await t.test(
      'a payment account used by an order cannot be removed from the company',
      async () => {
        const without = (id) => ({
          ...COMPANY,
          accounts: COMPANY.accounts.filter((account) => account.id !== id),
        });
        let response = await api(f, admin, 'PUT', '/api/company/main', without('test-bank'), {
          'If-Match': version(f, 'company', 'main'),
        });
        assert.equal(response.status, 409);
        const body = await json(response);
        assert.equal(body.code, 'DELETE_BLOCKED');
        assert.equal(body.blockers[0].code, 'ACCOUNT_USED_BY_ORDERS');
        assert.equal(f.repositories.company.get('main').payload.accounts.length, 2);
        response = await api(f, admin, 'PUT', '/api/company/main', without('spare-bank'), {
          'If-Match': version(f, 'company', 'main'),
        });
        assert.equal(response.status, 200);
        assert.deepEqual(
          f.repositories.company.get('main').payload.accounts.map((x) => x.id),
          ['test-bank'],
        );
      },
    );
  } finally {
    await f.cleanup();
  }
});
