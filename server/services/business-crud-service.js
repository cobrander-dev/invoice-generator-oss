'use strict';
const { ValidationError, NotFoundError, ConflictError } = require('../db/errors');
const { isAdmin, requireOwned } = require('../auth/authorization');

const SYSTEM_ACTOR = Object.freeze({ id: null, role: 'ADMIN', status: 'ACTIVE', username: 'system' });

function requireExpectedVersion(value) {
  const version = Number(value);
  if (!Number.isInteger(version) || version < 0) throw new ValidationError('A valid expected record version is required');
  return version;
}

function requireRecord(record, expectedId) {
  if (!record || typeof record !== 'object' || Array.isArray(record) || typeof record.id !== 'string' || !record.id.trim()) {
    throw new ValidationError('A valid business record is required');
  }
  if (expectedId !== undefined && record.id !== expectedId) throw new ValidationError('Record id does not match request path');
  return record;
}

class BusinessCrudService {
  constructor(db, repositories, orderOperationService = null) {
    this.db = db;
    this.repositories = repositories;
    this.orderOperationService = orderOperationService;
    this.bulkProductsTransaction = db.transaction(items => items.map(item => {
      requireRecord(item?.data);
      return repositories.products.put(item.data, requireExpectedVersion(item.expectedVersion));
    }));
    this.createTransaction = db.transaction((repository, record, actor, ownerUserId) => this.createInside(repository, record, actor, ownerUserId));
  }

  actor(actor) { return actor || SYSTEM_ACTOR; }
  owned(repository) { return ['customers', 'orders', 'packingLists'].includes(repository); }
  get(repository, id, actor) {
    const row = this.repositories[repository].get(id);
    return this.owned(repository) ? requireOwned(row, this.actor(actor)) : row;
  }
  requireActive(repository, id, actor) {
    const row = this.get(repository, id, actor);
    if (row?.lifecycle_state && row.lifecycle_state !== 'ACTIVE') throw new ConflictError('Archived or void records are read-only');
    return row;
  }
  list(repository, actor, { includeInactive = false } = {}) {
    actor = this.actor(actor);
    const owner = this.owned(repository) && !isAdmin(actor) ? actor.id : undefined;
    return this.repositories[repository].listVisible(owner, { includeInactive });
  }
  createInside(repository, record, actor, ownerUserId) {
    actor = this.actor(actor); requireRecord(record);
    if (repository === 'customers') {
      const row = this.repositories.customers.put(record, 0);
      return this.repositories.customers.setMetadata(row.payload.id, { owner_user_id: ownerUserId === undefined ? (actor.id || null) : ownerUserId, lifecycle_state: 'ACTIVE' });
    }
    if (repository === 'orders') {
      const customer = requireOwned(this.repositories.customers.get(record.customerId), actor);
      const row = this.orderOperationService.createOrder(record);
      return this.repositories.orders.setMetadata(row.payload.id, { owner_user_id: customer.owner_user_id, customer_id: customer.payload.id, lifecycle_state: 'ACTIVE' });
    }
    const row = this.repositories[repository].put(record, 0);
    return repository === 'products' ? this.repositories.products.setMetadata(row.payload.id, { lifecycle_state: 'ACTIVE' }) : row;
  }
  create(repository, record, actor, ownerUserId) { return this.createTransaction(repository, record, actor, ownerUserId); }
  update(repository, id, record, expectedVersion, actor) {
    actor = this.actor(actor); requireRecord(record, id);
    const current = this.requireActive(repository, id, actor);
    const version = requireExpectedVersion(expectedVersion);
    if (!current) {
      if (!this.owned(repository) && version === 0) return this.repositories[repository].put(record, 0);
      throw new NotFoundError('Record not found');
    }
    if (current.rowVersion !== version) throw new ConflictError();
    if (repository === 'orders' && this.orderOperationService) {
      const customer = requireOwned(this.repositories.customers.get(record.customerId), actor);
      if (customer.owner_user_id !== current.owner_user_id) throw new ValidationError('Order owner must match customer owner');
      const row = this.orderOperationService.updateOrder(id, record, version);
      return this.repositories.orders.setMetadata(row.payload.id, { customer_id: customer.payload.id });
    }
    return this.repositories[repository].put(record, version);
  }
  archive(repository, id, expectedVersion, actor) {
    const row = this.requireActive(repository, id, actor), version = requireExpectedVersion(expectedVersion);
    if (row.rowVersion !== version) throw new ConflictError();
    const state = repository === 'orders' ? 'VOID' : 'ARCHIVED';
    return this.repositories[repository].setMetadata(id, { lifecycle_state: state }, { incrementVersion: true });
  }
  remove(repository, id, expectedVersion, actor) { return this.archive(repository, id, expectedVersion, actor); }
  removeOrder(id, expectedVersion, actor) { return this.archive('orders', id, expectedVersion, actor); }
  bulkPutProducts(items) {
    if (!Array.isArray(items) || !items.length) throw new ValidationError('Product import requires at least one record');
    return this.bulkProductsTransaction(items);
  }
}

module.exports = { BusinessCrudService, requireExpectedVersion, requireRecord, SYSTEM_ACTOR };
