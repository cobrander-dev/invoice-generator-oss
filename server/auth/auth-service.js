'use strict';
const { randomUUID, randomBytes } = require('node:crypto');
const { hashPassword, verifyPassword } = require('./password');
const { requireValidPassword, passwordMinimum } = require('./password-policy');

function normalizeUsername(value) { return typeof value === 'string' ? value.trim().toLowerCase() : ''; }
function publicUser(row) {
  return row ? { id: row.id, username: row.username, email: row.email || '', displayName: row.display_name || row.username,
    role: row.role, status: row.status, mustChangePassword: Boolean(row.must_change_password),
    authVersion: row.auth_version, createdAt: row.created_at, updatedAt: row.updated_at, lastLoginAt: row.last_login_at } : null;
}
async function initializeAdmin(db, username, password, minimum = passwordMinimum()) {
  username = normalizeUsername(username);
  if (!/^[a-z0-9][a-z0-9@._+-]{2,127}$/.test(username)) throw new Error('ADMIN_USERNAME must be 3-128 ASCII username/email characters');
  requireValidPassword(password, minimum);
  if (db.prepare('SELECT COUNT(*) AS count FROM users').get().count) throw new Error('Administrator already exists; initialization refused');
  const hash = await hashPassword(password);
  return db.transaction(() => {
    if (db.prepare('SELECT COUNT(*) AS count FROM users').get().count) throw new Error('Administrator already exists; initialization refused');
    const id = randomUUID(), now = Date.now();
    db.prepare(`INSERT INTO users
      (id, username, password_hash, created_at, display_name, role, status, must_change_password, auth_version, updated_at)
      VALUES (?, ?, ?, ?, ?, 'ADMIN', 'ACTIVE', 0, 1, ?)`)
      .run(id, username, hash, now, username, now);
    db.prepare('INSERT INTO user_login_identifiers (identifier, user_id, kind) VALUES (?, ?, ?)').run(username, id, 'USERNAME');
    return publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(id));
  })();
}
async function createAuthService(db) {
  // Unknown users still perform an Argon2 verification to reduce timing enumeration.
  const dummyHash = await hashPassword(randomBytes(32).toString('hex'));
  return {
    async authenticate(username, password) {
      const identifier = normalizeUsername(username);
      const validInput = identifier.length <= 128 && typeof password === 'string' && password.length <= 1024;
      const row = validInput ? db.prepare(`SELECT users.* FROM user_login_identifiers
        JOIN users ON users.id=user_login_identifiers.user_id WHERE user_login_identifiers.identifier=?`).get(identifier) : null;
      const ok = await verifyPassword(row?.password_hash || dummyHash, validInput ? password : 'invalid-input');
      return row && ok && row.status === 'ACTIVE' ? publicUser(row) : null;
    },
    getUser(id) { return publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id)); },
    markLogin(id) {
      const now = Date.now();
      db.prepare('UPDATE users SET last_login_at=?, updated_at=? WHERE id=?').run(now, now, id);
      return this.getUser(id);
    },
    async verifyUserPassword(id, password) {
      const row = db.prepare('SELECT password_hash FROM users WHERE id=?').get(id);
      return Boolean(row) && verifyPassword(row.password_hash, password);
    }
  };
}
module.exports = { normalizeUsername, publicUser, initializeAdmin, createAuthService };
