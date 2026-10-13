'use strict';

const C = require('../../js/core.js');
const { ValidationError, ConflictError, NotFoundError } = require('../db/errors');
const { clone } = require('../repositories/business-repository');
const { requireExpectedVersion, requireRecord } = require('./business-crud-service');
const {
  requireCurrency,
  requireValidOrderFiles,
  requireValidPaymentCurrencies,
} = require('./input-policy');

const PROTECTED_FIELDS = Object.freeze([
  'orderNumber',
  'piNumber',
  'ciNumber',
  'packingListNumber',
  'piHistory',
  'activePiRevision',
  'piDocument',
  'piVersion',
  'piSignedAt',
  'piSigningSnapshot',
  'ciDocument',
  'ciVersion',
  'ciSignedAt',
  'ciSigningSnapshot',
  'packingListDocument',
  'plVersion',
  'plSignedAt',
  'plSigningSnapshot',
  'paymentRecords',
  'currentPaymentStage',
  'amountPaid',
  'outstandingAmount',
  'amountDue',
  'amountPayableNow',
  'subtotal',
  'total',
  'depositAmount',
  'balancePayment',
  'balanceAmount',
  'totalCartons',
  'totalNetWeight',
  'totalGrossWeight',
  'totalCBM',
]);
const SIGNING_MODES = new Set(['Electronic', 'Print']);
const PACKING_PROTECTED_FIELDS = Object.freeze([
  'id',
  'orderId',
  'orderNumber',
  'piNumber',
  'ciNumber',
  'number',
  'packingListNumber',
  'customerId',
  'relatedCiNumber',
  'relatedPiNumber',
  'relatedPiRevision',
  'seller',
  'buyer',
  'createdAt',
  'createdDate',
  'status',
  'documentStatus',
  'finalizedAt',
  'signedAt',
  'plVersion',
  'plSignedAt',
  'plSigningMode',
  'plIncludeSigningBlock',
  'plUseDocumentDateForPrint',
  'plSigningSnapshot',
  'signingSnapshot',
  'finalSnapshot',
  'documentSnapshot',
]);

function equal(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}
function assertOrdinaryUpdateSafe(current, proposed) {
  for (const field of PROTECTED_FIELDS)
    if (!equal(current[field], proposed[field])) {
      throw new ConflictError(`Protected order field requires a business action: ${field}`);
    }
}
function assertPackingProtectedFields(current = {}, proposed = {}) {
  const changed = (left, right, field) =>
    Object.prototype.hasOwnProperty.call(left, field) !==
      Object.prototype.hasOwnProperty.call(right, field) ||
    (Object.prototype.hasOwnProperty.call(left, field) &&
      JSON.stringify(left[field]) !== JSON.stringify(right[field]));
  for (const field of PACKING_PROTECTED_FIELDS)
    if (changed(current, proposed, field)) {
      throw new ConflictError(
        `Protected Packing List field requires finalize-packing-list: ${field}`,
      );
    }
  const currentData = current.data || {},
    proposedData = proposed.data || {};
  for (const field of PACKING_PROTECTED_FIELDS)
    if (changed(currentData, proposedData, field)) {
      throw new ConflictError(
        `Protected Packing List data requires finalize-packing-list: ${field}`,
      );
    }
}
function isFinalPackingList(order, record) {
  return (
    order?.plVersion === 'Final' ||
    order?.packingListDocument?.status === 'Final' ||
    record?.status === 'Final' ||
    record?.documentStatus === 'Final' ||
    record?.data?.plVersion === 'Final'
  );
}
function settings(body = {}, prefix) {
  const mode = body.signingMode === 'Print' ? 'Print' : 'Electronic';
  return {
    [`${prefix}SigningMode`]: mode,
    [`${prefix}IncludeSigningBlock`]: body.includeSigningBlock !== false,
    [`${prefix}UseDocumentDateForPrint`]: Boolean(body.useDocumentDateForPrint),
  };
}

class OrderOperationService {
  constructor(db, repositories, sequenceService) {
    this.db = db;
    this.repositories = repositories;
    this.sequenceService = sequenceService;
    this.createTransaction = db.transaction((input) => this.createInside(input));
    this.updateTransaction = db.transaction((id, input, expected) =>
      this.updateInside(id, input, expected),
    );
    this.actionTransaction = db.transaction((name, id, input, expected) =>
      this.actionInside(name, id, input, expected),
    );
    this.packingTransaction = db.transaction((name, id, input, expectedOrder, expectedPacking) =>
      this.packingInside(name, id, input, expectedOrder, expectedPacking),
    );
  }
  context() {
    return {
      company: this.repositories.company.get('main')?.payload || {},
      customers: this.repositories.customers.list().map((row) => row.payload),
      orders: this.repositories.orders.list().map((row) => row.payload),
    };
  }
  current(id, expectedVersion) {
    const row = this.repositories.orders.get(id);
    if (!row) throw new NotFoundError('Order not found');
    if (row.rowVersion !== requireExpectedVersion(expectedVersion)) throw new ConflictError();
    return row;
  }
  save(order, version) {
    order.updatedAt = new Date().toISOString();
    return this.repositories.orders.put(order, version);
  }
  createInside(input) {
    requireRecord(input);
    if (this.repositories.orders.get(input.id)) throw new ConflictError();
    const date = input.createdDate || C.today(),
      base = C.newOrder([]);
    let order = C.calculateOrder({ ...base, ...clone(input), id: input.id, createdDate: date });
    order.orderNumber = this.sequenceService.allocate('order', date);
    order.piNumber = this.sequenceService.allocate('pi', date);
    Object.assign(order, {
      ciNumber: '',
      packingListNumber: '',
      piVersion: 'Draft',
      ciVersion: 'Draft',
      plVersion: 'Draft',
      piSignedAt: '',
      ciSignedAt: '',
      plSignedAt: '',
      piSigningSnapshot: null,
      ciSigningSnapshot: null,
      plSigningSnapshot: null,
      piHistory: [],
      activePiRevision: null,
      piDocument: { number: order.piNumber, status: 'Draft', revision: 0 },
      ciDocument: null,
      packingListDocument: null,
      paymentRecords: [],
      amountPaid: 0,
    });
    order = C.calculateOrder(order);
    order.activePiRevision = null;
    requireCurrency(order.currency);
    requireValidOrderFiles(order);
    return this.save(order, 0);
  }
  updateInside(id, proposed, expectedVersion) {
    requireRecord(proposed, id);
    const row = this.current(id, expectedVersion);
    assertOrdinaryUpdateSafe(row.payload, proposed);
    requireCurrency(proposed.currency, row.payload.currency);
    requireValidOrderFiles(proposed, row.payload);
    const finalPackingList = isFinalPackingList(row.payload, row.payload.packingListDocument)
      ? clone(row.payload.packingListDocument)
      : null;
    const updated = C.updateStageDocuments(C.calculateOrder(clone(proposed)));
    // Final document content is immutable; ordinary order recalculation must not rewrite its embedded copy.
    if (finalPackingList) updated.packingListDocument = finalPackingList;
    return this.save(updated, row.rowVersion);
  }
  validateFinal(order, type, context) {
    const result = C.validateDocumentExport(order, type, context);
    if (result.errors.length) throw new ValidationError(result.errors[0]);
  }
  actionInside(name, id, input = {}, expectedVersion) {
    const row = this.current(id, expectedVersion),
      ctx = this.context();
    let order = C.calculateOrder(clone(row.payload));
    const finalPackingList = isFinalPackingList(row.payload, row.payload.packingListDocument)
      ? clone(row.payload.packingListDocument)
      : null;
    if (name === 'finalize-pi') {
      if (C.latestPISnapshot(order)) {
        if (C.needsPIRevision(order))
          throw new ConflictError('PI content changed; create a Revised PI');
        throw new ConflictError('Final PI already exists');
      }
      Object.assign(order, settings(input, 'pi'), { piVersion: 'Final' });
      this.validateFinal(order, 'PI', ctx);
      order = C.createPISnapshot(order, ctx, 0);
    } else if (name === 'revise-pi') {
      if (!C.latestPISnapshot(order)) throw new ConflictError('Original Final PI is required');
      if (!C.needsPIRevision(order))
        throw new ConflictError('Current PI content does not require a revision');
      Object.assign(order, settings(input, 'pi'), { piVersion: 'Final' });
      this.validateFinal(order, 'PI', ctx);
      order = C.createPISnapshot(order, ctx);
    } else if (name === 'generate-ci') {
      if (!C.latestPISnapshot(order))
        throw new ConflictError('A valid Final PI is required before CI generation');
      if (order.ciDocument) throw new ConflictError('CI already exists');
      order.ciNumber = this.sequenceService.allocate('ci', order.createdDate || C.today());
      order = C.createCIDocument(order, ctx.orders, false, ctx);
      order = C.updateStageDocuments(order);
    } else if (name === 'confirm-ci-differences') {
      if (!order.ciDocument) throw new ConflictError('CI does not exist');
      order = C.updateStageDocuments(order);
      order.ciDocument.differencesConfirmed = true;
    } else if (name === 'finalize-ci') {
      if (!order.ciDocument || !C.latestPISnapshot(order))
        throw new ConflictError('CI requires a valid Final PI');
      Object.assign(order, settings(input, 'ci'), { ciVersion: 'Final' });
      order = C.updateStageDocuments(order);
      this.validateFinal(order, 'CI', { ...ctx, customers: [order.ciDocument.buyer || {}] });
      const signedAt = new Date().toISOString();
      order.ciSignedAt = signedAt;
      order.ciSigningSnapshot = C.createSigningSnapshot(ctx.company, signedAt);
      order.ciDocument = {
        ...order.ciDocument,
        status: 'Final',
        finalizedAt: signedAt,
        data: {
          ...order.ciDocument.data,
          ciVersion: 'Final',
          ciSignedAt: signedAt,
          ciSigningSnapshot: clone(order.ciSigningSnapshot),
        },
      };
    } else if (name === 'payment-tracking') {
      if (!Array.isArray(input.paymentRecords))
        throw new ValidationError('Payment records must be an array');
      const ids = new Set();
      for (const payment of input.paymentRecords) {
        if (!payment || typeof payment.id !== 'string' || !payment.id || ids.has(payment.id))
          throw new ValidationError('Payment records require unique ids');
        ids.add(payment.id);
        if (Number(payment.amount) < 0 || !C.PAYMENT_RECORD_STATUSES.includes(payment.status))
          throw new ValidationError('Payment record is invalid');
      }
      if (!C.PAYMENT_STAGES.some((stage) => stage.value === input.currentPaymentStage))
        throw new ValidationError('Payment stage is invalid');
      requireValidPaymentCurrencies(input.paymentRecords, row.payload.paymentRecords);
      requireValidOrderFiles({ paymentRecords: input.paymentRecords }, row.payload);
      order.paymentRecords = clone(input.paymentRecords);
      order.currentPaymentStage = input.currentPaymentStage;
      order.amountPayableNowManualValue = Number(input.amountPayableNowManualValue) || 0;
      order.amountPayableNowNote = String(input.amountPayableNowNote || '');
      order = C.calculateOrder(order);
    } else throw new NotFoundError('Business action not found');
    // Every order action must preserve an already-issued Packing List exactly.
    if (finalPackingList) order.packingListDocument = finalPackingList;
    return this.save(order, row.rowVersion);
  }
  packingInside(name, id, input = {}, expectedOrderVersion, expectedPackingVersion = 0) {
    const row = this.current(id, expectedOrderVersion),
      ctx = this.context();
    let order = C.calculateOrder(clone(row.payload)),
      record;
    if (name === 'generate-packing-list') {
      if (!order.ciDocument)
        throw new ConflictError('CI is required before Packing List generation');
      if (order.packingListDocument) throw new ConflictError('Packing List already exists');
      if (
        !C.actualShipmentDate(order) ||
        !C.actualTransportMethod(order) ||
        !order.actualTransportConfirmed
      )
        throw new ValidationError('Actual shipment details must be confirmed');
      order.packingListNumber = this.sequenceService.allocate('pl', order.createdDate || C.today());
      order = C.createPackingListDocument(order, ctx.orders);
      order.packingListDocument.data.namedPlaceConfirmed = Boolean(row.payload.namedPlaceConfirmed);
      order.packingListDocument.data.testMode = Boolean(row.payload.testMode);
      if (row.payload.documentMode)
        order.packingListDocument.data.documentMode = row.payload.documentMode;
      record = {
        ...clone(order.packingListDocument),
        id: order.packingListDocument.id,
        orderId: order.id,
        orderNumber: order.orderNumber,
        number: order.packingListNumber,
        updatedAt: new Date().toISOString(),
      };
    } else {
      const existing = this.repositories.packingLists.get(
        input.packingList?.id || order.packingListDocument?.id,
      );
      if (!existing || existing.payload.orderId !== id)
        throw new NotFoundError('Packing List not found');
      if (existing.rowVersion !== requireExpectedVersion(expectedPackingVersion))
        throw new ConflictError();
      const proposed = input.packingList;
      requireRecord(proposed, existing.payload.id);
      if (
        proposed.orderId !== id ||
        proposed.number !== order.packingListNumber ||
        proposed.data?.packingListNumber !== order.packingListNumber
      )
        throw new ConflictError('Packing List identity is protected');
      if (name === 'save-packing-list' && isFinalPackingList(order, existing.payload))
        throw new ConflictError('Final Packing List is immutable');
      if (name === 'finalize-packing-list' && isFinalPackingList(order, existing.payload))
        throw new ConflictError('Final Packing List already exists');
      assertPackingProtectedFields(existing.payload, proposed);
      const data = C.calculateOrder(clone(proposed.data || {}));
      record = {
        ...clone(existing.payload),
        ...clone(proposed),
        number: order.packingListNumber,
        data,
        updatedAt: new Date().toISOString(),
      };
      order = {
        ...order,
        packingListDocument: clone(record),
        plVersion: data.plVersion || 'Draft',
      };
      if (name === 'finalize-packing-list') {
        Object.assign(order, settings(input, 'pl'), { plVersion: 'Final' });
        const signedAt = new Date().toISOString();
        order.plSignedAt = signedAt;
        order.plSigningSnapshot =
          input.includeSigningBlock === false
            ? null
            : C.createSigningSnapshot(ctx.company, signedAt);
        order.packingListDocument.data = {
          ...data,
          plVersion: 'Final',
          ...settings(input, 'pl'),
          plSignedAt: signedAt,
          plSigningSnapshot: clone(order.plSigningSnapshot),
        };
        order.packingListDocument.status = 'Final';
        record = clone(order.packingListDocument);
        this.validateFinal(C.documentOrder(order, 'PL'), 'PL', {
          ...ctx,
          customers: [record.buyer || {}],
        });
      } else if (name !== 'save-packing-list')
        throw new NotFoundError('Packing List action not found');
    }
    order.updatedAt = new Date().toISOString();
    const savedOrder = this.repositories.orders.put(order, row.rowVersion);
    const savedPackingList = this.repositories.packingLists.put(
      record,
      name === 'generate-packing-list' ? 0 : expectedPackingVersion,
    );
    return { order: savedOrder, packingList: savedPackingList };
  }
  createOrder(input) {
    return this.createTransaction(clone(input));
  }
  updateOrder(id, input, expectedVersion) {
    return this.updateTransaction(id, clone(input), expectedVersion);
  }
  action(name, id, input, expectedVersion) {
    return this.actionTransaction(name, id, clone(input || {}), expectedVersion);
  }
  packingAction(name, id, input, expectedOrderVersion, expectedPackingVersion) {
    return this.packingTransaction(
      name,
      id,
      clone(input || {}),
      expectedOrderVersion,
      expectedPackingVersion,
    );
  }
}

module.exports = {
  OrderOperationService,
  PROTECTED_FIELDS,
  PACKING_PROTECTED_FIELDS,
  assertOrdinaryUpdateSafe,
  assertPackingProtectedFields,
};
