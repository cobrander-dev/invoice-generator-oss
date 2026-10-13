'use strict';

const assert = require('node:assert/strict');

const baseUrl = process.env.TEST_BASE_URL || 'http://127.0.0.1:3001';
const origin = process.env.TEST_REQUEST_ORIGIN || 'https://invoice.example.com';
const forwardedProto = process.env.TEST_FORWARDED_PROTO || 'https';
const ADMIN = {
  login: 'test-enterprise-admin',
  password: process.env.TEST_ADMIN_PASSWORD || 'TEST-enterprise-admin-0001',
};
const TEMP = 'TEST-employee-temporary-0001';
const A_PASSWORD = 'TEST-employee-alpha-ready-0001';
const B_PASSWORD = 'TEST-employee-bravo-ready-0001';

class Client {
  constructor() {
    this.cookie = '';
  }
  async request(path, options = {}) {
    const headers = { 'X-Forwarded-Proto': forwardedProto, ...(options.headers || {}) };
    if (this.cookie) headers.Cookie = this.cookie;
    const response = await fetch(baseUrl + path, { ...options, headers, redirect: 'manual' });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';', 1)[0];
    return response;
  }
  async login(identifier, password, expected = 200) {
    this.cookie = '';
    const page = await this.request('/login');
    assert.equal(page.status, 200);
    const token = (await page.text()).match(/name="csrf-token" content="([^"]+)"/)?.[1];
    assert.ok(token);
    return expect(
      this.request('/api/auth/login', {
        method: 'POST',
        headers: {
          Origin: origin,
          'X-CSRF-Token': token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ username: identifier, password }),
      }),
      expected,
    );
  }
  async api(path, { method = 'GET', body, version, expected = 200 } = {}) {
    const headers = {};
    if (!['GET', 'HEAD'].includes(method)) {
      const tokenResponse = await this.request('/api/auth/csrf');
      assert.equal(tokenResponse.status, 200, `CSRF request for ${path}`);
      headers.Origin = origin;
      headers['X-CSRF-Token'] = (await tokenResponse.json()).csrfToken;
      headers['Content-Type'] = 'application/json';
    }
    if (version !== undefined) headers['If-Match'] = String(version);
    return expect(
      this.request(path, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      expected,
    );
  }
}

async function expect(promise, status) {
  const response = await promise;
  const text = await response.text();
  assert.equal(
    response.status,
    status,
    `${response.url}: expected ${status}, got ${response.status}: ${text}`,
  );
  return text ? JSON.parse(text) : null;
}

function customer(id, name) {
  return {
    id,
    buyerType: 'Company',
    companyName: name,
    buyerName: name,
    country: 'Testland',
    email: `${id}@example.invalid`,
    consigneeName: `${name} TEST Consignee`,
    consigneeAddress: '456 Test Buyer Road, Testland',
  };
}

function order(id, customerId, productId) {
  return {
    id,
    customerId,
    createdDate: '2026-09-11',
    documentMode: 'Test',
    testMode: true,
    paymentAccountId: 'test-bank',
    namedPlace: 'Test Port, Testland',
    namedPlaceConfirmed: true,
    actualShipmentDate: '2026-09-12',
    shipmentDate: '2026-09-12',
    actualTransportMethod: 'Sea Freight',
    actualTransportConfirmed: true,
    carrier: 'TEST Logistics Company',
    portOfLoading: 'Test Loading Port, Testland',
    portOfDischarge: 'Test Discharge Port, Testland',
    purposeOfShipment: 'Commercial',
    items: [
      {
        id: `line-${id}`,
        productId,
        description: 'TEST Enterprise Product',
        modelSku: 'TEST-MODEL / TEST-SKU',
        countryOfOrigin: 'Testland',
        quantity: 10,
        ciQuantity: 10,
        packingQuantity: 10,
        unit: 'PCS',
        unitPrice: 10,
        cartonQty: 2,
        quantityPerCarton: 5,
        netWeight: 1,
        grossWeight: 2,
        cartonLength: 10,
        cartonWidth: 10,
        cartonHeight: 10,
      },
    ],
  };
}

async function createEmployee(admin, username, email, displayName) {
  return (
    await admin.api('/api/users', {
      method: 'POST',
      expected: 201,
      body: { username, email, displayName, temporaryPassword: TEMP, role: 'ADMIN' },
    })
  ).data;
}

async function activateEmployee(identifier, nextPassword) {
  const client = new Client();
  const login = await client.login(identifier, TEMP);
  assert.equal(login.user.mustChangePassword, true);
  assert.equal((await client.request('/')).status, 302);
  assert.equal((await client.request('/api/customers')).status, 403);
  const changed = await client.api('/api/auth/change-password', {
    method: 'POST',
    body: { currentPassword: TEMP, newPassword: nextPassword, confirmPassword: nextPassword },
  });
  assert.equal(changed.user.mustChangePassword, false);
  assert.equal((await client.request('/api/customers')).status, 200);
  return client;
}

async function main() {
  const anonymous = new Client();
  assert.equal((await anonymous.request('/')).status, 302);
  assert.equal((await anonymous.request('/api/orders')).status, 401);

  const admin = new Client();
  const adminLogin = await admin.login(ADMIN.login, ADMIN.password);
  assert.equal(adminLogin.user.role, 'ADMIN');
  const employeeA = await createEmployee(
    admin,
    'employee-alpha',
    'employee-alpha@example.invalid',
    'Employee Alpha TEST',
  );
  const employeeB = await createEmployee(
    admin,
    'employee-bravo',
    'employee-bravo@example.invalid',
    'Employee Bravo TEST',
  );
  assert.equal(employeeA.role, 'EMPLOYEE');
  assert.equal(employeeB.role, 'EMPLOYEE');

  const a = await activateEmployee(' EMPLOYEE-ALPHA@EXAMPLE.INVALID ', A_PASSWORD);
  const b = await activateEmployee(' employee-bravo ', B_PASSWORD);
  assert.equal((await admin.api('/api/auth/me')).role, 'ADMIN');
  assert.equal((await a.api('/api/auth/me')).username, 'employee-alpha');
  assert.equal((await b.api('/api/auth/me')).username, 'employee-bravo');

  const company = {
    id: 'main',
    documentMode: 'Test',
    testMode: true,
    englishName: 'Example Enterprise Testing Co., Ltd.',
    address: '123 Test Street, Test City, Testland',
    email: 'enterprise@example.invalid',
    authorizedSignatoryName: 'TEST SIGNATORY',
    authorizedSignatoryTitle: 'TEST DIRECTOR',
    signatureImage: 'TEST_SIGNATURE',
    companyStampImage: 'TEST_STAMP',
    accounts: [
      {
        id: 'test-bank',
        currency: 'USD',
        bankName: 'Example Test Bank',
        accountNumber: '000000000000',
        swift: 'TESTBANKXXX',
      },
    ],
  };
  await admin.api('/api/company/main', { method: 'PUT', version: 0, body: company });
  assert.deepEqual((await a.api('/api/company/main')).data, company);
  await a.api('/api/company/main', {
    method: 'PUT',
    version: 1,
    body: { ...company, accounts: [] },
    expected: 403,
  });

  let product = await a.api('/api/products', {
    method: 'POST',
    expected: 201,
    body: {
      id: 'shared-test-product',
      englishName: 'TEST Enterprise Product',
      sku: 'TEST-SKU',
      unit: 'PCS',
    },
  });
  const bProducts = await b.api('/api/products');
  assert.ok(bProducts.data.some((item) => item.id === product.data.id));
  const productVersion = bProducts.meta.rowVersions[product.data.id];
  product = await b.api(`/api/products/${product.data.id}`, {
    method: 'PUT',
    version: productVersion,
    body: { ...product.data, englishName: 'TEST Enterprise Product Updated' },
  });
  assert.equal(
    (await a.api(`/api/products/${product.data.id}`)).data.englishName,
    'TEST Enterprise Product Updated',
  );
  assert.equal(
    (await admin.api(`/api/products/${product.data.id}`)).data.englishName,
    'TEST Enterprise Product Updated',
  );

  const customerAId = 'alpha-owned-test-customer';
  const customerBId = 'bravo-duplicate-test-customer';
  const createdA = await a.api('/api/customers', {
    method: 'POST',
    expected: 201,
    body: customer(customerAId, 'Possible Duplicate Testing Ltd.'),
  });
  const duplicate = await b.api('/api/customers', {
    method: 'POST',
    expected: 201,
    body: customer(customerBId, 'Possible Duplicate Testing Ltd.'),
  });
  assert.equal(duplicate.meta.possibleDuplicate, true);
  assert.equal(duplicate.data.id, customerBId);
  assert.equal(JSON.stringify(duplicate).includes(customerAId), false);
  assert.equal(JSON.stringify(duplicate).includes('employee-alpha'), false);
  await b.api(`/api/customers/${customerAId}`, { expected: 404 });
  await b.api(`/api/customers/${customerAId}`, {
    method: 'PUT',
    version: createdA.meta.rowVersion,
    body: customer(customerAId, 'FORGED TEST'),
    expected: 404,
  });

  let savedOrder = await a.api('/api/orders', {
    method: 'POST',
    expected: 201,
    body: order('alpha-owned-test-order', customerAId, product.data.id),
  });
  await b.api('/api/orders/alpha-owned-test-order', { expected: 404 });
  await b.api('/api/orders/alpha-owned-test-order/finalize-pi', {
    method: 'POST',
    version: savedOrder.meta.rowVersion,
    body: { signingMode: 'Electronic' },
    expected: 404,
  });
  savedOrder = await a.api('/api/orders/alpha-owned-test-order/finalize-pi', {
    method: 'POST',
    version: savedOrder.meta.rowVersion,
    body: { signingMode: 'Electronic' },
  });
  savedOrder.data.freight = 5;
  savedOrder = await a.api('/api/orders/alpha-owned-test-order', {
    method: 'PUT',
    version: savedOrder.meta.rowVersion,
    body: savedOrder.data,
  });
  savedOrder = await a.api('/api/orders/alpha-owned-test-order/revise-pi', {
    method: 'POST',
    version: savedOrder.meta.rowVersion,
    body: {},
  });
  savedOrder = await a.api('/api/orders/alpha-owned-test-order/payment-tracking', {
    method: 'POST',
    version: savedOrder.meta.rowVersion,
    body: {
      paymentRecords: [
        { id: 'alpha-test-payment', amount: 30, currency: 'USD', status: 'Confirmed' },
      ],
      currentPaymentStage: 'Deposit Requested',
    },
  });
  savedOrder = await a.api('/api/orders/alpha-owned-test-order/generate-ci', {
    method: 'POST',
    version: savedOrder.meta.rowVersion,
    body: {},
  });
  savedOrder = await a.api('/api/orders/alpha-owned-test-order', {
    method: 'PUT',
    version: savedOrder.meta.rowVersion,
    body: savedOrder.data,
  });
  savedOrder = await a.api('/api/orders/alpha-owned-test-order/finalize-ci', {
    method: 'POST',
    version: savedOrder.meta.rowVersion,
    body: { signingMode: 'Electronic' },
  });
  let packing = await a.api('/api/orders/alpha-owned-test-order/generate-packing-list', {
    method: 'POST',
    version: savedOrder.meta.rowVersion,
    body: { expectedPackingListVersion: 0 },
  });
  packing = await a.api('/api/orders/alpha-owned-test-order/finalize-packing-list', {
    method: 'POST',
    version: packing.meta.orderRowVersion,
    body: {
      packingList: packing.data.packingList,
      expectedPackingListVersion: packing.meta.packingListRowVersion,
      signingMode: 'Electronic',
      includeSigningBlock: true,
    },
  });
  const finalHistory = JSON.stringify({
    piHistory: packing.data.order.piHistory,
    ciDocument: packing.data.order.ciDocument,
    packingList: packing.data.packingList,
    payments: packing.data.order.paymentRecords,
  });

  await a.api('/api/server-backup/export', { expected: 403 });
  await a.api('/api/users', { expected: 403 });
  await a.api('/api/meta/last-full-backup', { expected: 403 });

  await admin.api(`/api/users/${employeeA.id}/transfer-customer/${customerAId}`, {
    method: 'POST',
    body: { ownerUserId: employeeB.id },
  });
  await a.api(`/api/customers/${customerAId}`, { expected: 404 });
  await a.api('/api/orders/alpha-owned-test-order', { expected: 404 });
  const transferredOrder = await b.api('/api/orders/alpha-owned-test-order');
  assert.equal(
    JSON.stringify({
      piHistory: transferredOrder.data.piHistory,
      ciDocument: transferredOrder.data.ciDocument,
      packingList: (await b.api(`/api/packing-lists/${packing.data.packingList.id}`)).data,
      payments: transferredOrder.data.paymentRecords,
    }),
    finalHistory,
  );

  const aLogs = (await a.api('/api/audit-logs')).data;
  const bLogs = (await b.api('/api/audit-logs')).data;
  const adminLogs = (await admin.api('/api/audit-logs')).data;
  assert.ok(aLogs.length && aLogs.every((log) => log.userId === employeeA.id));
  assert.ok(bLogs.length && bLogs.every((log) => log.userId === employeeB.id));
  assert.ok(adminLogs.some((log) => log.userId === employeeA.id));
  assert.ok(adminLogs.some((log) => log.userId === employeeB.id));
  assert.ok(adminLogs.some((log) => log.action === 'TRANSFER_OWNERSHIP'));
  assert.ok(
    adminLogs.some((log) => log.action === 'UPDATE_PRODUCT' && log.userId === employeeB.id),
  );

  const aOther = new Client();
  await aOther.login('employee-alpha', A_PASSWORD);
  await admin.api(`/api/users/${employeeA.id}/reset-password`, {
    method: 'POST',
    body: { temporaryPassword: 'TEST-alpha-reset-0002' },
  });
  assert.equal((await a.request('/api/auth/me')).status, 401);
  assert.equal((await aOther.request('/api/auth/me')).status, 401);
  await new Client().login('employee-alpha', A_PASSWORD, 401);
  const aReset = new Client();
  assert.equal(
    (await aReset.login('employee-alpha', 'TEST-alpha-reset-0002')).user.mustChangePassword,
    true,
  );
  await aReset.api('/api/auth/change-password', {
    method: 'POST',
    body: {
      currentPassword: 'TEST-alpha-reset-0002',
      newPassword: 'TEST-alpha-ready-0003',
      confirmPassword: 'TEST-alpha-ready-0003',
    },
  });
  const aSecond = new Client();
  await aSecond.login('employee-alpha', 'TEST-alpha-ready-0003');
  await aReset.api('/api/auth/change-password', {
    method: 'POST',
    body: {
      currentPassword: 'TEST-alpha-ready-0003',
      newPassword: 'TEST-alpha-ready-0004',
      confirmPassword: 'TEST-alpha-ready-0004',
    },
  });
  assert.equal((await aSecond.request('/api/auth/me')).status, 401);
  assert.equal((await admin.request('/api/auth/me')).status, 200);
  assert.equal((await b.request('/api/auth/me')).status, 200);
  await admin.api(`/api/users/${employeeA.id}/disable`, { method: 'POST', body: {} });
  assert.equal((await aReset.request('/api/auth/me')).status, 401);
  await new Client().login('employee-alpha', 'TEST-alpha-ready-0004', 401);
  assert.equal((await b.request('/api/auth/me')).status, 200);
  await admin.api(`/api/users/${employeeA.id}/enable`, { method: 'POST', body: {} });
  await new Client().login('employee-alpha', 'TEST-alpha-ready-0004');

  const currentCustomer = await b.api(`/api/customers/${customerAId}`);
  const archivedCustomer = await b.api(`/api/customers/${customerAId}`, {
    method: 'DELETE',
    version: currentCustomer.meta.rowVersion,
  });
  assert.equal(archivedCustomer.meta.lifecycleState, 'ARCHIVED');
  const currentProduct = await admin.api(`/api/products/${product.data.id}`);
  const archivedProduct = await admin.api(`/api/products/${product.data.id}`, {
    method: 'DELETE',
    version: currentProduct.meta.rowVersion,
  });
  assert.equal(archivedProduct.meta.lifecycleState, 'ARCHIVED');
  const currentOrder = await b.api('/api/orders/alpha-owned-test-order');
  const voidedOrder = await b.api('/api/orders/alpha-owned-test-order', {
    method: 'DELETE',
    version: currentOrder.meta.rowVersion,
  });
  assert.equal(voidedOrder.meta.lifecycleState, 'VOID');

  const backup = await admin.api('/api/server-backup/export');
  const backupText = JSON.stringify(backup);
  assert.equal(
    backup.customers.find((item) => item.id === customerAId)._server.lifecycleState,
    'ARCHIVED',
  );
  assert.equal(
    backup.products.find((item) => item.id === product.data.id)._server.lifecycleState,
    'ARCHIVED',
  );
  assert.equal(
    backup.orders.find((item) => item.id === 'alpha-owned-test-order')._server.lifecycleState,
    'VOID',
  );
  const backupPacking = {
    ...backup.packingLists.find((item) => item.id === packing.data.packingList.id),
  };
  delete backupPacking._server;
  assert.equal(
    JSON.stringify({
      piHistory: backup.orders.find((item) => item.id === 'alpha-owned-test-order').piHistory,
      ciDocument: backup.orders.find((item) => item.id === 'alpha-owned-test-order').ciDocument,
      packingList: backupPacking,
      payments: backup.orders.find((item) => item.id === 'alpha-owned-test-order').paymentRecords,
    }),
    finalHistory,
  );
  for (const forbidden of [
    'password_hash',
    'passwordHash',
    'SESSION_SECRET',
    'auth_version',
    'schema_migrations',
    'audit_logs',
  ]) {
    assert.equal(backupText.includes(forbidden), false, forbidden);
  }
  console.log('Production-container enterprise multi-user HTTP workflow passed.');
}

async function verifyAdminReset() {
  await new Client().login(ADMIN.login, 'TEST-enterprise-admin-0001', 401);
  const admin = new Client();
  const result = await admin.login(ADMIN.login, ADMIN.password);
  assert.equal(result.user.role, 'ADMIN');
  assert.equal(result.user.mustChangePassword, false);
  console.log('Production-container ADMIN CLI password reset passed.');
}

const mode = process.argv[2] || 'workflow';
(mode === 'workflow'
  ? main()
  : mode === 'verify-admin-reset'
    ? verifyAdminReset()
    : Promise.reject(new Error('Unknown mode'))
).catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
