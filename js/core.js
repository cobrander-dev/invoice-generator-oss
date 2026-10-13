(function (global) {
  'use strict';

  const CURRENCIES = ['USD', 'EUR', 'GBP', 'AUD', 'CAD', 'JPY', 'CNY', 'CHF', 'HKD', 'SGD'];
  const UNITS = ['PCS', 'SETS', 'CARTONS', 'PAIRS', 'KG', 'UNITS', 'BOXES', 'ROLLS'];
  const STATUSES = [
    'Draft',
    'PI Sent',
    'Deposit Received',
    'In Production',
    'Ready to Ship',
    'Balance Received',
    'Shipped',
    'Completed',
    'Cancelled',
  ];
  const PURPOSES = [
    'Commercial Sale',
    'Sample for Product Evaluation',
    'Free Sample, Value for Customs Purposes Only',
    'Personal Purchase',
    'Replacement Goods',
    'Warranty Replacement',
    'Return Shipment',
    'Other',
  ];
  const TRANSPORT_METHODS = [
    'Sea Freight',
    'Inland Waterway',
    'Air Freight',
    'Rail Freight',
    'Road Freight',
    'Express / Courier',
    'Multimodal Transport',
    'Buyer Pickup / Customer Forwarder',
    'Other',
  ];
  const TRANSPORT_DOCUMENT_TYPES = [
    'Courier Tracking Number',
    'Bill of Lading',
    'Sea Waybill',
    'Air Waybill',
    'Rail Waybill',
    'Road Consignment Note',
    'Forwarder Reference',
    'Other',
  ];
  const PAYMENT_TERMS = [
    { label: '100% T/T in Advance', deposit: 100 },
    { label: '30% Deposit, 70% Before Shipment', deposit: 30 },
    { label: '50% Deposit, 50% Before Shipment', deposit: 50 },
    { label: '30% Deposit, 70% Against Copy of B/L', deposit: 30 },
    { label: '20% Deposit, 80% Before Shipment', deposit: 20 },
    { label: '100% Before Shipment', deposit: 0 },
    { label: 'L/C at Sight', deposit: 0 },
    { label: 'Net 15 Days', deposit: 0 },
    { label: 'Net 30 Days', deposit: 0 },
    { label: 'Net 60 Days', deposit: 0 },
    { label: 'Custom', deposit: null },
  ];
  const ATTACHMENT_CATEGORIES = [
    'Sales Contract',
    'Payment Slip',
    'Purchase Document',
    'Proforma Invoice',
    'Commercial Invoice',
    'Packing List',
    'Logistics Document',
    'Bill of Lading',
    'Air Waybill',
    'Customs Document',
    'Product Photo',
    'Inspection Report',
    'Delivery Confirmation',
    '其他 / Other',
  ];
  const PAYMENT_STAGES = [
    { value: 'Deposit Requested', label: '收取定金 / Deposit Requested' },
    { value: 'Waiting for Production', label: '等待生产 / Waiting for Production' },
    { value: 'Balance Requested', label: '收取尾款 / Balance Requested' },
    { value: 'Full Payment Requested', label: '收取全款 / Full Payment Requested' },
    { value: 'Payment Completed', label: '已付清 / Payment Completed' },
    { value: 'Custom', label: '自定义 / Custom' },
  ];
  const PAYMENT_RECORD_STATUSES = ['Pending', 'Confirmed', 'Rejected'];
  const PAYMENT_METHODS = [
    'T/T Bank Transfer',
    'WorldFirst',
    'Credit Card',
    'PayPal',
    'Cash',
    'Other',
  ];
  const PORT_PRESETS = [
    'Yantian Port, Shenzhen, China',
    'Shekou Port, Shenzhen, China',
    'Nansha Port, Guangzhou, China',
    'Shanghai Port, China',
    'Ningbo-Zhoushan Port, China',
    'Qingdao Port, China',
    'Hamburg Port, Germany',
    'Rotterdam Port, Netherlands',
    'Los Angeles Port, United States',
  ];
  const INCOTERMS = [
    {
      code: 'EXW',
      englishName: 'Ex Works',
      chineseName: '工厂交货',
      placeLabel: 'Named Place of Delivery',
      mode: 'any',
    },
    {
      code: 'FCA',
      englishName: 'Free Carrier',
      chineseName: '货交承运人',
      placeLabel: 'Named Place of Delivery',
      mode: 'any',
    },
    {
      code: 'CPT',
      englishName: 'Carriage Paid To',
      chineseName: '运费付至',
      placeLabel: 'Named Place of Destination',
      mode: 'any',
    },
    {
      code: 'CIP',
      englishName: 'Carriage and Insurance Paid To',
      chineseName: '运费及保险费付至',
      placeLabel: 'Named Place of Destination',
      mode: 'any',
    },
    {
      code: 'DAP',
      englishName: 'Delivered at Place',
      chineseName: '目的地交货',
      placeLabel: 'Named Place of Destination',
      mode: 'any',
    },
    {
      code: 'DPU',
      englishName: 'Delivered at Place Unloaded',
      chineseName: '卸货地卸货交货',
      placeLabel: 'Named Place of Destination',
      mode: 'any',
    },
    {
      code: 'DDP',
      englishName: 'Delivered Duty Paid',
      chineseName: '完税后交货',
      placeLabel: 'Named Place of Destination',
      mode: 'any',
    },
    {
      code: 'FAS',
      englishName: 'Free Alongside Ship',
      chineseName: '船边交货',
      placeLabel: 'Named Port of Shipment',
      mode: 'sea',
    },
    {
      code: 'FOB',
      englishName: 'Free On Board',
      chineseName: '船上交货',
      placeLabel: 'Named Port of Shipment',
      mode: 'sea',
    },
    {
      code: 'CFR',
      englishName: 'Cost and Freight',
      chineseName: '成本加运费',
      placeLabel: 'Named Port of Destination',
      mode: 'sea',
    },
    {
      code: 'CIF',
      englishName: 'Cost, Insurance and Freight',
      chineseName: '成本、保险费加运费',
      placeLabel: 'Named Port of Destination',
      mode: 'sea',
    },
  ];
  const MONEY_SYMBOLS = {
    USD: '$',
    EUR: '€',
    GBP: '£',
    AUD: 'A$',
    CAD: 'C$',
    JPY: '¥',
    CNY: '¥',
    CHF: 'CHF ',
    HKD: 'HK$',
    SGD: 'S$',
  };
  const NAMED_PLACE_TERMS = INCOTERMS.map((x) => x.code);
  const BANK_FIELDS = {
    USD: ['accountNumber', 'achRoutingNumber', 'wireRoutingNumber', 'swift'],
    EUR: ['iban', 'swift'],
    GBP: ['accountNumber', 'sortCode', 'iban', 'swift'],
    OTHER: ['accountNumber', 'iban', 'swift', 'localClearingCode'],
  };

  const uid = (prefix = 'id') =>
    `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const deepClone = (value) => (value == null ? value : JSON.parse(JSON.stringify(value)));
  const today = () => new Date().toISOString().slice(0, 10);
  const asNumber = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
  const cents = (value) => Math.round((asNumber(value) + Number.EPSILON) * 100);
  const moneyFromCents = (value) => Math.round(value) / 100;
  const money = (value) => moneyFromCents(cents(value));
  const escapeHtml = (value) =>
    String(value ?? '').replace(
      /[&<>'"]/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[c],
    );
  const companyEnglishName = (company) => company?.englishName ?? '';
  const companySignatureImage = (company) => company?.signatureImage || company?.signature || '';
  const companyStampImage = (company) => company?.companyStampImage || company?.stamp || '';
  function formatModelSku(value = '') {
    const parts = String(value || '')
      .split(/\s+\/\s+/)
      .map((part) => part.trim())
      .filter(Boolean);
    return parts.length > 1 && parts.every((part) => part === parts[0])
      ? parts[0]
      : parts.join(' / ');
  }
  const assetFingerprint = (value) => {
    const text = String(value || '');
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return text ? `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}-${text.length}` : '';
  };
  function createSigningSnapshot(company = {}, signedAt = new Date().toISOString()) {
    const signatureImage = companySignatureImage(company),
      companyStampImageValue = companyStampImage(company);
    return {
      companyEnglishName: companyEnglishName(company),
      authorizedSignatoryName: company.authorizedSignatoryName || '',
      authorizedSignatoryTitle: company.authorizedSignatoryTitle || '',
      signatureImage,
      companyStampImage: companyStampImageValue,
      signature: signatureImage,
      signatureFileName: company.signatureFileName || '',
      signatureHash: assetFingerprint(signatureImage),
      stamp: companyStampImageValue,
      stampFileName: company.stampFileName || '',
      stampHash: assetFingerprint(companyStampImageValue),
      signedAt,
    };
  }
  const formatDate = (value) =>
    value ? new Date(`${value}T00:00:00`).toLocaleDateString('zh-CN') : '-';
  const addDays = (date, days) => {
    const d = new Date(`${date}T00:00:00`);
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
  };

  function tradeTermCode(value = '') {
    return String(value).trim().split(/\s+/)[0].toUpperCase();
  }
  function incoterm(code = '') {
    return (
      INCOTERMS.find((x) => x.code === tradeTermCode(code)) ||
      INCOTERMS.find((x) => x.code === 'FOB')
    );
  }
  function requiresNamedPlace(value = '') {
    return INCOTERMS.some((x) => x.code === tradeTermCode(value));
  }
  function namedPlaceLabel(value = '') {
    return incoterm(value).placeLabel;
  }
  function requiresExplicitPort(value = '') {
    return ['FAS', 'FOB', 'CFR', 'CIF'].includes(tradeTermCode(value));
  }
  function isExplicitPort(value = '') {
    return /(?:\bport\b|\bharbou?r\b|\bterminal\b|港|码头)/i.test(String(value || ''));
  }
  function isTestMode(order = {}, ctx = {}) {
    const explicit = [ctx.documentMode, ctx.company?.documentMode, order.documentMode].find(
      (value) => value === 'Test' || value === 'Production',
    );
    if (explicit) return explicit === 'Test';
    return Boolean(
      order.testMode === true || ctx.testMode === true || ctx.company?.testMode === true,
    );
  }
  function paymentTermDeposit(value = '') {
    const term = PAYMENT_TERMS.find((x) => x.label === value);
    return term ? term.deposit : null;
  }
  function actualShipmentDate(order = {}) {
    return order.actualShipmentDate || order.shipmentDate || '';
  }
  function plannedTransportMethod(order = {}) {
    return order.plannedTransportMethod || order.transportMethod || '';
  }
  function actualTransportMethod(order = {}) {
    return order.actualTransportMethod || '';
  }
  function formatTradeTerm(order = {}) {
    const code = tradeTermCode(order.incotermCode || order.tradeTerm),
      place = String(order.namedPlace || '').trim(),
      version = order.incotermVersion || 'Incoterms® 2020';
    return [code, place].filter(Boolean).join(' ') + (code && place ? `, ${version}` : '');
  }
  function migrateOrder(order = {}) {
    const code = tradeTermCode(order.incotermCode || order.tradeTerm || 'FOB'),
      term = incoterm(code),
      copy = { ...order };
    copy.incotermCode = code;
    copy.incotermEnglishName = order.incotermEnglishName || term.englishName;
    copy.incotermVersion = order.incotermVersion || 'Incoterms® 2020';
    copy.tradeTerm = code;
    copy.plannedTransportMethod =
      order.plannedTransportMethod || order.transportMethod || 'Sea Freight';
    copy.plannedTransportMethodOther = order.plannedTransportMethodOther || '';
    copy.actualShipmentDate = order.actualShipmentDate || order.shipmentDate || '';
    copy.shipmentDate = copy.actualShipmentDate;
    copy.actualTransportMethod = order.actualTransportMethod || '';
    copy.actualTransportMethodOther = order.actualTransportMethodOther || '';
    copy.actualTransportConfirmed = Boolean(order.actualTransportConfirmed);
    copy.carrier = order.carrier || order.logisticsCompany || '';
    copy.logisticsCompany = copy.carrier;
    copy.transportDocumentType =
      order.transportDocumentType || (order.trackingNumber ? 'Courier Tracking Number' : '');
    copy.transportDocumentTypeOther = order.transportDocumentTypeOther || '';
    copy.transportDocumentNumber = order.transportDocumentNumber || order.trackingNumber || '';
    copy.trackingNumber = copy.transportDocumentNumber;
    copy.vesselFlightNumber = order.vesselFlightNumber || '';
    copy.portOfLoading = order.portOfLoading || '';
    copy.portOfDischarge = order.portOfDischarge || '';
    copy.estimatedArrivalDate = order.estimatedArrivalDate || '';
    copy.paymentTermPreset = PAYMENT_TERMS.some((x) => x.label === order.paymentTerm)
      ? order.paymentTerm
      : 'Custom';
    copy.paymentTermCustom =
      copy.paymentTermPreset === 'Custom' ? order.paymentTermCustom || order.paymentTerm || '' : '';
    copy.purposeOfShipment = order.purposeOfShipment || PURPOSES[0];
    copy.purposeOfShipmentOther = order.purposeOfShipmentOther || '';
    copy.showZeroAmountItems = Boolean(order.showZeroAmountItems);
    copy.plShowDeclaration = Boolean(order.plShowDeclaration);
    copy.plDeclaration =
      order.plDeclaration ||
      'We certify that the packing details stated above are true and correct.';
    copy.packingRemarks = order.packingRemarks || '';
    copy.items = (order.items || []).map((item, index) => ({
      ...item,
      countryOfOrigin: item.countryOfOrigin || item.origin || order.countryOfOrigin || 'China',
      packageType: item.packageType || 'Carton',
      cartonNumber: item.cartonNumber || '',
      ciQuantity: Object.prototype.hasOwnProperty.call(item, 'ciQuantity')
        ? item.ciQuantity
        : item.quantity,
      packingQuantity: Object.prototype.hasOwnProperty.call(item, 'packingQuantity')
        ? item.packingQuantity
        : item.ciQuantity || item.quantity,
      netWeightPerCarton: Object.prototype.hasOwnProperty.call(item, 'netWeightPerCarton')
        ? item.netWeightPerCarton
        : null,
      grossWeightPerCarton: Object.prototype.hasOwnProperty.call(item, 'grossWeightPerCarton')
        ? item.grossWeightPerCarton
        : null,
      detailsExpanded: Boolean(item.detailsExpanded),
    }));
    copy.attachments = (order.attachments || []).map((file) => ({
      ...file,
      category: !file.category || file.category === 'Other' ? '其他 / Other' : file.category,
      createdAt: file.createdAt || new Date().toISOString(),
    }));
    copy.internalNotes = Object.prototype.hasOwnProperty.call(order, 'internalNotes')
      ? order.internalNotes
      : order.notes || '';
    copy.customerRemarks = order.customerRemarks || '';
    copy.showCustomerRemarksOnPI = Boolean(order.showCustomerRemarksOnPI);
    copy.showCustomerRemarksOnCI = Boolean(order.showCustomerRemarksOnCI);
    copy.showCustomerRemarksOnPL = Boolean(order.showCustomerRemarksOnPL);
    copy.namedPlaceConfirmed = Boolean(order.namedPlaceConfirmed);
    copy.standalone = Boolean(order.standalone);
    copy.testMode = Boolean(order.testMode);
    const legacyPaid = Math.max(0, asNumber(order.amountPaid)),
      hasRecords = Array.isArray(order.paymentRecords);
    copy.paymentRecords = (
      hasRecords
        ? order.paymentRecords
        : legacyPaid > 0
          ? [
              {
                id: uid('payment-legacy'),
                paymentDate: order.createdDate || today(),
                amount: legacyPaid,
                currency: order.currency || 'USD',
                paymentMethod: 'Legacy Migrated Total',
                transactionReference: '',
                paymentSlip: null,
                notes: '由旧版 Amount Paid 迁移',
                status: 'Confirmed',
                legacyMigrated: true,
              },
            ]
          : []
    ).map((record) => ({
      ...record,
      id: record.id || uid('payment'),
      paymentDate: record.paymentDate || '',
      amount: Math.max(0, asNumber(record.amount)),
      currency: record.currency || order.currency || 'USD',
      paymentMethod: record.paymentMethod || '',
      transactionReference: record.transactionReference || '',
      paymentSlip: record.paymentSlip || null,
      notes: record.notes || '',
      status: PAYMENT_RECORD_STATUSES.includes(record.status) ? record.status : 'Pending',
    }));
    const confirmedPaid = copy.paymentRecords
        .filter((x) => x.status === 'Confirmed')
        .reduce((sum, x) => sum + asNumber(x.amount), 0),
      depositRate = paymentTermDeposit(copy.paymentTermPreset || copy.paymentTerm),
      knownTotal = Math.max(0, asNumber(order.total));
    copy.currentPaymentStage = PAYMENT_STAGES.some((x) => x.value === order.currentPaymentStage)
      ? order.currentPaymentStage
      : knownTotal > 0 && confirmedPaid >= knownTotal
        ? 'Payment Completed'
        : depositRate > 0 && confirmedPaid < (knownTotal * depositRate) / 100
          ? 'Deposit Requested'
          : depositRate > 0
            ? 'Waiting for Production'
            : 'Full Payment Requested';
    copy.balancePayment = Object.prototype.hasOwnProperty.call(order, 'balancePayment')
      ? asNumber(order.balancePayment)
      : asNumber(order.balanceAmount);
    copy.outstandingAmount = Object.prototype.hasOwnProperty.call(order, 'outstandingAmount')
      ? asNumber(order.outstandingAmount)
      : Math.max(0, asNumber(order.total) - asNumber(order.amountPaid));
    copy.amountPayableNowManual = Boolean(order.amountPayableNowManual);
    copy.amountPayableNowManualValue = asNumber(order.amountPayableNowManualValue);
    copy.amountPayableNowNote = order.amountPayableNowNote || '';
    copy.showPaymentStatusOnCI = Boolean(order.showPaymentStatusOnCI);
    ['pi', 'ci', 'pl'].forEach((key) => {
      const mode = order[`${key}SigningMode`];
      copy[`${key}SigningMode`] = mode === 'Print' ? 'Print' : 'Electronic';
      const includeKey = `${key}IncludeSigningBlock`;
      copy[includeKey] = Object.prototype.hasOwnProperty.call(order, includeKey)
        ? Boolean(order[includeKey])
        : key !== 'pl';
      copy[`${key}SignedDate`] = order[`${key}SignedDate`] || '';
      copy[`${key}SignedAt`] = order[`${key}SignedAt`] || '';
      copy[`${key}UseDocumentDateForPrint`] = Boolean(order[`${key}UseDocumentDateForPrint`]);
      copy[`${key}SigningSnapshot`] = order[`${key}SigningSnapshot`]
        ? deepClone(order[`${key}SigningSnapshot`])
        : null;
    });
    copy.piHistory = Array.isArray(order.piHistory) ? deepClone(order.piHistory) : [];
    copy.activePiRevision = Number.isFinite(Number(order.activePiRevision))
      ? Number(order.activePiRevision)
      : copy.piHistory.length
        ? Math.max(...copy.piHistory.map((x) => asNumber(x.revision)))
        : null;
    copy.piDocument = order.piDocument
      ? deepClone(order.piDocument)
      : {
          number: copy.piNumber,
          status: copy.piVersion || 'Draft',
          revision: copy.activePiRevision ?? 0,
        };
    if (!order.__documentData && copy.ciNumber) {
      copy.ciDocument = order.ciDocument
        ? deepClone(order.ciDocument)
        : {
            number: copy.ciNumber,
            status: copy.ciVersion || 'Draft',
            relatedPiNumber: copy.piNumber,
            relatedPiRevision: copy.activePiRevision ?? 0,
            source: 'Legacy order migration',
            differences: [],
            differencesConfirmed: false,
            createdAt: order.updatedAt || new Date().toISOString(),
            data: documentDataCopy(copy),
          };
    } else copy.ciDocument = order.ciDocument ? deepClone(order.ciDocument) : null;
    if (copy.ciDocument) {
      const related = copy.piHistory.find(
        (x) => asNumber(x.revision) === asNumber(copy.ciDocument.relatedPiRevision),
      );
      if (!copy.ciDocument.seller && related?.seller)
        copy.ciDocument.seller = deepClone(related.seller);
      if (!copy.ciDocument.buyer && related?.buyer)
        copy.ciDocument.buyer = deepClone(related.buyer);
    }
    if (!order.__documentData && copy.packingListNumber) {
      copy.packingListDocument = order.packingListDocument
        ? deepClone(order.packingListDocument)
        : {
            number: copy.packingListNumber,
            status: copy.plVersion || 'Draft',
            relatedCiNumber: copy.ciNumber,
            createdAt: order.updatedAt || new Date().toISOString(),
            data: documentDataCopy(copy),
          };
    } else
      copy.packingListDocument = order.packingListDocument
        ? deepClone(order.packingListDocument)
        : null;
    if (copy.packingListDocument && copy.ciDocument) {
      if (!copy.packingListDocument.seller && copy.ciDocument.seller)
        copy.packingListDocument.seller = deepClone(copy.ciDocument.seller);
      if (!copy.packingListDocument.buyer && copy.ciDocument.buyer)
        copy.packingListDocument.buyer = deepClone(copy.ciDocument.buyer);
    }
    copy.dataModelVersion = 4;
    return copy;
  }

  function documentDataCopy(raw = {}) {
    const data = deepClone(raw) || {};
    ['piHistory', 'piDocument', 'ciDocument', 'packingListDocument'].forEach((k) => delete data[k]);
    data.__documentData = true;
    return data;
  }

  function calculateOrder(raw = {}) {
    const order = migrateOrder(raw);
    const items = (order.items || []).map((item, index) => {
      const quantity = Math.max(0, asNumber(item.quantity)),
        unitPriceCents = Math.max(0, cents(item.unitPrice)),
        amountCents = Math.round(quantity * unitPriceCents);
      const cartonQty = Math.max(0, asNumber(item.cartonQty)),
        netWeight = Math.max(0, asNumber(item.netWeight)),
        grossWeight = Math.max(0, asNumber(item.grossWeight)),
        netWeightPerCarton =
          item.netWeightPerCarton == null ? null : Math.max(0, asNumber(item.netWeightPerCarton)),
        grossWeightPerCarton =
          item.grossWeightPerCarton == null
            ? null
            : Math.max(0, asNumber(item.grossWeightPerCarton));
      const cartonVolume = Math.max(
          0,
          (asNumber(item.cartonLength) * asNumber(item.cartonWidth) * asNumber(item.cartonHeight)) /
            1000000,
        ),
        cbm = cartonVolume * cartonQty;
      return {
        ...item,
        itemNo: index + 1,
        quantity,
        unitPrice: moneyFromCents(unitPriceCents),
        amount: moneyFromCents(amountCents),
        cartonQty,
        netWeight,
        grossWeight,
        netWeightPerCarton,
        grossWeightPerCarton,
        cartonVolume,
        cbm,
      };
    });
    const subtotalCents = items.reduce((sum, item) => sum + cents(item.amount), 0),
      freightCents = Math.max(0, cents(order.freight)),
      insuranceCents = Math.max(0, cents(order.insurance));
    const otherCents = Math.max(0, cents(order.otherCharges)),
      discountCents = Math.max(0, cents(order.discount)),
      totalCents = Math.max(
        0,
        subtotalCents + freightCents + insuranceCents + otherCents - discountCents,
      );
    const depositPercentage = Math.min(100, Math.max(0, asNumber(order.depositPercentage))),
      depositCents = Math.round((totalCents * depositPercentage) / 100),
      paidCents = Math.max(
        0,
        (order.paymentRecords || [])
          .filter((x) => x.status === 'Confirmed')
          .reduce((sum, x) => sum + cents(x.amount), 0),
      ),
      outstandingCents = Math.max(0, totalCents - paidCents);
    const stage = order.currentPaymentStage || 'Deposit Requested';
    let payableCents = 0;
    if (stage === 'Deposit Requested') payableCents = Math.max(0, depositCents - paidCents);
    else if (stage === 'Balance Requested' || stage === 'Full Payment Requested')
      payableCents = outstandingCents;
    else if (stage === 'Custom')
      payableCents = Math.min(
        outstandingCents,
        Math.max(0, cents(order.amountPayableNowManualValue)),
      );
    return {
      ...order,
      items,
      subtotal: moneyFromCents(subtotalCents),
      freight: moneyFromCents(freightCents),
      insurance: moneyFromCents(insuranceCents),
      otherCharges: moneyFromCents(otherCents),
      discount: moneyFromCents(discountCents),
      total: moneyFromCents(totalCents),
      depositPercentage,
      depositAmount: moneyFromCents(depositCents),
      balancePayment: moneyFromCents(totalCents - depositCents),
      balanceAmount: moneyFromCents(totalCents - depositCents),
      amountPaid: moneyFromCents(paidCents),
      outstandingAmount: moneyFromCents(outstandingCents),
      amountDue: moneyFromCents(outstandingCents),
      amountPayableNow: moneyFromCents(payableCents),
      totalCartons: items.reduce((s, i) => s + i.cartonQty, 0),
      totalNetWeight: items.reduce(
        (s, i) =>
          s +
          (i.netWeightPerCarton == null
            ? i.netWeight * asNumber(i.packingQuantity || i.quantity)
            : i.netWeightPerCarton * i.cartonQty),
        0,
      ),
      totalGrossWeight: items.reduce(
        (s, i) =>
          s +
          (i.grossWeightPerCarton == null
            ? i.grossWeight * asNumber(i.packingQuantity || i.quantity)
            : i.grossWeightPerCarton * i.cartonQty),
        0,
      ),
      totalCBM: items.reduce((s, i) => s + i.cbm, 0),
    };
  }

  function latestPISnapshot(order = {}) {
    const history = Array.isArray(order.piHistory) ? order.piHistory : [];
    if (!history.length) return null;
    const active = history.find((x) => asNumber(x.revision) === asNumber(order.activePiRevision));
    return active || history.slice().sort((a, b) => asNumber(b.revision) - asNumber(a.revision))[0];
  }
  function piSnapshotFingerprint(data = {}) {
    const o = calculateOrder(data);
    return JSON.stringify({
      piNumber: o.piNumber,
      customerId: o.customerId,
      currency: o.currency,
      incotermCode: o.incotermCode,
      namedPlace: o.namedPlace,
      incotermVersion: o.incotermVersion,
      paymentTerm: o.paymentTerm,
      deliveryTime: o.deliveryTime,
      plannedTransportMethod: o.plannedTransportMethod,
      countryOfOrigin: o.countryOfOrigin,
      validUntil: o.validUntil,
      items: o.items.map((i) => ({
        description: i.description,
        modelSku: i.modelSku,
        material: i.material,
        hsCode: i.hsCode,
        countryOfOrigin: i.countryOfOrigin,
        quantity: i.quantity,
        unit: i.unit,
        unitPrice: i.unitPrice,
        amount: i.amount,
      })),
      freight: o.freight,
      insurance: o.insurance,
      discount: o.discount,
      otherCharges: o.otherCharges,
      total: o.total,
      depositPercentage: o.depositPercentage,
      depositAmount: o.depositAmount,
      balancePayment: o.balancePayment,
      amountPaid: o.amountPaid,
      outstandingAmount: o.outstandingAmount,
      amountPayableNow: o.amountPayableNow,
      currentPaymentStage: o.currentPaymentStage,
      paymentAccountId: o.paymentAccountId,
      customerRemarks: o.customerRemarks,
      showCustomerRemarksOnPI: o.showCustomerRemarksOnPI,
    });
  }
  function needsPIRevision(order = {}) {
    const latest = latestPISnapshot(order);
    return Boolean(latest && piSnapshotFingerprint(latest.data) !== piSnapshotFingerprint(order));
  }
  function createPISnapshot(raw = {}, ctx = {}, revision = null) {
    const order = calculateOrder(raw),
      history = Array.isArray(order.piHistory) ? deepClone(order.piHistory) : [],
      nextRevision =
        revision == null
          ? history.length
            ? Math.max(...history.map((x) => asNumber(x.revision))) + 1
            : 0
          : asNumber(revision),
      finalizedAt = new Date().toISOString();
    const customer = (ctx.customers || []).find((x) => x.id === order.customerId) || {},
      account = (ctx.company?.accounts || []).find((x) => x.id === order.paymentAccountId) || {};
    const signing = createSigningSnapshot(ctx.company || {}, finalizedAt),
      data = documentDataCopy(order);
    data.piVersion = 'Final';
    data.piNumber = order.piNumber;
    data.piRevision = nextRevision;
    data.piSignedAt = finalizedAt;
    data.piSigningSnapshot = deepClone(signing);
    const snapshot = {
      id: uid('pi-snapshot'),
      number: order.piNumber,
      displayNumber: nextRevision ? `${order.piNumber}-R${nextRevision}` : order.piNumber,
      revision: nextRevision,
      status: 'Final',
      createdAt: order.createdDate,
      finalizedAt,
      signing,
      seller: deepClone(ctx.company || {}),
      buyer: deepClone(customer),
      paymentAccount: deepClone(account),
      data,
    };
    history.push(snapshot);
    return {
      ...order,
      piVersion: 'Final',
      piSignedAt: finalizedAt,
      piSigningSnapshot: deepClone(signing),
      activePiRevision: nextRevision,
      piHistory: history,
      piDocument: { number: order.piNumber, status: 'Final', revision: nextRevision, finalizedAt },
    };
  }
  function piSnapshot(order = {}, revision = null) {
    const history = order.piHistory || [];
    return revision == null
      ? latestPISnapshot(order)
      : history.find((x) => asNumber(x.revision) === asNumber(revision)) || null;
  }
  function ciComparable(data = {}, useCIQuantity = true) {
    const o = calculateOrder(data),
      items = o.items.map((i) => {
        const quantity = asNumber(useCIQuantity ? (i.ciQuantity ?? i.quantity) : i.quantity);
        return {
          description: i.description,
          modelSku: i.modelSku,
          hsCode: i.hsCode,
          quantity,
          unitPrice: i.unitPrice,
          amount: money(quantity * i.unitPrice),
        };
      }),
      subtotal = moneyFromCents(items.reduce((sum, i) => sum + cents(i.amount), 0)),
      total = money(subtotal + o.freight + o.insurance + o.otherCharges - o.discount);
    return {
      currency: o.currency,
      incotermCode: o.incotermCode,
      namedPlace: o.namedPlace,
      freight: o.freight,
      insurance: o.insurance,
      discount: o.discount,
      otherCharges: o.otherCharges,
      total,
      items,
    };
  }
  function compareCIToPI(order = {}) {
    const ci = order.ciDocument?.data;
    if (!ci) return [];
    const source = piSnapshot(order, order.ciDocument.relatedPiRevision);
    if (!source) return [];
    const a = ciComparable(source.data, false),
      b = ciComparable(ci, true),
      diffs = [],
      currency = b.currency || a.currency;
    const labels = {
      currency: 'Currency',
      incotermCode: 'Trade Term',
      namedPlace: 'Named Port / Named Place',
      freight: 'Freight',
      insurance: 'Insurance',
      discount: 'Discount',
      otherCharges: 'Other Charges',
      total: 'Total Amount',
    };
    Object.keys(labels).forEach((k) => {
      if (String(a[k]) !== String(b[k]))
        diffs.push({
          field: k,
          label: labels[k],
          piValue: a[k],
          ciValue: b[k],
          message: `${labels[k]}: PI ${typeof a[k] === 'number' ? `${currency} ${a[k].toFixed(2)}` : a[k]} → CI ${typeof b[k] === 'number' ? `${currency} ${b[k].toFixed(2)}` : b[k]}`,
          severity: k === 'total' && b[k] > a[k] ? 'high' : 'warning',
        });
    });
    const max = Math.max(a.items.length, b.items.length);
    for (let i = 0; i < max; i++) {
      const p = a.items[i],
        c = b.items[i];
      if (!p || !c) {
        diffs.push({
          field: `items.${i}`,
          label: `Product ${i + 1}`,
          piValue: p || '',
          ciValue: c || '',
          message: `Product ${i + 1}: ${p ? 'present' : 'missing'} in PI → ${c ? 'present' : 'missing'} in CI`,
          severity: 'warning',
        });
        continue;
      }
      for (const k of ['description', 'modelSku', 'hsCode', 'quantity', 'unitPrice', 'amount'])
        if (String(p[k]) !== String(c[k]))
          diffs.push({
            field: `items.${i}.${k}`,
            label: `Product ${i + 1} ${k}`,
            piValue: p[k],
            ciValue: c[k],
            message: `${c.description || p.description || `Product ${i + 1}`} ${k}: PI ${p[k]} → CI ${c[k]}`,
            severity: k === 'quantity' && c[k] > p[k] ? 'high' : 'warning',
          });
    }
    return diffs;
  }
  function createCIDocument(raw = {}, allOrders = [], useDraft = false, ctx = {}) {
    const order = calculateOrder(raw),
      source = latestPISnapshot(order),
      sourceData = source ? source.data : documentDataCopy(order),
      number = order.ciNumber || nextDocumentNumber('CI', allOrders, order.createdDate),
      data = documentDataCopy(sourceData);
    data.items = (data.items || []).map((i) => ({ ...i, ciQuantity: asNumber(i.quantity) }));
    Object.assign(data, {
      ciNumber: number,
      ciVersion: 'Draft',
      piNumber: order.piNumber,
      actualShipmentDate: '',
      shipmentDate: '',
      actualTransportMethod: plannedTransportMethod(sourceData),
      actualTransportConfirmed: false,
      carrier: '',
      logisticsCompany: '',
      transportDocumentType: '',
      transportDocumentNumber: '',
      trackingNumber: '',
      vesselFlightNumber: '',
      portOfLoading: '',
      portOfDischarge: '',
      estimatedArrivalDate: '',
      showPaymentStatusOnCI: false,
    });
    const buyer =
        (ctx.customers || []).find((x) => x.id === data.customerId) || source?.buyer || {},
      seller = ctx.company || source?.seller || {};
    const ciDocument = {
      number,
      status: 'Draft',
      relatedPiNumber: order.piNumber,
      relatedPiRevision: source ? source.revision : null,
      source: source ? 'Final PI' : 'Draft PI',
      sourceConfirmed: Boolean(source),
      seller: deepClone(seller),
      buyer: deepClone(buyer),
      differences: [],
      differencesConfirmed: false,
      createdAt: new Date().toISOString(),
      data,
    };
    return { ...order, ciNumber: number, ciVersion: 'Draft', ciDocument };
  }
  function createPackingListDocument(raw = {}, allOrders = []) {
    const order = calculateOrder(raw);
    if (!order.ciDocument) return order;
    const source = calculateOrder(order.ciDocument.data),
      number = order.packingListNumber || nextDocumentNumber('PL', allOrders, order.createdDate),
      createdAt = new Date().toISOString();
    const data = {
      __documentData: true,
      orderId: order.id,
      orderNumber: order.orderNumber,
      piNumber: order.piNumber,
      ciNumber: order.ciNumber,
      packingListNumber: number,
      customerId: source.customerId,
      createdDate: source.createdDate,
      currency: source.currency,
      incotermCode: source.incotermCode,
      incotermEnglishName: source.incotermEnglishName,
      incotermVersion: source.incotermVersion,
      tradeTerm: source.tradeTerm,
      namedPlace: source.namedPlace,
      countryOfOrigin: source.countryOfOrigin,
      actualShipmentDate: source.actualShipmentDate,
      shipmentDate: source.shipmentDate,
      actualTransportMethod: source.actualTransportMethod,
      actualTransportMethodOther: source.actualTransportMethodOther,
      actualTransportConfirmed: source.actualTransportConfirmed,
      carrier: source.carrier,
      transportDocumentType: source.transportDocumentType,
      transportDocumentTypeOther: source.transportDocumentTypeOther,
      transportDocumentNumber: source.transportDocumentNumber,
      vesselFlightNumber: source.vesselFlightNumber,
      portOfLoading: source.portOfLoading,
      portOfDischarge: source.portOfDischarge,
      estimatedArrivalDate: source.estimatedArrivalDate,
      shippingMark: source.shippingMark || 'N/M',
      packingRemarks: '',
      plShowDeclaration: false,
      plDeclaration:
        source.plDeclaration ||
        'We certify that the packing details stated above are true and correct.',
      customerRemarks: source.customerRemarks || '',
      showCustomerRemarksOnPL: Boolean(source.showCustomerRemarksOnPL),
      plVersion: 'Draft',
      plSigningMode: 'Electronic',
      plIncludeSigningBlock: false,
      items: source.items.map((item) => {
        const actual = asNumber(item.ciQuantity ?? item.quantity),
          perCarton = Math.max(0, asNumber(item.quantityPerCarton));
        return {
          id: item.id || uid('packing-line'),
          productId: item.productId || '',
          description: item.description || '',
          modelSku: item.modelSku || '',
          countryOfOrigin: item.countryOfOrigin || source.countryOfOrigin || 'China',
          packingQuantity: actual,
          ciQuantity: actual,
          quantity: actual,
          unit: item.unit || 'PCS',
          packageType: item.packageType || 'Carton',
          cartonQty: Math.max(0, asNumber(item.cartonQty)),
          quantityPerCarton: perCarton,
          cartonNumber: item.cartonNumber || '',
          netWeightPerCarton: Math.max(0, asNumber(item.netWeight)) * perCarton,
          grossWeightPerCarton: Math.max(0, asNumber(item.grossWeight)) * perCarton,
          cartonLength: Math.max(0, asNumber(item.cartonLength)),
          cartonWidth: Math.max(0, asNumber(item.cartonWidth)),
          cartonHeight: Math.max(0, asNumber(item.cartonHeight)),
        };
      }),
    };
    const packingListDocument = {
      id: uid('packing-list'),
      number,
      status: 'Draft',
      orderId: order.id,
      orderNumber: order.orderNumber,
      relatedCiNumber: order.ciNumber,
      relatedPiNumber: order.ciDocument.relatedPiNumber || order.piNumber,
      relatedPiRevision: order.ciDocument.relatedPiRevision,
      seller: deepClone(order.ciDocument.seller || {}),
      buyer: deepClone(order.ciDocument.buyer || {}),
      createdAt,
      data,
    };
    return {
      ...order,
      packingListNumber: number,
      plVersion: 'Draft',
      plSigningMode: 'Electronic',
      plIncludeSigningBlock: false,
      packingListDocument,
    };
  }
  function signingDisplayFields(order, key) {
    return {
      [`${key}SigningMode`]: order[`${key}SigningMode`],
      [`${key}IncludeSigningBlock`]: order[`${key}IncludeSigningBlock`],
      [`${key}SignedDate`]: order[`${key}SignedDate`],
      [`${key}SignedAt`]: order[`${key}SignedAt`],
      [`${key}UseDocumentDateForPrint`]: order[`${key}UseDocumentDateForPrint`],
      [`${key}SigningSnapshot`]: deepClone(order[`${key}SigningSnapshot`] || null),
    };
  }
  function documentOrder(raw = {}, type = 'PI', revision = null) {
    const order = migrateOrder(raw),
      kind = String(type).toUpperCase();
    if (kind === 'PI' && documentSettings(order, 'PI').version === 'Final') {
      const snap = piSnapshot(order, revision);
      if (snap)
        return calculateOrder({
          ...snap.data,
          ...signingDisplayFields(order, 'pi'),
          namedPlaceConfirmed: order.namedPlaceConfirmed,
          piVersion: 'Final',
          piRevision: snap.revision,
          piDisplayNumber: snap.displayNumber,
        });
    }
    if (kind === 'CI' && order.ciDocument?.data) {
      const data = deepClone(order.ciDocument.data);
      data.items = (data.items || []).map((i) => ({
        ...i,
        piQuantity: i.quantity,
        quantity: asNumber(i.ciQuantity ?? i.quantity),
      }));
      return calculateOrder({
        ...data,
        ...signingDisplayFields(order, 'ci'),
        ciVersion: order.ciVersion,
        showPaymentStatusOnCI: data.showPaymentStatusOnCI,
        relatedPiNumber: order.ciDocument.relatedPiNumber,
        relatedPiRevision: order.ciDocument.relatedPiRevision,
      });
    }
    if (kind === 'PL' && order.packingListDocument?.data)
      return calculateOrder({
        ...order.packingListDocument.data,
        ...signingDisplayFields(order, 'pl'),
        plVersion: order.plVersion,
        relatedCiNumber: order.packingListDocument.relatedCiNumber,
        relatedPiNumber: order.packingListDocument.relatedPiNumber,
        relatedPiRevision: order.packingListDocument.relatedPiRevision,
      });
    return calculateOrder(order);
  }

  function tradeWarnings(raw = {}) {
    const order = calculateOrder(raw),
      warnings = [],
      code = order.incotermCode,
      planned = plannedTransportMethod(order),
      paymentDeposit = paymentTermDeposit(order.paymentTermPreset || order.paymentTerm);
    if (
      ['FAS', 'FOB', 'CFR', 'CIF'].includes(code) &&
      !['Sea Freight', 'Inland Waterway'].includes(planned)
    )
      warnings.push(
        `${code} is only suitable for sea or inland waterway transport. Please confirm the planned transport method.`,
      );
    if (['CIF', 'CIP'].includes(code) && order.insurance === 0)
      warnings.push(
        'The selected Incoterm includes insurance. Please confirm the insurance amount.',
      );
    if (code === 'FOB' && (order.freight > 0 || order.insurance > 0))
      warnings.push(
        'Please confirm whether the freight or insurance charge is consistent with the selected FOB term.',
      );
    if (
      requiresExplicitPort(code) &&
      String(order.namedPlace || '').trim() &&
      !isExplicitPort(order.namedPlace)
    )
      warnings.push(
        `${['FAS', 'FOB'].includes(code) ? '请确认明确装运港' : '请确认明确目的港'}：${code} requires a specific named port. “${order.namedPlace}” may be a city or broad place.`,
      );
    if (code === 'EXW')
      warnings.push('Please confirm who is responsible for export customs clearance.');
    if (code === 'DDP')
      warnings.push(
        'Please confirm the importer of record, import clearance, customs duties, taxes and local compliance responsibilities.',
      );
    if (paymentDeposit !== null && Math.abs(paymentDeposit - order.depositPercentage) > 0.001)
      warnings.push(
        `Deposit Percentage (${order.depositPercentage}%) does not match the selected payment term (${paymentDeposit}%).`,
      );
    (order.items || []).forEach((item, i) => {
      if (
        item.cartonQty > 0 &&
        item.quantityPerCarton > 0 &&
        Math.abs(item.cartonQty * item.quantityPerCarton - item.quantity) > 0.0001
      )
        warnings.push(
          `Item ${i + 1}: Carton Quantity × Quantity per Carton does not match Quantity.`,
        );
    });
    if (['Shipped', 'Completed'].includes(order.status) && !actualShipmentDate(order))
      warnings.push(
        'Actual Shipment Date is required when the order status is Shipped or Completed.',
      );
    return warnings;
  }
  function validateEmail(value) {
    return !value || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  }
  function validateOrder(raw, allOrders = []) {
    const order = calculateOrder(raw),
      errors = [],
      warnings = tradeWarnings(order),
      rawItems = raw.items || [];
    if (!order.orderNumber) errors.push('订单号不能为空');
    if (!order.piNumber) errors.push('PI 编号不能为空');
    (order.items || []).forEach((item, i) => {
      const source = rawItems[i] || item;
      if (item.description && asNumber(source.quantity) <= 0)
        errors.push(`第 ${i + 1} 行数量必须大于 0`);
      if (asNumber(source.unitPrice) < 0) errors.push(`第 ${i + 1} 行单价不能为负数`);
      if (asNumber(source.netWeight) < 0 || asNumber(source.grossWeight) < 0)
        errors.push(`第 ${i + 1} 行重量不能为负数`);
      if (asNumber(source.grossWeight) < asNumber(source.netWeight))
        errors.push(`第 ${i + 1} 行毛重不能小于净重`);
      if (asNumber(source.cartonQty) < 0) errors.push(`第 ${i + 1} 行箱数不能为负数`);
      if (asNumber(source.quantityPerCarton) < 0) errors.push(`第 ${i + 1} 行每箱数量不能为负数`);
      if (asNumber(item.ciQuantity) > asNumber(item.quantity))
        warnings.push(`第 ${i + 1} 行 CI 数量超过 PI 数量`);
      if (
        item.packingQuantity !== '' &&
        asNumber(item.packingQuantity) !== asNumber(item.ciQuantity)
      )
        warnings.push(`第 ${i + 1} 行装箱数量（Packing List）与 CI 数量不一致`);
    });
    if (asNumber(raw.depositPercentage) < 0 || asNumber(raw.depositPercentage) > 100)
      errors.push('定金比例必须在 0 至 100 之间');
    (order.paymentRecords || []).forEach((record, i) => {
      if (asNumber(record.amount) < 0) errors.push(`第 ${i + 1} 笔收款金额不能小于 0`);
      if (record.currency && record.currency !== order.currency)
        warnings.push(
          `第 ${i + 1} 笔收款币种 ${record.currency} 与订单币种 ${order.currency} 不一致，请核对。`,
        );
    });
    if (order.amountPaid > order.total)
      warnings.push('Amount Paid exceeds Total Amount. Please verify the received amount.');
    if (
      order.currentPaymentStage === 'Custom' &&
      (order.amountPayableNowManualValue < 0 ||
        order.amountPayableNowManualValue > order.outstandingAmount)
    )
      errors.push('自定义本次应付金额必须在 0 至未收金额之间');
    ['orderNumber', 'piNumber', 'ciNumber', 'packingListNumber'].forEach((key) => {
      if (order[key] && allOrders.some((x) => x.id !== order.id && x[key] === order[key]))
        errors.push(`${key === 'orderNumber' ? '订单号' : '单据编号'} ${order[key]} 已存在`);
    });
    return { errors, warnings };
  }

  function suspiciousText(value = '') {
    return (
      /\b(?:demo|test|sample)\b/i.test(String(value)) ||
      /(?:example\.com|example\.test)/i.test(String(value))
    );
  }
  const PRODUCTION_FORBIDDEN = [
    /Aurora Homeware/i,
    /Signing Workflow QA/i,
    /Demo International Bank/i,
    /Demo Banking Center/i,
    /DEMOHKHH/i,
    /QA LOCAL BANK/i,
    /QA-ACCOUNT/i,
    /0000 0000 0000/i,
    /Morgan Lee/i,
    /Export Director/i,
    /export@example\.com/i,
    /example-export\.com/i,
    /TEST SAMPLE/i,
    /TEST-BL/i,
  ];
  function productionForbiddenMatches(order = {}, type = 'PI', ctx = {}) {
    const company = ctx.company || {},
      customer = (ctx.customers || []).find((x) => x.id === order.customerId) || {},
      account = (company.accounts || []).find((x) => x.id === order.paymentAccountId) || {},
      kind = String(type).toUpperCase(),
      showRemarks =
        kind === 'PI'
          ? order.showCustomerRemarksOnPI
          : kind === 'CI'
            ? order.showCustomerRemarksOnCI
            : order.showCustomerRemarksOnPL,
      data = [
        companyEnglishName(company),
        company.chineseName,
        company.address,
        company.telephone,
        company.email,
        company.website,
        company.taxId,
        company.authorizedSignatoryName,
        company.authorizedSignatoryTitle,
        customer.buyerName,
        customer.companyName,
        customer.address,
        customer.country,
        customer.contactPerson,
        customer.telephone,
        customer.email,
        customer.consigneeName,
        customer.consigneeAddress,
        customer.consigneeCountry,
        customer.consigneeTelephone,
        customer.taxNumber,
        account.label,
        account.beneficiaryName,
        account.bankName,
        account.bankAddress,
        account.accountNumber,
        account.achRoutingNumber,
        account.wireRoutingNumber,
        account.sortCode,
        account.swift,
        account.iban,
        account.localClearingCode,
        account.paymentReference,
        order.orderNumber,
        order.piNumber,
        order.ciNumber,
        order.packingListNumber,
        order.namedPlace,
        order.paymentTerm,
        order.deliveryTime,
        order.shippingMark,
        order.declaration,
        order.transportDocumentNumber,
        showRemarks ? order.customerRemarks : '',
        ...(order.items || []).flatMap((i) => [i.description, i.modelSku, i.material, i.hsCode]),
      ]
        .map((value) => String(value || ''))
        .join('\n');
    return PRODUCTION_FORBIDDEN.filter((pattern) => pattern.test(data)).map(
      (pattern) => pattern.source,
    );
  }
  function bankFieldsForCurrency(currency = '') {
    const code = String(currency).toUpperCase();
    return BANK_FIELDS[code] || BANK_FIELDS.OTHER;
  }
  function isLegacyTestBeneficiary(value = '') {
    return /^Aurora Homeware Export Co\., ?Ltd\.$/i.test(String(value));
  }
  function migrateBankAccount(account = {}, companyName = '') {
    const migrated = { ...account };
    if (
      !Object.prototype.hasOwnProperty.call(account, 'beneficiaryName') ||
      !account.beneficiaryName ||
      isLegacyTestBeneficiary(account.beneficiaryName)
    )
      migrated.beneficiaryName = companyName;
    if (account.routingNumber && !account.legacyRoutingNumber)
      migrated.legacyRoutingNumber = account.routingNumber;
    return migrated;
  }
  function migrateCompanyAccounts(company = {}) {
    const name = companyEnglishName(company),
      accounts = (company.accounts || []).map((a) => migrateBankAccount(a, name));
    const changed = accounts.some(
      (a, i) =>
        a.beneficiaryName !== (company.accounts || [])[i]?.beneficiaryName ||
        a.legacyRoutingNumber !== (company.accounts || [])[i]?.legacyRoutingNumber,
    );
    return { company: { ...company, accounts }, changed };
  }
  function paymentInformationLines(account = {}) {
    const line = (label, value) => (value ? `${label}: ${value}` : ''),
      bankAddress = String(account.bankAddress || '').replace(/\bNY\s*10179\b/g, 'NY 10179');
    const common = [
      line('Payment Account', account.label),
      line('Beneficiary Name', account.beneficiaryName),
      line('Bank Name', account.bankName),
      line('Bank Address', bankAddress),
    ];
    const specific = bankFieldsForCurrency(account.currency).map(
      (key) =>
        ({
          accountNumber: line('Account Number', account.accountNumber),
          achRoutingNumber: line('ACH Routing Number', account.achRoutingNumber),
          wireRoutingNumber: line('Wire Routing Number', account.wireRoutingNumber),
          iban: line('IBAN', account.iban),
          sortCode: line('Sort Code', account.sortCode),
          swift: line('SWIFT/BIC', account.swift),
          localClearingCode: line('Local Clearing Code', account.localClearingCode),
        })[key],
    );
    return [...common, ...specific, line('Payment Reference', account.paymentReference)].filter(
      Boolean,
    );
  }
  function bankAccountTestIssues(account = {}) {
    const values = [
        account.label,
        account.beneficiaryName,
        account.bankName,
        account.bankAddress,
        account.accountNumber,
        account.achRoutingNumber,
        account.wireRoutingNumber,
        account.sortCode,
        account.swift,
        account.iban,
        account.localClearingCode,
        account.legacyRoutingNumber,
        account.paymentReference,
      ],
      joined = values.map((v) => String(v || '')).join('\n'),
      explicit =
        /Aurora Homeware Export Co\., ?Ltd\.|Demo International Bank|Demo Banking Center|DEMOHKHH|0000 0000 0000/i.test(
          joined,
        );
    return explicit || values.some(suspiciousText)
      ? ['收款账户包含 Aurora、DEMO、TEST、SAMPLE 或 example.com 测试资料']
      : [];
  }
  function finalDataIssues(order = {}, type = 'PI', ctx = {}) {
    const company = ctx.company || {},
      customers = ctx.customers || [],
      customer = customers.find((x) => x.id === order.customerId) || {},
      settings = documentSettings(order, type),
      kind = String(type).toUpperCase(),
      issues = [];
    const add = (condition, label) => {
      if (condition && !issues.includes(label)) issues.push(label);
    };
    const visibleCompany = [
        companyEnglishName(company),
        company.address,
        company.email,
        company.website,
        company.taxId,
        company.authorizedSignatoryName,
        company.authorizedSignatoryTitle,
      ],
      visibleCustomer = [
        customer.buyerName,
        customer.companyName,
        customer.address,
        customer.country,
        customer.contactPerson,
        customer.telephone,
        customer.email,
        customer.consigneeName,
        customer.consigneeAddress,
        customer.consigneeCountry,
        customer.consigneeTelephone,
        customer.taxNumber,
      ],
      showRemarks =
        kind === 'PI'
          ? order.showCustomerRemarksOnPI
          : kind === 'CI'
            ? order.showCustomerRemarksOnCI
            : order.showCustomerRemarksOnPL,
      visibleOrder = [
        order.orderNumber,
        order.piNumber,
        order.ciNumber,
        order.packingListNumber,
        order.incotermCode,
        order.namedPlace,
        order.paymentTerm,
        order.deliveryTime,
        plannedTransportMethod(order),
        order.shippingMark,
        order.declaration,
        showRemarks ? order.customerRemarks : '',
        ...(order.items || []).flatMap((i) => [i.description, i.modelSku, i.material, i.hsCode]),
      ];
    add(productionForbiddenMatches(order, kind, ctx).length > 0, '检测到指定Demo关键词');
    add(
      visibleCompany.some(suspiciousText),
      '公司资料包含 DEMO、TEST、SAMPLE 或 example.com 测试内容',
    );
    add(visibleCustomer.some(suspiciousText), '客户或收货人资料包含测试内容');
    add(visibleOrder.some(suspiciousText), '订单或产品资料包含测试内容');
    add(/(?:demo|test|sample|0{6,})/i.test(String(company.taxId || '')), 'Tax ID 疑似测试数据');
    add(suspiciousText(company.logoFileName || ''), 'Logo 文件名疑似测试图片');
    add(
      settings.showStamp && suspiciousText(company.stampFileName || ''),
      '公司印章文件名疑似测试图片',
    );
    if (kind === 'PI') {
      const account = (company.accounts || []).find((a) => a.id === order.paymentAccountId) || {};
      add(
        bankAccountTestIssues(account).length > 0,
        '收款账户包含 Aurora、DEMO、TEST、SAMPLE 或 example.com 测试资料',
      );
      add(
        /(?:demo|test|sample)/i.test(String(account.accountNumber || '')) ||
          /^\D*0[\s0-]*$/i.test(String(account.accountNumber || '')),
        '银行账号疑似测试账号',
      );
    }
    return issues;
  }

  function validateDocumentExport(raw = {}, type = 'PI', ctx = {}) {
    const order = calculateOrder(raw),
      kind = String(type || 'PI').toUpperCase(),
      settings = documentSettings(order, kind),
      errors = [],
      warnings = tradeWarnings(order),
      customer = (ctx.customers || []).find((x) => x.id === order.customerId) || {},
      company = ctx.company || {},
      testMode = isTestMode(order, ctx);
    if (kind === 'CI' && !order.ciNumber) errors.push('请先从 PI 生成 CI');
    if (kind === 'PL' && !order.packingListNumber) errors.push('请先从 CI 生成 Packing List');
    if (settings.version === 'Final') {
      if (!companyEnglishName(company) || !company.address) errors.push('Seller资料不完整');
      if (!order.customerId || !(customer.companyName || customer.buyerName))
        errors.push('请选择完整Buyer资料');
      if (!(order.items || []).length) errors.push('至少需要一个产品');
      if ((order.items || []).some((i) => !i.description || asNumber(i.quantity) <= 0))
        errors.push('产品描述和数量必须完整');
      if (order.total <= 0 && kind !== 'PL') errors.push('Total Amount必须大于0');
      if (!order.currency) errors.push('请选择币种');
      if (!order.incotermCode || !String(order.namedPlace || '').trim())
        errors.push(`${namedPlaceLabel(order.incotermCode)}必须填写`);
      if (requiresExplicitPort(order.incotermCode) && !isExplicitPort(order.namedPlace))
        errors.push(`${order.incotermCode} 必须填写明确港口，例如 Yantian Port, Shenzhen, China`);
      if (requiresNamedPlace(order.incotermCode) && !order.namedPlaceConfirmed)
        errors.push('请先确认指定港口或地点后再导出 Final');
      if (kind === 'PI') {
        const account = (company.accounts || []).find((a) => a.id === order.paymentAccountId);
        if (!account) errors.push('请选择与订单币种匹配的收款账户');
        else if (account.currency !== order.currency) errors.push('收款账户币种与订单币种不一致');
        if (!order.paymentTerm) errors.push('Payment Term必须填写');
        if (!order.deliveryTime) errors.push('Delivery Time必须填写');
      }
      if (kind === 'CI') {
        if (!order.piNumber) errors.push('PI尚未生成');
        if (!customer.consigneeName || !customer.consigneeAddress)
          errors.push('Consignee资料不完整');
        if (!actualShipmentDate(order)) errors.push('请先填写实际发货日期');
        if (!actualTransportMethod(order) || !order.actualTransportConfirmed)
          errors.push('请确认Actual Transport Method');
        if (!order.purposeOfShipment) errors.push('Purpose of Shipment必须选择');
        if (!order.declaration) errors.push('Declaration不能为空');
        const differences = raw.ciDocument?.differences || compareCIToPI(raw);
        if (differences.length && !raw.ciDocument?.differencesConfirmed)
          errors.push('CI数据与已确认PI存在差异，请在生成正式CI前核对并确认差异');
      }
      if (kind === 'PL') {
        if (!order.ciNumber) errors.push('CI尚未生成');
        if ((order.items || []).some((i) => asNumber(i.packingQuantity) !== asNumber(i.ciQuantity)))
          errors.push('Packing List数量必须与CI数量一致');
        if (order.totalCartons <= 0) errors.push('Total Cartons必须大于0');
        if (
          (order.items || []).some(
            (i) =>
              i.netWeightPerCarton != null &&
              asNumber(i.grossWeightPerCarton) < asNumber(i.netWeightPerCarton),
          )
        )
          errors.push('Gross Weight per Carton不能小于Net Weight per Carton');
        if ((order.items || []).some((i) => asNumber(i.cartonQty) > 0 && asNumber(i.cbm) <= 0))
          errors.push('CBM或箱规不完整');
        if (!String(order.shippingMark || '').trim()) errors.push('Shipping Mark不能为空');
      }
      if (settings.includeSigningBlock && settings.signingMode === 'Electronic') {
        if (!companySignatureImage(company) || !companyStampImage(company))
          errors.push(
            '无法读取公司资料中的正式签名或公司印章，请重新上传并保存，或改用打印签章版。',
          );
      }
    }
    if (!testMode) {
      const issues = finalDataIssues(order, kind, ctx);
      if (issues.length)
        errors.push(
          '检测到测试资料，Production文件无法导出，请检查公司、客户、签字人或收款账户设置。',
          ...issues.map(
            (x) =>
              `禁止导出${settings.version === 'Final' ? ' Final' : ''} Production：${x}，请替换为真实资料或切换到明确标记的 Test Mode`,
          ),
        );
    }
    return { errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
  }

  function nextDocumentNumber(prefix, orders, date = today()) {
    const month = date.replaceAll('-', '').slice(0, 6),
      key = prefix === 'PI' ? 'piNumber' : prefix === 'CI' ? 'ciNumber' : 'packingListNumber',
      rx = new RegExp(`^${prefix}-${month}-(\\d{3})$`),
      max = (orders || []).reduce((m, o) => {
        const hit = String(o[key] || '').match(rx);
        return hit ? Math.max(m, Number(hit[1])) : m;
      }, 0);
    return `${prefix}-${month}-${String(max + 1).padStart(3, '0')}`;
  }
  function nextOrderNumber(orders, date = today()) {
    const day = date.replaceAll('-', ''),
      rx = new RegExp(`^ORD-${day}-(\\d{3})$`),
      max = (orders || []).reduce((m, o) => {
        const hit = String(o.orderNumber || '').match(rx);
        return hit ? Math.max(m, Number(hit[1])) : m;
      }, 0);
    return `ORD-${day}-${String(max + 1).padStart(3, '0')}`;
  }
  function documentSettings(order = {}, type = 'PI') {
    const kind = String(type || 'PI').toUpperCase(),
      key = kind.toLowerCase(),
      explicit = order[`${key}Version`],
      version = ['Draft', 'Final'].includes(explicit)
        ? explicit
        : kind === 'CI' && actualShipmentDate(order)
          ? 'Final'
          : 'Draft',
      signingMode = order[`${key}SigningMode`] === 'Print' ? 'Print' : 'Electronic',
      includeValue = order[`${key}IncludeSigningBlock`],
      includeSigningBlock =
        version === 'Final' && (typeof includeValue === 'boolean' ? includeValue : kind !== 'PL'),
      signedAt = order[`${key}SignedAt`] || order[`${key}SigningSnapshot`]?.signedAt || '',
      useDocumentDateForPrint = Boolean(order[`${key}UseDocumentDateForPrint`]),
      signedDate =
        signingMode === 'Print'
          ? useDocumentDateForPrint
            ? order.createdDate || ''
            : '__________________'
          : signedAt
            ? signedAt.slice(0, 10)
            : order[`${key}SignedDate`] || '';
    return {
      version,
      signingMode,
      includeSigningBlock,
      signedAt,
      signedDate,
      useDocumentDateForPrint,
      showSignature: includeSigningBlock && signingMode === 'Electronic',
      showStamp: includeSigningBlock && signingMode === 'Electronic',
    };
  }
  function newOrder(orders = []) {
    const date = today(),
      term = incoterm('FOB');
    return migrateOrder({
      id: uid('order'),
      orderNumber: nextOrderNumber(orders, date),
      piNumber: nextDocumentNumber('PI', orders, date),
      ciNumber: '',
      packingListNumber: '',
      piVersion: 'Draft',
      ciVersion: 'Draft',
      plVersion: 'Draft',
      piSigningMode: 'Electronic',
      ciSigningMode: 'Electronic',
      plSigningMode: 'Electronic',
      piIncludeSigningBlock: true,
      ciIncludeSigningBlock: true,
      plIncludeSigningBlock: false,
      piSignedDate: '',
      ciSignedDate: '',
      plSignedDate: '',
      piSignedAt: '',
      ciSignedAt: '',
      plSignedAt: '',
      piUseDocumentDateForPrint: false,
      ciUseDocumentDateForPrint: false,
      plUseDocumentDateForPrint: false,
      piSigningSnapshot: null,
      ciSigningSnapshot: null,
      plSigningSnapshot: null,
      customerId: '',
      currency: 'USD',
      incotermCode: term.code,
      incotermEnglishName: term.englishName,
      incotermVersion: 'Incoterms® 2020',
      tradeTerm: term.code,
      namedPlace: 'Shenzhen, China',
      namedPlaceConfirmed: false,
      paymentTerm: '30% Deposit, 70% Before Shipment',
      paymentTermPreset: '30% Deposit, 70% Before Shipment',
      deliveryTime: '30 days after deposit',
      validUntil: addDays(date, 30),
      plannedTransportMethod: 'Sea Freight',
      transportMethod: 'Sea Freight',
      countryOfOrigin: 'China',
      purposeOfShipment: PURPOSES[0],
      paymentAccountId: '',
      status: 'Draft',
      createdDate: date,
      actualShipmentDate: '',
      actualTransportMethod: '',
      actualTransportConfirmed: false,
      carrier: '',
      transportDocumentType: '',
      transportDocumentNumber: '',
      shippingMark: 'N/M',
      declaration: 'We hereby certify that the information on this invoice is true and correct.',
      internalNotes: '',
      customerRemarks: '',
      showCustomerRemarksOnPI: false,
      showCustomerRemarksOnCI: false,
      showCustomerRemarksOnPL: false,
      freight: 0,
      insurance: 0,
      discount: 0,
      otherCharges: 0,
      depositPercentage: 30,
      currentPaymentStage: 'Deposit Requested',
      paymentRecords: [],
      amountPayableNowManualValue: 0,
      amountPayableNowNote: '',
      showPaymentStatusOnCI: false,
      items: [],
      attachments: [],
      piHistory: [],
      activePiRevision: null,
      piDocument: null,
      ciDocument: null,
      packingListDocument: null,
      updatedAt: new Date().toISOString(),
    });
  }
  function updateStageDocuments(raw = {}) {
    const order = calculateOrder(raw),
      now = new Date().toISOString();
    if (order.ciDocument) {
      const previous = order.ciDocument.data || {},
        data = documentDataCopy(previous),
        ciFields = [
          'currency',
          'incotermCode',
          'incotermEnglishName',
          'incotermVersion',
          'tradeTerm',
          'namedPlace',
          'namedPlaceConfirmed',
          'countryOfOrigin',
          'purposeOfShipment',
          'purposeOfShipmentOther',
          'actualShipmentDate',
          'shipmentDate',
          'actualTransportMethod',
          'actualTransportMethodOther',
          'actualTransportConfirmed',
          'carrier',
          'logisticsCompany',
          'transportDocumentType',
          'transportDocumentTypeOther',
          'transportDocumentNumber',
          'trackingNumber',
          'vesselFlightNumber',
          'portOfLoading',
          'portOfDischarge',
          'estimatedArrivalDate',
          'declaration',
          'freight',
          'insurance',
          'discount',
          'otherCharges',
          'showPaymentStatusOnCI',
          'paymentRecords',
          'currentPaymentStage',
          'customerRemarks',
          'showCustomerRemarksOnCI',
        ];
      ciFields.forEach((k) => (data[k] = deepClone(order[k])));
      data.items = order.items.map((item, i) => {
        const old = (previous.items || [])[i] || {};
        return {
          ...old,
          id: item.id,
          description: item.description,
          modelSku: item.modelSku,
          material: item.material,
          hsCode: item.hsCode,
          countryOfOrigin: item.countryOfOrigin,
          quantity: item.quantity,
          ciQuantity: item.ciQuantity,
          unit: item.unit,
          unitPrice: item.unitPrice,
        };
      });
      data.ciNumber = order.ciNumber;
      data.piNumber = order.piNumber;
      order.ciDocument = {
        ...order.ciDocument,
        number: order.ciNumber,
        status: order.ciVersion || 'Draft',
        updatedAt: now,
        data,
      };
      order.ciDocument.differences = compareCIToPI(order);
      if (!order.ciDocument.differences.length) order.ciDocument.differencesConfirmed = false;
    }
    if (order.packingListDocument) {
      const previous = order.packingListDocument.data || {},
        data = documentDataCopy(previous),
        plFields = [
          'shippingMark',
          'packingRemarks',
          'plShowDeclaration',
          'plDeclaration',
          'customerRemarks',
          'showCustomerRemarksOnPL',
        ];
      plFields.forEach((k) => (data[k] = deepClone(order[k])));
      data.items = order.items.map((item, i) => {
        const old = (previous.items || [])[i] || {};
        return {
          ...old,
          id: item.id,
          description: item.description,
          modelSku: item.modelSku,
          countryOfOrigin: item.countryOfOrigin,
          packingQuantity: item.packingQuantity,
          quantity: item.packingQuantity,
          ciQuantity: item.ciQuantity,
          unit: item.unit,
          packageType: item.packageType,
          cartonQty: item.cartonQty,
          quantityPerCarton: item.quantityPerCarton,
          cartonNumber: item.cartonNumber,
          netWeightPerCarton: item.netWeightPerCarton,
          grossWeightPerCarton: item.grossWeightPerCarton,
          cartonLength: item.cartonLength,
          cartonWidth: item.cartonWidth,
          cartonHeight: item.cartonHeight,
        };
      });
      data.packingListNumber = order.packingListNumber;
      order.packingListDocument = {
        ...order.packingListDocument,
        number: order.packingListNumber,
        status: order.plVersion || 'Draft',
        updatedAt: now,
        data,
      };
    }
    return order;
  }
  function formatMoney(value, currency = 'USD') {
    return `${MONEY_SYMBOLS[currency] || `${currency} `}${money(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  global.FTCore = {
    CURRENCIES,
    UNITS,
    STATUSES,
    PURPOSES,
    TRANSPORT_METHODS,
    TRANSPORT_DOCUMENT_TYPES,
    PAYMENT_TERMS,
    PAYMENT_STAGES,
    PAYMENT_RECORD_STATUSES,
    PAYMENT_METHODS,
    PORT_PRESETS,
    ATTACHMENT_CATEGORIES,
    INCOTERMS,
    MONEY_SYMBOLS,
    NAMED_PLACE_TERMS,
    BANK_FIELDS,
    uid,
    deepClone,
    today,
    asNumber,
    money,
    escapeHtml,
    companyEnglishName,
    companySignatureImage,
    companyStampImage,
    formatModelSku,
    assetFingerprint,
    createSigningSnapshot,
    formatDate,
    addDays,
    tradeTermCode,
    incoterm,
    requiresNamedPlace,
    namedPlaceLabel,
    requiresExplicitPort,
    isExplicitPort,
    isTestMode,
    paymentTermDeposit,
    actualShipmentDate,
    plannedTransportMethod,
    actualTransportMethod,
    formatTradeTerm,
    migrateOrder,
    calculateOrder,
    documentDataCopy,
    latestPISnapshot,
    piSnapshotFingerprint,
    needsPIRevision,
    createPISnapshot,
    piSnapshot,
    compareCIToPI,
    createCIDocument,
    createPackingListDocument,
    documentOrder,
    updateStageDocuments,
    tradeWarnings,
    validateEmail,
    validateOrder,
    suspiciousText,
    productionForbiddenMatches,
    bankFieldsForCurrency,
    isLegacyTestBeneficiary,
    migrateBankAccount,
    migrateCompanyAccounts,
    paymentInformationLines,
    bankAccountTestIssues,
    finalDataIssues,
    validateDocumentExport,
    nextDocumentNumber,
    nextOrderNumber,
    documentSettings,
    newOrder,
    formatMoney,
  };
  if (typeof module !== 'undefined') module.exports = global.FTCore;
})(typeof window !== 'undefined' ? window : globalThis);
