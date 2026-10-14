'use strict';
// Unit checks for the shared HTTPS gateway manager (installer/bundle/oss-gateway.sh) with
// stubbed docker, ss, systemctl and caddy. Real installs run in tests/installer/e2e.sh.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '../..');
const script = path.join(root, 'installer/bundle/oss-gateway.sh');

// STATE: managed | free | host-caddy | nginx. VALIDATE/RELOAD=fail make those steps fail.
const stubs = `
id() { echo 0; }
flock() { return 0; }
docker() {
  case "$1" in
    ps)
      case "$*" in
        *oss.gateway=1*) [ "$STATE" = managed ] && echo gw1 ;;
        *'{{.Names}}'*) [ "$STATE" = nginx ] && echo 'web-nginx 0.0.0.0:80->80/tcp, 0.0.0.0:443->443/tcp' ;;
        *'{{.Ports}}'*) [ "$STATE" = nginx ] && echo '0.0.0.0:80->80/tcp, 0.0.0.0:443->443/tcp' ;;
      esac ;;
    run) [ "\${VALIDATE:-ok}" = ok ]; return ;;
    exec) echo "reload $*" >>"$LOG"; [ "\${RELOAD:-ok}" = ok ]; return ;;
  esac
  return 0
}
ss() {
  case "$STATE" in
    host-caddy) echo 'LISTEN 0 4096 *:80 *:* users:(("caddy",pid=9,fd=7))' ;;
    nginx) ;;
  esac
}
systemctl() {
  case "$1" in
    is-active) [ "$STATE" = host-caddy ] ;;
    reload) echo "systemctl reload" >>"$LOG"; [ "\${RELOAD:-ok}" = ok ] ;;
  esac
}
caddy() { [ "\${VALIDATE:-ok}" = ok ]; }
`;

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oss-gateway-'));
  fs.mkdirSync(path.join(dir, 'gw/sites'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'gw/backups'));
  fs.writeFileSync(path.join(dir, 'gw/image'), 'caddy:test\n');
  fs.writeFileSync(path.join(dir, 'gw/Caddyfile'), 'import /etc/caddy/sites/*.caddy\n');
  fs.writeFileSync(path.join(dir, 'log'), '');
  fs.writeFileSync(
    path.join(dir, 'host.Caddyfile'),
    'other.example.com {\n\trespond "other site"\n}\n',
  );
  const site = (host, body = 'reverse_proxy 127.0.0.1:3001') => {
    const file = path.join(dir, `${host}.site`);
    fs.writeFileSync(file, `${host} {\n\t${body}\n}\n`);
    return file;
  };
  const run = (command, env = {}) =>
    spawnSync(
      'sh',
      ['-c', `${stubs}\nOSS_GATEWAY_SOURCE_ONLY=1 . "${script}"\nset +e\n${command}`],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          OSS_GATEWAY_ROOT: path.join(dir, 'gw'),
          OSS_GATEWAY_LOCK: path.join(dir, 'lock'),
          OSS_GATEWAY_HOST_CADDYFILE: path.join(dir, 'host.Caddyfile'),
          LOG: path.join(dir, 'log'),
          STATE: 'managed',
          ...env,
        },
      },
    );
  return { dir, site, run, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('both projects ship the same gateway manager', () => {
  const copy = path.join(root, '../product-hub-oss/scripts/oss-gateway.sh');
  if (!fs.existsSync(copy)) return;
  assert.equal(fs.readFileSync(copy, 'utf8'), fs.readFileSync(script, 'utf8'));
});

test('gateway manager is POSIX shell and never stops, prunes or removes other projects', () => {
  assert.equal(spawnSync('sh', ['-n', script]).status, 0);
  const text = fs.readFileSync(script, 'utf8');
  assert.doesNotMatch(text, /\b(down|prune|kill|rm -f \$\(|docker rm|systemctl (stop|restart))\b/);
  assert.match(text, /admin unix\/\/config\/admin\.sock/);
  assert.match(text, /network_mode: host/);
  assert.match(text, /GATEWAY_IMAGE=.*caddy:2\.11\.4-alpine@sha256:[0-9a-f]{64}/);
});

test('detect: managed gateway, free ports, manageable host Caddy, anything else', () => {
  const t = setup();
  try {
    assert.equal(t.run('detect').stdout.trim(), 'managed');
    assert.equal(t.run('detect', { STATE: 'free' }).stdout.trim(), 'absent');
    // host Caddy needs the binary; the stub provides a function named caddy.
    assert.equal(t.run('detect', { STATE: 'host-caddy' }).stdout.trim(), 'host-caddy');
    assert.equal(t.run('detect', { STATE: 'nginx' }).stdout.trim(), 'unmanageable 容器 web-nginx');
  } finally {
    t.cleanup();
  }
});

test('a site file may only define its own domain', () => {
  const t = setup();
  try {
    const both = path.join(t.dir, 'both.site');
    fs.writeFileSync(both, 'a.example.com {\n}\nb.example.com {\n}\n');
    let result = t.run(`cmd_add_site invoice-generator a.example.com "${both}"`);
    assert.match(result.stderr, /SITE_FILE_INVALID/);
    result = t.run(`cmd_add_site invoice-generator other.example.com "${t.site('a.example.com')}"`);
    assert.match(result.stderr, /SITE_FILE_INVALID/);
    const imports = t.site('a.example.com', 'import /etc/passwd');
    assert.match(t.run(`cmd_add_site x a.example.com "${imports}"`).stderr, /SITE_FILE_INVALID/);
    assert.match(
      t.run(`cmd_add_site 'Bad Name' a.example.com "${imports}"`).stderr,
      /SITE_NAME_INVALID/,
    );
    assert.match(
      t.run('cmd_add n8n n8n.example.com "127.0.0.1:80;evil"').stderr,
      /SITE_UPSTREAM_INVALID/,
    );
    assert.deepEqual(fs.readdirSync(path.join(t.dir, 'gw/sites')), []);
  } finally {
    t.cleanup();
  }
});

test('managed gateway: add, refuse a taken domain, roll back failed validation and reload', () => {
  const t = setup();
  const sites = path.join(t.dir, 'gw/sites');
  try {
    let result = t.run(
      `cmd_add_site invoice-generator invoice.example.com "${t.site('invoice.example.com')}"`,
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      fs.readFileSync(path.join(sites, 'invoice-generator.caddy'), 'utf8'),
      /^# oss-gateway site invoice-generator invoice\.example\.com/,
    );
    assert.match(
      fs.readFileSync(path.join(t.dir, 'log'), 'utf8'),
      /caddy reload .*--address unix\/\/config\/admin\.sock/,
    );

    result = t.run(
      `cmd_add_site product-hub invoice.example.com "${t.site('invoice.example.com')}"`,
    );
    assert.match(result.stderr, /GATEWAY_SITE_CONFLICT/);
    assert.equal(fs.existsSync(path.join(sites, 'product-hub.caddy')), false);

    const before = fs.readFileSync(path.join(sites, 'invoice-generator.caddy'), 'utf8');
    result = t.run(
      `cmd_add_site invoice-generator invoice.example.com "${t.site('invoice.example.com', 'respond 1')}"`,
      { VALIDATE: 'fail' },
    );
    assert.match(result.stderr, /GATEWAY_CONFIG_INVALID/);
    assert.equal(fs.readFileSync(path.join(sites, 'invoice-generator.caddy'), 'utf8'), before);

    result = t.run(
      `cmd_add_site invoice-generator invoice.example.com "${t.site('invoice.example.com', 'respond 2')}"`,
      { RELOAD: 'fail' },
    );
    assert.match(result.stderr, /GATEWAY_RELOAD_FAILED/);
    assert.equal(fs.readFileSync(path.join(sites, 'invoice-generator.caddy'), 'utf8'), before);

    result = t.run(`cmd_add_site product-hub hub.example.com "${t.site('hub.example.com')}"`, {
      RELOAD: 'fail',
    });
    assert.match(result.stderr, /GATEWAY_RELOAD_FAILED/);
    assert.equal(
      fs.existsSync(path.join(sites, 'product-hub.caddy')),
      false,
      'new site removed after failed reload',
    );

    assert.equal(t.run('cmd_add n8n n8n.example.com 127.0.0.1:5678').status, 0);
    assert.match(
      fs.readFileSync(path.join(sites, 'n8n.caddy'), 'utf8'),
      /reverse_proxy 127\.0\.0\.1:5678/,
    );
    assert.equal(t.run('cmd_remove n8n').status, 0);
    assert.deepEqual(fs.readdirSync(sites).sort(), ['invoice-generator.caddy']);
    assert.ok(
      fs.readdirSync(path.join(t.dir, 'gw/backups')).some((name) => name.startsWith('n8n.caddy.')),
    );
  } finally {
    t.cleanup();
  }
});

test('host Caddy: marked block added, other sites kept, failures restore the original', () => {
  const t = setup();
  const caddyfile = path.join(t.dir, 'host.Caddyfile');
  const original = fs.readFileSync(caddyfile, 'utf8');
  const env = { STATE: 'host-caddy' };
  try {
    let result = t.run(
      `cmd_add_site invoice-generator other.example.com "${t.site('other.example.com')}"`,
      env,
    );
    assert.match(result.stderr, /GATEWAY_SITE_CONFLICT/);
    assert.equal(fs.readFileSync(caddyfile, 'utf8'), original);

    result = t.run(
      `cmd_add_site invoice-generator invoice.example.com "${t.site('invoice.example.com')}"`,
      { ...env, VALIDATE: 'fail' },
    );
    assert.match(result.stderr, /GATEWAY_CONFIG_INVALID/);
    assert.equal(fs.readFileSync(caddyfile, 'utf8'), original);

    result = t.run(
      `cmd_add_site invoice-generator invoice.example.com "${t.site('invoice.example.com')}"`,
      { ...env, RELOAD: 'fail' },
    );
    assert.match(result.stderr, /GATEWAY_RELOAD_FAILED/);
    assert.equal(fs.readFileSync(caddyfile, 'utf8'), original);

    result = t.run(
      `cmd_add_site invoice-generator invoice.example.com "${t.site('invoice.example.com')}"`,
      env,
    );
    assert.equal(result.status, 0, result.stderr);
    let text = fs.readFileSync(caddyfile, 'utf8');
    assert.ok(text.startsWith(original));
    assert.match(
      text,
      /# BEGIN oss-gateway site invoice-generator invoice\.example\.com\ninvoice\.example\.com \{/,
    );
    // Re-adding replaces only its own block.
    assert.equal(
      t.run(
        `cmd_add_site invoice-generator invoice.example.com "${t.site('invoice.example.com')}"`,
        env,
      ).status,
      0,
    );
    text = fs.readFileSync(caddyfile, 'utf8');
    assert.equal(text.match(/# BEGIN oss-gateway site invoice-generator/g).length, 1);
    assert.equal(t.run('cmd_remove invoice-generator', env).status, 0);
    assert.equal(fs.readFileSync(caddyfile, 'utf8').trim(), original.trim());
    assert.ok(fs.readdirSync(t.dir).some((name) => name.startsWith('host.Caddyfile.oss-backup-')));
  } finally {
    t.cleanup();
  }
});

test('unmanageable owners of 80/443 are reported and never changed', () => {
  const t = setup();
  try {
    const result = t.run(
      `cmd_add_site invoice-generator invoice.example.com "${t.site('invoice.example.com')}"`,
      { STATE: 'nginx' },
    );
    assert.match(result.stderr, /GATEWAY_UNAVAILABLE/);
    assert.match(result.stderr, /web-nginx/);
    assert.match(t.run('cmd_create', { STATE: 'nginx' }).stderr, /GATEWAY_UNAVAILABLE/);
    assert.deepEqual(fs.readdirSync(path.join(t.dir, 'gw/sites')), []);
  } finally {
    t.cleanup();
  }
});

test('gateway configuration: socket-only admin, imports project sites, optional private ACME CA', () => {
  const t = setup();
  try {
    let text = t.run('render_main_caddyfile').stdout;
    assert.match(text, /admin unix\/\/config\/admin\.sock/);
    assert.match(text, /^import \/etc\/caddy\/sites\/\*\.caddy$/m);
    assert.doesNotMatch(text, /acme_ca|local_certs/);
    text = t.run('render_main_caddyfile', {
      OSS_GATEWAY_ACME_CA: 'https://127.0.0.1:14000/dir',
    }).stdout;
    assert.match(
      text,
      /acme_ca https:\/\/127\.0\.0\.1:14000\/dir\n\tacme_ca_root \/etc\/caddy\/acme-ca-root\.pem/,
    );
    const compose = t.run('render_compose').stdout;
    for (const token of [
      'network_mode: host',
      "oss.gateway: '1'",
      'read_only: true',
      '- ALL',
      'NET_BIND_SERVICE',
    ])
      assert.ok(compose.includes(token), token);
    assert.doesNotMatch(compose, /ports:|docker\.sock/);
  } finally {
    t.cleanup();
  }
});
