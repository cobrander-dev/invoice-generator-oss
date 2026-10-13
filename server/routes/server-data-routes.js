'use strict';
const express = require('express');
const { requireAdmin } = require('../auth/authorization');
function createServerDataRoutes(service) {
  const router = express.Router();
  router.get('/summary', (req, res) => {
    requireAdmin(req.user);
    res.json(service.inspectBackup(service.exportAllBusinessData()));
  });
  return router;
}
module.exports = { createServerDataRoutes };
