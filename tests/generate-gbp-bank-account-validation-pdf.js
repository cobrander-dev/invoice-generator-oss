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
  chineseName: 'Example Test Company',
  telephone: '+1 000 000 0000',
  email: 'qa@example.invalid',
  address: '123 Test Street, Test City, Testland',
  website: 'https://example.invalid',
  taxId: 'QA-TAX-ID-0001',
  authorizedSignatoryName: 'Test Signatory',
  authorizedSignatoryTitle: 'QA Signatory & Director',
  logo: '',
  signature: '',
  stamp: '',
  accounts: [
    {
      id: 'test-gbp',
      label: 'Example Test GBP Account',
      currency: 'GBP',
      beneficiaryName: 'Example Export Testing Co., Ltd.',
      bankName: 'Example Test Bank',
      bankAddress: '2 Test Bank Road, Test City, Testland',
      accountNumber: '000000000001',
      sortCode: '000000',
      iban: 'TEST-IBAN-0001',
      swift: 'TESTBANKXXX',
      paymentReference: 'Please include the PI number in the payment reference.',
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
};
const order = {
  id: 'order',
  orderNumber: 'ORD-20260718-GBP',
  piNumber: 'PI-202607-GBP',
  piVersion: 'Final',
  piShowSignature: false,
  piShowStamp: false,
  customerId: 'buyer',
  currency: 'GBP',
  tradeTerm: 'FOB',
  namedPlace: 'Shenzhen',
  paymentTerm: '30% Deposit, 70% Before Shipment',
  deliveryTime: '30 days after deposit',
  validUntil: '2026-08-16',
  transportMethod: 'Sea Freight',
  countryOfOrigin: 'China',
  purposeOfShipment: 'Commercial Sale',
  paymentAccountId: 'test-gbp',
  status: 'Draft',
  createdDate: '2026-07-18',
  shipmentDate: '',
  shippingMark: 'N/M',
  declaration: 'We hereby certify that the information on this invoice is true and correct.',
  notes: '',
  freight: 0,
  insurance: 0,
  discount: 0,
  otherCharges: 0,
  depositPercentage: 30,
  amountPaid: 0,
  items: [
    {
      id: 'line',
      description: 'Thermostatic shower system with overhead and hand shower',
      modelSku: 'TS680 / RR-TS680',
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
    },
  ],
};
const ctx = { company, customers: [customer], orders: [order] };
const validation = C.validateDocumentExport(order, 'PI', ctx);
if (validation.errors.length) throw new Error(validation.errors.join('; '));
const lines = C.paymentInformationLines(company.accounts[0]);
const expected = [
  'Account Number: 000000000001',
  'Sort Code: 000000',
  'IBAN: TEST-IBAN-0001',
  'SWIFT/BIC: TESTBANKXXX',
];
for (const value of expected) {
  if (!lines.includes(value)) throw new Error(`Missing payment line: ${value}`);
}
if (lines.some((value) => value.includes('ACH Routing') || value.includes('Wire Routing')))
  throw new Error('GBP payment information contains USD routing fields');
const doc = global.FTPDF.buildPI(order, ctx),
  out = path.join(__dirname, '..', 'output', 'pdf', 'GBP-Account-Validation-Final-PI.pdf');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, Buffer.from(doc.output('arraybuffer')));
console.log('Generated GBP account validation Final PI');
