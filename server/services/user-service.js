'use strict';
const { randomUUID } = require('node:crypto');
const { hashPassword, verifyPassword } = require('../auth/password');
const { requireValidPassword } = require('../auth/password-policy');
const { normalizeUsername, publicUser } = require('../auth/auth-service');
const { ValidationError, ConflictError, NotFoundError } = require('../db/errors');

function normalizeEmail(value) {
  const email = normalizeUsername(value);
  if (!email) return null;
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ValidationError('Email is invalid');
  return email;
}
function validateUsername(value) {
  const username = normalizeUsername(value);
  if (!/^[a-z0-9][a-z0-9._+-]{2,127}$/.test(username)) throw new ValidationError('Username must be 3-128 ASCII characters');
  return username;
}

class UserService {
  constructor(db, { passwordMinLength, auditService = null }) { this.db = db; this.passwordMinLength = passwordMinLength; this.audit = auditService; }
  listEmployees() { return this.db.prepare("SELECT * FROM users WHERE role='EMPLOYEE' ORDER BY created_at").all().map(publicUser); }
  get(id) { return publicUser(this.db.prepare('SELECT * FROM users WHERE id=?').get(id)); }
  requireEmployee(id) {
    const row = this.db.prepare("SELECT * FROM users WHERE id=? AND role='EMPLOYEE'").get(id);
    if (!row) throw new NotFoundError('Employee not found');
    return row;
  }
  assertIdentifiersAvailable(username, email, exceptId = null) {
    for (const identifier of [username, email].filter(Boolean)) {
      const found = this.db.prepare('SELECT user_id FROM user_login_identifiers WHERE identifier=?').get(identifier);
      if (found && found.user_id !== exceptId) throw new ConflictError('Username or email is already in use');
    }
  }
  replaceIdentifiers(id, username, email) {
    this.db.prepare('DELETE FROM user_login_identifiers WHERE user_id=?').run(id);
    this.db.prepare('INSERT INTO user_login_identifiers(identifier,user_id,kind) VALUES(?,?,?)').run(username, id, 'USERNAME');
    if (email) this.db.prepare('INSERT INTO user_login_identifiers(identifier,user_id,kind) VALUES(?,?,?)').run(email, id, 'EMAIL');
  }
  async createEmployee(input, auditEntry = null) {
    const username = validateUsername(input?.username), email = normalizeEmail(input?.email), displayName = String(input?.displayName || '').trim();
    if (!displayName || displayName.length > 128) throw new ValidationError('Display name is required');
    try { requireValidPassword(input?.temporaryPassword, this.passwordMinLength); } catch (err) { throw new ValidationError(err.message); }
    const hash = await hashPassword(input.temporaryPassword), id = randomUUID(), now = Date.now();
    return this.db.transaction(() => {
      this.assertIdentifiersAvailable(username, email);
      this.db.prepare(`INSERT INTO users
        (id,username,email,display_name,password_hash,role,status,must_change_password,auth_version,created_at,updated_at)
        VALUES(?,?,?,?,?,'EMPLOYEE','ACTIVE',1,1,?,?)`).run(id, username, email, displayName, hash, now, now);
      this.replaceIdentifiers(id, username, email);
      if (auditEntry) this.audit.write({ ...auditEntry, entityId: id });
      return this.get(id);
    })();
  }
  updateEmployee(id, input, auditEntry = null) {
    const current = this.requireEmployee(id), username = validateUsername(input?.username), email = normalizeEmail(input?.email);
    const displayName = String(input?.displayName || '').trim();
    if (!displayName || displayName.length > 128) throw new ValidationError('Display name is required');
    return this.db.transaction(() => {
      this.assertIdentifiersAvailable(username, email, id);
      this.db.prepare('UPDATE users SET username=?,email=?,display_name=?,updated_at=? WHERE id=? AND role=\'EMPLOYEE\'')
        .run(username, email, displayName, Date.now(), id);
      this.replaceIdentifiers(id, username, email);
      if (auditEntry) this.audit.write({ ...auditEntry, entityId: id });
      return this.get(current.id);
    })();
  }
  setStatus(id, status, auditEntry = null) {
    const current = this.requireEmployee(id);
    if (!['ACTIVE', 'DISABLED'].includes(status)) throw new ValidationError('Invalid employee status');
    const increment = current.status !== status && status === 'DISABLED' ? 1 : 0;
    return this.db.transaction(() => {
      this.db.prepare('UPDATE users SET status=?,auth_version=auth_version+?,updated_at=? WHERE id=?').run(status, increment, Date.now(), id);
      if (status === 'DISABLED') this.deleteSessions(id);
      if (auditEntry) this.audit.write({ ...auditEntry, entityId: id });
      return this.get(id);
    })();
  }
  async resetEmployeePassword(id, temporaryPassword, auditEntry = null) {
    this.requireEmployee(id);
    try { requireValidPassword(temporaryPassword, this.passwordMinLength); } catch (err) { throw new ValidationError(err.message); }
    const hash = await hashPassword(temporaryPassword);
    return this.db.transaction(() => {
      this.db.prepare('UPDATE users SET password_hash=?,must_change_password=1,auth_version=auth_version+1,updated_at=? WHERE id=?')
        .run(hash, Date.now(), id);
      this.deleteSessions(id);
      if (auditEntry) this.audit.write({ ...auditEntry, entityId: id });
      return this.get(id);
    })();
  }
  async changePassword(id, currentPassword, newPassword, auditEntry = null) {
    const row = this.db.prepare('SELECT * FROM users WHERE id=?').get(id);
    if (!row || !await verifyPassword(row.password_hash, currentPassword)) throw new ValidationError('Current password is incorrect');
    try { requireValidPassword(newPassword, this.passwordMinLength); } catch (err) { throw new ValidationError(err.message); }
    if (await verifyPassword(row.password_hash, newPassword)) throw new ValidationError('New password must be different');
    const hash = await hashPassword(newPassword);
    return this.db.transaction(() => {
      this.db.prepare('UPDATE users SET password_hash=?,must_change_password=0,auth_version=auth_version+1,updated_at=? WHERE id=?')
        .run(hash, Date.now(), id);
      this.deleteSessions(id);
      if (auditEntry) this.audit.write({ ...auditEntry, entityId: id });
      return this.get(id);
    })();
  }
  deleteSessions(userId) {
    this.db.prepare("DELETE FROM sessions WHERE json_extract(payload, '$.userId')=?").run(userId);
  }
}

module.exports = { UserService, normalizeEmail, validateUsername };
