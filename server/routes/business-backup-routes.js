'use strict';
const express = require('express');
const { requireAdmin } = require('../auth/authorization');
function auditEntry(req, action) { return { actor: req.user, action, entityType: 'BACKUP', ipAddress: req.ip }; }
function createBusinessBackupRoutes(service, auditService) {
  const router = express.Router();
  router.get('/export', (req, res) => {
    requireAdmin(req.user);
    const data = auditService.perform(auditEntry(req, 'EXPORT_BACKUP'), () => service.exportAllBusinessData());
    res.set('Content-Disposition', `attachment; filename="foreign-trade-server-backup-${data.createdAt.slice(0, 10)}.json"`);
    res.json(data);
  });
  router.post('/inspect', (req, res) => { requireAdmin(req.user); res.json(service.inspectBackup(req.body)); });
  router.post('/import', (req, res) => { requireAdmin(req.user); res.json({ replaced: true, summary: auditService.perform(
    auditEntry(req, 'IMPORT_BACKUP'), () => service.replaceAllBusinessData(req.body, true, req.user.id)) }); });
  router.post('/restore', (req, res) => {
    requireAdmin(req.user);
    const point = auditService.perform(auditEntry(req, 'RESTORE_BACKUP'), () => service.restoreLatestBusinessData(req.user.id));
    res.json({ restored: true, restorePoint: { id: point.id, createdAt: point.createdAt } });
  });
  return router;
}
module.exports = { createBusinessBackupRoutes };
