'use strict';
const { randomUUID } = require('node:crypto');

const SENSITIVE_KEY = /password|secret|cookie|token|session|authorization|hash/i;
function safeMetadata(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) continue;
    if (typeof item === 'string') result[key] = item.slice(0, 256);
    else if (typeof item === 'number' || typeof item === 'boolean' || item === null)
      result[key] = item;
  }
  return result;
}

class AuditService {
  constructor(db) {
    this.db = db;
    this.insert = db.prepare(`INSERT INTO audit_logs
      (id, user_id, username_snapshot, action, entity_type, entity_id, created_at, ip_address, result, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  }
  write({
    actor = null,
    username = '',
    action,
    entityType,
    entityId = null,
    ipAddress = '',
    result = 'SUCCESS',
    metadata = {},
  }) {
    this.insert.run(
      randomUUID(),
      actor?.id || null,
      actor?.username || String(username || '').slice(0, 128),
      action,
      entityType,
      entityId == null ? null : String(entityId),
      Date.now(),
      String(ipAddress || '').slice(0, 128),
      result,
      JSON.stringify(safeMetadata(metadata)),
    );
  }
  perform(entry, operation) {
    return this.performMany([entry], operation);
  }
  performMany(entries, operation) {
    return this.db.transaction(() => {
      const value = operation();
      for (const entry of entries) this.write({ ...entry, result: 'SUCCESS' });
      return value;
    })();
  }
  list(actor, { limit = 200 } = {}) {
    const count = Math.min(500, Math.max(1, Number(limit) || 200));
    const rows =
      actor.role === 'ADMIN'
        ? this.db.prepare('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT ?').all(count)
        : this.db
            .prepare('SELECT * FROM audit_logs WHERE user_id=? ORDER BY created_at DESC LIMIT ?')
            .all(actor.id, count);
    return rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      username: row.username_snapshot,
      action: row.action,
      entityType: row.entity_type,
      entityId: row.entity_id,
      createdAt: row.created_at,
      ipAddress: row.ip_address,
      result: row.result,
      metadata: JSON.parse(row.metadata_json),
    }));
  }
}

module.exports = { AuditService, safeMetadata, SENSITIVE_KEY };
