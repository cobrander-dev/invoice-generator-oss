'use strict';
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

async function main() {
  process.umask(0o077);
  const source = path.resolve(process.env.DATABASE_PATH || process.env.AUTH_DB_PATH || './data/foreign-trade.sqlite');
  const dataRoot = path.dirname(source);
  const destination = path.resolve(process.env.BACKUP_PATH || path.join(dataRoot, 'backups', `database-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`));
  if (destination === source || !destination.startsWith(`${dataRoot}${path.sep}`)) throw new Error('BACKUP_PATH must be inside the persistent data directory');
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  const db = new Database(source, { readonly: true, fileMustExist: true });
  try { await db.backup(destination); }
  finally { db.close(); }
  fs.chmodSync(destination, 0o600);
  console.log(path.relative(dataRoot, destination));
}

if (require.main === module) main().catch(() => {
  console.error('SQLite backup failed; the active database was not modified.');
  process.exitCode = 1;
});
module.exports = { main };
