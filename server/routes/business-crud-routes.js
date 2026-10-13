'use strict';
const express = require('express');
const { ValidationError } = require('../db/errors');
const { requireAdmin } = require('../auth/authorization');

function recordResponse(row) {
  return { data: row.payload, meta: { rowVersion: row.rowVersion, updatedAt: row.updatedAt,
    ownerUserId: row.owner_user_id ?? null, lifecycleState: row.lifecycle_state || 'ACTIVE' } };
}
function listResponse(rows) {
  return {
    data: rows.map(row => row.payload),
    meta: { rowVersions: Object.fromEntries(rows.map(row => [row.payload.id, row.rowVersion])),
      owners: Object.fromEntries(rows.filter(row => row.owner_user_id !== undefined).map(row => [row.payload.id, row.owner_user_id])),
      lifecycle: Object.fromEntries(rows.filter(row => row.lifecycle_state).map(row => [row.payload.id, row.lifecycle_state])) }
  };
}
function expectedVersion(req) {
  const raw = req.get('If-Match');
  if (raw === undefined) throw new ValidationError('If-Match record version is required');
  return raw;
}
function sendRecord(res, row) { return row ? res.json(recordResponse(row)) : res.status(404).json({ error: 'Record not found' }); }

function entry(req, action, entityType, entityId = null, metadata = {}) {
  return { actor: req.user, action, entityType, entityId, ipAddress: req.ip, metadata };
}
function createBusinessCrudRoutes(service, backupService, ownershipService, auditService) {
  const router = express.Router();

  router.get('/company/main', (req, res) => sendRecord(res, service.get('company', 'main', req.user)));
  router.put('/company/main', (req, res) => {
    requireAdmin(req.user);
    const before = service.get('company', 'main', req.user)?.payload || {}, after = req.body || {}, entries = [entry(req, 'UPDATE_COMPANY', 'COMPANY', 'main')];
    if (JSON.stringify(before.accounts || []) !== JSON.stringify(after.accounts || [])) entries.push(entry(req, 'UPDATE_PAYMENT_ACCOUNTS', 'COMPANY', 'main'));
    if ((before.signatureImage || before.signature || '') !== (after.signatureImage || after.signature || '')) entries.push(entry(req, 'REPLACE_SIGNATURE', 'COMPANY', 'main'));
    if ((before.companyStampImage || before.stamp || '') !== (after.companyStampImage || after.stamp || '')) entries.push(entry(req, 'REPLACE_COMPANY_STAMP', 'COMPANY', 'main'));
    res.json(recordResponse(auditService.performMany(entries, () => service.update('company', 'main', after, expectedVersion(req), req.user))));
  });

  for (const [path, repository] of [['customers', 'customers'], ['products', 'products'], ['orders', 'orders']]) {
    router.get(`/${path}`, (req, res) => res.json(listResponse(service.list(repository, req.user))));
    router.get(`/${path}/:id`, (req, res) => sendRecord(res, service.get(repository, req.params.id, req.user)));
    router.post(`/${path}`, (req, res) => {
      const possibleDuplicate = repository === 'customers' && ownershipService.possibleCustomerDuplicate(req.body);
      let ownerUserId;
      if (repository === 'customers' && req.get('X-Owner-User-Id')) {
        requireAdmin(req.user);
        ownerUserId = ownershipService.validateTarget(req.get('X-Owner-User-Id'));
      }
      const row = auditService.perform(entry(req, `CREATE_${repository.slice(0, -1).toUpperCase()}`, repository.toUpperCase(), req.body?.id),
        () => service.create(repository, req.body, req.user, ownerUserId));
      const response = recordResponse(row); if (possibleDuplicate) response.meta.possibleDuplicate = true;
      res.status(201).json(response);
    });
    router.put(`/${path}/:id`, (req, res) => res.json(recordResponse(auditService.perform(
      entry(req, `UPDATE_${repository.slice(0, -1).toUpperCase()}`, repository.toUpperCase(), req.params.id),
      () => service.update(repository, req.params.id, req.body, expectedVersion(req), req.user)))));
    router.delete(`/${path}/:id`, (req, res) => {
      const action = repository === 'orders' ? 'VOID_ORDER' : `ARCHIVE_${repository.slice(0, -1).toUpperCase()}`;
      const removed = auditService.perform(entry(req, action, repository.toUpperCase(), req.params.id), () => repository === 'orders'
        ? service.removeOrder(req.params.id, expectedVersion(req), req.user)
        : service.remove(repository, req.params.id, expectedVersion(req), req.user));
      res.json(recordResponse(removed));
    });
  }

  router.post('/products/bulk', (req, res) => {
    const rows = auditService.perform(entry(req, 'BULK_IMPORT_PRODUCTS', 'PRODUCT', null, { count: req.body?.items?.length || 0 }),
      () => service.bulkPutProducts(req.body?.items));
    res.json(listResponse(rows));
  });

  router.get('/packing-lists', (req, res) => res.json(listResponse(service.list('packingLists', req.user))));
  router.get('/packing-lists/:id', (req, res) => sendRecord(res, service.get('packingLists', req.params.id, req.user)));

  router.get('/meta/:id', (req, res) => { requireAdmin(req.user); sendRecord(res, service.get('meta', req.params.id)); });
  router.put('/meta/:id', (req, res) => { requireAdmin(req.user); res.json(recordResponse(auditService.perform(
    entry(req, 'UPDATE_META', 'META', req.params.id), () => service.update('meta', req.params.id, req.body, expectedVersion(req), req.user)))); });
  router.get('/server-backup/restore-point', (req, res) => { requireAdmin(req.user); sendRecord(res, service.get('restorePoints', 'latest', req.user)); });
  router.post('/server-backup/clear', (req, res) => {
    requireAdmin(req.user);
    if (req.body?.confirmation !== '清空数据') throw new ValidationError('Clear confirmation phrase is invalid');
    auditService.perform(entry(req, 'CLEAR_BUSINESS_DATA', 'BACKUP'), () => backupService.clearAllBusinessData(true));
    res.json({ cleared: true });
  });

  return router;
}

module.exports = { createBusinessCrudRoutes, recordResponse, listResponse };
