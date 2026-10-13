'use strict';
const fs = require('fs');
const path = require('path');
global.window = global;
const C = require('../js/core.js');
global.jspdf = require('jspdf');
require('jspdf-autotable');
require('../js/pdf.js');

const company = {
  id: 'main',
  englishName: 'Example Export Testing Co., Ltd.',
  address: '123 Test Street, Test City, Testland',
  telephone: '+1 000 000 0000',
  email: 'qa@example.invalid',
  website: 'https://example.invalid',
  taxId: 'QA-TAX-ID-0001',
  authorizedSignatoryName: 'Test Signatory',
  authorizedSignatoryTitle: 'Test Title',
  logo: '',
  signature: '',
  stamp: '',
  accounts: [
    {
      id: 'usd',
      label: 'Example Test USD Account',
      currency: 'USD',
      beneficiaryName: 'Example Export Testing Co., Ltd.',
      bankName: 'Example Test Bank',
      bankAddress: '1 Test Bank Road, Test City, Testland',
      accountNumber: '000000000001',
      achRoutingNumber: '000000000',
      wireRoutingNumber: '000000000',
      swift: 'TESTBANKXXX',
      paymentReference: 'Use the test document number.',
    },
  ],
};
const customer = {
  id: 'buyer',
  buyerType: 'Company',
  buyerName: 'Sample Buyer Testing Ltd.',
  companyName: 'Sample Buyer Testing Ltd.',
  address: '456 Buyer Test Avenue, Sample City, Testland',
  country: 'Testland',
  contactPerson: 'Test Contact',
  telephone: '+1 000 000 0001',
  email: 'buyer@example.invalid',
  consigneeName: 'Sample Buyer Warehouse',
  consigneeAddress: '789 Warehouse Test Road, Sample City, Testland',
  consigneeCountry: 'Testland',
  consigneeTelephone: '+1 000 000 0002',
};
const item = (n) => ({
  id: `line-${n}`,
  description: `Thermostatic shower system model ${String(n).padStart(2, '0')} with overhead and hand shower`,
  modelSku: `ITEM-${String(n).padStart(3, '0')}`,
  material: 'Brass / Stainless Steel',
  hsCode: '84818090',
  quantity: 10,
  ciQuantity: 10,
  packingQuantity: 10,
  unit: 'SETS',
  unitPrice: 125.5,
  netWeight: 4.5,
  grossWeight: 5.2,
  cartonQty: 2,
  quantityPerCarton: 5,
  cartonLength: 80,
  cartonWidth: 40,
  cartonHeight: 30,
});
const base = {
  id: 'signing-qa',
  orderNumber: 'ORD-20260719-901',
  piNumber: 'PI-202607-901',
  ciNumber: 'CI-202607-901',
  packingListNumber: 'PL-202607-901',
  customerId: 'buyer',
  currency: 'USD',
  incotermCode: 'CIF',
  namedPlace: 'Hamburg',
  paymentTerm: '30% Deposit, 70% Before Shipment',
  deliveryTime: '30 days after deposit',
  validUntil: '2026-08-18',
  plannedTransportMethod: 'Sea Freight',
  actualShipmentDate: '2026-07-19',
  shipmentDate: '2026-07-19',
  actualTransportMethod: 'Sea Freight',
  actualTransportConfirmed: true,
  carrier: 'Maersk Line',
  transportDocumentType: 'Bill of Lading',
  transportDocumentNumber: 'BL-20260719-901',
  portOfLoading: 'Yantian, Shenzhen',
  portOfDischarge: 'Hamburg',
  countryOfOrigin: 'China',
  purposeOfShipment: 'Commercial Sale',
  paymentAccountId: 'usd',
  createdDate: '2026-07-19',
  shippingMark: 'TEST / TESTLAND',
  declaration: 'We hereby certify that the information on this invoice is true and correct.',
  freight: 88.5,
  insurance: 12.25,
  discount: 25,
  otherCharges: 5.75,
  depositPercentage: 30,
  amountPaid: 0,
  items: [item(1)],
};
const make = (versions, modes = {}, items = base.items) =>
  C.calculateOrder({ ...base, ...versions, ...modes, items });
const docs = [
  [
    'Signing-Draft-PI.pdf',
    'PI',
    make({ piVersion: 'Draft' }, { piSigningMode: 'Electronic', piIncludeSigningBlock: true }),
  ],
  [
    'Signing-Draft-CI.pdf',
    'CI',
    make({ ciVersion: 'Draft' }, { ciSigningMode: 'Electronic', ciIncludeSigningBlock: true }),
  ],
  [
    'Signing-Draft-Packing-List.pdf',
    'PL',
    make({ plVersion: 'Draft' }, { plSigningMode: 'Electronic', plIncludeSigningBlock: true }),
  ],
  [
    'Signing-Final-PI-Print.pdf',
    'PI',
    make(
      { piVersion: 'Final' },
      { piSigningMode: 'Print', piIncludeSigningBlock: true, piUseDocumentDateForPrint: false },
    ),
  ],
  [
    'Signing-Final-CI-Print.pdf',
    'CI',
    make(
      { ciVersion: 'Final' },
      { ciSigningMode: 'Print', ciIncludeSigningBlock: true, ciUseDocumentDateForPrint: false },
    ),
  ],
  [
    'Signing-Final-Packing-List-Print.pdf',
    'PL',
    make(
      { plVersion: 'Final' },
      { plSigningMode: 'Print', plIncludeSigningBlock: true, plUseDocumentDateForPrint: false },
    ),
  ],
  [
    'Signing-Multipage-PI-Print.pdf',
    'PI',
    make(
      { piVersion: 'Final' },
      { piSigningMode: 'Print', piIncludeSigningBlock: true },
      Array.from({ length: 28 }, (_, i) => item(i + 1)),
    ),
  ],
];
const ctx = { company, customers: [customer], orders: docs.map(([, , order]) => order) },
  out = path.join(__dirname, '..', 'output', 'pdf');
fs.mkdirSync(out, { recursive: true });
for (const type of ['PI', 'CI', 'PL']) {
  const key = type.toLowerCase(),
    electronic = make(
      { [`${key}Version`]: 'Final' },
      { [`${key}SigningMode`]: 'Electronic', [`${key}IncludeSigningBlock`]: true },
    );
  const check = C.validateDocumentExport(electronic, type, ctx);
  if (!check.errors.includes('未检测到正式签名或公司印章，请检查公司资料上传状态。'))
    throw new Error(`${type} electronic missing-image guard failed`);
}
for (const [name, type, order] of docs) {
  const check = C.validateDocumentExport(order, type, ctx);
  if (check.errors.length) throw new Error(`${name}: ${check.errors.join('; ')}`);
  const doc =
    type === 'PI'
      ? global.FTPDF.buildPI(order, ctx)
      : type === 'CI'
        ? global.FTPDF.buildCI(order, ctx)
        : global.FTPDF.buildPL(order, ctx);
  fs.writeFileSync(path.join(out, name), Buffer.from(doc.output('arraybuffer')));
}
console.log(
  `Generated ${docs.length} PDFs without embedded signature or stamp test assets; Electronic Final export correctly blocked.`,
);
