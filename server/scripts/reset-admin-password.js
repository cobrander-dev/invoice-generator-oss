'use strict';
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const readline = require('node:readline/promises');
const { openDatabase } = require('../db/database');
const { hashPassword } = require('../auth/password');
const { requireValidPassword, passwordMinimum } = require('../auth/password-policy');
const { AuditService } = require('../services/audit-service');

async function hiddenQuestions() {
  if (!process.stdin.isTTY || !process.stderr.isTTY) throw new Error('Interactive TTY is required');
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  const ask = async label => {
    process.stderr.write(label);
    spawnSync('stty', ['-echo'], { stdio: ['inherit', 'ignore', 'inherit'] });
    try { return await rl.question(''); }
    finally { spawnSync('stty', ['echo'], { stdio: ['inherit', 'ignore', 'inherit'] }); process.stderr.write('\n'); }
  };
  try { return [await ask('New administrator password: '), await ask('Confirm new password: ')]; }
  finally { rl.close(); }
}

async function main() {
  process.umask(0o077);
  const [password, confirmation] = await hiddenQuestions();
  if (password !== confirmation) throw new Error('Password confirmation does not match');
  requireValidPassword(password, passwordMinimum());
  const db = openDatabase(path.resolve(process.env.DATABASE_PATH || process.env.AUTH_DB_PATH || './data/foreign-trade.sqlite'));
  try {
    await resetAdminPassword(db, password, passwordMinimum());
    console.log('Administrator password reset. Existing administrator sessions were invalidated.');
  } finally { db.close(); }
}

async function resetAdminPassword(db, password, minimum = passwordMinimum()) {
  requireValidPassword(password, minimum);
  const admin = db.prepare("SELECT * FROM users WHERE role='ADMIN'").get();
  if (!admin) throw new Error('Administrator does not exist');
  const hash = await hashPassword(password), audit = new AuditService(db);
  db.transaction(() => {
    db.prepare('UPDATE users SET password_hash=?,must_change_password=0,auth_version=auth_version+1,updated_at=? WHERE id=?')
      .run(hash, Date.now(), admin.id);
    db.prepare("DELETE FROM sessions WHERE json_extract(payload, '$.userId')=?").run(admin.id);
    audit.write({ actor: { id: admin.id, username: admin.username }, action: 'ADMIN_CLI_RESET_PASSWORD', entityType: 'USER', entityId: admin.id, ipAddress: 'LOCAL_CLI' });
  })();
  return admin.id;
}

if (require.main === module) main().catch(() => { console.error('Administrator password reset failed.'); process.exitCode = 1; });
module.exports = { main, hiddenQuestions, resetAdminPassword };
