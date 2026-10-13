'use strict';
// Verifies a SQLite backup without modifying it: works on a private temporary copy, runs
// PRAGMA integrity_check and reports the schema version and record counts as JSON.
// Exit codes: 0 valid, 1 unreadable or corrupt, 2 schema newer than this application.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { LATEST_SCHEMA_VERSION } = require('../db/migrations');

const COUNTED_TABLES = ['users', 'customers', 'products', 'orders', 'packing_lists'];

function verify(source) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-'));
  const copy = path.join(directory, 'database.sqlite');
  try {
    fs.copyFileSync(source, copy);
    const db = new Database(copy, { fileMustExist: true });
    try {
      const integrity = db.pragma('integrity_check', { simple: true });
      const tables = new Set(
        db
          .prepare("SELECT name FROM sqlite_master WHERE type='table'")
          .all()
          .map((row) => row.name),
      );
      const schemaVersion = tables.has('schema_migrations')
        ? db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version || 0
        : 0;
      const counts = {};
      for (const table of COUNTED_TABLES)
        if (tables.has(table))
          counts[table] = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
      return { integrity, schemaVersion, supportedSchemaVersion: LATEST_SCHEMA_VERSION, counts };
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

if (require.main === module) {
  try {
    const result = verify(path.resolve(process.argv[2] || ''));
    console.log(JSON.stringify(result));
    if (result.integrity !== 'ok' || result.schemaVersion < 1) process.exitCode = 1;
    else if (result.schemaVersion > LATEST_SCHEMA_VERSION) process.exitCode = 2;
  } catch {
    console.error('Database verification failed: the file is missing, unreadable or not SQLite.');
    process.exitCode = 1;
  }
}
module.exports = { verify };
