'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  createApiDB,
  ConflictError,
  AuthExpiredError,
  ServerError,
  NetworkError,
  DeleteBlockedError,
} = require('../../js/api-db.js');

const response = (status, body = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
function scripted(...steps) {
  const calls = [];
  const fetch = async (url, options = {}) => {
    calls.push({ url, options });
    const step = steps.shift();
    if (step instanceof Error) throw step;
    if (typeof step === 'function') return step(url, options);
    return step;
  };
  return { db: createApiDB(fetch), calls, remaining: () => steps.length };
}
const csrf = () => response(200, { csrfToken: 'TEST-CSRF-TOKEN' });

test('adapter get reads fixed server route and caches rowVersion', async () => {
  const s = scripted(response(200, { data: { id: 'c1' }, meta: { rowVersion: 3 } }));
  assert.deepEqual(await s.db.get('customers', 'c1'), { id: 'c1' });
  assert.equal(s.db._testing.versions.get('customers\0c1'), 3);
  assert.equal(s.calls[0].url, '/api/customers/c1');
});
test('adapter get maps 404 to undefined without fallback', async () => {
  const s = scripted(response(404, { error: 'Record not found' }));
  assert.equal(await s.db.get('company', 'main'), undefined);
  assert.equal(s.calls.length, 1);
});
test('adapter getAll caches each returned rowVersion', async () => {
  const s = scripted(
    response(200, { data: [{ id: 'a' }, { id: 'b' }], meta: { rowVersions: { a: 1, b: 4 } } }),
  );
  assert.equal((await s.db.getAll('products')).length, 2);
  assert.equal(s.db._testing.versions.get('products\0b'), 4);
});
test('adapter creates a new client-id record with POST', async () => {
  const s = scripted(csrf, response(201, { data: { id: 'c1' }, meta: { rowVersion: 1 } }));
  await s.db.put('customers', { id: 'c1' });
  assert.equal(s.calls[1].options.method, 'POST');
  assert.equal(s.calls[1].url, '/api/customers');
});
test('adapter updates a loaded record with If-Match', async () => {
  const s = scripted(
    response(200, { data: { id: 'c1' }, meta: { rowVersion: 2 } }),
    csrf,
    response(200, { data: { id: 'c1', name: 'new' }, meta: { rowVersion: 3 } }),
  );
  await s.db.get('customers', 'c1');
  await s.db.put('customers', { id: 'c1', name: 'new' });
  assert.equal(s.calls[2].options.method, 'PUT');
  assert.equal(s.calls[2].options.headers['If-Match'], '2');
});
test('adapter DELETE requires cached version and retains archived server metadata', async () => {
  const s = scripted(
    response(200, { data: [{ id: 'c1' }], meta: { rowVersions: { c1: 2 } } }),
    csrf,
    response(200, { data: { id: 'c1' }, meta: { rowVersion: 3, lifecycleState: 'ARCHIVED' } }),
  );
  await s.db.getAll('customers');
  assert.deepEqual(await s.db.remove('customers', 'c1'), { id: 'c1' });
  assert.equal(s.calls[2].options.headers['If-Match'], '2');
  assert.equal(s.db._testing.versions.get('customers\0c1'), 3);
  assert.equal(s.db.getMetadata('customers', 'c1').lifecycleState, 'ARCHIVED');
});
test('adapter lists archived records, archives and restores with If-Match', async () => {
  const s = scripted(
    response(200, {
      data: [{ id: 'c1' }],
      meta: { rowVersions: { c1: 4 }, lifecycle: { c1: 'ARCHIVED' } },
    }),
    csrf,
    response(200, { data: { id: 'c1' }, meta: { rowVersion: 5, lifecycleState: 'ACTIVE' } }),
    response(200, { data: { id: 'c1' }, meta: { rowVersion: 6, lifecycleState: 'ARCHIVED' } }),
  );
  await s.db.getAll('customers', { archived: true });
  assert.equal(s.calls[0].url, '/api/customers?view=archived');
  assert.equal(s.db.getMetadata('customers', 'c1').lifecycleState, 'ARCHIVED');
  await s.db.restore('customers', 'c1');
  assert.equal(s.calls[2].url, '/api/customers/c1/restore');
  assert.equal(s.calls[2].options.method, 'POST');
  assert.equal(s.calls[2].options.headers['If-Match'], '4');
  await s.db.archive('customers', 'c1');
  assert.equal(s.calls[3].url, '/api/customers/c1/archive');
  assert.equal(s.calls[3].options.headers['If-Match'], '5');
  assert.equal(s.db.getMetadata('customers', 'c1').lifecycleState, 'ARCHIVED');
  await assert.rejects(s.db.getAll('packingLists', { archived: true }), /no archived view/);
});
test('adapter permanent delete sends the confirmation and forgets the record', async () => {
  const s = scripted(
    response(200, { data: [{ id: 'p1' }], meta: { rowVersions: { p1: 2 } } }),
    response(200, { data: { id: 'p1', deletable: true, blockers: [] } }),
    csrf,
    response(200, { data: { id: 'p1' }, meta: { deleted: true } }),
  );
  await s.db.getAll('products');
  assert.deepEqual(await s.db.deletionCheck('products', 'p1'), {
    id: 'p1',
    deletable: true,
    blockers: [],
  });
  assert.equal(s.calls[1].url, '/api/products/p1/deletion-check');
  assert.deepEqual(await s.db.permanentDelete('products', 'p1', '永久删除'), { id: 'p1' });
  assert.equal(s.calls[3].url, '/api/products/p1/permanent-delete');
  assert.equal(s.calls[3].options.headers['If-Match'], '2');
  assert.deepEqual(JSON.parse(s.calls[3].options.body), { confirmation: '永久删除' });
  assert.equal(s.db._testing.versions.has('products\0p1'), false);
  await assert.rejects(s.db.permanentDelete('products', 'p1', '永久删除'), ConflictError);
});
test('a blocked permanent delete becomes DeleteBlockedError with its blockers', async () => {
  const blockers = [{ code: 'CUSTOMER_HAS_ORDERS', count: 2, message: '已有 2 个订单使用该客户' }];
  const s = scripted(
    response(200, { data: [{ id: 'c1' }], meta: { rowVersions: { c1: 1 } } }),
    csrf,
    response(409, { error: '无法永久删除', code: 'DELETE_BLOCKED', blockers }),
  );
  await s.db.getAll('customers');
  await assert.rejects(s.db.permanentDelete('customers', 'c1', '永久删除'), (err) => {
    assert.ok(err instanceof DeleteBlockedError);
    assert.equal(err.status, 409);
    assert.deepEqual(err.blockers, blockers);
    return true;
  });
  assert.equal(s.db._testing.versions.get('customers\0c1'), 1);
});
test('409 becomes ConflictError and is never automatically retried', async () => {
  const s = scripted(
    response(200, { data: { id: 'o1' }, meta: { rowVersion: 1 } }),
    csrf,
    response(409, { error: 'conflict' }),
  );
  await s.db.get('orders', 'o1');
  await assert.rejects(s.db.put('orders', { id: 'o1' }), ConflictError);
  assert.equal(s.calls.length, 3);
});
test('read 401 becomes AuthExpiredError', async () => {
  const s = scripted(response(401, { error: '请先登录' }));
  await assert.rejects(s.db.getAll('customers'), AuthExpiredError);
});
test('write CSRF 401 becomes AuthExpiredError before any write', async () => {
  const s = scripted(response(401, { error: '请先登录' }));
  await assert.rejects(s.db.put('customers', { id: 'c1' }), AuthExpiredError);
  assert.equal(s.calls.length, 1);
});
test('5xx becomes ServerError without retry', async () => {
  const s = scripted(response(503, { error: 'Unavailable' }));
  await assert.rejects(s.db.getAll('orders'), ServerError);
  assert.equal(s.calls.length, 1);
});
test('fetch rejection becomes NetworkError without retry', async () => {
  const s = scripted(new TypeError('TEST network down'));
  await assert.rejects(s.db.getAll('products'), NetworkError);
  assert.equal(s.calls.length, 1);
});
test('adapter source has no IndexedDB or local persistence fallback', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../js/api-db.js'), 'utf8');
  assert.doesNotMatch(source, /indexedDB|localStorage|js\/db\.js/i);
});
test('exportAll reads the server backup endpoint', async () => {
  const backup = {
      version: 2,
      company: [],
      customers: [],
      products: [],
      orders: [],
      packingLists: [],
      meta: [],
    },
    s = scripted(response(200, backup));
  assert.deepEqual(await s.db.exportAll(), backup);
  assert.equal(s.calls[0].url, '/api/server-backup/export');
});
test('inspectBackup sends the actual backup body to server', async () => {
  const backup = { version: 2, customers: [{ id: 'c1' }] },
    s = scripted(csrf, response(200, { customers: 1 }));
  assert.equal((await s.db.inspectBackup(backup)).customers, 1);
  assert.deepEqual(JSON.parse(s.calls[1].options.body), backup);
});
test('replaceAll uses server import and clears rowVersion cache', async () => {
  const s = scripted(
    response(200, { data: [{ id: 'c1' }], meta: { rowVersions: { c1: 1 } } }),
    csrf,
    response(200, { replaced: true }),
  );
  await s.db.getAll('customers');
  await s.db.replaceAll({ version: 2 });
  assert.equal(s.calls[2].url, '/api/server-backup/import');
  assert.equal(s.db._testing.versions.size, 0);
});
test('restoreLatest uses server restore and clears rowVersion cache', async () => {
  const s = scripted(
    response(200, { data: [{ id: 'c1' }], meta: { rowVersions: { c1: 1 } } }),
    csrf,
    response(200, { restored: true }),
  );
  await s.db.getAll('customers');
  await s.db.restoreLatest();
  assert.equal(s.calls[2].url, '/api/server-backup/restore');
  assert.equal(s.db._testing.versions.size, 0);
});
test('clearAll sends exact confirmation through protected endpoint', async () => {
  const s = scripted(csrf, response(200, { cleared: true }));
  await s.db.clearAll('清空数据');
  assert.equal(s.calls[1].url, '/api/server-backup/clear');
  assert.deepEqual(JSON.parse(s.calls[1].options.body), { confirmation: '清空数据' });
});
test('every write automatically attaches CSRF header but not token or session to business payload', async () => {
  const business = { id: 'c1', buyerName: 'TEST' },
    s = scripted(csrf, response(201, { data: business, meta: { rowVersion: 1 } }));
  await s.db.put('customers', business);
  assert.equal(s.calls[1].options.headers['X-CSRF-Token'], 'TEST-CSRF-TOKEN');
  assert.deepEqual(JSON.parse(s.calls[1].options.body), business);
  assert.doesNotMatch(s.calls[1].options.body, /csrf|session/i);
});
test('product bulk adapter uses one server request with expected versions', async () => {
  const s = scripted(
    response(200, { data: [{ id: 'p1' }], meta: { rowVersions: { p1: 2 } } }),
    csrf,
    response(200, { data: [{ id: 'p1' }, { id: 'p2' }], meta: { rowVersions: { p1: 3, p2: 1 } } }),
  );
  await s.db.getAll('products');
  await s.db.putMany('products', [{ id: 'p1' }, { id: 'p2' }]);
  const body = JSON.parse(s.calls[2].options.body);
  assert.deepEqual(
    body.items.map((x) => x.expectedVersion),
    [2, 0],
  );
  assert.equal(s.calls[2].url, '/api/products/bulk');
});
test('Packing List adapter uses the authoritative generation action and caches both versions', async () => {
  const s = scripted(
    response(200, { data: [{ id: 'o1' }], meta: { rowVersions: { o1: 1 } } }),
    response(200, { data: [], meta: { rowVersions: {} } }),
    csrf,
    response(200, {
      data: { order: { id: 'o1' }, packingList: { id: 'pl1', orderId: 'o1' } },
      meta: { orderRowVersion: 2, packingListRowVersion: 1 },
    }),
  );
  await s.db.getAll('orders');
  await s.db.getAll('packingLists');
  await s.db.generatePackingList('o1');
  assert.equal(s.calls[3].url, '/api/orders/o1/generate-packing-list');
  assert.equal(s.db._testing.versions.get('orders\0o1'), 2);
  assert.equal(s.db._testing.versions.get('packingLists\0pl1'), 1);
});
