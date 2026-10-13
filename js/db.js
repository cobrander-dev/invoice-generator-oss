(function (global) {
  'use strict';
  const DB_NAME = 'foreign-trade-docs';
  const DB_VERSION = 2;
  const STORES = [
    'company',
    'customers',
    'products',
    'orders',
    'packingLists',
    'meta',
    'restorePoints',
  ];
  let dbPromise;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () =>
        STORES.forEach((name) => {
          if (!req.result.objectStoreNames.contains(name))
            req.result.createObjectStore(name, { keyPath: 'id' });
        });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }
  async function store(name, mode = 'readonly') {
    const db = await open();
    return db.transaction(name, mode).objectStore(name);
  }
  async function getAll(name) {
    const s = await store(name);
    return new Promise((r, j) => {
      const q = s.getAll();
      q.onsuccess = () => r(q.result || []);
      q.onerror = () => j(q.error);
    });
  }
  async function get(name, id) {
    const s = await store(name);
    return new Promise((r, j) => {
      const q = s.get(id);
      q.onsuccess = () => r(q.result);
      q.onerror = () => j(q.error);
    });
  }
  async function put(name, value) {
    const s = await store(name, 'readwrite');
    return new Promise((r, j) => {
      const q = s.put(value);
      q.onsuccess = () => r(value);
      q.onerror = () => j(q.error);
    });
  }
  async function remove(name, id) {
    const s = await store(name, 'readwrite');
    return new Promise((r, j) => {
      const q = s.delete(id);
      q.onsuccess = () => r();
      q.onerror = () => j(q.error);
    });
  }
  async function clear(name) {
    const s = await store(name, 'readwrite');
    return new Promise((r, j) => {
      const q = s.clear();
      q.onsuccess = () => r();
      q.onerror = () => j(q.error);
    });
  }
  function validateBackup(data) {
    if (!data || ![1, 2].includes(Number(data.version))) throw new Error('备份版本不受支持');
    const required = STORES.filter((x) => x !== 'restorePoints' && x !== 'packingLists');
    for (const name of required)
      if (!Array.isArray(data[name])) throw new Error(`备份缺少 ${name} 数据`);
    for (const name of STORES.filter((x) => x !== 'restorePoints'))
      for (const row of data[name] || [])
        if (!row || typeof row !== 'object' || !row.id) throw new Error(`${name} 中存在无效记录`);
    return true;
  }
  async function exportAll() {
    const now = new Date().toISOString(),
      data = { version: 2, createdAt: now, exportedAt: now };
    for (const name of STORES.filter((x) => x !== 'restorePoints')) data[name] = await getAll(name);
    return data;
  }
  async function replaceAll(data, createRestore = true) {
    validateBackup(data);
    if (createRestore) {
      const snapshot = await exportAll();
      await put('restorePoints', {
        id: 'latest',
        createdAt: new Date().toISOString(),
        data: snapshot,
      });
    }
    const names = STORES.filter((x) => x !== 'restorePoints'),
      db = await open();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(names, 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error || new Error('导入事务已取消，当前数据未改变'));
      tx.onerror = () => reject(tx.error || new Error('导入失败，当前数据未改变'));
      for (const name of names) {
        const target = tx.objectStore(name),
          seen = new Set();
        target.clear();
        for (const row of data[name] || [])
          if (!seen.has(row.id)) {
            seen.add(row.id);
            target.put(row);
          }
      }
    });
  }
  async function restoreLatest() {
    const point = await get('restorePoints', 'latest');
    if (!point) throw new Error('没有可用的恢复点');
    await replaceAll(point.data, false);
    return point;
  }
  global.FTDB = {
    DB_NAME,
    STORES,
    open,
    getAll,
    get,
    put,
    remove,
    clear,
    validateBackup,
    exportAll,
    replaceAll,
    restoreLatest,
  };
})(window);
