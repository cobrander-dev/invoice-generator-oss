'use strict';
// Static and unit checks for the one-line installer. Full installs, upgrades and restores run
// in tests/installer/e2e.sh on disposable GitHub Actions runners.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const linux = process.platform === 'linux';
const scripts = [
  'installer/install.sh',
  'installer/bundle/setup.sh',
  'installer/bundle/invoice-generator',
  'installer/bundle/lib/common.sh',
  'installer/bundle/lib/https.sh',
  'installer/bundle/lib/host-caddy.sh',
  'installer/bundle/lib/validate.sh',
  'scripts/build-installer-bundle.sh',
];

function bash(script, env = {}) {
  return spawnSync('bash', ['-c', script], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}
const lib = '. installer/bundle/lib/common.sh; . installer/bundle/lib/https.sh;';

test('installer scripts pass bash syntax checks', () => {
  for (const script of scripts) assert.equal(spawnSync('bash', ['-n', script]).status, 0, script);
});

test('installer never destroys volumes, prunes Docker or touches other projects', () => {
  for (const script of scripts) {
    const text = read(script);
    assert.doesNotMatch(
      text,
      /down\s+(-v|--volumes)|volume prune|system prune|image prune/,
      script,
    );
    assert.doesNotMatch(text, /docker compose down|docker rm -f \$\(|xargs docker rm/, script);
    for (const match of text.matchAll(/docker volume rm ([^\s>]+)/g))
      assert.equal(match[1], '"$volume"', `${script} may only remove its candidate volume`);
  }
  const cli = read('installer/bundle/invoice-generator');
  assert.match(cli, /volume="invoice-generator-candidate-\$\$"/);
  assert.match(read('installer/bundle/lib/common.sh'), /IG_PROJECT=invoice-generator\n/);
});

test('setup refuses a Docker project or volume it did not create', () => {
  const setup = read('installer/bundle/setup.sh');
  assert.match(setup, /label=com\.docker\.compose\.project=\$IG_PROJECT/);
  assert.match(setup, /docker volume inspect "\$IG_DATA_VOLUME"/);
  assert.match(setup, /die PROJECT_EXISTS/);
  assert.ok(setup.indexOf('check_ownership\n') < setup.indexOf('write_configuration\n'));
});

test('compose files keep the app private, hardened and log-limited', () => {
  const app = read('installer/bundle/compose/compose.yaml');
  const https = read('installer/bundle/compose/compose.https.yaml');
  const external = read('installer/bundle/compose/compose.external.yaml');
  assert.match(app, /^name: invoice-generator$/m);
  assert.doesNotMatch(app, /ports:/);
  assert.match(app, /backend:\n\s+internal: true/);
  for (const token of ['read_only: true', 'no-new-privileges:true', '- ALL', 'max-size: 10m'])
    assert.ok(app.includes(token), token);
  assert.match(external, /'127\.0\.0\.1:\$\{IG_APP_PORT/);
  assert.doesNotMatch(external, /0\.0\.0\.0/);
  assert.match(https, /'80:80'/);
  assert.match(https, /'443:443'/);
  assert.match(https, /condition: service_healthy/);
});

test('Caddyfile uses automatic certificates for domains and IP certificates with local CA fallback', () => {
  const domain = bash(`${lib} render_caddyfile domain invoice.example.com`).stdout;
  assert.match(domain, /^invoice\.example\.com \{$/m);
  assert.doesNotMatch(domain, /tls internal|default_sni/);
  assert.match(domain, /reverse_proxy app:3000/);
  assert.match(domain, /max_size 70MB/);
  const ip = bash(`${lib} render_caddyfile ip 203.0.113.10`).stdout;
  assert.match(ip, /^https:\/\/203\.0\.113\.10 \{$/m);
  assert.match(ip, /default_sni 203\.0\.113\.10/);
  assert.match(ip, /issuer acme \{\n\t+profile shortlived\n\t+\}\n\t+issuer internal/);
  const internal = bash(`${lib} render_caddyfile domain invoice.ci.test internal`).stdout;
  assert.match(internal, /\ttls internal/);
  for (const text of [domain, ip, internal]) assert.match(text, /admin off/);
});

test('only public IPv4 addresses are accepted for IP installs', () => {
  const check = (ip, env = {}) => bash(`${lib} public_ipv4 "$IP"`, { IP: ip, ...env }).status;
  for (const ip of ['8.8.8.8', '203.0.113.10', '1.1.1.1', '172.32.0.1'])
    assert.equal(check(ip), 0, ip);
  for (const ip of [
    '10.0.0.1',
    '127.0.0.1',
    '192.168.1.1',
    '172.16.0.1',
    '100.64.0.1',
    '169.254.1.1',
    '0.0.0.0',
    '224.0.0.1',
    '256.1.1.1',
    '01.2.3.4',
    '1.2.3',
    'example.com',
  ])
    assert.notEqual(check(ip), 0, ip);
  assert.equal(check('10.0.0.1', { IG_ALLOW_PRIVATE_IP: '1' }), 0);
});

test('domain validation rejects injection before any configuration is written', () => {
  const check = (domain) =>
    bash('. installer/bundle/lib/host-caddy.sh; valid_domain "$D"', { D: domain }).status;
  assert.equal(check('invoice.example.com'), 0);
  for (const domain of ['invoice.example.com {', 'a;b.com', '-bad.example.com', 'localhost', ''])
    assert.notEqual(check(domain), 0, domain);
});

test('configuration files are parsed without shell evaluation and written as 0600', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-config-'));
  try {
    const file = path.join(directory, 'settings.env');
    const marker = path.join(directory, 'evaluated');
    fs.writeFileSync(file, `KEY=$(touch ${marker})\nOTHER=value\n`);
    const result = bash(`${lib} env_get "$F" KEY`, { F: file });
    assert.equal(result.stdout.trim(), `$(touch ${marker})`);
    assert.equal(fs.existsSync(marker), false);
    const written = path.join(directory, 'written.env');
    assert.equal(bash(`${lib} write_env_file "$F" A=1 B=two`, { F: written }).status, 0);
    assert.equal(fs.statSync(written).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(written, 'utf8'), 'A=1\nB=two\n');
    assert.notEqual(bash(`${lib} write_env_file "$F" $'A=1\\nB=2'`, { F: written }).status, 0);
    assert.equal(bash(`${lib} set_env_value "$F" B three`, { F: written }).status, 0);
    assert.equal(fs.readFileSync(written, 'utf8'), 'A=1\nB=three\n');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test(
  'automatic backup rotation never removes manual, upgrade or restore backups',
  { skip: !linux },
  () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-backups-'));
    try {
      const names = [
        ...[1, 2, 3, 4, 5].map((day) => `invoice-generator-2026010${day}T000000Z-auto.sqlite.gz`),
        'invoice-generator-20260101T000000Z-manual.sqlite.gz',
        'invoice-generator-20260101T000000Z-pre-upgrade.sqlite.gz',
        'invoice-generator-20260101T000000Z-pre-restore.sqlite.gz',
      ];
      for (const name of names) {
        fs.writeFileSync(path.join(directory, name), 'x');
        fs.writeFileSync(path.join(directory, `${name}.sha256`), 'x');
      }
      assert.equal(
        bash(`${lib} IG_BACKUP_DIR="$D" IG_BACKUP_KEEP=2 prune_auto_backups`, { D: directory })
          .status,
        0,
      );
      const remaining = fs
        .readdirSync(directory)
        .filter((name) => name.endsWith('.gz'))
        .sort();
      assert.deepEqual(remaining, [
        'invoice-generator-20260101T000000Z-manual.sqlite.gz',
        'invoice-generator-20260101T000000Z-pre-restore.sqlite.gz',
        'invoice-generator-20260101T000000Z-pre-upgrade.sqlite.gz',
        'invoice-generator-20260104T000000Z-auto.sqlite.gz',
        'invoice-generator-20260105T000000Z-auto.sqlite.gz',
      ]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
);

test('the unrendered install.sh template refuses to run', () => {
  const result = spawnSync('bash', ['installer/install.sh'], { cwd: root, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /INSTALLER_NOT_RENDERED/);
});

test('release bundles require digest-pinned images', () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-dist-'));
  try {
    const result = spawnSync(
      'bash',
      [
        'scripts/build-installer-bundle.sh',
        'v1.0.0',
        'invoice-generator:latest',
        'caddy:2',
        output,
      ],
      { cwd: root, encoding: 'utf8', env: { ...process.env, IG_ALLOW_LOCAL_IMAGES: '' } },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /pinned by digest/);
  } finally {
    fs.rmSync(output, { recursive: true, force: true });
  }
});

test(
  'release bundles are reproducible, checksummed and pin images in install.sh',
  { skip: !linux },
  () => {
    const digest = `@sha256:${'a'.repeat(64)}`;
    const build = (output) =>
      spawnSync(
        'bash',
        [
          'scripts/build-installer-bundle.sh',
          'v1.2.3',
          `ghcr.io/cobrander-dev/invoice-generator${digest}`,
          `caddy:2.11.4-alpine${digest}`,
          output,
        ],
        { cwd: root, encoding: 'utf8' },
      );
    const first = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-dist-'));
    const second = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-dist-'));
    const extracted = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-bundle-'));
    try {
      assert.equal(build(first).status, 0);
      assert.equal(build(second).status, 0);
      const sums = fs.readFileSync(path.join(first, 'SHA256SUMS'), 'utf8');
      assert.equal(sums, fs.readFileSync(path.join(second, 'SHA256SUMS'), 'utf8'));
      const bundleSha = sums.match(/^([0-9a-f]{64})\s+invoice-generator-installer\.tar\.gz$/m)[1];
      const install = fs.readFileSync(path.join(first, 'install.sh'), 'utf8');
      assert.match(install, new RegExp(`^IG_BUNDLE_SHA256='${bundleSha}'$`, 'm'));
      assert.match(install, /^IG_RELEASE='v1\.2\.3'$/m);
      assert.doesNotMatch(install, /@(VERSION|BUNDLE_SHA256|REPOSITORY)@/);
      spawnSync('tar', [
        '-xzf',
        path.join(first, 'invoice-generator-installer.tar.gz'),
        '-C',
        extracted,
      ]);
      assert.equal(
        spawnSync('sha256sum', ['--check', '--strict', '--quiet', 'MANIFEST.sha256'], {
          cwd: extracted,
        }).status,
        0,
      );
      const release = fs.readFileSync(path.join(extracted, 'release.env'), 'utf8');
      assert.match(release, /^VERSION=v1\.2\.3$/m);
      assert.match(
        release,
        new RegExp(
          `^APP_IMAGE=ghcr\\.io/cobrander-dev/invoice-generator${digest.replace('$', '\\$')}$`,
          'm',
        ),
      );
      for (const file of ['setup.sh', 'invoice-generator', 'compose/compose.yaml', 'LICENSE'])
        assert.ok(fs.existsSync(path.join(extracted, file)), file);
    } finally {
      for (const directory of [first, second, extracted])
        fs.rmSync(directory, { recursive: true, force: true });
    }
  },
);
