'use strict';
const assert = require('assert');
const { indexedDB } = require('fake-indexeddb');
global.window = global;
global.indexedDB = indexedDB;
const C = require('../js/core.js');
require('../js/sample-data.js');
global.jspdf = require('jspdf');
require('jspdf-autotable');
global.JSZip = require('jszip');
require('../js/pdf.js');
require('../js/db.js');

(async () => {
  const DB = global.FTDB;
  await DB.put('customers', { id: 'c1', buyerName: 'First' });
  await DB.put('products', { id: 'p1', englishName: 'Product' });
  await DB.put('orders', { id: 'o1', orderNumber: 'ORD-1' });
  await DB.put('packingLists', { id: 'pl1', orderId: 'o1', number: 'PL-1' });
  const backup = await DB.exportAll();
  assert.strictEqual(backup.customers.length, 1);
  assert.strictEqual(backup.products.length, 1);
  assert.strictEqual(backup.orders.length, 1);
  assert.strictEqual(backup.packingLists.length, 1);
  console.log('PASS IndexedDB 保存与 JSON 备份');

  const legacyBackup = { ...backup };
  delete legacyBackup.packingLists;
  assert.doesNotThrow(() => DB.validateBackup(legacyBackup));
  console.log('PASS 旧版备份缺少独立Packing List表时仍可兼容导入');

  const importData = {
    ...backup,
    customers: [
      { id: 'c2', buyerName: 'Imported' },
      { id: 'c2', buyerName: 'Duplicate' },
    ],
    products: [],
    orders: [],
  };
  await DB.replaceAll(importData, true);
  const imported = await DB.getAll('customers');
  assert.strictEqual(imported.length, 1);
  assert.strictEqual(imported[0].buyerName, 'Imported');
  console.log('PASS 导入去重与导入前恢复点');

  await DB.restoreLatest();
  const restored = await DB.getAll('customers');
  assert.strictEqual(restored.length, 1);
  assert.strictEqual(restored[0].id, 'c1');
  console.log('PASS 一键恢复上一个备份');

  const beforeInvalid = await DB.getAll('customers');
  await assert.rejects(() =>
    DB.replaceAll({ ...backup, customers: [{ buyerName: 'missing id' }] }, true),
  );
  const afterInvalid = await DB.getAll('customers');
  assert.deepStrictEqual(afterInvalid, beforeInvalid);
  console.log('PASS 无效备份导入失败且不会覆盖当前数据');

  const sample = global.FTSample;
  const built = await global.FTPDF.buildArchiveBlob(sample.orders[0], {
    company: sample.company,
    customers: sample.customers,
    orders: sample.orders,
  });
  const zip = await global.JSZip.loadAsync(await built.blob.arrayBuffer());
  const names = Object.keys(zip.files);
  assert(names.some((x) => x.endsWith('.pdf')));
  assert(names.includes('order-data.json'));
  assert(names.includes('attachments/'));
  console.log('PASS 订单 ZIP 包含三份 PDF、JSON 与附件目录');
  console.log('\n6/6 database and archive tests passed');
  // Run startup regressions in another Node process with its own in-memory IDB factory.
  const { spawnSync } = require('node:child_process');
  const result = spawnSync(
    process.execPath,
    [require('node:path').join(__dirname, 'startup-safety-tests.js')],
    { stdio: 'inherit' },
  );
  if (result.error) throw result.error;
  assert.strictEqual(result.status, 0, 'Startup safety regression suite failed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
