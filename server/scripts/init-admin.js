'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { openDatabase } = require('../db/database');
const { initializeAdmin } = require('../auth/auth-service');

async function main() {
  process.umask(0o077);
  const password =
    process.env.ADMIN_PASSWORD_STDIN === '1'
      ? fs.readFileSync(0, 'utf8')
      : process.env.ADMIN_PASSWORD;
  delete process.env.ADMIN_PASSWORD;
  delete process.env.ADMIN_PASSWORD_STDIN;
  const db = openDatabase(
    path.resolve(
      process.env.DATABASE_PATH || process.env.AUTH_DB_PATH || './data/foreign-trade.sqlite',
    ),
  );
  try {
    await initializeAdmin(db, process.env.ADMIN_USERNAME, password);
    console.log('Administrator initialized. Do not persist administrator credentials in .env.');
  } finally {
    db.close();
  }
}
if (require.main === module)
  main().catch(() => {
    console.error(
      'Administrator initialization refused. Check required credentials, database permissions, and whether an administrator already exists.',
    );
    process.exitCode = 1;
  });
module.exports = { main };
