'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const Database = require('better-sqlite3');
const { loadConfig } = require('../../server/config');
const { openDatabase } = require('../../server/db/database');
const { createBusinessRepositories } = require('../../server/repositories/business-repository');
const { fixture } = require('./helpers');

const root = path.resolve(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const dockerfile = read('Dockerfile');
const compose = read('docker-compose.yml');
const caddy = read('deploy/caddy/Caddyfile');
const install = read('deploy/install.sh');
const update = read('deploy/update.sh');
const dockerignore = read('.dockerignore');
const gitignore = read('.gitignore');

test('Docker image pins an exact Node version and production mode', () => {
  assert.match(dockerfile, /FROM node:24\.20\.0-bookworm-slim/);
  assert.doesNotMatch(dockerfile, /FROM\s+\S*:latest/i);
  assert.match(dockerfile, /ENV NODE_ENV=production/);
});
test('application image runs as non-root and has a writable data mount point', () => {
  assert.match(dockerfile, /chown node:node \/app\/data/);
  assert.match(dockerfile, /USER node/);
  assert.ok(dockerfile.indexOf('USER node') < dockerfile.indexOf('CMD ['));
});
test('Docker build copies only explicit runtime application files', () => {
  assert.doesNotMatch(dockerfile, /COPY\s+\.\s+\./);
  for (const required of ['server', 'js/api-db.js', 'js/core.js', 'css'])
    assert.match(dockerfile, new RegExp(required.replace('/', '\\/')));
  for (const forbidden of ['tests', 'js/db.js', '.env', '.git'])
    assert.doesNotMatch(
      dockerfile,
      new RegExp(`COPY[^\\n]*${forbidden.replace('.', '\\.').replace('/', '\\/')}`),
    );
});
test('Compose app has no public port and uses a persistent SQLite volume', () => {
  const app = compose.slice(compose.indexOf('  app:'), compose.indexOf('  caddy:'));
  assert.doesNotMatch(app, /^\s{4}ports:/m);
  assert.match(app, /app_data:\/app\/data/);
  assert.match(app, /DATABASE_PATH: \/app\/data\/foreign-trade\.sqlite/);
  assert.match(app, /expose:\s*\n\s*- "3000"/);
});
test('Compose uses restart, health, read-only root and reduced privileges', () => {
  assert.match(compose, /restart: unless-stopped/);
  assert.match(compose, /healthcheck:/);
  assert.match(compose, /read_only: true/);
  assert.match(compose, /no-new-privileges:true/);
  assert.match(compose, /cap_drop:\s*\n\s*- ALL/);
});
test('Compose isolates the application on an internal backend network', () => {
  assert.match(compose, /backend:\s*\n\s+internal: true/);
  assert.match(compose, /caddy:2\.11\.4-alpine/);
  assert.match(compose, /condition: service_healthy/);
});
test('Caddy is the only public entry and proxies to the app service', () => {
  assert.match(compose, /"\$\{HTTP_PORT:-80\}:80"/);
  assert.match(compose, /"\$\{HTTPS_PORT:-443\}:443"/);
  assert.match(caddy, /\{\$DOMAIN\}/);
  assert.match(caddy, /reverse_proxy app:3000/);
});
test('production configuration fails fast without origin, database or secret', () => {
  const secret = randomBytes(48).toString('hex');
  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: 'production',
        DATABASE_PATH: '/tmp/test.sqlite',
        SESSION_SECRET: secret,
      }),
    /HTTPS APP_ORIGIN/,
  );
  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: 'production',
        APP_ORIGIN: 'https://invoice.example.invalid',
        SESSION_SECRET: secret,
      }),
    /DATABASE_PATH/,
  );
  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: 'production',
        APP_ORIGIN: 'https://invoice.example.invalid',
        DATABASE_PATH: '/tmp/test.sqlite',
      }),
    /SESSION_SECRET/,
  );
});
test('production configuration accepts one reverse proxy hop only', () => {
  const env = {
    NODE_ENV: 'production',
    APP_ORIGIN: 'https://invoice.example.invalid',
    DATABASE_PATH: '/tmp/test.sqlite',
    SESSION_SECRET: randomBytes(48).toString('hex'),
    TRUST_PROXY_HOPS: '1',
  };
  assert.equal(loadConfig(env).trustProxy, 1);
  assert.throws(() => loadConfig({ ...env, TRUST_PROXY_HOPS: '2' }), /exactly 1/);
});
test('environment template contains placeholders but no administrator password', () => {
  const env = read('.env.example');
  for (const key of [
    'NODE_ENV=production',
    'DOMAIN=invoice.example.com',
    'APP_ORIGIN=https://invoice.example.com',
    'DATABASE_PATH=/app/data/',
    'SESSION_SECRET=change-me',
  ])
    assert.match(env, new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(env, /ADMIN_PASSWORD|GITHUB_TOKEN|BEGIN PRIVATE KEY/);
});
test('health endpoint is public and returns only status ok', async () => {
  const f = await fixture();
  try {
    const response = await f.client().request('/health');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok' });
  } finally {
    await f.cleanup();
  }
});
test('business page and API remain protected by login', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.client().request('/')).status, 302);
    assert.equal((await f.client().request('/api/orders')).status, 401);
  } finally {
    await f.cleanup();
  }
});
test('administrator password can be supplied through stdin without persistence or output', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-phase5-admin-'));
  const databasePath = path.join(directory, 'foreign-trade.sqlite');
  const password = 'TEST-stdin-passphrase-0000';
  const result = spawnSync(process.execPath, ['server/scripts/init-admin.js'], {
    cwd: root,
    env: {
      ...process.env,
      DATABASE_PATH: databasePath,
      ADMIN_USERNAME: 'test-stdin-admin',
      ADMIN_PASSWORD_STDIN: '1',
    },
    input: password,
    encoding: 'utf8',
  });
  try {
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(password));
    const db = new Database(databasePath, { readonly: true });
    try {
      const row = db.prepare('SELECT username, password_hash FROM users').get();
      assert.equal(row.username, 'test-stdin-admin');
      assert.match(row.password_hash, /^\$argon2id\$/);
      assert.doesNotMatch(row.password_hash, /TEST-stdin-passphrase/);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
test('SQLite backup helper creates a restorable consistent database copy', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-phase5-backup-'));
  const source = path.join(directory, 'foreign-trade.sqlite'),
    destination = path.join(directory, 'backups', 'test.sqlite');
  const db = openDatabase(source);
  createBusinessRepositories(db).customers.put(
    { id: 'test-customer', buyerName: 'Example Backup Testing Ltd.' },
    0,
  );
  db.close();
  const result = spawnSync(process.execPath, ['server/scripts/backup-database.js'], {
    cwd: root,
    env: { ...process.env, DATABASE_PATH: source, BACKUP_PATH: destination },
    encoding: 'utf8',
  });
  try {
    assert.equal(result.status, 0, result.stderr);
    const copy = new Database(destination, { readonly: true });
    try {
      assert.equal(
        JSON.parse(
          copy.prepare('SELECT payload_json FROM customers WHERE id=?').get('test-customer')
            .payload_json,
        ).buyerName,
        'Example Backup Testing Ltd.',
      );
    } finally {
      copy.close();
    }
    assert.equal(fs.statSync(destination).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
test('SQLite backup helper rejects a destination outside persistent data', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-phase5-boundary-'));
  const source = path.join(directory, 'data', 'foreign-trade.sqlite'),
    outside = path.join(directory, 'outside.sqlite');
  openDatabase(source).close();
  const result = spawnSync(process.execPath, ['server/scripts/backup-database.js'], {
    cwd: root,
    env: { ...process.env, DATABASE_PATH: source, BACKUP_PATH: outside },
    encoding: 'utf8',
  });
  try {
    assert.notEqual(result.status, 0);
    assert.equal(fs.existsSync(outside), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
test('installer is idempotent around env, secret and administrator state', () => {
  assert.match(install, /apt-get install -y ca-certificates curl git openssl openssh-client/);
  assert.match(install, /if \[\[ ! -f \.env \]\]/);
  assert.match(install, /preserving existing \.env and session secret/);
  assert.match(install, /npm run admin:status/);
  assert.match(install, /ADMIN_PASSWORD_STDIN=1/);
  assert.doesNotMatch(install, /-e ADMIN_PASSWORD=/);
  assert.doesNotMatch(install, /admin\/admin|ADMIN_PASSWORD=.*change-me/i);
});
test('installer uses SSH for private repository acquisition and never stores a token', () => {
  assert.match(install, /git@github\\\.com|ssh:\/\/git@github/);
  assert.match(install, /git clone/);
  assert.doesNotMatch(install, /GITHUB_TOKEN|Authorization:|oauth2:/i);
});
test('updater backs up before fetch and permits fast-forward updates only', () => {
  assert.ok(update.indexOf('npm run db:backup') < update.indexOf('git fetch'));
  assert.match(update, /git merge --ff-only/);
  assert.match(update, /merge-base --is-ancestor/);
});
test('deployment scripts never destroy volumes, prune Docker or reset credentials', () => {
  const scripts = [install, update, read('deploy/backup.sh')].join('\n');
  for (const forbidden of [
    'down -v',
    'volume prune',
    'system prune',
    'ADMIN_PASSWORD=admin',
    'SESSION_SECRET=change-me',
  ])
    assert.doesNotMatch(scripts, new RegExp(forbidden, 'i'));
});
test('updater retains rollback image and pre-update database backup on failure', () => {
  assert.match(update, /candidate-/);
  assert.match(update, /APP_IMAGE_TAG=current/);
  assert.match(update, /pre-update-/);
  assert.match(update, /backup.*preserved/i);
  assert.doesNotMatch(update, /new_head.*old_head.*exit 0/);
});
test('deployment scripts pass bash syntax and built-in validation', () => {
  for (const script of ['deploy/install.sh', 'deploy/update.sh', 'deploy/backup.sh'])
    assert.equal(spawnSync('bash', ['-n', script], { cwd: root }).status, 0);
  assert.equal(spawnSync('bash', ['deploy/install.sh', '--check'], { cwd: root }).status, 0);
  assert.equal(spawnSync('bash', ['deploy/update.sh', '--check'], { cwd: root }).status, 0);
});
test('git and Docker ignore files protect runtime data, secrets and certificates', () => {
  for (const text of [gitignore, dockerignore])
    for (const token of ['.env', 'node_modules', '*.pdf', '*.sqlite', '*.key', '*.pem'])
      assert.match(text, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  for (const token of ['tests', '.git', 'output', 'tmp'])
    assert.match(dockerignore, new RegExp(`^${token}$`, 'm'));
});
test('server frontend adapter has no IndexedDB or localStorage business fallback', () => {
  const source = read('js/api-db.js');
  assert.doesNotMatch(source, /indexedDB|localStorage|js\/db\.js/i);
});
test('container smoke test is present for Docker-capable CI or host validation', () => {
  const smoke = read('tests/deploy/container-smoke.sh');
  const containerWorkflow = read('tests/deploy/container-workflow.js');
  const workflow = read('.github/workflows/test.yml');
  assert.match(smoke, /--force-recreate app/);
  assert.match(smoke, /restart app/);
  assert.match(smoke, /stop -t 15 app/);
  assert.match(smoke, /State\.ExitCode/);
  assert.match(smoke, /expect_production_failure/);
  assert.match(smoke, /test ! -e \/app\/js\/db\.js/);
  assert.doesNotMatch(smoke, /down\s+(?:-v|--volumes)|volume prune|system prune/);
  assert.match(containerWorkflow, /finalize-pi/);
  assert.match(containerWorkflow, /finalize-ci/);
  assert.match(containerWorkflow, /finalize-packing-list/);
  assert.match(containerWorkflow, /server-backup\/export/);
  assert.match(smoke, /COMPOSE_PROJECT_NAME/);
  assert.match(workflow, /docker compose config --quiet/);
  assert.match(workflow, /tests\/deploy\/container-smoke\.sh/);
  assert.match(workflow, /tests\/deploy\/host-caddy-container-smoke\.sh/);
});
