'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { IDBFactory } = require('fake-indexeddb');
const seedDemo = require('./seed-demo');
const root = path.join(__dirname, '..');
let passed = 0;
const company = {
  id: 'main',
  documentMode: 'Production',
  englishName: 'Production Company Preserve Test',
  chineseName: 'TEST COMPANY',
  address: '123 Test Street, Testland',
  telephone: '+1 000 000 0000',
  email: 'qa@example.invalid',
  taxId: 'TEST-TAX-ID-0001',
  authorizedSignatoryName: 'TEST SIGNATORY',
  authorizedSignatoryTitle: 'Legal Representative & Director',
  accounts: [
    {
      id: 'test-a',
      accountNumber: '000000000000',
      beneficiaryName: 'TEST BENEFICIARY A',
      unknown: 'KEEP',
    },
    { id: 'test-b', accountNumber: '000000000000', beneficiaryName: 'TEST BENEFICIARY B' },
  ],
  signatureImage: 'TEST_SIGNATURE_PRESERVE',
  companyStampImage: 'TEST_STAMP_PRESERVE',
  signature: 'TEST_LEGACY_SIGNATURE',
  stamp: 'TEST_LEGACY_STAMP',
  unknown: { keep: true },
};
const records = {
  company: [company],
  customers: [
    { id: 'customer-northstar', companyName: 'Production Customer Preserve Test', unknown: 'KEEP' },
  ],
  products: [
    { id: 'product-shower', englishName: 'Production Product Preserve Test', unknown: 'KEEP' },
  ],
  orders: [
    {
      id: 'order-demo-1',
      orderNumber: 'Production Order Preserve Test',
      unknown: 'KEEP',
      dataModelVersion: 1,
      ciDocument: { number: 'TEST-CI', data: { unknown: 'KEEP' } },
      packingListDocument: { number: 'TEST-PL', data: { unknown: 'KEEP' } },
      piHistory: [{ seller: company, data: { unknown: 'KEEP' } }],
    },
  ],
  packingLists: [{ id: 'test-pl', number: 'TEST-PL-PRESERVE', unknown: 'KEEP' }],
};
async function isolated(run) {
  const factory = new IDBFactory(),
    name = 'ft-startup-test-' + Math.random().toString(36).slice(2);
  const errors = [];
  const context = vm.createContext({
    indexedDB: factory,
    console: { error: (e) => errors.push(e) },
    structuredClone,
    Blob,
    ArrayBuffer,
    Date,
    setTimeout,
    clearTimeout,
    document: { querySelector: () => ({ innerHTML: '' }) },
  });
  context.window = context;
  // Same order as index.html: i18n.js must be loaded before app.js.
  for (const file of ['core.js', 'sample-data.js', 'db.js', 'i18n.js']) {
    let source = fs.readFileSync(path.join(root, 'js', file), 'utf8');
    if (file === 'db.js') {
      const isolated = source.replace(/DB_NAME\s*=\s*'foreign-trade-docs'/, `DB_NAME='${name}'`);
      assert.notEqual(isolated, source, 'db.js database name must be replaced for isolation');
      source = isolated;
    }
    vm.runInContext(source, context, { filename: file });
  }
  const app = fs.readFileSync(path.join(root, 'js/app.js'), 'utf8');
  assert(app.endsWith('  init();\n})();\n'));
  // Exercise the actual startup/load functions; stub only DOM rendering and event binding.
  vm.runInContext(
    app.replace(
      '  init();\n})();',
      '  bindEvents=()=>{};render=()=>{};window.testStartup={init,loadData,state};\n})();',
    ),
    context,
    { filename: 'app.js' },
  );
  const DB = context.FTDB,
    db = await DB.open();
  let writes = 0;
  const transaction = db.transaction.bind(db);
  db.transaction = (names, mode, ...rest) => {
    if (mode === 'readwrite') writes++;
    return transaction(names, mode, ...rest);
  };
  const snapshot = async () => {
    const result = {};
    for (const store of DB.STORES) result[store] = await DB.getAll(store);
    return structuredClone(result);
  };
  try {
    await run({
      factory,
      db,
      DB,
      context,
      snapshot,
      writes: () => writes,
      reset: () => {
        writes = 0;
      },
      errors,
    });
  } finally {
    db.close();
    await new Promise((resolve, reject) => {
      const req = factory.deleteDatabase(name);
      req.onsuccess = resolve;
      req.onerror = () => reject(req.error);
    });
    assert.equal((await factory.databases()).length, 0);
  }
}
async function test(name, fn) {
  await isolated(fn);
  passed++;
  console.log('PASS ' + name);
}
async function populate(DB, data = records) {
  for (const [store, rows] of Object.entries(data))
    for (const row of rows) await DB.put(store, structuredClone(row));
}
async function unchanged(h) {
  const before = await h.snapshot();
  h.reset();
  await h.context.testStartup.init();
  assert.deepEqual(h.errors, []);
  assert.deepEqual(await h.snapshot(), before);
  assert.equal(h.writes(), 0);
}
async function main() {
  await test('Empty Production startup creates no Demo or metadata', unchanged);
  await test('Existing company without initialized marker remains byte-for-byte equivalent', async (h) => {
    await populate(h.DB, { company: [company] });
    await unchanged(h);
  });
  await test('Accounts, canonical and conflicting legacy signing fields remain intact', async (h) => {
    await populate(h.DB, { company: [company] });
    await unchanged(h);
    assert.deepEqual(structuredClone(h.context.testStartup.state.company), company);
  });
  await test('Missing initialized marker preserves customers, products, orders, CI and PL', async (h) => {
    await populate(h.DB);
    await unchanged(h);
  });
  await test('Repeated startup and load are idempotent with zero writes', async (h) => {
    await populate(h.DB);
    await unchanged(h);
    const before = await h.snapshot();
    await h.context.testStartup.init();
    await h.context.testStartup.loadData();
    assert.deepEqual(await h.snapshot(), before);
    assert.equal(h.writes(), 0);
  });
  await test('Explicit isolated test seeding creates marked Demo records', async (h) => {
    assert.equal(
      (await seedDemo({ factory: h.factory, db: h.db, sample: h.context.FTSample })).seeded,
      true,
    );
    for (const store of ['company', 'customers', 'products', 'orders'])
      for (const row of await h.DB.getAll(store)) {
        assert.equal(row.documentMode, 'Test');
        assert.equal(row.testMode, true);
        assert.equal(row.fixtureLabel, 'TEST DEMO ONLY');
      }
    const before = await h.snapshot();
    assert.equal(
      (await seedDemo({ factory: h.factory, db: h.db, sample: h.context.FTSample })).seeded,
      false,
    );
    assert.deepEqual(await h.snapshot(), before);
  });
  await test('Explicit test seeding cannot overwrite an existing company or business records', async (h) => {
    await populate(h.DB);
    const before = await h.snapshot();
    assert.equal(
      (await seedDemo({ factory: h.factory, db: h.db, sample: h.context.FTSample })).seeded,
      false,
    );
    assert.deepEqual(await h.snapshot(), before);
  });
  await test('Initialized marker deletion and database schema upgrade preserve Production records', async (h) => {
    await populate(h.DB);
    await h.DB.put('meta', { id: 'initialized', value: true });
    await h.DB.remove('meta', 'initialized');
    const before = await h.snapshot();
    h.db.close();
    const upgraded = await new Promise((resolve, reject) => {
      const req = h.factory.open(h.db.name, 3);
      req.onupgradeneeded = () => req.result.createObjectStore('testFutureSchema');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    try {
      h.context.FTDB.getAll = async (store) =>
        new Promise((resolve, reject) => {
          const req = upgraded.transaction(store).objectStore(store).getAll();
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
      h.context.FTDB.get = async (store, id) =>
        new Promise((resolve, reject) => {
          const req = upgraded.transaction(store).objectStore(store).get(id);
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
      h.context.FTDB.open = async () => upgraded;
      await h.context.testStartup.init();
      assert.deepEqual(h.errors, []);
      assert.deepEqual(await h.snapshot(), before);
    } finally {
      upgraded.close();
    }
  });
  await test('Initialization marker present does not trigger writes', async (h) => {
    await populate(h.DB);
    await h.DB.put('meta', { id: 'initialized', value: true });
    await unchanged(h);
  });
  console.log(`\n${passed}/${passed} startup safety tests passed; all isolated databases deleted`);
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
