'use strict';
const express = require('express');
function createAuditRoutes(auditService) {
  const router = express.Router();
  router.get('/', (req, res) => res.json({ data: auditService.list(req.user, { limit: req.query.limit }) }));
  return router;
}
module.exports = { createAuditRoutes };
