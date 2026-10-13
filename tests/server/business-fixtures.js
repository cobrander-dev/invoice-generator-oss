'use strict';
const TEST_IMAGE = 'data:image/png;base64,VEVTVCBJTUFHRSBOT1QgUkVBTA==';
const TEST_ATTACHMENT = 'data:application/octet-stream;base64,VEVTVCBBVFRBQ0hNRU5U';
function complexOrder(id = 'order-test-001') {
  return {
    id, orderNumber: 'TEST-ORDER-001', piNumber: 'TEST-PI-001', currency: 'USD', currentPaymentStage: 'Balance Requested',
    subtotal: 200, freight: 20, insurance: 3, discount: 2, otherCharges: 1, totalAmount: 222,
    items: [{ id: 'line-test-1', description: 'TEST Product', quantity: 2, unitPrice: 100, amount: 200, cartons: 1, netWeight: 1, grossWeight: 2, cbm: 0.01 }],
    paymentRecords: [{ id: 'payment-test-1', amount: 50, status: 'Confirmed', paymentSlip: { name: 'TEST-slip.txt', type: 'text/plain', size: 9, data: TEST_ATTACHMENT } }],
    piHistory: [{ id: 'pi-test-r0', revision: 0, status: 'Final', data: { immutableTestMarker: 'TEST PI SNAPSHOT' } }],
    piDocument: { number: 'TEST-PI-001', status: 'Final', revision: 0 },
    ciDocument: { number: 'TEST-CI-001', status: 'Draft', data: { actualShipmentDate: '2026-01-01' } },
    packingListDocument: { id: 'pl-test-001', number: 'TEST-PL-001', data: { totalCartons: 1 } },
    attachments: [{ id: 'attachment-test-1', name: 'TEST-file.bin', type: 'application/octet-stream', size: 15, data: TEST_ATTACHMENT }],
    unknownOrderField: { preserve: ['TEST', 1, true] }
  };
}
function backupA(version = 2) {
  const backup = {
    version, createdAt: '2026-01-01T00:00:00.000Z', exportedAt: '2026-01-01T00:00:00.000Z',
    company: [{ id: 'main', englishName: 'Example Current Testing Co., Ltd.', logo: TEST_IMAGE, signatureImage: TEST_IMAGE, signature: TEST_IMAGE,
      companyStampImage: TEST_IMAGE, stamp: TEST_IMAGE, routingNumber: '000000000', legacyRoutingNumber: '000000000',
      accounts: [{ id: 'test-account', accountNumber: '000000000000', swift: 'TESTBANKXXX', unknownAccountField: 'TEST preserve' }], extraCompanyField: { test: true } }],
    customers: [{ id: 'customer-test-1', buyerName: 'TEST Buyer One', country: 'Testland', extraCustomerField: 'keep' }],
    products: [{ id: 'product-test-1', englishName: 'TEST Product One', sku: 'TEST-SKU-1', extraProductField: 7 }],
    orders: [complexOrder()],
    packingLists: [{ id: 'pl-test-001', orderId: 'order-test-001', packingListNumber: 'TEST-PL-001', rows: [{ cartons: 1 }], extraPackingField: 'keep' }],
    meta: [{ id: 'test-meta', value: 'TEST only', unknownMeta: true }]
  };
  if (version === 1) delete backup.packingLists;
  return backup;
}
function backupB() {
  return {
    version: 2, createdAt: '2026-02-02T00:00:00.000Z', exportedAt: '2026-02-02T00:00:00.000Z',
    company: [{ id: 'main', englishName: 'Example Imported Testing Co., Ltd.', accounts: [] }],
    customers: [{ id: 'customer-test-b1', buyerName: 'TEST B1', country: 'Testland' }, { id: 'customer-test-b2', buyerName: 'TEST B2', country: 'Testland' }],
    products: [{ id: 'product-test-b1', englishName: 'TEST B Product', sku: 'TEST-B-1' }],
    orders: [{ ...complexOrder('order-test-b1'), orderNumber: 'TEST-B-ORDER-1' }],
    packingLists: [{ id: 'pl-test-b1', orderId: 'order-test-b1', packingListNumber: 'TEST-B-PL-1' }],
    meta: []
  };
}
module.exports = { TEST_IMAGE, TEST_ATTACHMENT, complexOrder, backupA, backupB };
