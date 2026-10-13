'use strict';

const assert = require('node:assert/strict');

const baseUrl = process.env.TEST_BASE_URL || 'http://localhost:18080';
const origin = process.env.TEST_REQUEST_ORIGIN || new URL(baseUrl).origin;
const forwardedProto = process.env.TEST_FORWARDED_PROTO || '';
const username = 'test-container-admin';
const password = 'TEST-container-passphrase-0000';
let cookie = '';

async function request(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (forwardedProto) headers['X-Forwarded-Proto'] = forwardedProto;
  if (cookie) headers.Cookie = cookie;
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers, redirect: 'manual' });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';', 1)[0];
  return response;
}

async function json(response, expected = 200) {
  const text = await response.text();
  assert.equal(
    response.status,
    expected,
    `${response.url}: expected ${expected}, got ${response.status}: ${text}`,
  );
  return text ? JSON.parse(text) : null;
}

async function login() {
  cookie = '';
  const loginPage = await request('/login');
  assert.equal(loginPage.status, 200);
  const html = await loginPage.text();
  const csrfToken = html.match(/name="csrf-token" content="([^"]+)"/)?.[1];
  assert.ok(csrfToken, 'login CSRF token is missing');
  const response = await request('/api/auth/login', {
    method: 'POST',
    headers: { Origin: origin, 'X-CSRF-Token': csrfToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const body = await json(response);
  assert.equal(body.user.username, username);
}

async function csrf() {
  return (await json(await request('/api/auth/csrf'))).csrfToken;
}

async function api(path, { method = 'GET', body, version } = {}) {
  const headers = {};
  if (method !== 'GET') {
    headers.Origin = origin;
    headers['X-CSRF-Token'] = await csrf();
    headers['Content-Type'] = 'application/json';
  }
  if (version !== undefined) headers['If-Match'] = String(version);
  const response = await request(path, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return json(
    response,
    method === 'POST' && ['/api/customers', '/api/products', '/api/orders'].includes(path)
      ? 201
      : 200,
  );
}

async function expectApiStatus(path, expected, { method = 'POST', body, version } = {}) {
  const headers = {
    Origin: origin,
    'X-CSRF-Token': await csrf(),
    'Content-Type': 'application/json',
  };
  if (version !== undefined) headers['If-Match'] = String(version);
  const response = await request(path, { method, headers, body: JSON.stringify(body) });
  const text = await response.text();
  assert.equal(
    response.status,
    expected,
    `${response.url}: expected ${expected}, got ${response.status}: ${text}`,
  );
}

async function assertPublicBoundary() {
  cookie = '';
  const root = await request('/');
  assert.equal(root.status, 302);
  assert.equal(root.headers.get('location'), '/login');
  assert.equal((await request('/login')).status, 200);
  assert.equal((await request('/api/orders')).status, 401);
}

async function seedWorkflow() {
  await assertPublicBoundary();
  await login();
  const company = {
    id: 'main',
    documentMode: 'Test',
    testMode: true,
    englishName: 'Example Container Testing Co., Ltd.',
    address: '123 Container Test Street, Test City, Testland',
    email: 'container-company@example.invalid',
    authorizedSignatoryName: 'TEST SIGNATORY',
    authorizedSignatoryTitle: 'TEST DIRECTOR',
    signatureImage: 'TEST_SIGNATURE',
    companyStampImage: 'TEST_STAMP',
    accounts: [
      {
        id: 'test-bank',
        currency: 'USD',
        beneficiaryName: 'Example Container Testing Co., Ltd.',
        bankName: 'Example Test Bank',
        accountNumber: '000000000000',
        swift: 'TESTBANKXXX',
      },
    ],
  };
  await api('/api/company/main', { method: 'PUT', body: company, version: 0 });
  await api('/api/customers', {
    method: 'POST',
    body: {
      id: 'container-test-customer',
      buyerType: 'Company',
      companyName: 'Example Container Buyer Testing Ltd.',
      buyerName: 'Example Container Buyer Testing Ltd.',
      country: 'Testland',
      email: 'container-buyer@example.invalid',
      consigneeName: 'TEST Consignee',
      consigneeAddress: '456 Container Buyer Road, Testland',
    },
  });
  await api('/api/products', {
    method: 'POST',
    body: {
      id: 'container-test-product',
      name: 'TEST Container Product',
      description: 'TEST Container Product',
      model: 'TEST-MODEL-001',
      sku: 'TEST-SKU-001',
      unit: 'PCS',
      unitPrice: 10,
      currency: 'USD',
      hsCode: '00000000',
      countryOfOrigin: 'Testland',
    },
  });
  let order = await api('/api/orders', {
    method: 'POST',
    body: {
      id: 'container-test-order',
      createdDate: '2026-09-08',
      documentMode: 'Test',
      testMode: true,
      customerId: 'container-test-customer',
      paymentAccountId: 'test-bank',
      namedPlace: 'Test Port, Testland',
      namedPlaceConfirmed: true,
      purposeOfShipment: 'Commercial',
      shippingMark: 'TEST SHIPPING MARK',
      declaration: 'TEST declaration for container workflow verification.',
      items: [
        {
          id: 'container-test-line',
          productId: 'container-test-product',
          description: 'TEST Container Product',
          modelSku: 'TEST-MODEL-001 / TEST-SKU-001',
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
    },
  });
  order = await api('/api/orders/container-test-order/finalize-pi', {
    method: 'POST',
    body: { signingMode: 'Electronic' },
    version: order.meta.rowVersion,
  });
  assert.equal(order.data.piVersion, 'Final');
  order.data.freight = 5;
  order = await api('/api/orders/container-test-order', {
    method: 'PUT',
    body: order.data,
    version: order.meta.rowVersion,
  });
  order = await api('/api/orders/container-test-order/revise-pi', {
    method: 'POST',
    body: { signingMode: 'Electronic' },
    version: order.meta.rowVersion,
  });
  assert.equal(order.data.activePiRevision, 1);
  order = await api('/api/orders/container-test-order/payment-tracking', {
    method: 'POST',
    version: order.meta.rowVersion,
    body: {
      paymentRecords: [
        { id: 'container-test-payment', amount: 30, currency: 'USD', status: 'Confirmed' },
      ],
      currentPaymentStage: 'Deposit Requested',
    },
  });
  assert.equal(order.data.amountPaid, 30);
  order = await api('/api/orders/container-test-order/generate-ci', {
    method: 'POST',
    body: {},
    version: order.meta.rowVersion,
  });
  order.data.actualShipmentDate = '2026-09-09';
  order.data.shipmentDate = '2026-09-09';
  order.data.actualTransportMethod = 'Sea Freight';
  order.data.actualTransportConfirmed = true;
  order.data.carrier = 'TEST Logistics Company';
  order.data.portOfLoading = 'Test Loading Port, Testland';
  order.data.portOfDischarge = 'Test Discharge Port, Testland';
  order = await api('/api/orders/container-test-order', {
    method: 'PUT',
    body: order.data,
    version: order.meta.rowVersion,
  });
  order = await api('/api/orders/container-test-order/finalize-ci', {
    method: 'POST',
    body: { signingMode: 'Electronic' },
    version: order.meta.rowVersion,
  });
  assert.equal(order.data.ciVersion, 'Final');
  let packing = await api('/api/orders/container-test-order/generate-packing-list', {
    method: 'POST',
    body: {},
    version: order.meta.rowVersion,
  });
  const draftPacking = packing.data.packingList;
  const forgedPayloads = [
    { ...structuredClone(draftPacking), status: 'Final' },
    {
      ...structuredClone(draftPacking),
      data: { ...structuredClone(draftPacking.data), plSignedAt: 'FORGED' },
    },
    { ...structuredClone(draftPacking), number: 'PL-FORGED-001' },
    {
      ...structuredClone(draftPacking),
      data: {
        ...structuredClone(draftPacking.data),
        plSigningSnapshot: { signatureImage: 'FORGED' },
      },
    },
  ];
  for (const forged of forgedPayloads) {
    await expectApiStatus('/api/orders/container-test-order/save-packing-list', 409, {
      version: packing.meta.orderRowVersion,
      body: { packingList: forged, expectedPackingListVersion: packing.meta.packingListRowVersion },
    });
  }
  packing = await api('/api/orders/container-test-order/finalize-packing-list', {
    method: 'POST',
    version: packing.meta.orderRowVersion,
    body: {
      packingList: packing.data.packingList,
      expectedPackingListVersion: packing.meta.packingListRowVersion,
      signingMode: 'Electronic',
      includeSigningBlock: true,
    },
  });
  assert.equal(packing.data.order.plVersion, 'Final');
  assert.equal(packing.data.packingList.status, 'Final');
  const backup = await api('/api/server-backup/export');
  assert.equal(backup.customers.length, 1);
  assert.equal(backup.products.length, 1);
  assert.equal(backup.orders.length, 1);
  assert.equal(backup.packingLists.length, 1);
  assert.equal(backup.packingLists.filter((item) => item.status === 'Final').length, 1);
  console.log('TEST workflow through Caddy passed.');
}

async function verifyPersistence() {
  await login();
  const customer = await api('/api/customers/container-test-customer');
  const product = await api('/api/products/container-test-product');
  const order = await api('/api/orders/container-test-order');
  const packingLists = await api('/api/packing-lists');
  assert.equal(customer.data.companyName, 'Example Container Buyer Testing Ltd.');
  assert.equal(product.data.name, 'TEST Container Product');
  assert.equal(order.data.piVersion, 'Final');
  assert.equal(order.data.activePiRevision, 1);
  assert.equal(order.data.amountPaid, 30);
  assert.equal(order.data.ciVersion, 'Final');
  assert.equal(order.data.plVersion, 'Final');
  assert.equal(packingLists.data.length, 1);
  console.log('TEST persistence verification passed.');
}

const mode = process.argv[2];
(mode === 'seed'
  ? seedWorkflow()
  : mode === 'verify'
    ? verifyPersistence()
    : Promise.reject(new Error('Use seed or verify'))
).catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
