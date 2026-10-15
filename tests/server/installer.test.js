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
  'installer/bundle/oss-gateway.sh',
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
  // Defaults keep the original 80/443 layout for CLIs from before custom ports.
  assert.match(https, /'\$\{IG_HTTP_BIND:-80\}:80'/);
  assert.match(https, /'\$\{IG_HTTPS_PORT:-443\}:443'/);
  assert.match(https, /condition: service_healthy/);
  const relay = read('installer/bundle/compose/compose.relay.yaml');
  assert.match(relay, /name: oss-https-relay\n\s+external: true/);
  assert.match(relay, /oss\.https-relay: \$\{IG_RELAY_ROLE/);
  assert.match(relay, /- \$\{IG_RELAY_ALIAS/);
});

test('legacy installations render the exact Caddyfile they had before custom ports', () => {
  const legacy = bash(`${lib} render_caddyfile domain invoice.example.com auto 443 ''`).stdout;
  assert.equal(legacy, bash(`${lib} render_caddyfile domain invoice.example.com`).stdout);
  assert.doesNotMatch(legacy, /auto_https|acme-relay|protocols|tls \{/);
});

test('custom HTTPS ports keep the port in redirects and use only challenges that can work', () => {
  const holder = bash(`${lib} render_caddyfile domain invoice.example.com auto 8443 holder`).stdout;
  assert.match(holder, /auto_https disable_redirects/);
  assert.match(holder, /issuer acme \{\n\t+disable_tlsalpn_challenge\n/);
  assert.doesNotMatch(holder, /disable_http_challenge/);
  assert.match(
    holder,
    /http:\/\/invoice\.example\.com \{\n\tredir https:\/\/invoice\.example\.com:8443\{uri\} 308/,
  );
  assert.match(holder, /protocols h1 h2/);
  assert.match(holder, /reverse_proxy \{http\.request\.host\}\.acme-relay\.invalid:80/);
  assert.match(holder, /@relay not header X-OSS-HTTPS-Relay \*/);
  assert.match(holder, /header_up X-OSS-HTTPS-Relay 1/);

  const member = bash(`${lib} render_caddyfile domain hub.example.com auto 9443 member`).stdout;
  assert.match(member, /disable_tlsalpn_challenge/);
  assert.doesNotMatch(member, /acme-relay|disable_http_challenge/);
  assert.match(member, /redir https:\/\/hub\.example\.com:9443\{uri\}/);

  const standard = bash(`${lib} render_caddyfile domain a.example.com auto 443 holder`).stdout;
  assert.doesNotMatch(standard, /disable_tlsalpn_challenge|protocols h1 h2/);
  assert.match(standard, /redir https:\/\/a\.example\.com\{uri\} 308/);

  // Port 80 owned by an unrelated program: TLS-ALPN-01 on 443 only.
  const alpn = bash(`${lib} render_caddyfile domain a.example.com auto 443 none`).stdout;
  assert.match(alpn, /issuer acme \{\n\t+disable_http_challenge\n/);
  assert.doesNotMatch(alpn, /disable_tlsalpn_challenge/);

  // No challenge can reach this server: never configure an ACME issuer that cannot succeed.
  const none = bash(`${lib} render_caddyfile domain a.example.com auto 9443 none`).stdout;
  assert.match(none, /\ttls internal/);
  assert.doesNotMatch(none, /issuer acme/);

  const ip = bash(`${lib} render_caddyfile ip 203.0.113.10 auto 8443 holder`).stdout;
  assert.match(ip, /profile shortlived\n\t+disable_tlsalpn_challenge\n\t+\}\n\t+issuer internal/);
  assert.match(ip, /redir https:\/\/203\.0\.113\.10:8443\{uri\}/);

  const ca = bash(
    `${lib} render_caddyfile domain a.example.com auto 8443 holder https://pebble:14000/dir`,
  ).stdout;
  assert.match(
    ca,
    /acme_ca https:\/\/pebble:14000\/dir\n\tacme_ca_root \/etc\/caddy\/acme-ca-root\.pem/,
  );
});

test('HTTPS ports: 443 or 1024-65535, origins carry non-standard ports', () => {
  const valid = (port) => bash(`${lib} valid_https_port "$P"`, { P: port }).status;
  for (const port of ['443', '1024', '8443', '9443', '65535']) assert.equal(valid(port), 0, port);
  for (const port of ['80', '0', '22', '1023', '65536', '08443', '8443 ', 'p', '', '-1'])
    assert.notEqual(valid(port), 0, port);
  const origin = (port) => bash(`${lib} public_origin a.example.com "$P"`, { P: port }).stdout;
  assert.equal(origin('443'), 'https://a.example.com');
  assert.equal(origin('8443'), 'https://a.example.com:8443');
});

// Stubs for docker and ss: PORTS lists "<id/name> <ports>" lines, LABELS maps id=project:relay-role.
const stubs = `
docker() {
  case "$1 $2" in
    'ps --format')
      if [[ "$3" == '{{.Ports}}' ]]; then printf '%b' "$PORTS" | cut -d' ' -f2-; else printf '%b' "$PORTS"; fi ;;
    'inspect --format')
      local entry; entry="$(printf '%s' "$LABELS" | tr ' ' '\n' | grep "^$4=" | cut -d= -f2)"
      if [[ "$3" == *compose.project* ]]; then printf '%s\n' "\${entry%%:*}"; else printf '%s\n' "\${entry#*:}"; fi ;;
  esac
}
ss() { [[ "$*" == *":80 "* && -n "\${SS80:-}" ]] && printf 'LISTEN 0 4096 0.0.0.0:80 0.0.0.0:* users:(("nginx",pid=1,fd=6))\n'; return 0; }
`;
const relayRole = (env) =>
  bash(
    `${lib} ${stubs} IG_ACCESS_KIND=\${KIND:-domain}; decide_relay_role; printf '%s %s' "$IG_RELAY_ROLE" "$IG_HTTP_BIND"`,
    env,
  ).stdout;

test('relay role: free port 80 holds, OSS holders relay, unrelated programs do not', () => {
  assert.equal(relayRole({ PORTS: '', LABELS: '' }), 'holder 80');
  assert.equal(
    relayRole({
      PORTS: 'abc 0.0.0.0:80->80/tcp, [::]:80->80/tcp\n',
      LABELS: 'abc=invoice-generator:holder',
    }),
    'holder 80',
  );
  assert.equal(
    relayRole({ PORTS: 'def 0.0.0.0:80->80/tcp\n', LABELS: 'def=product-hub-https:holder' }),
    'member 127.0.0.1:18080',
  );
  assert.equal(
    relayRole({
      PORTS: 'def 0.0.0.0:80->80/tcp\n',
      LABELS: 'def=product-hub-https:holder',
      KIND: 'ip',
    }),
    'none 127.0.0.1:18080',
  );
  assert.equal(
    relayRole({ PORTS: 'xyz 0.0.0.0:80->8080/tcp\n', LABELS: 'xyz=other:' }),
    'none 127.0.0.1:18080',
  );
  assert.equal(relayRole({ PORTS: '', LABELS: '', SS80: '1' }), 'none 127.0.0.1:18080');
  // A loopback-only publication of port 80 is not the public port 80.
  assert.equal(
    relayRole({ PORTS: 'abc 127.0.0.1:80->80/tcp\n', LABELS: 'abc=x:' }),
    'none 127.0.0.1:18080',
  );
});

// Loads setup.sh's functions without running the wizard.
function setupFunctions() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-setup-'));
  fs.symlinkSync(path.join(root, 'installer/bundle/lib'), path.join(directory, 'lib'));
  fs.writeFileSync(
    path.join(directory, 'setup.sh'),
    read('installer/bundle/setup.sh').replace(/\nmain "\$@"\n$/, '\n'),
  );
  return directory;
}

test('setup never takes over a busy HTTPS port and refuses unworkable certificates', () => {
  const directory = setupFunctions();
  const run = (script, env) =>
    bash(`. "${directory}/setup.sh"; ${stubs} ${script}`, {
      IG_NONINTERACTIVE: '1',
      PORTS: '',
      LABELS: '',
      ...env,
    });
  try {
    const busy = { PORTS: 'n1 0.0.0.0:443->443/tcp, 0.0.0.0:80->80/tcp\n', LABELS: 'n1=nginx:' };
    let result = run('choose_https_port', { ...busy, IG_HTTPS_PORT: '443' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /HTTPS_PORT_IN_USE/);
    assert.match(result.stderr, /容器 n1/);
    result = run('choose_https_port; echo "$IG_PROXY_MODE"', busy);
    assert.equal(
      result.stdout.trim(),
      'external',
      'unattended default keeps the existing-proxy fallback',
    );
    result = run('choose_https_port; echo "$IG_PROXY_MODE $IG_HTTPS_PORT"', {
      ...busy,
      IG_HTTPS_PORT: '8443',
    });
    assert.equal(result.stdout.trim(), 'bundled 8443');
    result = run('choose_https_port', { IG_HTTPS_PORT: '80' });
    assert.match(result.stderr, /HTTPS_PORT_INVALID/);

    const port80 = {
      PORTS: 'n1 0.0.0.0:80->80/tcp\n',
      LABELS: 'n1=nginx:',
      IG_ACCESS_KIND: 'domain',
    };
    result = run('IG_HTTPS_PORT=9443; choose_certificate_plan', port80);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ACME_HTTP_PORT_UNAVAILABLE/);
    result = run(
      'IG_HTTPS_PORT=9443; choose_certificate_plan; echo "$IG_RELAY_ROLE $IG_TLS_ISSUER"',
      {
        ...port80,
        IG_TLS_ISSUER: 'internal',
      },
    );
    assert.equal(result.stdout.trim().split('\n').at(-1), 'none internal');
    result = run(
      'IG_HTTPS_PORT=443; choose_certificate_plan; echo "$IG_RELAY_ROLE $IG_TLS_ISSUER"',
      port80,
    );
    assert.equal(result.stdout.trim().split('\n').at(-1), 'none auto');
    result = run('IG_HTTPS_PORT=9443; choose_certificate_plan; echo "$IG_RELAY_ROLE"', {
      ...port80,
      LABELS: 'n1=invoice-generator-other:holder',
    });
    assert.equal(result.stdout.trim().split('\n').at(-1), 'member');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
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

test('a downloaded install.sh re-runs itself through sudo, forwarding only IG_* answers', (t) => {
  if (process.getuid && process.getuid() === 0) return t.skip('needs a non-root user');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-elevate-'));
  fs.writeFileSync(path.join(dir, 'sudo'), '#!/bin/bash\nprintf "[%s]" "$@"\n', { mode: 0o755 });
  const rendered = read('installer/install.sh').replace('@BUNDLE_SHA256@', '0'.repeat(64));
  fs.writeFileSync(path.join(dir, 'install.sh'), rendered);
  const env = {
    ...process.env,
    PATH: `${dir}:${process.env.PATH}`,
    IG_ACCESS_HOST: 'a.example.com',
    OTHER: 'x',
  };
  const fromFile = spawnSync('bash', ['install.sh'], { cwd: dir, env, encoding: 'utf8' });
  assert.equal(fromFile.stdout, '[IG_ACCESS_HOST=a.example.com][bash][install.sh]');
  // A script read from a pipe cannot be re-run, so it must stop instead of running partially.
  const piped = spawnSync('bash', [], { cwd: dir, env, input: rendered, encoding: 'utf8' });
  assert.notEqual(piped.status, 0);
  assert.match(piped.stderr, /ROOT_REQUIRED/);
  assert.doesNotMatch(piped.stdout, /\[bash\]/);
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

test('restore stops services before its safety backup so no write can be lost', () => {
  const cli = read('installer/bundle/invoice-generator');
  const restore = cli.slice(cli.indexOf('cmd_restore() {'), cli.indexOf('# Fetches and verifies'));
  assert.ok(restore.indexOf('stop_services\n') < restore.indexOf('create_backup pre-restore'));
  assert.ok(
    restore.indexOf('preserve_database failed-restore') <
      restore.indexOf('database="$(unpack_backup "$pre"'),
  );
});

test('upgrade rollback preserves the post-switch database before restoring old data', () => {
  const cli = read('installer/bundle/invoice-generator');
  const upgrade = cli.slice(cli.indexOf('cmd_upgrade() {'), cli.indexOf('refresh_schedule() {'));
  const rollback = upgrade.slice(upgrade.indexOf('新版本启动失败'));
  assert.ok(
    upgrade.indexOf('stop_services "$old_dir"') <
      upgrade.indexOf('create_backup final-pre-upgrade'),
  );
  assert.ok(
    rollback.indexOf('stop_services "$new_dir"') <
      rollback.indexOf('preserve_database failed-upgrade'),
  );
  assert.ok(
    rollback.indexOf('preserve_database failed-upgrade') < rollback.indexOf('replace_database'),
  );
  assert.match(rollback, /die UPGRADE_ROLLBACK_HALTED/);
});

test('shared gateway mode: domain only, never takes over an unmanageable owner of 80/443', () => {
  const directory = setupFunctions();
  const run = (script, env) =>
    bash(
      `. "${directory}/setup.sh"; ${stubs} gateway() { [ "$1" = detect ] && echo "$GW_STATE"; }; ${script}`,
      { IG_NONINTERACTIVE: '1', PORTS: '', LABELS: '', IG_ACCESS_KIND: 'domain', ...env },
    );
  try {
    let result = run(
      'choose_proxy_mode; echo "$IG_HTTPS_MODE $IG_PROXY_MODE $IG_GATEWAY $IG_APP_PORT $IG_HTTPS_PORT"',
      {
        IG_HTTPS_MODE: 'gateway',
        GW_STATE: 'absent',
      },
    );
    assert.equal(result.stdout.trim().split('\n').at(-1), 'gateway external yes 3001 443');
    result = run('choose_proxy_mode; echo "$IG_GATEWAY"', {
      IG_HTTPS_MODE: 'gateway',
      GW_STATE: 'managed',
    });
    assert.equal(result.stdout.trim().split('\n').at(-1), 'yes');
    result = run('choose_proxy_mode', { IG_HTTPS_MODE: 'gateway', GW_STATE: 'unmanageable nginx' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /GATEWAY_UNAVAILABLE/);
    assert.match(result.stderr, /nginx/);
    result = run('choose_proxy_mode', {
      IG_HTTPS_MODE: 'gateway',
      GW_STATE: 'absent',
      IG_ACCESS_KIND: 'ip',
    });
    assert.match(result.stderr, /GATEWAY_UNAVAILABLE/);
    // Unattended installs without a mode keep the original behaviour.
    result = run('choose_proxy_mode; echo "$IG_HTTPS_MODE $IG_PROXY_MODE $IG_GATEWAY"', {
      GW_STATE: 'absent',
    });
    assert.equal(result.stdout.trim().split('\n').at(-1), 'port bundled no');
    assert.match(run('choose_proxy_mode', { IG_HTTPS_MODE: 'other' }).stderr, /CONFIG_INVALID/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('gateway site keeps the app on loopback and adds only its own domain', () => {
  const site = bash(`${lib} render_gateway_site invoice.example.com 3001`).stdout;
  assert.equal(site.split('\n')[0], 'invoice.example.com {');
  assert.match(site, /reverse_proxy 127\.0\.0\.1:3001/);
  assert.match(site, /max_size 70MB/);
  assert.equal(site.match(/^\S.*\{$/gm).length, 1);
});

test('upgrades order versions by SemVer: a release outranks its release candidates', () => {
  const gt = (a, b) => bash(`${lib} semver_gt "$A" "$B"`, { A: a, B: b }).status === 0;
  for (const [newer, older] of [
    ['v0.1.0', 'v0.1.0-rc.8'],
    ['v0.1.0-rc.10', 'v0.1.0-rc.9'],
    ['v0.1.1', 'v0.1.0'],
    ['v0.10.0', 'v0.9.9'],
    ['v1.0.0', 'v1.0.0-rc.1'],
    ['v1.0.0-rc.1', 'v1.0.0-beta.11'],
    ['v1.0.0-alpha.beta', 'v1.0.0-alpha.1'],
  ]) {
    assert.equal(gt(newer, older), true, `${newer} > ${older}`);
    assert.equal(gt(older, newer), false, `${older} < ${newer}`);
  }
  assert.equal(gt('v0.1.0', 'v0.1.0'), false);
  const order = bash(`${lib} semver_sort_desc v0.1.0-rc.7 v0.1.0 v0.1.0-rc.10 v0.1.1 v0.1.0-rc.8`);
  assert.equal(order.stdout, 'v0.1.1\nv0.1.0\nv0.1.0-rc.10\nv0.1.0-rc.8\nv0.1.0-rc.7\n');
  const cli = read('installer/bundle/invoice-generator');
  assert.doesNotMatch(cli, /sort -r?V/);
  assert.match(cli, /semver_gt "\$new_version" "\$old_version" \|\|\n\s+die DOWNGRADE_REFUSED/);
});
