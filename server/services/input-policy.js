'use strict';
// Server-side validation for values that reach HTML rendered to other users or that are
// stored as files. Only new or changed values are checked, so historical records and
// imported backups that predate these rules keep working unchanged.
const C = require('../../js/core.js');
const { ValidationError } = require('../db/errors');

const RECORD_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CURRENCY = /^[A-Z]{3}$/;
const DATA_URL = /^data:([^;,]*)((?:;[^;,]*)*),/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

function requireNewRecordId(id) {
  if (typeof id !== 'string' || !RECORD_ID.test(id)) {
    throw new ValidationError(
      'Record id must be 1-128 letters, digits, dot, underscore, colon or hyphen',
    );
  }
  return id;
}

function requireCurrency(value, previous, label = 'Currency') {
  if (value === previous) return value;
  if (typeof value !== 'string' || !CURRENCY.test(value)) {
    throw new ValidationError(`${label} must be a three-letter uppercase currency code`);
  }
  return value;
}

function dataUrlInfo(data) {
  if (data === 'data:') return { type: '', bytes: 0 }; // FileReader result for an empty file
  const match = typeof data === 'string' ? DATA_URL.exec(data) : null;
  if (!match || !match[2].split(';').includes('base64')) return null;
  const body = data.slice(match[0].length);
  if (body.length % 4 === 1 || !BASE64.test(body)) return null;
  const padding = body.endsWith('==') ? 2 : body.endsWith('=') ? 1 : 0;
  return { type: match[1], bytes: Math.floor((body.length * 3) / 4) - padding };
}

function requireValidFile(file, label) {
  if (!file || typeof file !== 'object' || Array.isArray(file)) {
    throw new ValidationError(`${label} is invalid`);
  }
  const info = dataUrlInfo(file.data);
  if (!info) throw new ValidationError(`${label} must be a base64 data URL`);
  const problem =
    C.attachmentProblem({ name: file.name, type: file.type, size: info.bytes }) ||
    C.attachmentProblem({ name: file.name, type: info.type, size: info.bytes });
  if (problem) throw new ValidationError(problem);
}

function fileKey(file) {
  return JSON.stringify([file?.name ?? null, file?.type ?? null, file?.data ?? null]);
}

function orderFiles(order) {
  const files = [];
  for (const file of Array.isArray(order?.attachments) ? order.attachments : [])
    files.push(['Attachment', file]);
  for (const payment of Array.isArray(order?.paymentRecords) ? order.paymentRecords : [])
    if (payment?.paymentSlip) files.push(['Payment slip', payment.paymentSlip]);
  return files;
}

// Validates attachments and payment slips that are not already stored on the order.
function requireValidOrderFiles(proposed, previous = null) {
  if (proposed?.attachments != null && !Array.isArray(proposed.attachments)) {
    throw new ValidationError('Attachments must be an array');
  }
  const existing = new Set(orderFiles(previous).map(([, file]) => fileKey(file)));
  for (const [label, file] of orderFiles(proposed)) {
    if (!existing.has(fileKey(file))) requireValidFile(file, label);
  }
}

function requireValidPaymentCurrencies(records, previousRecords = []) {
  const previous = new Map(
    (Array.isArray(previousRecords) ? previousRecords : []).map((record) => [
      record?.id,
      record?.currency,
    ]),
  );
  for (const record of Array.isArray(records) ? records : []) {
    if (record?.currency == null || record.currency === '') continue;
    requireCurrency(record.currency, previous.get(record.id), 'Payment currency');
  }
}

module.exports = {
  RECORD_ID,
  CURRENCY,
  requireNewRecordId,
  requireCurrency,
  requireValidOrderFiles,
  requireValidPaymentCurrencies,
  dataUrlInfo,
};
