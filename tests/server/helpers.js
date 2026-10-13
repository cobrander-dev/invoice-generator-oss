'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { randomBytes } = require('node:crypto');
const { loadConfig } = require('../../server/config');
const { createApp } = require('../../server/app');
const { initializeAdmin } = require('../../server/auth/auth-service');

const TEST_USERNAME = 'test-admin';
const TEST_PASSWORD = 'TEST-only-passphrase-0000-invalid';
async function fixture(overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-auth-test-'));
  const config = {
    ...loadConfig({
      NODE_ENV: 'test',
      SESSION_SECRET: randomBytes(32).toString('hex'),
      AUTH_DB_PATH: path.join(directory, 'auth.sqlite'),
    }),
    ...overrides,
  };
  const runtime = await createApp(config);
  const user = await initializeAdmin(runtime.db, TEST_USERNAME, TEST_PASSWORD);
  const server = runtime.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  // Keep the configured exact origin fixed; tests send it explicitly (including TLS proxy tests).
  function client() {
    let cookie = '';
    return {
      get cookie() {
        return cookie;
      },
      set cookie(value) {
        cookie = value;
      },
      async request(route, options = {}) {
        const headers = {
          ...(config.production ? { 'X-Forwarded-Proto': 'https' } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
          ...options.headers,
        };
        const response = await fetch(url + route, { ...options, headers, redirect: 'manual' });
        const set = response.headers.getSetCookie();
        if (set.length) cookie = set[set.length - 1].split(';')[0];
        return response;
      },
      async csrf() {
        const response = await this.request('/login');
        const html = await response.text();
        return html.match(/name="csrf-token" content="([a-f0-9]+)"/)[1];
      },
      async login(username = TEST_USERNAME, password = TEST_PASSWORD) {
        const token = await this.csrf();
        return this.request('/api/auth/login', {
          method: 'POST',
          headers: {
            Origin: config.origin,
            'X-CSRF-Token': token,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ username, password }),
        });
      },
      async write(route, { csrf = true, origin = config.origin, body } = {}) {
        const response = csrf ? await this.request('/api/auth/csrf') : null;
        const token = response?.ok ? (await response.json()).csrfToken : '';
        return this.request(route, {
          method: 'POST',
          headers: {
            ...(origin !== null ? { Origin: origin } : {}),
            ...(csrf ? { 'X-CSRF-Token': token } : {}),
            'Content-Type': 'application/json',
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      },
    };
  }
  return {
    ...runtime,
    config,
    directory,
    url,
    user,
    client,
    async cleanup() {
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      });
      runtime.close();
      fs.rmSync(directory, { recursive: true, force: true }); // Exact mkdtemp-owned TEST directory only.
    },
  };
}
module.exports = { fixture, TEST_USERNAME, TEST_PASSWORD };
