'use strict';
const path = require('node:path');
const { openDatabase } = require('../db/database');

function main() {
  process.umask(0o077);
  const filename = path.resolve(
    process.env.DATABASE_PATH || process.env.AUTH_DB_PATH || './data/foreign-trade.sqlite',
  );
  const db = openDatabase(filename);
  try {
    const count = db.prepare("SELECT COUNT(*) AS count FROM users WHERE role='ADMIN'").get().count;
    if (!count) process.exitCode = 3;
  } finally {
    db.close();
  }
}

if (require.main === module) {
  try {
    main();
  } catch {
    console.error('Administrator status check failed.');
    process.exitCode = 1;
  }
}
module.exports = { main };
