'use strict';
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { migrateDatabase } = require('./migrations');

function openDatabase(filename) {
  if (filename !== ':memory:')
    fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true, mode: 0o700 });
  const db = new Database(filename);
  try {
    if (filename !== ':memory:') fs.chmodSync(filename, 0o600);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    migrateDatabase(db);
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}
module.exports = { openDatabase };
