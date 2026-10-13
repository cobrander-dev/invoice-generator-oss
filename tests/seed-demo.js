'use strict';
// Test-only entry point. Never loaded by index.html or app.js.
const { IDBFactory } = require('fake-indexeddb');
module.exports = async function seedDemo({ factory, db, sample }) {
  if (!(factory instanceof IDBFactory) || !db.name.startsWith('ft-startup-test-'))
    throw new Error('Demo seeding requires an isolated test database');
  const names = ['company', 'customers', 'products', 'orders', 'packingLists'];
  return new Promise((resolve, reject) => {
    const tx = db.transaction(names, 'readwrite');
    let remaining = names.length,
      occupied = false,
      seeded = false;
    tx.oncomplete = () => resolve({ seeded });
    tx.onabort = () => reject(tx.error || new Error('Demo transaction aborted'));
    for (const name of names) {
      const request = tx.objectStore(name).count();
      request.onsuccess = () => {
        occupied ||= request.result > 0;
        if (--remaining || occupied) return;
        for (const [store, rows] of Object.entries({
          company: [sample.company],
          customers: sample.customers,
          products: sample.products,
          orders: sample.orders,
        })) {
          for (const original of rows) {
            const row = structuredClone(original);
            row.documentMode = 'Test';
            row.testMode = true;
            row.fixtureLabel = 'TEST DEMO ONLY';
            tx.objectStore(store).add(row);
          }
        }
        seeded = true;
      };
    }
  });
};
