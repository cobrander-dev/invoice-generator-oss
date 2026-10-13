'use strict';
const { ConflictError, ValidationError } = require('../db/errors');

const TABLES = Object.freeze({
  company: 'company',
  customers: 'customers',
  products: 'products',
  orders: 'orders',
  packingLists: 'packing_lists',
  meta: 'meta',
  restorePoints: 'restore_points',
});
const METADATA = Object.freeze({
  customers: ['owner_user_id', 'lifecycle_state'],
  products: ['lifecycle_state'],
  orders: ['owner_user_id', 'customer_id', 'lifecycle_state'],
  packing_lists: ['owner_user_id', 'order_id'],
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
function recordId(record) {
  if (
    !record ||
    typeof record !== 'object' ||
    Array.isArray(record) ||
    typeof record.id !== 'string' ||
    !record.id.trim()
  ) {
    throw new ValidationError('Business record requires a non-empty string id');
  }
  return record.id;
}

class BusinessRepository {
  constructor(db, table) {
    if (!Object.values(TABLES).includes(table))
      throw new Error('Unsupported internal business table');
    this.db = db;
    this.table = table;
    this.metadata = METADATA[table] || [];
    const metadataColumns = this.metadata.length ? `, ${this.metadata.join(', ')}` : '';
    this.select = db.prepare(
      `SELECT payload_json, row_version, updated_at${metadataColumns} FROM ${table} WHERE id = ?`,
    );
    // IndexedDB getAll() is key-ordered; id ordering keeps backup arrays compatible.
    this.selectAll = db.prepare(
      `SELECT payload_json, row_version, updated_at${metadataColumns} FROM ${table} ORDER BY id`,
    );
    this.insert = db.prepare(
      `INSERT INTO ${table} (id, payload_json, row_version, updated_at) VALUES (?, ?, 1, ?)`,
    );
    this.update = db.prepare(
      `UPDATE ${table} SET payload_json=?, row_version=row_version+1, updated_at=? WHERE id=? AND row_version=?`,
    );
    this.updateAny = db.prepare(
      `UPDATE ${table} SET payload_json=?, row_version=row_version+1, updated_at=? WHERE id=?`,
    );
    this.deleteVersion = db.prepare(`DELETE FROM ${table} WHERE id=? AND row_version=?`);
    this.deleteAny = db.prepare(`DELETE FROM ${table} WHERE id=?`);
    this.clearStatement = db.prepare(`DELETE FROM ${table}`);
  }
  decode(row) {
    if (!row) return null;
    const result = {
      payload: JSON.parse(row.payload_json),
      rowVersion: row.row_version,
      updatedAt: row.updated_at,
    };
    for (const column of this.metadata) result[column] = row[column];
    return result;
  }
  get(id) {
    return this.decode(this.select.get(String(id)));
  }
  list() {
    return this.selectAll.all().map((row) => this.decode(row));
  }
  put(record, expectedVersion) {
    const id = recordId(record),
      json = JSON.stringify(record),
      now = Date.now(),
      current = this.select.get(id);
    if (!current) {
      if (expectedVersion !== undefined && expectedVersion !== 0) throw new ConflictError();
      this.insert.run(id, json, now);
      return this.get(id);
    }
    if (expectedVersion !== undefined) {
      if (
        !Number.isInteger(expectedVersion) ||
        expectedVersion < 1 ||
        this.update.run(json, now, id, expectedVersion).changes !== 1
      )
        throw new ConflictError();
    } else this.updateAny.run(json, now, id);
    return this.get(id);
  }
  delete(id, expectedVersion) {
    const result =
      expectedVersion === undefined
        ? this.deleteAny.run(String(id))
        : this.deleteVersion.run(String(id), expectedVersion);
    if (expectedVersion !== undefined && result.changes !== 1) throw new ConflictError();
    return result.changes === 1;
  }
  clear() {
    this.clearStatement.run();
  }
  setMetadata(id, values, { incrementVersion = false } = {}) {
    const entries = Object.entries(values).filter(([key]) => this.metadata.includes(key));
    if (!entries.length) return this.get(id);
    const assignments = entries.map(([key]) => `${key}=?`).join(', ');
    const version = incrementVersion ? ', row_version=row_version+1, updated_at=?' : '';
    const args = entries.map(([, value]) => value);
    if (incrementVersion) args.push(Date.now());
    args.push(String(id));
    this.db.prepare(`UPDATE ${this.table} SET ${assignments}${version} WHERE id=?`).run(...args);
    return this.get(id);
  }
  listVisible(ownerUserId, { includeInactive = false } = {}) {
    const ownerClause =
      ownerUserId === undefined || !this.metadata.includes('owner_user_id')
        ? ''
        : ' AND owner_user_id=?';
    const lifecycleClause =
      includeInactive || !this.metadata.includes('lifecycle_state')
        ? ''
        : " AND lifecycle_state='ACTIVE'";
    const metadataColumns = this.metadata.length ? `, ${this.metadata.join(', ')}` : '';
    const rows = this.db
      .prepare(
        `SELECT payload_json, row_version, updated_at${metadataColumns} FROM ${this.table} WHERE 1=1${ownerClause}${lifecycleClause} ORDER BY id`,
      )
      .all(...(ownerClause ? [ownerUserId] : []));
    return rows.map((row) => this.decode(row));
  }
}

function createBusinessRepositories(db) {
  return Object.fromEntries(
    Object.entries(TABLES).map(([name, table]) => [name, new BusinessRepository(db, table)]),
  );
}
module.exports = {
  TABLES,
  METADATA,
  BusinessRepository,
  createBusinessRepositories,
  clone,
  recordId,
};
