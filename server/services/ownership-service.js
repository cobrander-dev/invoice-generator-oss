'use strict';
const { NotFoundError, ValidationError } = require('../db/errors');

function duplicateKey(record = {}) {
  return String(record.companyName || record.buyerName || '').trim().toLowerCase().replace(/[^a-z0-9\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ');
}

class OwnershipService {
  constructor(db, repositories) { this.db = db; this.repositories = repositories; }
  possibleCustomerDuplicate(record, excludeId = null) {
    const key = duplicateKey(record);
    if (!key) return false;
    return this.repositories.customers.list().some(row => row.payload.id !== excludeId && duplicateKey(row.payload) === key);
  }
  validateTarget(ownerUserId) {
    if (ownerUserId === null || ownerUserId === '') return null;
    const user = this.db.prepare("SELECT id FROM users WHERE id=? AND role IN ('ADMIN','EMPLOYEE') AND status='ACTIVE'").get(ownerUserId);
    if (!user) throw new ValidationError('Ownership target is invalid');
    return user.id;
  }
  transferCustomer(customerId, ownerUserId, expectedOwnerUserId) {
    const customer = this.repositories.customers.get(customerId);
    if (!customer) throw new NotFoundError('Customer not found');
    if (expectedOwnerUserId && customer.owner_user_id !== expectedOwnerUserId) throw new NotFoundError('Customer not found');
    const target = this.validateTarget(ownerUserId), orderRows = this.db.prepare('SELECT id FROM orders WHERE customer_id=?').all(customerId);
    const orderIds = orderRows.map(row => row.id);
    this.repositories.customers.setMetadata(customerId, { owner_user_id: target }, { incrementVersion: true });
    for (const { id } of orderRows) this.repositories.orders.setMetadata(id, { owner_user_id: target }, { incrementVersion: true });
    for (const id of orderIds) {
      for (const row of this.db.prepare('SELECT id FROM packing_lists WHERE order_id=?').all(id)) {
        this.repositories.packingLists.setMetadata(row.id, { owner_user_id: target }, { incrementVersion: true });
      }
    }
    return { customerId, ownerUserId: target, ordersTransferred: orderIds.length };
  }
  employeeSummary(userId) {
    return {
      customers: this.db.prepare('SELECT COUNT(*) count FROM customers WHERE owner_user_id=?').get(userId).count,
      orders: this.db.prepare('SELECT COUNT(*) count FROM orders WHERE owner_user_id=?').get(userId).count,
      packingLists: this.db.prepare('SELECT COUNT(*) count FROM packing_lists WHERE owner_user_id=?').get(userId).count
    };
  }
}

module.exports = { OwnershipService, duplicateKey };
