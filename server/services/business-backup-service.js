'use strict';
const { ValidationError } = require('../db/errors');
const { clone } = require('../repositories/business-repository');

const COLLECTIONS = Object.freeze([
  ['company', 'company'], ['customers', 'customers'], ['products', 'products'],
  ['orders', 'orders'], ['packingLists', 'packingLists'], ['meta', 'meta']
]);

function validateBusinessBackup(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new ValidationError('Backup must be an object');
  if (![1, 2].includes(Number(data.version))) throw new ValidationError('Unsupported backup version');
  for (const key of ['company', 'customers', 'products', 'orders', 'meta']) {
    if (!Array.isArray(data[key])) throw new ValidationError(`Backup requires ${key} array`);
  }
  if (data.packingLists !== undefined && !Array.isArray(data.packingLists)) throw new ValidationError('packingLists must be an array when present');
  for (const [key] of COLLECTIONS) {
    const seen = new Set();
    for (const row of data[key] || []) {
      if (!row || typeof row !== 'object' || Array.isArray(row) || typeof row.id !== 'string' || !row.id.trim()) throw new ValidationError(`${key} contains an invalid record`);
      if (seen.has(row.id)) throw new ValidationError(`${key} contains duplicate id`);
      seen.add(row.id);
      if (row._server !== undefined) {
        if (!row._server || typeof row._server !== 'object' || Array.isArray(row._server)) throw new ValidationError(`${key} contains invalid server metadata`);
        const allowed = new Set(['ownerUserId', 'ownerUsernameSnapshot', 'lifecycleState']);
        if (Object.keys(row._server).some(name => !allowed.has(name))) throw new ValidationError(`${key} contains unsupported server metadata`);
      }
    }
  }
  return true;
}

function inspectBackup(data) {
  validateBusinessBackup(data);
  const company = data.company || [], orders = data.orders || [];
  return {
    version: Number(data.version), createdAt: data.createdAt || null, exportedAt: data.exportedAt || null,
    company: company.length,
    accounts: company.reduce((n, row) => n + (Array.isArray(row.accounts) ? row.accounts.length : 0), 0),
    customers: data.customers.length, products: data.products.length, orders: orders.length,
    packingLists: (data.packingLists || []).length,
    piHistory: orders.reduce((n, row) => n + (Array.isArray(row.piHistory) ? row.piHistory.length : 0), 0),
    ci: orders.filter(row => row && row.ciDocument).length,
    payments: orders.reduce((n, row) => n + (Array.isArray(row.paymentRecords) ? row.paymentRecords.length : 0), 0),
    attachments: orders.reduce((n, row) => n + (Array.isArray(row.attachments) ? row.attachments.length : 0) +
      (Array.isArray(row.paymentRecords) ? row.paymentRecords.filter(payment => payment && payment.paymentSlip).length : 0), 0)
  };
}

class BusinessBackupService {
  constructor(db, repositories, { onStep = () => {}, sequenceService = null } = {}) {
    this.db = db; this.repositories = repositories; this.onStep = onStep; this.sequenceService = sequenceService;
    this.replaceTransaction = db.transaction((data, createRestorePoint, defaultOwnerId) => this.replaceInsideTransaction(data, createRestorePoint, defaultOwnerId));
    this.restoreTransaction = db.transaction(defaultOwnerId => this.restoreInsideTransaction(defaultOwnerId));
    this.clearTransaction = db.transaction(createRestorePoint => this.clearInsideTransaction(createRestorePoint));
  }
  exportInsideTransaction(now = new Date().toISOString()) {
    const result = { version: 2, createdAt: now, exportedAt: now };
    for (const [key, repository] of COLLECTIONS) result[key] = this.repositories[repository].list().map(row => {
      const payload = clone(row.payload), metadata = {};
      if (row.owner_user_id) {
        metadata.ownerUserId = row.owner_user_id;
        metadata.ownerUsernameSnapshot = this.db.prepare('SELECT username FROM users WHERE id=?').get(row.owner_user_id)?.username || '';
      }
      if (row.lifecycle_state && row.lifecycle_state !== 'ACTIVE') metadata.lifecycleState = row.lifecycle_state;
      if (Object.keys(metadata).length) payload._server = metadata;
      return payload;
    });
    return result;
  }
  exportAllBusinessData() { return this.db.transaction(() => this.exportInsideTransaction())(); }
  validateBusinessBackup(data) { return validateBusinessBackup(data); }
  inspectBackup(data) { return inspectBackup(data); }
  resolveOwner(metadata, defaultOwnerId) {
    const requested = metadata?.ownerUserId;
    if (requested && this.db.prepare('SELECT 1 FROM users WHERE id=?').get(requested)) return requested;
    return defaultOwnerId || null;
  }
  writeCollections(data, defaultOwnerId = null) {
    for (const [, repository] of COLLECTIONS) this.repositories[repository].clear();
    this.onStep('after-clear');
    for (const [key, repository] of COLLECTIONS) for (const input of data[key] || []) {
      const row = clone(input), metadata = row._server || {};
      delete row._server;
      const saved = this.repositories[repository].put(row, 0);
      const values = {};
      if (['customers', 'orders', 'packingLists'].includes(key)) values.owner_user_id = this.resolveOwner(metadata, defaultOwnerId);
      if (key === 'orders') values.customer_id = row.customerId || null;
      if (key === 'packingLists') values.order_id = row.orderId || null;
      if (['customers', 'products'].includes(key)) values.lifecycle_state = metadata.lifecycleState === 'ARCHIVED' ? 'ARCHIVED' : 'ACTIVE';
      if (key === 'orders') values.lifecycle_state = metadata.lifecycleState === 'VOID' ? 'VOID' : 'ACTIVE';
      this.repositories[repository].setMetadata(saved.payload.id, values);
    }
    this.onStep('after-write');
  }
  replaceInsideTransaction(data, createRestorePoint = true, defaultOwnerId = null) {
    validateBusinessBackup(data);
    if (createRestorePoint) {
      const createdAt = new Date().toISOString();
      this.repositories.restorePoints.put({ id: 'latest', createdAt, data: this.exportInsideTransaction(createdAt) });
      this.onStep('after-restore-point');
    }
    this.writeCollections(data, defaultOwnerId);
    this.sequenceService?.syncFromBusiness();
    return inspectBackup(data);
  }
  replaceAllBusinessData(data, createRestorePoint = true, defaultOwnerId = null) { return this.replaceTransaction(clone(data), createRestorePoint, defaultOwnerId); }
  restoreInsideTransaction(defaultOwnerId = null) {
    const point = this.repositories.restorePoints.get('latest');
    if (!point) throw new ValidationError('No restore point is available');
    validateBusinessBackup(point.payload.data);
    this.onStep('before-restore-write');
    this.writeCollections(point.payload.data, defaultOwnerId);
    this.sequenceService?.syncFromBusiness();
    return clone(point.payload);
  }
  restoreLatestBusinessData(defaultOwnerId = null) { return this.restoreTransaction(defaultOwnerId); }
  clearInsideTransaction(createRestorePoint = true) {
    if (createRestorePoint) {
      const createdAt = new Date().toISOString();
      this.repositories.restorePoints.put({ id: 'latest', createdAt, data: this.exportInsideTransaction(createdAt) });
      this.onStep('after-clear-restore-point');
    }
    for (const [, repository] of COLLECTIONS) this.repositories[repository].clear();
    this.sequenceService?.clear();
    this.onStep('after-business-clear');
    return true;
  }
  clearAllBusinessData(createRestorePoint = true) { return this.clearTransaction(createRestorePoint); }
}
module.exports = { COLLECTIONS, BusinessBackupService, validateBusinessBackup, inspectBackup };
