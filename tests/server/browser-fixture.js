'use strict';
// Explicit TEST-only browser harness; not served by the application.
// Creates a temporary auth DB, runs the real admin CLI, starts the real server,
// and deletes its own temporary data on SIGINT/SIGTERM.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { TEST_USERNAME, TEST_PASSWORD } = require('./helpers');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-auth-browser-'));
const port = process.env.FT_TEST_PORT || '33187';
const env = { ...process.env, NODE_ENV: 'development', HOST: '127.0.0.1', PORT: port,
  APP_ORIGIN: `http://127.0.0.1:${port}`, AUTH_DB_PATH: path.join(directory, 'auth.sqlite'),
  SESSION_SECRET: randomBytes(32).toString('hex'), ADMIN_USERNAME: TEST_USERNAME,
  ADMIN_PASSWORD: TEST_PASSWORD, TRUST_PROXY_LOOPBACK: 'false' };
const root = path.resolve(__dirname, '../..');
const result = spawnSync(process.execPath, ['server/scripts/init-admin.js'], { cwd: root, env, stdio: 'inherit' });
if (result.status !== 0) { fs.rmSync(directory, { recursive: true, force: true }); process.exit(1); }
delete env.ADMIN_PASSWORD;
const child = spawn(process.execPath, ['server/server.js'], { cwd: root, env, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill('SIGTERM'));
child.on('exit', code => {
  fs.rmSync(directory, { recursive: true, force: true });
  console.log('Isolated TEST authentication database removed.');
  process.exitCode = code || 0;
});
