'use strict';

const fs = require('node:fs');
const path = require('node:path');

global.window = global;
const C = require('../js/core.js');
global.jspdf = require('jspdf');
require('jspdf-autotable');
require('../js/pdf.js');

const outputDirectory = path.resolve(process.argv[2] || path.join(__dirname, '..', 'tmp', 'pdfs', 'phase6'));
fs.mkdirSync(outputDirectory, { recursive: true });

function packageVersion(name) {
  let directory = path.dirname(require.resolve(name));
  while (directory !== path.dirname(directory)) {
    const packageFile = path.join(directory, 'package.json');
    if (fs.existsSync(packageFile)) return JSON.parse(fs.readFileSync(packageFile, 'utf8')).version;
    directory = path.dirname(directory);
  }
  throw new Error(`Unable to resolve package version: ${name}`);
}

const testImage = require('./fixtures/test-image')();
const company = {
  id: 'main',
  documentMode: 'Test',
  testMode: true,
  englishName: 'Example Export Testing Co., Ltd.',
  chineseName: 'TEST EXPORT COMPANY',
  address: '123 Test Street, Test City, Testland',
  telephone: '+1 000 000 0000',
  email: 'qa@example.invalid',
  website: 'https://example.invalid',
  taxId: 'TEST-TAX-ID-0001',
  authorizedSignatoryName: 'Test Signatory',
  authorizedSignatoryTitle: 'TEST Export Director',
  logo: '',
  signatureImage: testImage,
  companyStampImage: testImage,
  accounts: [{
    id: 'test-usd',
    label: 'Example Test USD Account',
    currency: 'USD',
    beneficiaryName: 'Example Export Testing Co., Ltd.',
    bankName: 'Example Test Bank',
    bankAddress: '1 Test Bank Road, Test City, Testland',
    accountNumber: '000000000000',
    achRoutingNumber: '000000000',
    wireRoutingNumber: '000000000',
    swift: 'TESTBANKXXX',
    paymentReference: 'Use the TEST document number.'
  }]
};
const customer = {
  id: 'test-buyer',
  buyerType: 'Company',
  buyerName: 'Sample Buyer Testing Ltd.',
  companyName: 'Sample Buyer Testing Ltd.',
  address: '456 Buyer Test Avenue, Sample City, Testland',
  country: 'Testland',
  contactPerson: 'Test Contact',
  telephone: '+1 000 000 0001',
  email: 'buyer@example.invalid',
  consigneeName: 'Sample Buyer Testing Warehouse',
  consigneeAddress: '789 Warehouse Test Road, Sample City, Testland',
  consigneeCountry: 'Testland',
  consigneeTelephone: '+1 000 000 0002'
};

function item(index) {
  const number = String(index).padStart(3, '0');
  return {
    id: `test-line-${number}`,
    description: `TEST thermostatic shower system product line ${number} with overhead and hand shower`,
    modelSku: `TEST-MODEL-${number} / TEST-SKU-${number}`,
    material: 'TEST Brass / Stainless Steel',
    hsCode: '84818090',
    countryOfOrigin: 'Testland',
    quantity: 10 + index,
    ciQuantity: 10 + index,
    packingQuantity: 10 + index,
    unit: 'SETS',
    unitPrice: 100 + index,
    packageType: 'TEST Carton',
    cartonQty: 2,
    quantityPerCarton: (10 + index) / 2,
    netWeight: 4,
    grossWeight: 5,
    netWeightPerCarton: 20,
    grossWeightPerCarton: 25,
    cartonLength: 60,
    cartonWidth: 40,
    cartonHeight: 30
  };
}

const base = {
  ...C.newOrder([]),
  id: 'phase6-test-order',
  documentMode: 'Test',
  testMode: true,
  orderNumber: 'ORD-TEST-20260908-001',
  piNumber: 'PI-TEST-202609-001',
  ciNumber: 'CI-TEST-202609-001',
  packingListNumber: 'PL-TEST-202609-001',
  customerId: customer.id,
  paymentAccountId: 'test-usd',
  currency: 'USD',
  createdDate: '2026-09-08',
  validUntil: '2026-10-08',
  incotermCode: 'FOB',
  tradeTerm: 'FOB',
  namedPlace: 'Test Export Port, Testland',
  namedPlaceConfirmed: true,
  paymentTerm: '30% Deposit, 70% Before Shipment',
  deliveryTime: '30 TEST days after deposit',
  plannedTransportMethod: 'Sea Freight',
  actualShipmentDate: '2026-09-09',
  shipmentDate: '2026-09-09',
  actualTransportMethod: 'Sea Freight',
  actualTransportConfirmed: true,
  carrier: 'Example Test Logistics Co.',
  transportDocumentType: 'Bill of Lading',
  transportDocumentNumber: 'TEST-BL-0001',
  vesselFlightNumber: 'TEST-VESSEL-01',
  portOfLoading: 'Test Export Port, Testland',
  portOfDischarge: 'Test Import Port, Testland',
  estimatedArrivalDate: '2026-10-01',
  countryOfOrigin: 'Testland',
  purposeOfShipment: 'Commercial Sale',
  shippingMark: 'TEST SHIPPING MARK',
  declaration: 'We certify that this TEST invoice information is true and correct.',
  packingRemarks: 'TEST cartons must remain dry.',
  plShowDeclaration: true,
  plDeclaration: 'We certify that these TEST packing details are true and correct.',
  customerRemarks: 'TEST CUSTOMER REMARKS',
  showCustomerRemarksOnPI: true,
  showCustomerRemarksOnCI: true,
  showCustomerRemarksOnPL: true,
  freight: 120,
  insurance: 30,
  discount: 10,
  otherCharges: 5,
  depositPercentage: 30,
  paymentRecords: [{ id: 'test-payment', status: 'Confirmed', amount: 500, date: '2026-09-08' }],
  items: [item(1)]
};
const ctx = { company, customers: [customer], orders: [] };
const single = C.calculateOrder(base);
const multi = C.calculateOrder({ ...base, id: 'phase6-test-order-multi', items: [item(1), item(2), item(3)] });
const long = C.calculateOrder({ ...base, id: 'phase6-test-order-long', items: Array.from({ length: 75 }, (_, index) => item(index + 1)) });

const variants = [
  ['01-draft-pi-single.pdf', 'PI', single, { piVersion: 'Draft' }],
  ['02-final-pi-unsigned-single.pdf', 'PI', single, { piVersion: 'Final', piIncludeSigningBlock: false }],
  ['03-final-pi-electronic-single.pdf', 'PI', single, { piVersion: 'Final', piSigningMode: 'Electronic', piIncludeSigningBlock: true, piSignedAt: '2026-09-08T08:00:00.000Z' }],
  ['04-final-pi-print-single.pdf', 'PI', single, { piVersion: 'Final', piSigningMode: 'Print', piIncludeSigningBlock: true, piUseDocumentDateForPrint: false }],
  ['05-revised-pi-multi.pdf', 'PI', multi, { piVersion: 'Final', piRevision: 1, piDisplayNumber: 'PI-TEST-202609-001-R1', piSigningMode: 'Electronic', piIncludeSigningBlock: true, piSignedAt: '2026-09-08T08:00:00.000Z' }],
  ['06-draft-ci-multi.pdf', 'CI', multi, { ciVersion: 'Draft' }],
  ['07-final-ci-electronic-multi.pdf', 'CI', multi, { ciVersion: 'Final', ciSigningMode: 'Electronic', ciIncludeSigningBlock: true, ciSignedAt: '2026-09-09T08:00:00.000Z' }],
  ['08-final-ci-print-multi.pdf', 'CI', multi, { ciVersion: 'Final', ciSigningMode: 'Print', ciIncludeSigningBlock: true, ciUseDocumentDateForPrint: false }],
  ['09-draft-pl-multi.pdf', 'PL', multi, { plVersion: 'Draft' }],
  ['10-final-pl-unsigned-multi.pdf', 'PL', multi, { plVersion: 'Final', plIncludeSigningBlock: false }],
  ['11-final-pl-electronic-multi.pdf', 'PL', multi, { plVersion: 'Final', plSigningMode: 'Electronic', plIncludeSigningBlock: true, plSignedAt: '2026-09-09T08:00:00.000Z' }],
  ['12-final-pl-print-multi.pdf', 'PL', multi, { plVersion: 'Final', plSigningMode: 'Print', plIncludeSigningBlock: true, plUseDocumentDateForPrint: false }],
  ['13-final-pi-electronic-multipage.pdf', 'PI', long, { piVersion: 'Final', piSigningMode: 'Electronic', piIncludeSigningBlock: true, piSignedAt: '2026-09-08T08:00:00.000Z' }],
  ['14-final-ci-electronic-multipage.pdf', 'CI', long, { ciVersion: 'Final', ciSigningMode: 'Electronic', ciIncludeSigningBlock: true, ciSignedAt: '2026-09-09T08:00:00.000Z' }],
  ['15-final-pl-electronic-multipage.pdf', 'PL', long, { plVersion: 'Final', plSigningMode: 'Electronic', plIncludeSigningBlock: true, plSignedAt: '2026-09-09T08:00:00.000Z' }]
];

const builders = { PI: global.FTPDF.buildPI, CI: global.FTPDF.buildCI, PL: global.FTPDF.buildPL };
const manifest = [];
for (const [fileName, type, source, overrides] of variants) {
  const data = C.calculateOrder({ ...source, ...overrides });
  const doc = builders[type](data, ctx);
  const internalText = doc.internal.pages.flat().join('\n');
  for (const required of ['TEST SAMPLE - NOT FOR COMMERCIAL USE', company.englishName, customer.companyName, data.orderNumber]) {
    if (!internalText.includes(required)) throw new Error(`${fileName}: missing ${required}`);
  }
  const documentNumber = type === 'PI' ? (data.piDisplayNumber || data.piNumber) : type === 'CI' ? data.ciNumber : data.packingListNumber;
  if (!internalText.includes(documentNumber)) throw new Error(`${fileName}: missing document number ${documentNumber}`);
  const buffer = Buffer.from(doc.output('arraybuffer'));
  fs.writeFileSync(path.join(outputDirectory, fileName), buffer);
  manifest.push({
    fileName,
    type,
    pages: doc.getNumberOfPages(),
    bytes: buffer.length,
    documentNumber,
    itemCount: data.items.length,
    total: data.total,
    totalCartons: data.totalCartons,
    totalNetWeight: data.totalNetWeight,
    totalGrossWeight: data.totalGrossWeight,
    totalCBM: data.totalCBM,
    signingMode: C.documentSettings(data, type).signingMode,
    includeSigningBlock: C.documentSettings(data, type).includeSigningBlock
  });
}

fs.writeFileSync(path.join(outputDirectory, 'manifest.json'), JSON.stringify({
  generatedAt: new Date().toISOString(),
  jspdf: packageVersion('jspdf'),
  jspdfAutotable: packageVersion('jspdf-autotable'),
  fixtures: { company: company.englishName, buyer: customer.companyName, accountNumber: company.accounts[0].accountNumber },
  documents: manifest
}, null, 2));
console.log(JSON.stringify(manifest, null, 2));
