'use strict';
const session = require('express-session');
const { createHash } = require('node:crypto');

// express-session Store contract, persisted in the auth DB (not MemoryStore).
// Only a digest of the opaque session ID is kept on disk.
class SQLiteSessionStore extends session.Store {
  constructor(db, config) {
    super(); this.db = db; this.config = config;
    this.timer = setInterval(() => {
      try { this.prune(); } catch { this.emit('disconnect'); }
    }, 60000);
    this.timer.unref();
    this.prune();
  }
  key(sid) { return createHash('sha256').update(sid).digest('hex'); }
  prune() { this.db.prepare('DELETE FROM sessions WHERE expires_at <= ? OR absolute_expires_at <= ?').run(Date.now(), Date.now()); }
  get(sid, callback) {
    try {
      const row = this.db.prepare('SELECT * FROM sessions WHERE sid = ?').get(this.key(sid));
      if (!row) return callback(null, null);
      if (row.expires_at <= Date.now() || row.absolute_expires_at <= Date.now()) return this.destroy(sid, err => callback(err, null));
      callback(null, JSON.parse(row.payload));
    } catch (err) { callback(err); }
  }
  set(sid, value, callback = () => {}) {
    try {
      const absolute = Number(value.startedAt) + this.config.absoluteMs;
      if (!Number.isFinite(absolute) || absolute <= Date.now()) return this.destroy(sid, callback);
      const expiry = Math.min(Date.now() + this.config.idleMs, absolute);
      this.db.prepare(`INSERT INTO sessions (sid, payload, expires_at, absolute_expires_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(sid) DO UPDATE SET payload=excluded.payload, expires_at=excluded.expires_at,
        absolute_expires_at=excluded.absolute_expires_at`).run(this.key(sid), JSON.stringify(value), expiry, absolute);
      callback(null);
    } catch (err) { callback(err); }
  }
  touch(sid, value, callback = () => {}) {
    try {
      // Touch cannot resurrect an expired/deleted session or move the absolute deadline.
      this.db.prepare(`UPDATE sessions SET expires_at = MIN(?, absolute_expires_at)
        WHERE sid = ? AND expires_at > ? AND absolute_expires_at > ?`)
        .run(Date.now() + this.config.idleMs, this.key(sid), Date.now(), Date.now());
      callback(null);
    } catch (err) { callback(err); }
  }
  destroy(sid, callback = () => {}) {
    try { this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(this.key(sid)); callback(null); }
    catch (err) { callback(err); }
  }
  close() { clearInterval(this.timer); }
}
module.exports = { SQLiteSessionStore };
