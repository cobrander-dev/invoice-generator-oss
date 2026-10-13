'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
global.window = global;
const C = require('../js/core.js');
require('../js/sample-data.js');
global.jspdf = require('jspdf');
require('jspdf-autotable');
global.JSZip = require('jszip');
require('../js/pdf.js');
const { readSource } = require('./source-text');

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error: error.stack });
  }
}
const sample = global.FTSample,
  ctx = { company: sample.company, customers: sample.customers, orders: sample.orders };

test('可靠金额计算：100 × 128.50', () => {
  const o = C.calculateOrder({
    items: [{ quantity: 100, unitPrice: 128.5, netWeight: 1, grossWeight: 2, cartonQty: 1 }],
  });
  assert.strictEqual(o.subtotal, 12850);
});
test('运费、保险、其他费用与折扣', () => {
  const o = C.calculateOrder({
    items: [{ quantity: 3, unitPrice: 0.1 }],
    freight: 0.2,
    insurance: 0.1,
    otherCharges: 1,
    discount: 0.3,
  });
  assert.strictEqual(o.total, 1.3);
});
test('30% 定金与尾款', () => {
  const o = C.calculateOrder({ items: [{ quantity: 1, unitPrice: 100 }], depositPercentage: 30 });
  assert.strictEqual(o.depositAmount, 30);
  assert.strictEqual(o.balanceAmount, 70);
});
test('已付和待付', () => {
  const o = C.calculateOrder({ items: [{ quantity: 1, unitPrice: 100 }], amountPaid: 40 });
  assert.strictEqual(o.amountDue, 60);
});
test('重量和 CBM 自动汇总', () => {
  const o = C.calculateOrder({
    items: [
      {
        quantity: 10,
        unitPrice: 1,
        netWeight: 2,
        grossWeight: 2.5,
        cartonQty: 2,
        cartonLength: 100,
        cartonWidth: 50,
        cartonHeight: 40,
      },
    ],
  });
  assert.strictEqual(o.totalNetWeight, 20);
  assert.strictEqual(o.totalGrossWeight, 25);
  assert.strictEqual(o.totalCBM, 0.4);
});
test('PI 月度编号递增', () => {
  assert.match(
    C.nextDocumentNumber('PI', sample.orders, sample.orders[0].createdDate),
    /PI-\d{6}-004/,
  );
});
test('CI 月度编号递增', () => {
  assert.match(
    C.nextDocumentNumber('CI', sample.orders, sample.orders[0].createdDate),
    /CI-\d{6}-004/,
  );
});
test('PL 月度编号递增', () => {
  assert.match(
    C.nextDocumentNumber('PL', sample.orders, sample.orders[0].createdDate),
    /PL-\d{6}-004/,
  );
});
test('负数量校验', () => {
  const o = {
    ...C.newOrder([]),
    customerId: 'x',
    items: [{ description: 'x', quantity: -1, unitPrice: 1, netWeight: 0, grossWeight: 0 }],
  };
  assert(C.validateOrder(o, []).errors.some((x) => x.includes('数量')));
});
test('定金比例校验', () => {
  const o = {
    ...C.newOrder([]),
    customerId: 'x',
    depositPercentage: 101,
    items: [{ description: 'x', quantity: 1, unitPrice: 1, netWeight: 0, grossWeight: 0 }],
  };
  assert(C.validateOrder(o, []).errors.some((x) => x.includes('定金比例')));
});
test('毛重不小于净重', () => {
  const o = {
    ...C.newOrder([]),
    customerId: 'x',
    items: [{ description: 'x', quantity: 1, unitPrice: 1, netWeight: 2, grossWeight: 1 }],
  };
  assert(C.validateOrder(o, []).errors.some((x) => x.includes('毛重')));
});
test('单据编号重复校验', () => {
  const o = { ...sample.orders[0], id: 'new-id' };
  assert(C.validateOrder(o, sample.orders).errors.some((x) => x.includes('已存在')));
});
test('CI 数量超过 PI 时警告', () => {
  const o = {
    ...C.newOrder([]),
    customerId: 'x',
    items: [
      { description: 'x', quantity: 1, ciQuantity: 2, unitPrice: 1, netWeight: 0, grossWeight: 0 },
    ],
  };
  assert(C.validateOrder(o, []).warnings.some((x) => x.includes('CI')));
});
test('Packing List 数量不一致时警告', () => {
  const o = {
    ...C.newOrder([]),
    customerId: 'x',
    items: [
      {
        description: 'x',
        quantity: 2,
        ciQuantity: 2,
        packingQuantity: 1,
        unitPrice: 1,
        netWeight: 0,
        grossWeight: 0,
      },
    ],
  };
  assert(C.validateOrder(o, []).warnings.some((x) => x.includes('装箱')));
});
test('三份示例订单齐全', () => {
  assert.strictEqual(sample.orders.length, 3);
  assert(sample.orders.some((o) => o.depositPercentage === 30));
  assert(sample.orders.some((o) => o.purposeOfShipment.includes('Sample')));
  assert(sample.customers.some((c) => c.buyerType === 'Individual'));
});
test('多个收款账户', () => assert(sample.company.accounts.length >= 2));
test('公司英文名称保持原始字符不做格式化', () => {
  const exact = 'MiXeD Export Co., Ltd.  ';
  assert.strictEqual(C.companyEnglishName({ englishName: exact }), exact);
});
test('银行字段按 USD、EUR、GBP 和其他币种切换', () => {
  assert.deepStrictEqual(C.bankFieldsForCurrency('USD'), [
    'accountNumber',
    'achRoutingNumber',
    'wireRoutingNumber',
    'swift',
  ]);
  assert.deepStrictEqual(C.bankFieldsForCurrency('EUR'), ['iban', 'swift']);
  assert.deepStrictEqual(C.bankFieldsForCurrency('GBP'), [
    'accountNumber',
    'sortCode',
    'iban',
    'swift',
  ]);
  assert(C.bankFieldsForCurrency('CAD').includes('localClearingCode'));
});
test('旧收款账户安全迁移且不丢失原字段', () => {
  const company = {
    documentMode: 'Test',
    testMode: true,
    englishName: 'Example Export Testing Co., Ltd.',
    telephone: 'keep',
    accounts: [
      {
        id: 'a',
        beneficiaryName: 'Aurora Homeware Export Co., Ltd.',
        accountNumber: 'KEEP-ME',
        routingNumber: 'LEGACY-ROUTE',
      },
    ],
  };
  const r = C.migrateCompanyAccounts(company);
  assert(r.changed);
  assert.strictEqual(r.company.telephone, 'keep');
  assert.strictEqual(r.company.accounts[0].beneficiaryName, company.englishName);
  assert.strictEqual(r.company.accounts[0].accountNumber, 'KEEP-ME');
  assert.strictEqual(r.company.accounts[0].legacyRoutingNumber, 'LEGACY-ROUTE');
  assert.strictEqual(r.company.accounts[0].routingNumber, 'LEGACY-ROUTE');
});
test('手动 Beneficiary Name 在迁移中保持原样', () => {
  const value = 'Example Test Beneficiary';
  assert.strictEqual(
    C.migrateBankAccount({ beneficiaryName: value }, 'Company Name').beneficiaryName,
    value,
  );
});
test('PI 付款字段按币种分行且保留原始字符', () => {
  const usd = C.paymentInformationLines({
    currency: 'USD',
    label: 'Example Test Account',
    beneficiaryName: 'Mixed Co., Ltd.',
    bankName: 'Example Test Bank',
    bankAddress: '1 TEST BANK ROAD, TESTLAND',
    accountNumber: 'AB 12-34',
    achRoutingNumber: '000000000',
    wireRoutingNumber: '000000000',
    swift: 'TESTBANKXXX',
    iban: 'HIDDEN',
    paymentReference: 'Keep PI punctuation.',
  });
  assert(usd.includes('ACH Routing Number: 000000000'));
  assert(usd.includes('Wire Routing Number: 000000000'));
  assert(!usd.some((x) => x.startsWith('IBAN:')));
  assert(!usd.some((x) => x === 'Routing Number: 000000000 000000000'));
  const eur = C.paymentInformationLines({ currency: 'EUR', iban: 'DE12 3456', swift: 'ABCDEF' });
  assert(eur.includes('IBAN: DE12 3456'));
  assert(!eur.some((x) => x.includes('ACH Routing')));
  const gbp = C.paymentInformationLines({
    currency: 'GBP',
    accountNumber: '12 34',
    sortCode: '00-00-00',
    iban: 'TEST-IBAN-0001',
    swift: 'TESTBANKXXX',
    achRoutingNumber: 'HIDDEN',
    wireRoutingNumber: 'HIDDEN',
  });
  assert.deepStrictEqual(
    gbp.filter((x) => /^(Account Number|Sort Code|IBAN|SWIFT\/BIC):/.test(x)),
    [
      'Account Number: 12 34',
      'Sort Code: 00-00-00',
      'IBAN: TEST-IBAN-0001',
      'SWIFT/BIC: TESTBANKXXX',
    ],
  );
  assert(!gbp.some((x) => x.includes('ACH Routing') || x.includes('Wire Routing')));
  const gbpEmpty = C.paymentInformationLines({
    currency: 'GBP',
    accountNumber: '12 34',
    sortCode: '',
    iban: '',
    swift: '',
  });
  assert.deepStrictEqual(gbpEmpty, ['Account Number: 12 34']);
});
test('单据签章默认规则', () => {
  const pi = C.documentSettings({}, 'PI'),
    ci = C.documentSettings({}, 'CI'),
    finalCI = C.documentSettings({ shipmentDate: '2026-07-18' }, 'CI'),
    pl = C.documentSettings({}, 'PL');
  assert.strictEqual(pi.version, 'Draft');
  assert.strictEqual(pi.includeSigningBlock, false);
  assert.strictEqual(ci.version, 'Draft');
  assert.strictEqual(finalCI.version, 'Final');
  assert.strictEqual(finalCI.signingMode, 'Electronic');
  assert.strictEqual(finalCI.includeSigningBlock, true);
  assert.strictEqual(finalCI.showSignature, true);
  assert.strictEqual(finalCI.showStamp, true);
  assert.strictEqual(pl.includeSigningBlock, false);
});
test('Draft 禁止显示印章', () => {
  assert.strictEqual(
    C.documentSettings(
      { piVersion: 'Draft', piSigningMode: 'Electronic', piIncludeSigningBlock: true },
      'PI',
    ).showStamp,
    false,
  );
  assert.strictEqual(
    C.documentSettings(
      { piVersion: 'Final', piSigningMode: 'Electronic', piIncludeSigningBlock: true },
      'PI',
    ).showStamp,
    true,
  );
});
test('Draft 禁止显示真实签名', () => {
  assert.strictEqual(
    C.documentSettings(
      { piVersion: 'Draft', piSigningMode: 'Electronic', piIncludeSigningBlock: true },
      'PI',
    ).showSignature,
    false,
  );
  assert.strictEqual(
    C.documentSettings(
      { piVersion: 'Final', piSigningMode: 'Print', piIncludeSigningBlock: true },
      'PI',
    ).showSignature,
    false,
  );
});
test('新订单包含三类单据显示设置', () => {
  const o = C.newOrder([]);
  assert.strictEqual(o.piVersion, 'Draft');
  assert.strictEqual(o.ciVersion, 'Draft');
  assert.strictEqual(o.namedPlace, 'Shenzhen, China');
  assert.strictEqual(o.piSigningMode, 'Electronic');
  assert.strictEqual(o.piIncludeSigningBlock, true);
  assert.strictEqual(o.ciIncludeSigningBlock, true);
  assert.strictEqual(o.plIncludeSigningBlock, false);
  assert.strictEqual(o.ciNumber, '');
  assert.strictEqual(o.packingListNumber, '');
});
test('Draft允许缺少Named Place但Final禁止', () => {
  const o = {
    ...C.newOrder([]),
    namedPlace: '',
    customerId: 'x',
    items: [{ description: 'x', quantity: 1, unitPrice: 1, netWeight: 0, grossWeight: 0 }],
  };
  assert(!C.validateOrder(o, []).errors.some((x) => x.includes('Named')));
  const ctx = {
    company: {
      englishName: 'Real Export Co., Ltd.',
      address: 'Real address',
      accounts: [{ id: 'bank', currency: 'USD', accountNumber: '123456' }],
    },
    customers: [{ id: 'x', companyName: 'Buyer GmbH' }],
  };
  assert(
    C.validateDocumentExport(
      { ...o, piVersion: 'Final', paymentAccountId: 'bank' },
      'PI',
      ctx,
    ).errors.some((x) => x.includes('Named Port')),
  );
  assert.strictEqual(
    C.formatTradeTerm({ ...o, namedPlace: 'Yantian Port, Shenzhen, China' }),
    'FOB Yantian Port, Shenzhen, China, Incoterms® 2020',
  );
});
test('FOB 含 Freight 或 Insurance 时警告但不改条款', () => {
  const o = { ...C.newOrder([]), freight: 20 };
  const r = C.validateDocumentExport(o, 'PI', { company: {}, customers: [] });
  assert(r.warnings.some((x) => x.includes('FOB')));
  assert.strictEqual(o.tradeTerm, 'FOB');
});
test('Final 测试数据检查', () => {
  const order = {
    ...C.newOrder([]),
    piVersion: 'Final',
    customerId: 'buyer',
    paymentAccountId: 'bank',
    items: [{ description: 'Valve', quantity: 1, unitPrice: 1 }],
  };
  const ctx = {
    company: {
      englishName: 'DEMO Co.',
      email: 'sales@example.com',
      taxId: 'TEST-0000',
      logoFileName: 'test-logo.png',
      accounts: [{ id: 'bank', accountNumber: '0000 0000', bankName: 'TEST BANK' }],
    },
    customers: [{ id: 'buyer', companyName: 'Buyer GmbH' }],
  };
  assert(
    C.validateDocumentExport(order, 'PI', ctx).errors.some((x) => x.includes('禁止导出 Final')),
  );
});
test('正式公司选择 Aurora 或 Demo 收款账户时禁止 Final PI', () => {
  const order = {
    ...C.newOrder([]),
    piVersion: 'Final',
    customerId: 'buyer',
    paymentAccountId: 'bank',
    items: [{ description: 'Valve', quantity: 1, unitPrice: 1 }],
  };
  const ctx = {
    company: {
      englishName: 'Example Export Testing Co., Ltd.',
      email: 'qa@example.invalid',
      taxId: 'QA-TAX-ID-0001',
      accounts: [
        {
          id: 'bank',
          beneficiaryName: 'Aurora Homeware Export Co., Ltd.',
          bankName: 'Demo International Bank',
          accountNumber: '0000 0000 0000',
          swift: 'DEMOHKHH',
        },
      ],
    },
    customers: [{ id: 'buyer', companyName: 'Buyer GmbH' }],
  };
  assert(
    C.validateDocumentExport(order, 'PI', ctx).errors.some((x) =>
      x.includes('收款账户包含 Aurora'),
    ),
  );
});
test('PDF 与 ZIP 依赖本地存在', () =>
  [
    'jspdf/dist/jspdf.umd.min.js',
    'jspdf-autotable/dist/jspdf.plugin.autotable.min.js',
    'jszip/dist/jszip.min.js',
  ].forEach((p) => assert(fs.existsSync(path.join(__dirname, '..', 'node_modules', p)))));
test('核心页面模块齐全', () => {
  const src = readSource('js/app.js');
  [
    'renderDashboard',
    'renderOrders',
    'renderCustomers',
    'renderProducts',
    'renderCompany',
    'renderPreview',
    'renderBackup',
    'renderHelp',
  ].forEach((x) => assert(src.includes(x)));
});
test('签署人资料和两种 Final 签署模式齐全', () => {
  const src = readSource('js/app.js');
  [
    'authorizedSignatoryName',
    'authorizedSignatoryTitle',
    'preview-document-version',
    'preview-signing-mode',
    'preview-include-signing-block',
    'preview-use-document-date',
  ].forEach((x) => assert(src.includes(x)));
});
test('电子签章缺图禁止 Final 导出，打印签章不要求图片', () => {
  const base = {
      ...C.newOrder([]),
      piVersion: 'Final',
      piSigningMode: 'Electronic',
      piIncludeSigningBlock: true,
      customerId: 'buyer',
      paymentAccountId: 'bank',
      items: [{ description: 'Valve', quantity: 1, unitPrice: 10 }],
    },
    ctx = {
      company: {
        englishName: 'Real Export Co., Ltd.',
        address: 'Real address',
        taxId: 'REAL-123',
        accounts: [{ id: 'bank', currency: 'USD', accountNumber: '123456' }],
      },
      customers: [{ id: 'buyer', companyName: 'Buyer GmbH' }],
    };
  const electronic = C.validateDocumentExport(base, 'PI', ctx);
  assert(
    electronic.errors.some(
      (x) => x === '无法读取公司资料中的正式签名或公司印章，请重新上传并保存，或改用打印签章版。',
    ),
  );
  const print = C.validateDocumentExport({ ...base, piSigningMode: 'Print' }, 'PI', ctx);
  assert(!print.errors.some((x) => x.includes('正式签名或公司印章')));
});
test('打印签章日期默认空白且可主动使用单据日期', () => {
  assert.strictEqual(
    C.documentSettings(
      {
        piVersion: 'Final',
        piSigningMode: 'Print',
        piIncludeSigningBlock: true,
        createdDate: '2026-07-19',
      },
      'PI',
    ).signedDate,
    '__________________',
  );
  assert.strictEqual(
    C.documentSettings(
      {
        piVersion: 'Final',
        piSigningMode: 'Print',
        piIncludeSigningBlock: true,
        piUseDocumentDateForPrint: true,
        createdDate: '2026-07-19',
      },
      'PI',
    ).signedDate,
    '2026-07-19',
  );
});
test('Final签章快照保存signedAt和图片哈希且不随公司图片更新', () => {
  const company = {
      englishName: 'Exact Co., Ltd.',
      authorizedSignatoryName: 'Test Signatory',
      authorizedSignatoryTitle: 'QA Signatory',
      signature: 'TEST_SIGNATURE_PRESERVE',
      stamp: 'TEST_STAMP_PRESERVE',
    },
    ctx = { company, customers: [{ id: 'buyer', companyName: 'Buyer' }] },
    order = {
      ...C.newOrder([]),
      customerId: 'buyer',
      items: [{ description: 'Valve', quantity: 1, unitPrice: 10 }],
    },
    finalized = C.createPISnapshot(order, ctx, 0),
    snap = C.latestPISnapshot(finalized);
  assert(snap.signing.signedAt);
  assert(snap.signing.signatureHash);
  assert(snap.signing.stampHash);
  company.signature = 'TEST_SIGNATURE_CHANGED';
  assert.notStrictEqual(snap.signing.signature, company.signature);
  assert.strictEqual(snap.data.piSigningSnapshot.signature, snap.signing.signature);
});
test('Draft 和 Final PDF 源码没有旧印章占位文字', () => {
  const src = readSource('js/pdf.js', 'js/app.js');
  assert(!src.includes('STAMP AREA'));
  assert(!src.includes('FINAL ONLY'));
});
test('PDF 图片保持宽高比例', () => {
  const src = readSource('js/pdf.js');
  assert(src.includes('getImageProperties'));
  assert(src.includes('addFittedImage'));
  assert(src.includes('data:image/webp'));
});
test('Production 单产品 Final PI电子版保持A4一页且签章位于同页', () => {
  const image = require('./fixtures/test-image')(),
    company = {
      documentMode: 'Test',
      testMode: true,
      englishName: 'Example Export Testing Co., Ltd.',
      address: '123 Test Street, Test City, Testland',
      telephone: '+1 000 000 0000',
      email: 'qa@example.invalid',
      website: 'https://example.invalid',
      taxId: 'QA-TAX-ID-0001',
      authorizedSignatoryName: 'Test Signatory',
      authorizedSignatoryTitle: 'QA Signatory',
      signatureImage: image,
      companyStampImage: image,
      accounts: [
        {
          id: 'usd',
          label: 'Example Test Account',
          currency: 'USD',
          beneficiaryName: 'Example Export Testing Co., Ltd.',
          bankName: 'Example Test Bank',
          bankAddress: '1 Test Bank Road, Test City, Testland',
          accountNumber: '000000000001',
          achRoutingNumber: '000000000',
          wireRoutingNumber: '000000000',
          swift: 'TESTBANKXXX',
          paymentReference: 'Please include the PI number in the payment reference.',
        },
      ],
    },
    customer = {
      id: 'buyer',
      companyName: 'Sample Buyer Testing Ltd.',
      address: '456 Buyer Test Avenue, Sample City, Testland',
      country: 'Testland',
      contactPerson: 'Test Contact',
      email: 'buyer@example.invalid',
    },
    order = {
      ...C.newOrder([]),
      documentMode: 'Test',
      testMode: true,
      piVersion: 'Final',
      piSigningMode: 'Electronic',
      piIncludeSigningBlock: true,
      piSignedAt: '2026-07-20T08:00:00.000Z',
      customerId: 'buyer',
      paymentAccountId: 'usd',
      namedPlace: 'Yantian Port, Shenzhen, China',
      namedPlaceConfirmed: true,
      items: [
        {
          description: 'Thermostatic Shower System',
          modelSku: 'EX-100',
          material: 'Brass and Stainless Steel',
          hsCode: '84818090',
          quantity: 10,
          unit: 'SETS',
          unitPrice: 128.5,
          netWeight: 5,
          grossWeight: 6,
          cartonQty: 10,
          quantityPerCarton: 1,
          cartonLength: 50,
          cartonWidth: 30,
          cartonHeight: 20,
        },
      ],
    },
    ctx = { company, customers: [customer] };
  assert.deepStrictEqual(C.validateDocumentExport(order, 'PI', ctx).errors, []);
  const doc = global.FTPDF.buildPI(order, ctx),
    text = doc.internal.pages.flat().join('\n');
  assert.strictEqual(doc.getNumberOfPages(), 1);
  assert(text.includes('PAYMENT INFORMATION'));
  assert(text.includes('AUTHORIZED SIGNATURE'));
  assert(text.includes('COMPANY STAMP'));
});
test('动态银行表单和隐藏规则存在', () => {
  const app = readSource('js/app.js'),
    css = fs.readFileSync(path.join(__dirname, '..', 'css', 'styles.css'), 'utf8');
  [
    'achRoutingNumber',
    'wireRoutingNumber',
    'sortCode',
    'localClearingCode',
    'legacyRoutingNumber',
    'updateAccountCurrency',
  ].forEach((x) => assert(app.includes(x)));
  assert(css.includes('[hidden]{display:none!important}'));
});

test('Incoterms 2020 包含且仅包含 11 个正式条款', () => {
  assert.deepStrictEqual(
    C.INCOTERMS.map((x) => x.code),
    ['EXW', 'FCA', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP', 'FAS', 'FOB', 'CFR', 'CIF'],
  );
  for (const forbidden of ['DDU', 'DAT', 'CNF', 'C&F'])
    assert(!C.INCOTERMS.some((x) => x.code === forbidden));
});
test('Named Place 标签按贸易条款动态变化', () => {
  assert.strictEqual(C.namedPlaceLabel('EXW'), 'Named Place of Delivery');
  assert.strictEqual(C.namedPlaceLabel('CIP'), 'Named Place of Destination');
  assert.strictEqual(C.namedPlaceLabel('FOB'), 'Named Port of Shipment');
  assert.strictEqual(C.namedPlaceLabel('CIF'), 'Named Port of Destination');
});
test('贸易条款完整格式包含地点和版本', () => {
  for (const term of C.INCOTERMS) {
    const text = C.formatTradeTerm({
      incotermCode: term.code,
      namedPlace: 'Named Location',
      incotermVersion: 'Incoterms® 2020',
    });
    assert.strictEqual(text, `${term.code} Named Location, Incoterms® 2020`);
  }
});
test('海运条款与运输方式冲突会警告', () => {
  const o = {
    ...C.newOrder([]),
    incotermCode: 'FOB',
    tradeTerm: 'FOB',
    plannedTransportMethod: 'Air Freight',
  };
  assert(C.tradeWarnings(o).some((x) => x.includes('only suitable for sea')));
});
test('CIF零保险、EXW和DDP分别提示', () => {
  assert(
    C.tradeWarnings({
      ...C.newOrder([]),
      incotermCode: 'CIF',
      tradeTerm: 'CIF',
      insurance: 0,
    }).some((x) => x.includes('includes insurance')),
  );
  assert(
    C.tradeWarnings({ ...C.newOrder([]), incotermCode: 'EXW', tradeTerm: 'EXW' }).some((x) =>
      x.includes('export customs clearance'),
    ),
  );
  assert(
    C.tradeWarnings({ ...C.newOrder([]), incotermCode: 'DDP', tradeTerm: 'DDP' }).some((x) =>
      x.includes('importer of record'),
    ),
  );
});
test('付款条款预设对应定金比例', () => {
  assert.strictEqual(C.paymentTermDeposit('30% Deposit, 70% Before Shipment'), 30);
  assert.strictEqual(C.paymentTermDeposit('100% T/T in Advance'), 100);
  assert.strictEqual(C.paymentTermDeposit('Custom'), null);
});
test('旧订单迁移保留旧字段并新增PI与CI字段', () => {
  const old = {
    id: 'old',
    tradeTerm: 'CIF',
    transportMethod: 'Sea Freight',
    shipmentDate: '2026-07-18',
    logisticsCompany: 'Carrier',
    trackingNumber: 'BL-1',
    items: [],
  };
  const o = C.migrateOrder(old);
  assert.strictEqual(o.tradeTerm, 'CIF');
  assert.strictEqual(o.incotermCode, 'CIF');
  assert.strictEqual(o.plannedTransportMethod, 'Sea Freight');
  assert.strictEqual(o.actualShipmentDate, '2026-07-18');
  assert.strictEqual(o.carrier, 'Carrier');
  assert.strictEqual(o.transportDocumentNumber, 'BL-1');
});
test('Final CI必须有实际日期并确认实际运输方式', () => {
  const base = {
    ...C.newOrder([]),
    ciNumber: 'CI-202607-999',
    ciVersion: 'Final',
    customerId: 'buyer',
    items: [{ description: 'Valve', quantity: 1, ciQuantity: 1, unitPrice: 10 }],
    purposeOfShipment: 'Commercial Sale',
    declaration: 'Correct',
    namedPlace: 'Shenzhen, China',
  };
  const local = {
    company: { englishName: 'Real Export Co., Ltd.', address: 'Real Address' },
    customers: [
      {
        id: 'buyer',
        companyName: 'Buyer GmbH',
        consigneeName: 'Buyer Warehouse',
        consigneeAddress: 'Warehouse Road',
      },
    ],
  };
  assert(
    C.validateDocumentExport(base, 'CI', local).errors.some((x) => x.includes('实际发货日期')),
  );
  const dated = {
    ...base,
    actualShipmentDate: '2026-07-18',
    shipmentDate: '2026-07-18',
    actualTransportMethod: 'Sea Freight',
  };
  assert(
    C.validateDocumentExport(dated, 'CI', local).errors.some((x) =>
      x.includes('Actual Transport Method'),
    ),
  );
  assert(
    !C.validateDocumentExport(
      { ...dated, actualTransportConfirmed: true },
      'CI',
      local,
    ).errors.some((x) => x.includes('Actual Transport Method')),
  );
});
test('Final Packing List检查数量、箱数、CBM和Shipping Mark', () => {
  const base = {
    ...C.newOrder([]),
    ciNumber: 'CI-X',
    packingListNumber: 'PL-X',
    plVersion: 'Final',
    customerId: 'buyer',
    shippingMark: 'N/M',
    items: [
      {
        description: 'Valve',
        quantity: 10,
        ciQuantity: 10,
        packingQuantity: 9,
        unitPrice: 10,
        cartonQty: 0,
        quantityPerCarton: 5,
        netWeight: 1,
        grossWeight: 2,
        cartonLength: 10,
        cartonWidth: 10,
        cartonHeight: 10,
      },
    ],
  };
  const local = {
    company: { englishName: 'Real Export Co., Ltd.', address: 'Real Address' },
    customers: [{ id: 'buyer', companyName: 'Buyer GmbH' }],
  };
  const bad = C.validateDocumentExport(base, 'PL', local).errors;
  assert(bad.some((x) => x.includes('数量')));
  assert(bad.some((x) => x.includes('Cartons')));
  const good = { ...base, items: [{ ...base.items[0], packingQuantity: 10, cartonQty: 2 }] };
  assert(
    !C.validateDocumentExport(good, 'PL', local).errors.some((x) => x.includes('数量必须与CI')),
  );
});
test('附件分类清单完整', () => {
  for (const category of [
    'Sales Contract',
    'Payment Slip',
    'Commercial Invoice',
    'Packing List',
    'Bill of Lading',
    'Air Waybill',
    'Customs Document',
    'Inspection Report',
    'Delivery Confirmation',
    '其他 / Other',
  ])
    assert(C.ATTACHMENT_CATEGORIES.includes(category));
});
test('订单编辑页包含阶段、折叠、币种联动和分类附件实现', () => {
  const app = readSource('js/app.js');
  for (const token of [
    'data-order-section',
    'incotermCode',
    'actualShipmentDate',
    'actualTransportConfirmed',
    'plannedTransportMethod',
    'matchingAccounts',
    'item-details',
    'amount-layout',
    'attachment-category',
    'data-preview-stage',
  ])
    assert(app.includes(token));
});
test('PI PDF不包含实际物流，CI和PL按填写内容显示', () => {
  const company = {
      ...sample.company,
      englishName: 'Real Export Co., Ltd.',
      address: 'Real Address',
      email: 'qa@example.invalid',
      taxId: '000000000000',
      accounts: [
        {
          id: 'bank',
          label: 'USD Account',
          currency: 'USD',
          beneficiaryName: 'Real Export Co., Ltd.',
          accountNumber: '000000000001',
          swift: 'ABCDEFGH',
        },
      ],
    },
    customer = {
      ...sample.customers[0],
      id: 'buyer',
      companyName: 'Buyer GmbH',
      email: 'buyer@example.invalid',
      consigneeName: 'Buyer Warehouse',
      consigneeAddress: 'Warehouse Road',
    },
    base = {
      ...C.newOrder([]),
      orderNumber: 'ORD-X',
      piNumber: 'PI-X',
      ciNumber: 'CI-X',
      packingListNumber: 'PL-X',
      customerId: 'buyer',
      paymentAccountId: 'bank',
      namedPlace: 'Yantian Port, Shenzhen, China',
      actualShipmentDate: '2026-07-18',
      shipmentDate: '2026-07-18',
      actualTransportMethod: 'Sea Freight',
      actualTransportConfirmed: true,
      carrier: 'Actual Carrier',
      transportDocumentType: 'Bill of Lading',
      transportDocumentNumber: 'BL-REAL-1',
      items: [
        {
          description: 'Valve',
          modelSku: 'V1',
          material: 'Brass',
          hsCode: '8481',
          quantity: 10,
          ciQuantity: 10,
          packingQuantity: 10,
          unit: 'PCS',
          unitPrice: 10,
          cartonQty: 2,
          quantityPerCarton: 5,
          netWeight: 1,
          grossWeight: 2,
          cartonLength: 10,
          cartonWidth: 10,
          cartonHeight: 10,
        },
      ],
    },
    local = { company, customers: [customer], orders: [base] };
  const pi = global.FTPDF.buildPI(base, local).internal.pages.flat().join('\n');
  assert(!pi.includes('Actual Carrier'));
  assert(!pi.includes('BL-REAL-1'));
  const ci = global.FTPDF.buildCI(base, local).internal.pages.flat().join('\n');
  assert(ci.includes('Actual Carrier'));
  assert(ci.includes('BL-REAL-1'));
  const pl = global.FTPDF.buildPL(base, local).internal.pages.flat().join('\n');
  assert(pl.includes('Actual Carrier'));
});
test('PDF不会在PI阶段自动生成CI和PL编号', () => {
  const o = C.newOrder([]),
    kept = global.FTPDF.ensureNumbers(o, []);
  assert.strictEqual(kept.ciNumber, '');
  assert.strictEqual(kept.packingListNumber, '');
});

test('单据抬头和 PI Beneficiary Name 统一读取公司英文名称', () => {
  const exact = 'Example Export Testing Co., Ltd.',
    beneficiary = 'Example Test Beneficiary LLC';
  const company = {
    ...sample.company,
    englishName: exact,
    accounts: [{ ...sample.company.accounts[0], beneficiaryName: beneficiary }],
  };
  const base = {
    ...sample.orders[0],
    piVersion: 'Final',
    piSigningMode: 'Print',
    ciVersion: 'Final',
    ciSigningMode: 'Print',
    plVersion: 'Final',
    plSigningMode: 'Print',
    shipmentDate: '2026-07-18',
    paymentAccountId: company.accounts[0].id,
  };
  const localCtx = { company, customers: sample.customers, orders: [base] };
  const pi = global.FTPDF.buildPI(base, localCtx),
    piContent = pi.internal.pages.flat().join('\n');
  assert(piContent.includes(exact));
  assert(!piContent.includes(beneficiary));
  for (const doc of [global.FTPDF.buildCI(base, localCtx), global.FTPDF.buildPL(base, localCtx)]) {
    const content = doc.internal.pages.flat().join('\n');
    assert(content.includes(exact));
    assert(!content.includes(beneficiary));
  }
});

test('生成 PI/CI/Packing List PDF', () => {
  const out = path.join(__dirname, '..', 'output', 'pdf');
  fs.mkdirSync(out, { recursive: true });
  const order = sample.orders[0];
  const docs = [
    ['PI', global.FTPDF.buildPI(order, ctx)],
    ['CI', global.FTPDF.buildCI(order, ctx)],
    ['PL', global.FTPDF.buildPL(order, ctx)],
  ];
  for (const [name, doc] of docs) {
    const file = path.join(out, `${name}-sample.pdf`);
    fs.writeFileSync(file, Buffer.from(doc.output('arraybuffer')));
    assert(fs.statSync(file).size > 3000);
    assert(doc.getNumberOfPages() >= 1);
  }
});
test('A4 多页产品表且页数正确', () => {
  const many = {
    ...sample.orders[0],
    items: Array.from({ length: 75 }, (_, i) => ({
      ...sample.orders[0].items[0],
      id: `line-${i}`,
      description: `Test product line ${i + 1}`,
    })),
  };
  const doc = global.FTPDF.buildPI(many, ctx);
  assert(doc.getNumberOfPages() > 1);
  const file = path.join(__dirname, '..', 'output', 'pdf', 'PI-multipage-sample.pdf');
  fs.writeFileSync(file, Buffer.from(doc.output('arraybuffer')));
});

test('Amount Payable Now由当前收款阶段控制', () => {
  const base = {
      ...C.newOrder([]),
      items: [{ description: 'Product', quantity: 10, unitPrice: 100 }],
      depositPercentage: 30,
      paymentRecords: [],
    },
    confirmed = [
      { id: 'p1', paymentDate: '2026-07-19', amount: 300, currency: 'USD', status: 'Confirmed' },
    ];
  const unpaid = C.calculateOrder({ ...base, currentPaymentStage: 'Deposit Requested' }),
    depositPaid = C.calculateOrder({
      ...base,
      paymentRecords: confirmed,
      currentPaymentStage: 'Deposit Requested',
    }),
    waiting = C.calculateOrder({
      ...base,
      paymentRecords: confirmed,
      currentPaymentStage: 'Waiting for Production',
    }),
    balance = C.calculateOrder({
      ...base,
      paymentRecords: confirmed,
      currentPaymentStage: 'Balance Requested',
    });
  assert.deepStrictEqual(
    [unpaid.total, unpaid.depositAmount, unpaid.amountPayableNow],
    [1000, 300, 300],
  );
  assert.deepStrictEqual(
    [depositPaid.amountPaid, depositPaid.outstandingAmount, depositPaid.amountPayableNow],
    [300, 700, 0],
  );
  assert.strictEqual(waiting.amountPayableNow, 0);
  assert.strictEqual(balance.amountPayableNow, 700);
});
test('Custom阶段允许手动设置本次应付金额并限制上限', () => {
  const base = {
    ...C.newOrder([]),
    paymentTerm: 'Net 30 Days',
    paymentTermPreset: 'Net 30 Days',
    items: [{ description: 'Product', quantity: 1, unitPrice: 1000 }],
    paymentRecords: [{ id: 'p1', amount: 200, currency: 'USD', status: 'Confirmed' }],
    currentPaymentStage: 'Custom',
    amountPayableNowManualValue: 350,
    amountPayableNowNote: 'Milestone',
  };
  const o = C.calculateOrder(base);
  assert.strictEqual(o.outstandingAmount, 800);
  assert.strictEqual(o.amountPayableNow, 350);
  assert(
    C.validateOrder({ ...base, amountPayableNowManualValue: 900 }, []).errors.some((x) =>
      x.includes('未收金额'),
    ),
  );
});
test('收款记录仅汇总Confirmed且币种不一致会警告', () => {
  const o = C.calculateOrder({
    ...C.newOrder([]),
    items: [{ description: 'Product', quantity: 1, unitPrice: 1000 }],
    paymentRecords: [
      { id: 'a', amount: 100, currency: 'USD', status: 'Confirmed' },
      { id: 'b', amount: 200, currency: 'USD', status: 'Pending' },
      { id: 'c', amount: 50, currency: 'EUR', status: 'Confirmed' },
    ],
  });
  assert.strictEqual(o.amountPaid, 150);
  assert(C.validateOrder(o, []).warnings.some((x) => x.includes('币种')));
});
test('旧Amount Paid迁移为Confirmed记录且旧备注只进入Internal Notes', () => {
  const o = C.migrateOrder({
    id: 'legacy',
    createdDate: '2026-07-19',
    currency: 'USD',
    amountPaid: 125,
    notes: 'private legacy note',
    items: [],
  });
  assert.strictEqual(o.paymentRecords.length, 1);
  assert.strictEqual(o.paymentRecords[0].status, 'Confirmed');
  assert.strictEqual(C.calculateOrder(o).amountPaid, 125);
  assert.strictEqual(o.internalNotes, 'private legacy note');
  assert.strictEqual(o.customerRemarks, '');
  assert.strictEqual(o.showCustomerRemarksOnPI, false);
});
test('港口明确性校验和Final确认', () => {
  const draft = { ...C.newOrder([]), incotermCode: 'FOB', namedPlace: 'Shenzhen, China' };
  assert(C.tradeWarnings(draft).some((x) => x.includes('specific named port')));
  assert(
    !C.tradeWarnings({ ...draft, namedPlace: 'Yantian Port, Shenzhen, China' }).some((x) =>
      x.includes('specific named port'),
    ),
  );
  const ctx2 = {
    company: {
      englishName: 'Real Export Co., Ltd.',
      address: 'Address',
      accounts: [{ id: 'b', currency: 'USD' }],
    },
    customers: [{ id: 'c', companyName: 'Buyer' }],
  };
  const final = {
    ...draft,
    piVersion: 'Final',
    customerId: 'c',
    paymentAccountId: 'b',
    items: [{ description: 'Product', quantity: 1, unitPrice: 10 }],
  };
  assert(C.validateDocumentExport(final, 'PI', ctx2).errors.some((x) => x.includes('明确港口')));
  assert(
    C.validateDocumentExport(
      { ...final, namedPlace: 'Yantian Port, Shenzhen, China' },
      'PI',
      ctx2,
    ).errors.some((x) => x.includes('确认指定港口')),
  );
});
test('订单和PI编号按现有最大值递增', () => {
  const orders = [{ orderNumber: 'ORD-20260719-007', piNumber: 'PI-202607-004' }];
  assert.strictEqual(C.nextOrderNumber(orders, '2026-07-19'), 'ORD-20260719-008');
  assert.strictEqual(C.nextDocumentNumber('PI', orders, '2026-07-19'), 'PI-202607-005');
});
test('Internal Notes永不进入PDF且客户备注按开关显示', () => {
  const base = {
    ...sample.orders[0],
    internalNotes: 'PRIVATE INTERNAL ONLY',
    customerRemarks: 'VISIBLE CUSTOMER REMARK',
    showCustomerRemarksOnPI: false,
  };
  let text = global.FTPDF.buildPI(base, ctx).internal.pages.flat().join('\n');
  assert(!text.includes('PRIVATE INTERNAL ONLY'));
  assert(!text.includes('VISIBLE CUSTOMER REMARK'));
  text = global.FTPDF.buildPI({ ...base, showCustomerRemarksOnPI: true }, ctx)
    .internal.pages.flat()
    .join('\n');
  assert(text.includes('VISIBLE CUSTOMER REMARK'));
  assert(!text.includes('PRIVATE INTERNAL ONLY'));
});
test('Final PI快照深拷贝且修订历史永久保留', () => {
  const local = {
      company: {
        englishName: 'Real Export Co., Ltd.',
        address: 'Address',
        accounts: [{ id: 'bank', currency: 'USD', accountNumber: '123' }],
      },
      customers: [{ id: 'buyer', companyName: 'Buyer' }],
    },
    base = {
      ...C.newOrder([]),
      customerId: 'buyer',
      paymentAccountId: 'bank',
      items: [{ description: 'Product', quantity: 10, unitPrice: 100 }],
    };
  let o = C.createPISnapshot(base, local, 0);
  o.items[0].quantity = 9;
  assert.strictEqual(C.piSnapshot(o, 0).data.items[0].quantity, 10);
  assert(C.needsPIRevision(o));
  o = C.createPISnapshot(o, local);
  assert.deepStrictEqual(
    o.piHistory.map((x) => x.revision),
    [0, 1],
  );
  assert.strictEqual(C.piSnapshot(o, 0).data.items[0].quantity, 10);
  assert.strictEqual(C.piSnapshot(o, 1).data.items[0].quantity, 9);
});
test('CI记录关联PI版本且初始数据与Final PI一致', () => {
  const local = { company: {}, customers: [] },
    base = { ...C.newOrder([]), items: [{ description: 'Product', quantity: 10, unitPrice: 100 }] };
  let o = C.createPISnapshot(base, local, 0);
  o.items[0].quantity = 9;
  o = C.createPISnapshot(o, local);
  o = C.createCIDocument(o, []);
  assert.strictEqual(o.ciDocument.relatedPiRevision, 1);
  assert.strictEqual(o.ciDocument.data.items[0].ciQuantity, 9);
  assert.deepStrictEqual(C.compareCIToPI(o), []);
});
test('CI数量变化生成具体差异且不修改Final PI', () => {
  const local = { company: {}, customers: [] },
    base = {
      ...C.newOrder([]),
      items: [{ description: 'Product A', quantity: 10, unitPrice: 100 }],
    };
  let o = C.createPISnapshot(base, local, 0);
  o = C.createCIDocument(o, []);
  o.ciDocument.data.items[0].ciQuantity = 8;
  const diffs = C.compareCIToPI(o);
  assert(diffs.some((x) => x.field === 'items.0.quantity' && x.message.includes('PI 10 → CI 8')));
  assert(diffs.some((x) => x.field === 'total'));
  assert.strictEqual(C.piSnapshot(o, 0).data.items[0].quantity, 10);
});
test('CI和Packing List独立对象不会覆盖Final PI', () => {
  const local = { company: {}, customers: [] },
    base = {
      ...C.newOrder([]),
      items: [
        {
          description: 'Product',
          quantity: 10,
          unitPrice: 100,
          cartonQty: 2,
          quantityPerCarton: 5,
        },
      ],
    };
  let o = C.createPISnapshot(base, local, 0);
  o = C.createCIDocument(o, []);
  o.items[0].ciQuantity = 9;
  o = C.updateStageDocuments(o);
  o = C.createPackingListDocument(o, []);
  o.items[0].packingQuantity = 8;
  o = C.updateStageDocuments(o);
  assert.strictEqual(C.piSnapshot(o, 0).data.items[0].quantity, 10);
  assert.strictEqual(o.ciDocument.data.items[0].ciQuantity, 9);
  assert.strictEqual(o.packingListDocument.data.items[0].packingQuantity, 8);
});
test('CI和Packing List冻结Seller Buyer资料', () => {
  const company = { englishName: 'Frozen Seller' },
    buyer = { id: 'buyer', companyName: 'Frozen Buyer' },
    ctx = { company, customers: [buyer] },
    base = {
      ...C.newOrder([]),
      customerId: 'buyer',
      items: [{ description: 'Product', quantity: 1, unitPrice: 100 }],
    };
  let o = C.createPISnapshot(base, ctx, 0);
  o = C.createCIDocument(o, [], false, ctx);
  company.englishName = 'Changed Seller';
  buyer.companyName = 'Changed Buyer';
  o = C.createPackingListDocument(o, []);
  assert.strictEqual(o.ciDocument.seller.englishName, 'Frozen Seller');
  assert.strictEqual(o.ciDocument.buyer.companyName, 'Frozen Buyer');
  assert.strictEqual(o.packingListDocument.seller.englishName, 'Frozen Seller');
  assert.strictEqual(o.packingListDocument.buyer.companyName, 'Frozen Buyer');
});
test('订单编辑和PDF包含新金额、快照、差异与CI付款开关', () => {
  const app = readSource('js/app.js'),
    pdf = readSource('js/pdf.js');
  for (const token of [
    'PI历史 / PI History',
    'Amount Payable Now',
    'Outstanding Amount',
    'ciDifferencesConfirmed',
    'createPIRevision',
    'data-missing-section',
    'Show payment status on CI',
  ])
    assert(app.includes(token));
  for (const token of [
    'AMOUNT PAYABLE NOW',
    'Balance Payment',
    'showPaymentStatusOnCI',
    'relatedPiRevision',
  ])
    assert(pdf.includes(token));
});
test('Standalone CI与PI关联CI使用独立对象且显示规则不同', () => {
  const company = { ...sample.company, documentMode: 'Test' },
    local = { company, customers: sample.customers },
    base = {
      ...sample.orders[0],
      testMode: true,
      documentMode: 'Test',
      actualShipmentDate: '2026-07-19',
      actualTransportMethod: 'Sea Freight',
      actualTransportConfirmed: true,
    };
  const standalone = C.calculateOrder({
    ...base,
    id: 'standalone-ci',
    standalone: true,
    orderNumber: '',
    piNumber: '',
    relatedPiNumber: '',
    relatedPiRevision: '',
    ciNumber: 'CI-STANDALONE',
  });
  const linked = C.calculateOrder({
    ...base,
    id: 'linked-ci',
    standalone: false,
    orderNumber: 'ORD-LINKED',
    piNumber: 'PI-LINKED',
    relatedPiNumber: 'PI-LINKED',
    relatedPiRevision: 0,
    ciNumber: 'CI-LINKED',
  });
  assert.notStrictEqual(standalone.id, linked.id);
  const standaloneText = global.FTPDF.buildCI(standalone, local).internal.pages.flat().join('\n'),
    linkedText = global.FTPDF.buildCI(linked, local).internal.pages.flat().join('\n');
  assert(!standaloneText.includes('Order:'));
  assert(!standaloneText.includes('Related PI:'));
  assert(!standaloneText.includes('SHIPMENT REFERENCE'));
  assert(linkedText.includes('Order: ORD-LINKED'));
  assert(linkedText.includes('Related PI: PI-LINKED / Revision 0'));
});
test('显式Production覆盖遗留testMode并阻止Demo资料', () => {
  const order = {
      ...sample.orders[0],
      documentMode: 'Production',
      testMode: true,
      piVersion: 'Draft',
    },
    company = { ...sample.company, documentMode: 'Production', testMode: true };
  assert.strictEqual(C.isTestMode(order, { company, documentMode: 'Production' }), false);
  assert(
    C.validateDocumentExport(order, 'PI', {
      company,
      customers: sample.customers,
      documentMode: 'Production',
    }).errors.some((x) => x.includes('Production')),
  );
  assert.strictEqual(
    C.isTestMode(
      { ...order, documentMode: 'Test' },
      { company: { ...company, documentMode: 'Test' } },
    ),
    true,
  );
});
test('Test Mode所有PDF页显示样例标记且公司名字符完全一致', () => {
  const exact = 'Aurora Homeware Export Co., Ltd.',
    bad = 'Aurora Homeware Export Co.,Ltd.',
    company = { ...sample.company, englishName: exact, documentMode: 'Test', testMode: true },
    local = { company, customers: sample.customers },
    order = { ...sample.orders[0], documentMode: 'Test', testMode: true };
  for (const doc of [
    global.FTPDF.buildPI(order, local),
    global.FTPDF.buildCI(order, local),
    global.FTPDF.buildPL(order, local),
  ]) {
    const content = doc.internal.pages.flat().join('\n');
    assert(content.includes('TEST SAMPLE - NOT FOR COMMERCIAL USE'));
    assert(content.includes(exact));
    assert(!content.includes(bad));
  }
});
test('统一页脚使用互不重叠的左中右三个绘制区域', () => {
  const pdf = readSource('js/pdf.js');
  assert(pdf.includes('const leftX=14,leftWidth=66,centerX=105,rightX=196'));
  assert(pdf.includes('doc.text(leftLines,leftX'));
  assert(pdf.includes("doc.text('TEST SAMPLE - NOT FOR COMMERCIAL USE',centerX"));
  assert(pdf.includes('doc.text(`Page ${p} of ${pages}`,rightX'));
});
test('客户备注三个开关独立控制PI、CI和Packing List', () => {
  const remark =
      'Please confirm the product finish, packaging artwork and shipping mark before production.',
    base = {
      ...sample.orders[0],
      customerRemarks: remark,
      internalNotes: 'PRIVATE INTERNAL ONLY',
      plShowDeclaration: false,
    },
    local = { company: sample.company, customers: sample.customers },
    hasRemark = (value) =>
      value.includes('Remarks') &&
      value.includes('Please confirm the product finish') &&
      value.includes('shipping mark before production.');
  const render = (o) => ({
    PI: global.FTPDF.buildPI(o, local).internal.pages.flat().join('\n'),
    CI: global.FTPDF.buildCI(o, local).internal.pages.flat().join('\n'),
    PL: global.FTPDF.buildPL(o, local).internal.pages.flat().join('\n'),
  });
  for (const [flags, expected] of [
    [
      {
        showCustomerRemarksOnPI: false,
        showCustomerRemarksOnCI: false,
        showCustomerRemarksOnPL: false,
      },
      [],
    ],
    [
      {
        showCustomerRemarksOnPI: true,
        showCustomerRemarksOnCI: false,
        showCustomerRemarksOnPL: false,
      },
      ['PI'],
    ],
    [
      {
        showCustomerRemarksOnPI: false,
        showCustomerRemarksOnCI: true,
        showCustomerRemarksOnPL: false,
      },
      ['CI'],
    ],
    [
      {
        showCustomerRemarksOnPI: false,
        showCustomerRemarksOnCI: false,
        showCustomerRemarksOnPL: true,
      },
      ['PL'],
    ],
    [
      {
        showCustomerRemarksOnPI: true,
        showCustomerRemarksOnCI: true,
        showCustomerRemarksOnPL: true,
      },
      ['PI', 'CI', 'PL'],
    ],
  ]) {
    const docs = render({ ...base, ...flags });
    for (const type of ['PI', 'CI', 'PL'])
      assert.strictEqual(hasRemark(docs[type]), expected.includes(type));
    for (const type of ['PI', 'CI', 'PL']) assert(!docs[type].includes('PRIVATE INTERNAL ONLY'));
  }
});
test('空客户备注不输出Remarks且换行内容保持分行', () => {
  const local = { company: sample.company, customers: sample.customers },
    empty = {
      ...sample.orders[0],
      customerRemarks: '  \n ',
      showCustomerRemarksOnPI: true,
      showCustomerRemarksOnCI: true,
      showCustomerRemarksOnPL: true,
    },
    multiline = {
      ...sample.orders[0],
      customerRemarks: 'First line\nSecond line',
      showCustomerRemarksOnPI: true,
    };
  for (const doc of [
    global.FTPDF.buildPI(empty, local),
    global.FTPDF.buildCI(empty, local),
    global.FTPDF.buildPL(empty, local),
  ])
    assert(!doc.internal.pages.flat().join('\n').includes('Remarks'));
  const text = global.FTPDF.buildPI(multiline, local).internal.pages.flat().join('\n');
  assert(text.includes('Remarks'));
  assert(text.includes('First line'));
  assert(text.includes('Second line'));
});
test('Production指定Demo关键词统一阻止并返回明确提示', () => {
  const company = {
      englishName: 'Aurora Homeware',
      address: 'Real Address',
      email: 'export@example.com',
      website: 'example-export.com',
      taxId: '91440000DEMO00000X',
      authorizedSignatoryName: 'Morgan Lee',
      authorizedSignatoryTitle: 'Export Director',
      documentMode: 'Production',
      accounts: [
        {
          id: 'usd',
          currency: 'USD',
          beneficiaryName: 'Real Co.',
          bankName: 'Demo International Bank',
          bankAddress: 'Demo Banking Center',
          accountNumber: '0000 0000 0000',
          swift: 'DEMOHKHH',
        },
      ],
    },
    customer = { id: 'buyer', companyName: 'Northstar Trading' },
    order = {
      ...C.newOrder([]),
      documentMode: 'Test',
      testMode: true,
      testMode: false,
      customerId: 'buyer',
      paymentAccountId: 'usd',
      transportDocumentNumber: 'TEST-BL-1',
      items: [{ description: 'Product', quantity: 1, unitPrice: 10 }],
    },
    ctx = { company, customers: [customer], documentMode: 'Production' };
  const result = C.validateDocumentExport(order, 'PI', ctx);
  assert.strictEqual(
    result.errors[0],
    '检测到测试资料，Production文件无法导出，请检查公司、客户、签字人或收款账户设置。',
  );
  assert(C.productionForbiddenMatches(order, 'PI', ctx).length >= 10);
});
test('备注响应式与签章上传界面规则完整且没有个人章字段', () => {
  const app = readSource('js/app.js'),
    css = fs.readFileSync(path.join(__dirname, '..', 'css', 'styles.css'), 'utf8'),
    pdf = readSource('js/pdf.js');
  for (const token of [
    '在PI中显示 / Show on PI',
    '在CI中显示 / Show on CI',
    '在Packing List中显示 / Show on Packing List',
    'rows="3"',
    'data-view-company-image',
    'FileType',
    '签名和公司印章属于敏感资料',
    '第一次确认：删除后需重新上传',
    '第二次确认：确定从服务器业务数据中永久删除',
  ])
    assert(app.includes(token));
  for (const token of ['minmax(260px,280px)', '@media(max-width:1100px)', 'white-space:pre-wrap'])
    assert(css.includes(token));
  for (const forbidden of ['Personal Seal', 'Name Stamp', 'Private Seal', '个人姓名章输入'])
    assert(!`${app}\n${pdf}`.includes(forbidden));
});
test('PI页面提供四个明确入口、签章状态和独立导出文件名', () => {
  const app = readSource('js/app.js'),
    pdf = readSource('js/pdf.js');
  for (const token of [
    '预览Draft PI',
    '生成Final PI</button>',
    '生成Final PI电子签章版',
    '生成Final PI打印签章版',
    '签名状态：',
    '公司公章状态：',
    'previewPIForceDraft',
    'Final-Electronic',
    'Final-Print',
  ])
    assert(app.includes(token));
  assert(pdf.includes("function saveDoc(type,order,ctx,fileName='')"));
  assert(pdf.includes("undefined,'SLOW'"));
});
test('Model与SKU相同只显示一次，不同时保持分隔', () => {
  assert.strictEqual(C.formatModelSku('EX-QA-100 / EX-QA-100'), 'EX-QA-100');
  assert.strictEqual(C.formatModelSku('MODEL-1 / SKU-2'), 'MODEL-1 / SKU-2');
});
test('PI收款信息使用Payment Account并规范纽约邮编空格', () => {
  const lines = C.paymentInformationLines({
    currency: 'USD',
    label: 'Example Test Account',
    beneficiaryName: 'Example Export Testing Co., Ltd.',
    bankAddress: 'NEW YORK, NY10179',
  });
  assert(lines.includes('Payment Account: Example Test Account'));
  assert(lines.includes('Bank Address: NEW YORK, NY 10179'));
  assert(!lines.some((line) => line.startsWith('Account Name:')));
});
test('签名和公章上传不再经过Canvas裁剪或重新编码', () => {
  const app = readSource('js/app.js');
  assert(!app.includes('trimTransparentImageDataURL'));
  assert(!app.includes("document.createElement('canvas')"));
  assert(app.includes('const data=await fileToDataURL(f),dim=await imageDimensions(data)'));
});
test('AI重绘公章会被阻断且浏览器不再改写服务器Final签章快照', () => {
  const app = readSource('js/app.js');
  assert(app.includes('rejectedStampFileName'));
  assert(app.includes('当前公司公章属于AI生成或重绘图片'));
  assert(app.includes('DB.finalizePI'));
  assert(!app.includes('activeFinal.signing='));
});
test('Packing List从CI继承且按每箱重量和尺寸计算', () => {
  const company = { englishName: 'Production Export Company', address: 'Factory Road' },
    buyer = { id: 'buyer', companyName: 'Production Buyer' },
    ctx = { company, customers: [buyer] },
    base = {
      ...C.newOrder([]),
      orderNumber: 'ORD-PL-1',
      piNumber: 'PI-PL-1',
      customerId: 'buyer',
      items: [
        {
          id: 'line',
          description: 'Shower System',
          modelSku: 'EX-100',
          countryOfOrigin: 'China',
          quantity: 10,
          unit: 'SETS',
          unitPrice: 120,
          netWeight: 6.8,
          grossWeight: 7.5,
          cartonQty: 2,
          quantityPerCarton: 5,
          cartonLength: 65,
          cartonWidth: 42,
          cartonHeight: 18,
        },
      ],
    };
  let order = C.createPISnapshot(base, ctx, 0);
  order = C.createCIDocument(order, [], false, ctx);
  order.ciDocument.data.items[0].ciQuantity = 10;
  order.ciDocument.data.actualShipmentDate = '2026-07-20';
  order.ciDocument.data.actualTransportMethod = 'Sea Freight';
  order.ciDocument.data.portOfLoading = 'Yantian Port, Shenzhen, China';
  order.ciDocument.data.portOfDischarge = 'Hamburg Port, Germany';
  order = C.createPackingListDocument(order, []);
  const data = order.packingListDocument.data;
  data.items[0] = {
    ...data.items[0],
    cartonQty: 2,
    quantityPerCarton: 5,
    netWeightPerCarton: 34,
    grossWeightPerCarton: 37.5,
    cartonLength: 65,
    cartonWidth: 42,
    cartonHeight: 18,
  };
  const pl = C.calculateOrder(data);
  assert.strictEqual(pl.totalCartons, 2);
  assert.strictEqual(pl.totalNetWeight, 68);
  assert.strictEqual(pl.totalGrossWeight, 75);
  assert.strictEqual(pl.totalCBM, 0.09828);
  assert.strictEqual(pl.items[0].cartonVolume, 0.04914);
  assert.strictEqual(data.portOfLoading, 'Yantian Port, Shenzhen, China');
  assert.strictEqual(data.portOfDischarge, 'Hamburg Port, Germany');
  for (const forbidden of [
    'paymentAccountId',
    'paymentRecords',
    'freight',
    'insurance',
    'discount',
    'depositPercentage',
    'unitPrice',
  ])
    assert(!Object.prototype.hasOwnProperty.call(data, forbidden));
});
test('Packing List PDF不包含银行、付款和价格字段', () => {
  const company = { englishName: 'Production Export Company', address: 'Factory Road' },
    buyer = { id: 'buyer', companyName: 'Production Buyer' },
    order = C.calculateOrder({
      ...C.newOrder([]),
      orderNumber: 'ORD-PL-2',
      piNumber: 'PI-PL-2',
      ciNumber: 'CI-PL-2',
      packingListNumber: 'PL-PL-2',
      customerId: 'buyer',
      shippingMark: 'N/M',
      actualShipmentDate: '2026-07-20',
      actualTransportMethod: 'Sea Freight',
      actualTransportConfirmed: true,
      portOfLoading: 'Yantian Port, Shenzhen, China',
      portOfDischarge: 'Hamburg Port, Germany',
      items: [
        {
          description: 'Shower System',
          modelSku: 'EX-100',
          countryOfOrigin: 'China',
          quantity: 10,
          ciQuantity: 10,
          packingQuantity: 10,
          unit: 'SETS',
          packageType: 'Carton',
          cartonQty: 2,
          quantityPerCarton: 5,
          netWeightPerCarton: 34,
          grossWeightPerCarton: 37.5,
          cartonLength: 65,
          cartonWidth: 42,
          cartonHeight: 18,
        },
      ],
    });
  const text = global.FTPDF.buildPL(order, { company, customers: [buyer] })
    .internal.pages.flat()
    .join('\n');
  for (const forbidden of [
    'PAYMENT INFORMATION',
    'Payment Account',
    'Account Number',
    'SWIFT',
    'Deposit',
    'Balance Payment',
    'Amount Payable Now',
    'Unit Price',
    'TOTAL AMOUNT',
  ])
    assert(!text.includes(forbidden));
  for (const required of [
    'PACKING LIST',
    'Package',
    'N.W. / Carton',
    'G.W. / Carton',
    'Origin',
    'TOTAL CBM',
  ])
    assert(text.includes(required));
});
test('Packing List入口仅位于CI阶段且具有独立编辑、五个操作按钮与服务器事务保存', () => {
  const app = readSource('js/app.js'),
    ciActions = app.indexOf('const ciStageActions'),
    piFooter = app.indexOf('const buttons=');
  assert(ciActions >= 0 && ciActions < piFooter);
  assert.strictEqual((app.match(/data-generate-pl/g) || []).length, 3);
  for (const token of [
    'renderPackingListEdit',
    'packing-list-form',
    '保存Packing List',
    '预览Draft Packing List',
    '生成Final Packing List</button>',
    '生成Final Packing List电子签章版',
    '生成Final Packing List打印签章版',
    'DB.savePackingList',
    'DB.generatePackingList',
    'DB.finalizePackingList',
  ])
    assert(app.includes(token));
  assert(!app.includes("DB.put('packingLists'"));
});

const failed = results.filter((x) => !x.ok);
for (const r of results)
  console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.ok ? '' : `\n${r.error}`}`);
console.log(`\n${results.length - failed.length}/${results.length} tests passed`);
if (failed.length) process.exit(1);
