'use strict';
// Real-browser checks for the administration UI: bilingual labels, the customer form and
// detail layout on desktop and mobile, archive / restore / permanent deletion, role-based
// actions and untouched English document previews. Drives headless Chrome over the
// DevTools protocol (no extra dependencies) against a real server with a temporary database.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { loadConfig } = require('../../server/config');
const { createApp } = require('../../server/app');
const { initializeAdmin } = require('../../server/auth/auth-service');

const ADMIN = { username: 'browser-admin', password: 'TEST-browser-admin-0001' };
const EMPLOYEE = { username: 'browser-employee', password: 'TEST-browser-employee-0001' };
const DESKTOP = { width: 1366, height: 900, mobile: false };
const MOBILE = { width: 390, height: 844, mobile: true };
const ARTIFACTS = process.env.BROWSER_TEST_ARTIFACTS || '';

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || '';
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- DevTools protocol client
class Browser {
  static async launch(executable) {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-browser-profile-'));
    const child = spawn(
      executable,
      [
        '--headless=new',
        '--remote-debugging-port=0',
        `--user-data-dir=${profile}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--disable-extensions',
        // CI runners (Ubuntu 24.04) may not allow Chrome's user-namespace sandbox.
        ...(process.getuid?.() === 0 || process.env.CI ? ['--no-sandbox'] : []),
        'about:blank',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    const endpoint = await new Promise((resolve, reject) => {
      let buffer = '';
      const timer = setTimeout(() => reject(new Error('Chrome did not start')), 30000);
      child.stderr.on('data', (chunk) => {
        buffer += chunk;
        const match = buffer.match(/DevTools listening on (ws:\/\/\S+)/);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
      child.on('exit', (code) => reject(new Error(`Chrome exited early (${code})`)));
    });
    const socket = new WebSocket(endpoint);
    await new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = reject;
    });
    return new Browser(child, socket, profile);
  }
  constructor(child, socket, profile) {
    this.child = child;
    this.socket = socket;
    this.profile = profile;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    socket.onmessage = ({ data }) => {
      const message = JSON.parse(data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error)
          reject(new Error(`${message.error.message} ${message.error.data || ''}`));
        else resolve(message.result);
      } else for (const listener of this.listeners) listener(message);
    };
  }
  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  async newPage(viewport) {
    const { browserContextId } = await this.send('Target.createBrowserContext');
    const { targetId } = await this.send('Target.createTarget', {
      url: 'about:blank',
      browserContextId,
    });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new Page(this, sessionId);
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: viewport.mobile ? 2 : 1,
      mobile: viewport.mobile,
    });
    if (viewport.mobile) await page.send('Emulation.setTouchEmulationEnabled', { enabled: true });
    return page;
  }
  async close() {
    try {
      await this.send('Browser.close');
    } catch {}
    this.socket.close();
    await sleep(300);
    this.child.kill('SIGKILL');
    fs.rmSync(this.profile, { recursive: true, force: true });
  }
}
class Page {
  constructor(browser, sessionId) {
    this.browser = browser;
    this.sessionId = sessionId;
    this.errors = [];
    browser.listeners.add((message) => {
      if (message.sessionId !== sessionId) return;
      if (message.method === 'Runtime.exceptionThrown')
        this.errors.push(message.params.exceptionDetails.exception?.description || 'exception');
      if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error')
        this.errors.push(message.params.args.map((arg) => arg.value ?? arg.description).join(' '));
    });
  }
  send(method, params) {
    return this.browser.send(method, params, this.sessionId);
  }
  async evaluate(fn, ...args) {
    const result = await this.send('Runtime.evaluate', {
      expression: `(${fn})(...${JSON.stringify(args)})`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails)
      throw new Error(result.exceptionDetails.exception?.description || 'evaluation failed');
    return result.result.value;
  }
  async waitFor(fn, args = [], { timeout = 10000, message = 'condition' } = {}) {
    const end = Date.now() + timeout;
    let last;
    while (Date.now() < end) {
      last = await this.evaluate(fn, ...args).catch((err) => err.message);
      if (last === true) return;
      await sleep(80);
    }
    throw new Error(`Timed out waiting for ${message} (last: ${JSON.stringify(last)})`);
  }
  async goto(url) {
    await this.send('Page.navigate', { url });
    await this.waitFor(() => document.readyState === 'complete', [], { message: `load ${url}` });
  }
  click(selector) {
    return this.evaluate((s) => {
      const element = document.querySelector(s);
      if (!element) throw new Error(`missing ${s}`);
      element.scrollIntoView({ block: 'center' });
      element.click();
      return true;
    }, selector);
  }
  type(selector, value) {
    return this.evaluate(
      (s, v) => {
        const element = document.querySelector(s);
        if (!element) throw new Error(`missing ${s}`);
        element.focus();
        element.value = v;
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      },
      selector,
      value,
    );
  }
  async screenshot(name, { full = false } = {}) {
    if (!ARTIFACTS) return;
    fs.mkdirSync(ARTIFACTS, { recursive: true });
    const options = { format: 'png' };
    if (full) {
      const { cssContentSize } = await this.send('Page.getLayoutMetrics');
      Object.assign(options, {
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width: cssContentSize.width, height: cssContentSize.height, scale: 1 },
      });
    }
    const { data } = await this.send('Page.captureScreenshot', options);
    fs.writeFileSync(path.join(ARTIFACTS, `${name}.png`), Buffer.from(data, 'base64'));
  }
}

// ---------------------------------------------------------------- server and API helpers
async function startServer() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-browser-ui-'));
  const port = await freePort();
  const config = loadConfig({
    NODE_ENV: 'test',
    PORT: String(port),
    SESSION_SECRET: randomBytes(32).toString('hex'),
    AUTH_DB_PATH: path.join(directory, 'auth.sqlite'),
  });
  const runtime = await createApp(config);
  await initializeAdmin(runtime.db, ADMIN.username, ADMIN.password);
  const server = runtime.app.listen(port, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  return {
    runtime,
    url: config.origin,
    async stop() {
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      });
      runtime.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}
function apiClient(base) {
  let cookie = '';
  async function request(route, { method = 'GET', body, headers = {} } = {}) {
    const response = await fetch(base + route, {
      method,
      redirect: 'manual',
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const set = response.headers.getSetCookie();
    if (set.length) cookie = set[set.length - 1].split(';')[0];
    let data = {};
    try {
      data = await response.json();
    } catch {}
    return { status: response.status, data };
  }
  async function write(route, method, body, headers = {}) {
    const token = (await request('/api/auth/csrf')).data.csrfToken;
    return request(route, {
      method,
      body,
      headers: { Origin: base, 'X-CSRF-Token': token, ...headers },
    });
  }
  return {
    request,
    write,
    async login(username, password) {
      const html = await (await fetch(`${base}/login`)).text();
      const token = html.match(/name="csrf-token" content="([a-f0-9]+)"/)[1];
      const result = await request('/api/auth/login', {
        method: 'POST',
        body: { username, password },
        headers: { Origin: base, 'X-CSRF-Token': token },
      });
      assert.equal(result.status, 200, 'API login');
    },
  };
}
const company = {
  id: 'main',
  documentMode: 'Test',
  testMode: true,
  englishName: 'Example Enterprise Testing Co., Ltd.',
  address: '123 Test Street',
  signatureImage: 'TEST_SIGNATURE',
  companyStampImage: 'TEST_STAMP',
  accounts: [
    { id: 'test-bank', currency: 'USD', accountNumber: '000000000000', swift: 'TESTBANKXXX' },
  ],
};
const customer = (id, name, extra = {}) => ({
  id,
  buyerType: 'Company',
  companyName: name,
  buyerName: name,
  country: 'Testland',
  ...extra,
});
const order = (id, customerId) => ({
  id,
  customerId,
  createdDate: '2026-09-11',
  testMode: true,
  paymentAccountId: 'test-bank',
  items: [
    { id: `line-${id}`, description: 'TEST Product', quantity: 10, unit: 'PCS', unitPrice: 10 },
  ],
});

// ---------------------------------------------------------------- browser-side checks
async function login(page, base, user) {
  await page.goto(`${base}/login`);
  await page.type('#username', user.username);
  await page.type('#password', user.password);
  await page.evaluate(() => {
    document.querySelector('form').requestSubmit();
    return true;
  });
  await page.waitFor(
    () => location.pathname === '/' && !!document.querySelector('#page-title .i18n-zh'),
    [],
    {
      timeout: 15000,
      message: 'application after login',
    },
  );
  // Archive and delete use native confirm() for the reversible step; accept it in tests.
  await page.evaluate(() => {
    window.confirm = () => true;
    window.alert = () => {};
    return true;
  });
}
async function openPage(page, name) {
  await page.click(`#main-nav [data-page="${name}"]`);
  await page.waitFor(
    (n) => document.querySelector(`#main-nav [data-page="${n}"]`)?.classList.contains('active'),
    [name],
    {
      message: `page ${name}`,
    },
  );
  await sleep(150);
}
// UI chrome (titles, labels, headers, buttons) that is English-only outside documents.
function englishOnlyChrome() {
  const allowed =
    /^(PI|CI|SKU|HS Code|CBM|PDF|ZIP|CSV|JSON|IBAN|SWIFT\/BIC|Incoterms® 2020|Final PI|Final CI|Draft PI|Packing List|PL|ID|IP|USD|N\.W\.|G\.W\.|[A-Z]{3}|[\d\s.,:/()+-]*)$/;
  const roots = [
    document.querySelector('#page-content'),
    document.querySelector('#modal:not(.hidden) .modal'),
    document.querySelector('.topbar'),
  ];
  const found = new Set();
  for (const root of roots.filter(Boolean)) {
    for (const element of root.querySelectorAll('h1,h2,h3,h4,label,th,button,summary,legend,dt')) {
      if (element.closest('.paper,[data-no-i18n],.record-title') || element.offsetParent === null)
        continue;
      const text = element.textContent.replace(/\s+/g, ' ').trim();
      if (!text || /[㐀-鿿]/.test(text) || allowed.test(text)) continue;
      if (/@|^\S+\.\S+$/.test(text)) continue;
      found.add(`${element.tagName}: ${text}`);
    }
  }
  return [...found];
}
// Optional report (BROWSER_TEST_REPORT=1): every visible English-only text outside documents.
function englishOnlyText() {
  const found = new Set();
  const walker = document.createTreeWalker(document.querySelector('#app'), NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode,
      parent = node.parentElement,
      text = node.nodeValue.replace(/\s+/g, ' ').trim();
    if (!text || !/[A-Za-z]{3}/.test(text) || /[\u3400-\u9fff]/.test(text)) continue;
    if (
      parent.closest(
        '.paper,td,[data-no-i18n],.record-title,.record-sub,option,script,textarea,.i18n-en',
      ) ||
      parent.offsetParent === null
    )
      continue;
    found.add(`${parent.tagName}.${parent.className || ''}: ${text.slice(0, 80)}`);
  }
  return [...found];
}
// Form labels inside root that are cut off horizontally.
function clippedLabels(selector) {
  return [...document.querySelectorAll(`${selector} .field > label`)]
    .filter((label) => label.offsetParent !== null && label.scrollWidth > label.clientWidth + 1)
    .map((label) => label.textContent.trim());
}
// Layout facts of the customer form or detail inside the open dialog.
function customerLayout(selector) {
  const root = document.querySelector(selector);
  if (!root) return { error: `missing ${selector}` };
  const modal = document.querySelector('#modal .modal');
  const sections = [...root.querySelectorAll('.customer-form-section,.customer-detail-section')];
  const columns = sections.map((section) => {
    const cells = [
      ...section.querySelectorAll(
        '.customer-field:not(.customer-field-wide),.customer-detail-item:not(.wide)',
      ),
    ];
    return new Set(cells.map((cell) => Math.round(cell.getBoundingClientRect().left))).size;
  });
  const labels = [...root.querySelectorAll('label, dt')].map((label) => {
    const box = label.getBoundingClientRect(),
      parent = label.parentElement.getBoundingClientRect();
    return {
      text: label.textContent.trim(),
      bilingual: !!label.querySelector('.i18n-zh') && !!label.querySelector('.i18n-en'),
      clipped:
        label.scrollWidth > label.clientWidth + 1 ||
        box.right > parent.right + 1 ||
        box.left < parent.left - 1,
    };
  });
  const controls = [...root.querySelectorAll('input:not([type=hidden]),select')].map((control) => ({
    name: control.name,
    height: Math.round(control.getBoundingClientRect().height),
    fills:
      control.getBoundingClientRect().width >=
      control.parentElement.getBoundingClientRect().width - 2,
  }));
  return {
    columns,
    labels,
    controls,
    modalOverflow: modal.scrollWidth > modal.clientWidth + 1,
    pageOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
  };
}
function assertCustomerLayout(layout, { columns, context }) {
  assert.ok(!layout.error, layout.error);
  for (const count of layout.columns.filter((value) => value > 0))
    assert.ok(
      count <= columns,
      `${context}: expected at most ${columns} columns, got ${layout.columns}`,
    );
  assert.ok(
    layout.columns.some((value) => value === columns),
    `${context}: no section uses ${columns} column(s): ${layout.columns}`,
  );
  const clipped = layout.labels.filter((label) => label.clipped);
  assert.deepEqual(clipped, [], `${context}: labels must be fully visible`);
  const monolingual = layout.labels.filter((label) => !label.bilingual);
  assert.deepEqual(monolingual, [], `${context}: labels must be bilingual`);
  assert.equal(layout.modalOverflow, false, `${context}: dialog must not scroll sideways`);
  assert.equal(layout.pageOverflow, false, `${context}: page must not scroll sideways`);
  if (layout.controls.length) {
    const heights = new Set(layout.controls.map((control) => control.height));
    assert.equal(heights.size, 1, `${context}: inputs share one height (${[...heights]})`);
    assert.ok([...heights][0] >= 38, `${context}: inputs are at least 38px high`);
    assert.deepEqual(
      layout.controls.filter((control) => !control.fills),
      [],
      `${context}: inputs fill their column`,
    );
  }
}

// ---------------------------------------------------------------- scenarios
async function run() {
  const executable = findChrome();
  if (!executable) {
    if (process.env.CI) throw new Error('Chrome is required for the browser UI test in CI');
    console.log('SKIP browser UI test: Chrome/Chromium not found (set CHROME_PATH)');
    return;
  }
  const server = await startServer();
  const browser = await Browser.launch(executable);
  const results = [];
  const step = async (name, fn) => {
    await fn();
    results.push(name);
    console.log(`PASS ${name}`);
  };
  try {
    const admin = apiClient(server.url);
    await admin.login(ADMIN.username, ADMIN.password);
    assert.equal(
      (await admin.write('/api/company/main', 'PUT', company, { 'If-Match': '0' })).status,
      200,
    );
    for (const [id, name] of [
      ['customer-with-order', 'Ordering Buyer Testing Ltd.'],
      ['customer-plain', 'Plain Buyer Testing Ltd.'],
    ])
      assert.equal((await admin.write('/api/customers', 'POST', customer(id, name))).status, 201);
    assert.equal(
      (await admin.write('/api/orders', 'POST', order('order-1', 'customer-with-order'))).status,
      201,
    );
    // An order with documents and a payment so the editor shows its CI and payment sections.
    const created = await admin.write('/api/orders', 'POST', {
      ...order('order-docs', 'customer-with-order'),
      namedPlace: 'Test Port, Testland',
      namedPlaceConfirmed: true,
    });
    assert.equal(created.status, 201);
    let version = created.data.meta.rowVersion;
    for (const [action, body] of [
      [
        'payment-tracking',
        {
          paymentRecords: [{ id: 'pay-1', amount: 30, currency: 'USD', status: 'Confirmed' }],
          currentPaymentStage: 'Deposit Requested',
        },
      ],
      ['finalize-pi', { signingMode: 'Electronic' }],
      ['generate-ci', {}],
    ]) {
      const result = await admin.write(`/api/orders/order-docs/${action}`, 'POST', body, {
        'If-Match': String(version),
      });
      assert.equal(result.status, 200, `${action}: ${JSON.stringify(result.data)}`);
      version = result.data.meta.rowVersion;
    }
    assert.equal(
      (
        await admin.write('/api/products', 'POST', {
          id: 'product-1',
          englishName: 'TEST Widget',
          sku: 'TEST-W1',
          unit: 'PCS',
        })
      ).status,
      201,
    );
    await admin.write('/api/users', 'POST', {
      username: EMPLOYEE.username,
      email: 'browser-employee@example.invalid',
      displayName: 'BROWSER EMPLOYEE',
      temporaryPassword: 'TEST-temporary-pass-0001',
    });
    const employeeApi = apiClient(server.url);
    await employeeApi.login(EMPLOYEE.username, 'TEST-temporary-pass-0001');
    await employeeApi.write('/api/auth/change-password', 'POST', {
      currentPassword: 'TEST-temporary-pass-0001',
      newPassword: EMPLOYEE.password,
      confirmPassword: EMPLOYEE.password,
    });
    await employeeApi.write(
      '/api/customers',
      'POST',
      customer('customer-employee', 'Employee Buyer Testing Ltd.'),
    );

    const page = await browser.newPage(DESKTOP);
    await login(page, server.url, ADMIN);

    await step('page titles and table headers are bilingual', async () => {
      const title = await page.evaluate(() => document.querySelector('#page-title').textContent);
      assert.match(title, /首页仪表盘\s*Dashboard/);
      await openPage(page, 'customers');
      const headers = await page.evaluate(() =>
        [...document.querySelectorAll('.customer-table th')].map((th) => [
          th.querySelector('.i18n-zh')?.textContent,
          th.querySelector('.i18n-en')?.textContent,
        ]),
      );
      assert.deepEqual(headers[0], ['客户', 'Customer']);
      assert.ok(
        headers.every(([zh, en]) => zh && en),
        JSON.stringify(headers),
      );
    });

    await step(
      'every page keeps titles, labels, headers and buttons free of English-only text',
      async () => {
        const problems = {};
        for (const name of [
          'dashboard',
          'orders',
          'customers',
          'products',
          'company',
          'backup',
          'users',
          'audit',
          'account',
          'help',
        ]) {
          await openPage(page, name);
          await page.screenshot(`desktop-page-${name}`);
          if (process.env.BROWSER_TEST_REPORT)
            console.log(
              `REPORT ${name}:`,
              JSON.stringify(await page.evaluate(englishOnlyText), null, 1),
            );
          const found = await page.evaluate(englishOnlyChrome);
          if (found.length) problems[name] = found;
        }
        await page.click('[data-action="new-order"]');
        await page.waitFor(() => !!document.querySelector('#order-form'), [], {
          message: 'order editor',
        });
        await sleep(200);
        await page.screenshot('desktop-page-order-edit');
        if (process.env.BROWSER_TEST_REPORT)
          console.log(
            'REPORT order-edit:',
            JSON.stringify(await page.evaluate(englishOnlyText), null, 1),
          );
        const editor = await page.evaluate(englishOnlyChrome);
        if (editor.length) problems['order-edit'] = editor;
        await openPage(page, 'orders');
        await page.click('[data-edit-order="order-docs"]');
        await page.waitFor(
          () => !!document.querySelector('#order-form [data-order-section="ci"]'),
          [],
          { message: 'order with CI' },
        );
        await page.evaluate(() => {
          document.querySelectorAll('#order-form details').forEach((d) => (d.open = true));
          return true;
        });
        await sleep(200);
        await page.screenshot('desktop-page-order-documents', { full: true });
        if (process.env.BROWSER_TEST_REPORT)
          console.log(
            'REPORT order-documents:',
            JSON.stringify(await page.evaluate(englishOnlyText), null, 1),
          );
        const documents = await page.evaluate(englishOnlyChrome);
        if (documents.length) problems['order-documents'] = documents;
        const clipped = await page.evaluate(clippedLabels, '#order-form');
        if (clipped.length) problems['order-documents clipped labels'] = clipped;
        assert.deepEqual(problems, {});
      },
    );

    await step(
      'document previews and PDFs stay English (no UI translation inside the document)',
      async () => {
        await page.evaluate(() => {
          window.testDirty = true;
          return true;
        });
        await openPage(page, 'preview');
        await page.waitFor(() => !!document.querySelector('.paper'), [], {
          message: 'document preview',
        });
        const paper = await page.evaluate(() => ({
          translated: document.querySelectorAll('.paper .i18n-zh, .paper .i18n-en').length,
          text: document.querySelector('.paper').textContent,
        }));
        assert.equal(paper.translated, 0);
        assert.match(paper.text, /PROFORMA INVOICE/);
      },
    );

    await openPage(page, 'customers');
    await step(
      'new customer form: two columns, complete bilingual labels, even inputs (desktop)',
      async () => {
        await page.click('[data-new-customer]');
        await page.waitFor(() => !!document.querySelector('#customer-form'), [], {
          message: 'customer form',
        });
        const title = await page.evaluate(() => document.querySelector('#modal-title').textContent);
        assert.match(title, /新增客户\s*New Customer/);
        assertCustomerLayout(await page.evaluate(customerLayout, '#customer-form'), {
          columns: 2,
          context: 'desktop form',
        });
        await page.screenshot('desktop-customer-form');
      },
    );

    await step('saving a new customer stores every field unchanged', async () => {
      await page.type('#customer-field-companyName', 'Browser Buyer Testing Ltd.');
      await page.type('#customer-field-buyerName', 'Browser Buyer Testing Ltd.');
      await page.type('#customer-field-country', 'Testland');
      await page.type('#customer-field-contactPerson', 'Alex Example');
      await page.type('#customer-field-email', 'alex@example.invalid');
      await page.type('#customer-field-consigneeAddress', '9 Harbour Road');
      await page.evaluate(() => {
        document.querySelector('#customer-form').requestSubmit();
        return true;
      });
      await page.waitFor(() => document.querySelector('#modal').classList.contains('hidden'), [], {
        message: 'form closed',
      });
      const list = (await admin.request('/api/customers')).data.data;
      const saved = list.find((item) => item.companyName === 'Browser Buyer Testing Ltd.');
      assert.ok(saved, 'customer saved');
      assert.equal(saved.contactPerson, 'Alex Example');
      assert.equal(saved.email, 'alex@example.invalid');
      assert.equal(saved.consigneeAddress, '9 Harbour Road');
      assert.equal(saved.buyerType, 'Company');
      page.newCustomerId = saved.id;
    });

    await step('editing a customer keeps its data and saves the change', async () => {
      await page.click(`[data-edit-customer="${page.newCustomerId}"]`);
      await page.waitFor(() => !!document.querySelector('#customer-form'), [], {
        message: 'edit form',
      });
      const prefilled = await page.evaluate(
        () => document.querySelector('#customer-field-contactPerson').value,
      );
      assert.equal(prefilled, 'Alex Example');
      await page.type('#customer-field-telephone', '+00 123 4567');
      await page.evaluate(() => {
        document.querySelector('#customer-form').requestSubmit();
        return true;
      });
      await page.waitFor(() => document.querySelector('#modal').classList.contains('hidden'), [], {
        message: 'edit closed',
      });
      const saved = (await admin.request(`/api/customers/${page.newCustomerId}`)).data.data;
      assert.equal(saved.telephone, '+00 123 4567');
      assert.equal(saved.contactPerson, 'Alex Example');
    });

    await step('customer detail shows grouped, bilingual sections', async () => {
      await page.click(`[data-view-customer="${page.newCustomerId}"]`);
      await page.waitFor(() => !!document.querySelector('.customer-detail'), [], {
        message: 'detail',
      });
      const detail = await page.evaluate(() => ({
        sections: [...document.querySelectorAll('.customer-detail-section h4 .i18n-zh')].map(
          (x) => x.textContent,
        ),
        telephone: document.querySelector('.customer-detail').textContent.includes('+00 123 4567'),
      }));
      assert.deepEqual(detail.sections, ['客户主体', '主要联系人', '买方地址', '收货人']);
      assert.ok(detail.telephone);
      assertCustomerLayout(await page.evaluate(customerLayout, '.customer-detail'), {
        columns: 2,
        context: 'desktop detail',
      });
      await page.click('#modal [data-close-modal]');
    });

    await step(
      'archive hides a customer, the archived view shows it and restore brings it back',
      async () => {
        await page.click(`[data-archive-record][data-id="${page.newCustomerId}"]`);
        await page.waitFor(
          (id) => !document.querySelector(`[data-view-customer="${id}"]`),
          [page.newCustomerId],
          { message: 'archived row hidden' },
        );
        await page.click('[data-record-view="customers"][data-view="archived"]');
        await page.waitFor(
          (id) => !!document.querySelector(`[data-restore-record][data-id="${id}"]`),
          [page.newCustomerId],
          { message: 'archived view' },
        );
        await page.click(`[data-restore-record][data-id="${page.newCustomerId}"]`);
        await page.waitFor(
          (id) => !document.querySelector(`[data-restore-record][data-id="${id}"]`),
          [page.newCustomerId],
          { message: 'restored' },
        );
        await page.click('[data-record-view="customers"][data-view="active"]');
        await page.waitFor(
          (id) => !!document.querySelector(`[data-view-customer="${id}"]`),
          [page.newCustomerId],
          { message: 'active again' },
        );
      },
    );

    await step(
      'permanent delete needs the typed phrase and removes the customer from the server',
      async () => {
        await page.click(`[data-delete-record][data-id="${page.newCustomerId}"]`);
        await page.waitFor(() => !!document.querySelector('#permanent-delete-form'), [], {
          message: 'delete dialog',
        });
        const before = await page.evaluate(
          () => document.querySelector('#permanent-delete-form [type=submit]').disabled,
        );
        assert.equal(before, true);
        await page.type('#permanent-delete-confirm', '删除');
        assert.equal(
          await page.evaluate(
            () => document.querySelector('#permanent-delete-form [type=submit]').disabled,
          ),
          true,
        );
        await page.type('#permanent-delete-confirm', '永久删除');
        assert.equal(
          await page.evaluate(
            () => document.querySelector('#permanent-delete-form [type=submit]').disabled,
          ),
          false,
        );
        await page.screenshot('desktop-delete-dialog');
        await page.evaluate(() => {
          document.querySelector('#permanent-delete-form').requestSubmit();
          return true;
        });
        await page.waitFor(
          (id) =>
            !document.querySelector(`[data-view-customer="${id}"]`) &&
            document.querySelector('#modal').classList.contains('hidden'),
          [page.newCustomerId],
          { message: 'deleted' },
        );
        assert.equal((await admin.request(`/api/customers/${page.newCustomerId}`)).status, 404);
      },
    );

    await step('a customer with orders cannot be deleted and the dialog explains why', async () => {
      await page.click('[data-delete-record][data-id="customer-with-order"]');
      await page.waitFor(() => !!document.querySelector('.delete-blocked'), [], {
        message: 'blocked dialog',
      });
      const text = await page.evaluate(() => document.querySelector('.delete-blocked').textContent);
      assert.match(text, /2 个订单使用该客户/);
      assert.equal(
        await page.evaluate(() => !!document.querySelector('#permanent-delete-form')),
        false,
      );
      await page.click('#modal [data-close-modal]');
      assert.equal((await admin.request('/api/customers/customer-with-order')).status, 200);
    });

    await step('product form labels are bilingual and fully visible', async () => {
      await openPage(page, 'products');
      await page.click('[data-new-product]');
      await page.waitFor(() => !!document.querySelector('#product-form'), [], {
        message: 'product form',
      });
      const form = await page.evaluate(() => ({
        title: document.querySelector('#modal-title').textContent,
        labels: [...document.querySelectorAll('#product-form .field > label')].map((l) => [
          !!l.querySelector('.i18n-zh'),
          l.textContent.trim(),
        ]),
      }));
      assert.match(form.title, /新增产品\s*New Product/);
      assert.deepEqual(
        form.labels.filter(([bilingual]) => !bilingual),
        [],
      );
      assert.deepEqual(await page.evaluate(clippedLabels, '#product-form'), []);
      await page.screenshot('desktop-product-form');
      await page.click('#modal [data-close-modal]');
    });

    await step(
      'order and product lists offer void/archive and delete; admin may delete products',
      async () => {
        await openPage(page, 'orders');
        const orderActions = await page.evaluate(() =>
          [...document.querySelectorAll('.order-actions button')].map((b) => b.textContent.trim()),
        );
        assert.ok(
          orderActions.includes('作废') && orderActions.includes('删除'),
          orderActions.join(),
        );
        await openPage(page, 'products');
        const productActions = await page.evaluate(() =>
          [...document.querySelectorAll('.product-actions button')].map((b) =>
            b.textContent.trim(),
          ),
        );
        assert.deepEqual(productActions, ['编辑', '归档', '删除']);
      },
    );

    await step('no browser errors during the admin session', async () => {
      assert.deepEqual(page.errors, []);
    });

    const mobile = await browser.newPage(MOBILE);
    await login(mobile, server.url, ADMIN);
    await step(
      'mobile: customer form and detail use one column without sideways scrolling',
      async () => {
        await mobile.evaluate(() => {
          document.querySelector('#main-nav [data-page="customers"]').click();
          return true;
        });
        await mobile.waitFor(() => !!document.querySelector('.customer-table'), [], {
          message: 'mobile customers',
        });
        assert.equal(
          await mobile.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth + 1,
          ),
          true,
        );
        await mobile.click('[data-new-customer]');
        await mobile.waitFor(() => !!document.querySelector('#customer-form'), [], {
          message: 'mobile form',
        });
        assertCustomerLayout(await mobile.evaluate(customerLayout, '#customer-form'), {
          columns: 1,
          context: 'mobile form',
        });
        await mobile.screenshot('mobile-customer-form');
        await mobile.click('#modal [data-close-modal]');
        await mobile.click('[data-view-customer="customer-plain"]');
        await mobile.waitFor(() => !!document.querySelector('.customer-detail'), [], {
          message: 'mobile detail',
        });
        assertCustomerLayout(await mobile.evaluate(customerLayout, '.customer-detail'), {
          columns: 1,
          context: 'mobile detail',
        });
        await mobile.screenshot('mobile-customer-detail');
        assert.deepEqual(mobile.errors, []);
      },
    );

    const employee = await browser.newPage(DESKTOP);
    await login(employee, server.url, EMPLOYEE);
    await step('employee: only own customers, no product deletion', async () => {
      await openPage(employee, 'customers');
      const names = await employee.evaluate(() =>
        [...document.querySelectorAll('[data-view-customer]')].map((b) => b.textContent),
      );
      assert.deepEqual(names, ['Employee Buyer Testing Ltd.']);
      await openPage(employee, 'products');
      const actions = await employee.evaluate(() =>
        [...document.querySelectorAll('.product-actions button')].map((b) => b.textContent.trim()),
      );
      assert.deepEqual(actions, ['编辑', '归档']);
      assert.deepEqual(employee.errors, []);
    });
    console.log(`\n${results.length}/${results.length} browser UI checks passed`);
  } finally {
    await browser.close();
    await server.stop();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
