'use strict';

// Explicit versioned DDL. Migrations create schema only: no Demo seed, import,
// payload normalization, or application-startup rewrite is allowed here.
function migrateDatabase(db) {
  db.transaction(() => {
    db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
    const latest = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version || 0;
    if (latest > 4) throw new Error('Unsupported server schema version');
    if (latest === 0) {
      db.exec(`
        CREATE TABLE users (
          id TEXT PRIMARY KEY,
          username TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE sessions (
          sid TEXT PRIMARY KEY,
          payload TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          absolute_expires_at INTEGER NOT NULL
        );
        CREATE INDEX sessions_expiry ON sessions(expires_at);
      `);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (1, ?)').run(Date.now());
    }
    if (latest < 2) {
      for (const table of ['company', 'customers', 'products', 'orders', 'packing_lists', 'meta', 'restore_points']) {
        db.exec(`CREATE TABLE ${table} (
          id TEXT PRIMARY KEY,
          payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
          row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
          updated_at INTEGER NOT NULL
        )`);
      }
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (2, ?)').run(Date.now());
    }
    if (latest < 3) {
      db.exec(`CREATE TABLE document_sequences (
        kind TEXT NOT NULL,
        period TEXT NOT NULL,
        next_value INTEGER NOT NULL CHECK (next_value >= 1),
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (kind, period)
      )`);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (3, ?)').run(Date.now());
    }
    if (latest < 4) {
      const userCount = db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
      if (userCount > 1) throw new Error('Multi-user migration requires at most one legacy administrator');
      db.exec(`
        ALTER TABLE users ADD COLUMN email TEXT;
        ALTER TABLE users ADD COLUMN display_name TEXT NOT NULL DEFAULT '';
        ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'EMPLOYEE' CHECK (role IN ('ADMIN', 'EMPLOYEE'));
        ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED'));
        ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0, 1));
        ALTER TABLE users ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 1 CHECK (auth_version >= 1);
        ALTER TABLE users ADD COLUMN updated_at INTEGER;
        ALTER TABLE users ADD COLUMN last_login_at INTEGER;

        CREATE UNIQUE INDEX users_username_ci_unique ON users(lower(username));
        CREATE UNIQUE INDEX users_email_unique ON users(lower(email)) WHERE email IS NOT NULL;
        CREATE UNIQUE INDEX users_single_admin ON users((1)) WHERE role = 'ADMIN';
        CREATE TABLE user_login_identifiers (
          identifier TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id),
          kind TEXT NOT NULL CHECK (kind IN ('USERNAME', 'EMAIL')),
          UNIQUE(user_id, kind)
        );
        CREATE INDEX user_login_identifiers_user ON user_login_identifiers(user_id);

        CREATE TABLE audit_logs (
          id TEXT PRIMARY KEY,
          user_id TEXT,
          username_snapshot TEXT NOT NULL,
          action TEXT NOT NULL,
          entity_type TEXT NOT NULL,
          entity_id TEXT,
          created_at INTEGER NOT NULL,
          ip_address TEXT NOT NULL DEFAULT '',
          result TEXT NOT NULL CHECK (result IN ('SUCCESS', 'FAILURE')),
          metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json))
        );
        CREATE INDEX audit_logs_user_created ON audit_logs(user_id, created_at DESC);
        CREATE INDEX audit_logs_created ON audit_logs(created_at DESC);
        CREATE TRIGGER audit_logs_no_update BEFORE UPDATE ON audit_logs
          BEGIN SELECT RAISE(ABORT, 'audit logs are immutable'); END;
        CREATE TRIGGER audit_logs_no_delete BEFORE DELETE ON audit_logs
          BEGIN SELECT RAISE(ABORT, 'audit logs are immutable'); END;

        ALTER TABLE customers ADD COLUMN owner_user_id TEXT REFERENCES users(id);
        ALTER TABLE customers ADD COLUMN lifecycle_state TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (lifecycle_state IN ('ACTIVE', 'ARCHIVED'));
        ALTER TABLE products ADD COLUMN lifecycle_state TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (lifecycle_state IN ('ACTIVE', 'ARCHIVED'));
        ALTER TABLE orders ADD COLUMN owner_user_id TEXT REFERENCES users(id);
        ALTER TABLE orders ADD COLUMN customer_id TEXT;
        ALTER TABLE orders ADD COLUMN lifecycle_state TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (lifecycle_state IN ('ACTIVE', 'VOID'));
        ALTER TABLE packing_lists ADD COLUMN owner_user_id TEXT REFERENCES users(id);
        ALTER TABLE packing_lists ADD COLUMN order_id TEXT;
        CREATE INDEX customers_owner_state ON customers(owner_user_id, lifecycle_state);
        CREATE INDEX orders_owner_state ON orders(owner_user_id, lifecycle_state);
        CREATE INDEX orders_customer ON orders(customer_id);
        CREATE INDEX packing_lists_owner ON packing_lists(owner_user_id);
        CREATE INDEX packing_lists_order ON packing_lists(order_id);
        CREATE INDEX products_lifecycle ON products(lifecycle_state);
      `);
      const now = Date.now();
      const legacy = db.prepare('SELECT id, username FROM users').get();
      if (legacy) {
        db.prepare(`UPDATE users SET role='ADMIN', status='ACTIVE', display_name=?, updated_at=? WHERE id=?`)
          .run(legacy.username, now, legacy.id);
        db.prepare('INSERT INTO user_login_identifiers (identifier, user_id, kind) VALUES (?, ?, ?)')
          .run(legacy.username, legacy.id, 'USERNAME');
        db.prepare('UPDATE customers SET owner_user_id=?').run(legacy.id);
        db.prepare(`UPDATE orders SET owner_user_id=?, customer_id=json_extract(payload_json, '$.customerId')`).run(legacy.id);
        db.prepare(`UPDATE packing_lists SET owner_user_id=?, order_id=COALESCE(json_extract(payload_json, '$.orderId'), '')`).run(legacy.id);
      } else {
        db.prepare(`UPDATE orders SET customer_id=json_extract(payload_json, '$.customerId')`).run();
        db.prepare(`UPDATE packing_lists SET order_id=COALESCE(json_extract(payload_json, '$.orderId'), '')`).run();
      }
      db.exec(`
        CREATE TRIGGER users_role_immutable BEFORE UPDATE OF role ON users
          WHEN OLD.role <> NEW.role BEGIN SELECT RAISE(ABORT, 'user role is immutable'); END;
        CREATE TRIGGER users_no_delete BEFORE DELETE ON users
          BEGIN SELECT RAISE(ABORT, 'users cannot be deleted'); END;
      `);
      // Multi-user authorization is a security boundary change. Existing sessions intentionally expire.
      db.prepare('DELETE FROM sessions').run();
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (4, ?)').run(now);
    }
  })();
}
module.exports = { migrateDatabase, migrateAuthDatabase: migrateDatabase };
