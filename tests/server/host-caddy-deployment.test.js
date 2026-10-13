'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const composeOverride = read('docker-compose.host-caddy.yml');
const helper = read('installer/bundle/lib/host-caddy.sh');

function makeHarness() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-host-caddy-'));
  const bin = path.join(directory, 'bin');
  const caddyfile = path.join(directory, 'Caddyfile');
  const systemctlLog = path.join(directory, 'systemctl.log');
  fs.mkdirSync(bin);
  fs.writeFileSync(caddyfile, 'existing-site.example.com {\n    reverse_proxy 127.0.0.1:5678\n}\n');
  fs.writeFileSync(
    path.join(bin, 'ss'),
    `#!/usr/bin/env bash\nprintf '%s\\n' 'LISTEN 0 4096 0.0.0.0:80 0.0.0.0:* users:(("caddy",pid=100,fd=1))' 'LISTEN 0 4096 0.0.0.0:443 0.0.0.0:* users:(("caddy",pid=100,fd=2))'\n`,
  );
  fs.writeFileSync(
    path.join(bin, 'systemctl'),
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "$MOCK_SYSTEMCTL_LOG"\nif [[ "$1" == is-active ]]; then exit "\${MOCK_CADDY_ACTIVE_STATUS:-0}"; fi\nif [[ "$1" == reload ]]; then exit "\${MOCK_RELOAD_STATUS:-0}"; fi\nexit 0\n`,
  );
  fs.writeFileSync(
    path.join(bin, 'caddy'),
    `#!/usr/bin/env bash\nconfig=''\nwhile [[ $# -gt 0 ]]; do [[ "$1" == --config ]] && { config="$2"; shift 2; continue; }; shift; done\n[[ -n "$config" && -f "$config" ]] || exit 2\nif [[ "\${MOCK_FAIL_INVOICE_VALIDATE:-0}" == 1 ]] && grep -q 'invoice.example.com' "$config"; then exit 1; fi\nexit 0\n`,
  );
  for (const command of ['ss', 'systemctl', 'caddy']) fs.chmodSync(path.join(bin, command), 0o755);
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    MOCK_SYSTEMCTL_LOG: systemctlLog,
  };
  return {
    directory,
    caddyfile,
    systemctlLog,
    env,
    run(command, extraEnv = {}) {
      return spawnSync('bash', ['-c', `. installer/bundle/lib/host-caddy.sh; ${command}`], {
        cwd: root,
        env: { ...env, ...extraEnv },
        encoding: 'utf8',
      });
    },
    cleanup() {
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('Existing host Caddy detection requires file, active service and Caddy listeners on 80/443', () => {
  const h = makeHarness();
  try {
    assert.equal(h.run(`detect_existing_host_caddy '${h.caddyfile}'`).status, 0);
    assert.notEqual(
      h.run(`detect_existing_host_caddy '${h.caddyfile}'`, { MOCK_CADDY_ACTIVE_STATUS: '3' })
        .status,
      0,
    );
    fs.writeFileSync(path.join(h.directory, 'bin', 'ss'), '#!/usr/bin/env bash\nexit 0\n');
    fs.chmodSync(path.join(h.directory, 'bin', 'ss'), 0o755);
    assert.notEqual(h.run(`detect_existing_host_caddy '${h.caddyfile}'`).status, 0);
  } finally {
    h.cleanup();
  }
});

test('Host Caddy Compose override exposes only loopback 127.0.0.1:3001 and preserves app safety controls', () => {
  assert.match(composeOverride, /127\.0\.0\.1:3001:3000/);
  assert.doesNotMatch(composeOverride, /0\.0\.0\.0/);
  assert.match(composeOverride, /caddy:[\s\S]*profiles:[\s\S]*bundled-caddy/);
  const base = read('docker-compose.yml');
  for (const control of [
    'app_data:/app/data',
    'restart: unless-stopped',
    'healthcheck:',
    'read_only: true',
  ])
    assert.match(base, new RegExp(control.replace('/', '\\/')));
});

test('Host Caddy site installation preserves existing site and adds invoice site exactly once', () => {
  const h = makeHarness();
  try {
    const result = h.run(
      `ensure_host_caddy_site '${h.caddyfile}' invoice.example.com 127.0.0.1:3001`,
    );
    assert.equal(result.status, 0, result.stderr);
    const content = fs.readFileSync(h.caddyfile, 'utf8');
    assert.match(content, /existing-site\.example\.com[\s\S]*127\.0\.0\.1:5678/);
    assert.match(content, /invoice\.example\.com[\s\S]*127\.0\.0\.1:3001/);
    assert.equal((content.match(/invoice\.example\.com/g) || []).length, 1);
  } finally {
    h.cleanup();
  }
});

test('Host Caddy site uses the configured domain instead of a fixed Production hostname', () => {
  const h = makeHarness();
  try {
    const result = h.run(
      `ensure_host_caddy_site '${h.caddyfile}' documents.example.net 127.0.0.1:3001`,
    );
    assert.equal(result.status, 0, result.stderr);
    const content = fs.readFileSync(h.caddyfile, 'utf8');
    assert.match(content, /documents\.example\.net[\s\S]*127\.0\.0\.1:3001/);
    assert.doesNotMatch(content, /invoice\.example\.com/);
  } finally {
    h.cleanup();
  }
});

test('Existing invoice site is idempotent and is not appended again', () => {
  const h = makeHarness();
  try {
    assert.equal(
      h.run(`ensure_host_caddy_site '${h.caddyfile}' invoice.example.com 127.0.0.1:3001`).status,
      0,
    );
    const once = fs.readFileSync(h.caddyfile, 'utf8');
    assert.equal(
      h.run(`ensure_host_caddy_site '${h.caddyfile}' invoice.example.com 127.0.0.1:3001`).status,
      0,
    );
    assert.equal(fs.readFileSync(h.caddyfile, 'utf8'), once);
  } finally {
    h.cleanup();
  }
});

test('Candidate Caddy validation failure restores the original file', () => {
  const h = makeHarness();
  try {
    const original = fs.readFileSync(h.caddyfile, 'utf8');
    const result = h.run(
      `ensure_host_caddy_site '${h.caddyfile}' invoice.example.com 127.0.0.1:3001`,
      { MOCK_FAIL_INVOICE_VALIDATE: '1' },
    );
    assert.notEqual(result.status, 0);
    assert.equal(fs.readFileSync(h.caddyfile, 'utf8'), original);
    assert.match(result.stderr, /original restored/);
  } finally {
    h.cleanup();
  }
});

test('Successful host Caddy change uses reload and never restart', () => {
  const h = makeHarness();
  try {
    assert.equal(
      h.run(`ensure_host_caddy_site '${h.caddyfile}' invoice.example.com 127.0.0.1:3001`).status,
      0,
    );
    const calls = fs.readFileSync(h.systemctlLog, 'utf8');
    assert.match(calls, /^reload caddy$/m);
    assert.doesNotMatch(calls, /restart/);
  } finally {
    h.cleanup();
  }
});

test('Host Caddy helper rejects domain injection before changing the Caddyfile', () => {
  const h = makeHarness();
  try {
    const original = fs.readFileSync(h.caddyfile, 'utf8');
    const invalidDomains = [
      '',
      'invoice example.com',
      'https://invoice.example.com',
      'invoice.example.com/path',
      'invoice.example.com:443',
      'invoice.example.com;touch /tmp/pwned',
      'invoice.example.com\nrespond hacked',
      'invoice.example.com { }',
    ];
    for (const domain of invalidDomains) {
      const encoded = Buffer.from(domain).toString('base64');
      const result = h.run(
        `domain="$(printf %s '${encoded}' | base64 --decode)"; ensure_host_caddy_site '${h.caddyfile}' "$domain" 127.0.0.1:3001`,
      );
      assert.notEqual(result.status, 0, `unexpectedly accepted domain: ${JSON.stringify(domain)}`);
      assert.equal(fs.readFileSync(h.caddyfile, 'utf8'), original);
      assert.match(result.stderr, /invalid domain/);
    }
  } finally {
    h.cleanup();
  }
});

test('Host Caddy helper validates before and after change and keeps a timestamped backup', () => {
  assert.match(helper, /validate_host_caddy_file "\$caddy_file"/);
  assert.match(helper, /Caddyfile\.backup-|backup-\$\{timestamp\}/);
  assert.match(helper, /validate_host_caddy_file "\$temporary_file"/);
  assert.match(helper, /validate_host_caddy_file "\$caddy_file"/g);
  assert.match(helper, /cp -a -- "\$backup_file" "\$caddy_file"/);
});
