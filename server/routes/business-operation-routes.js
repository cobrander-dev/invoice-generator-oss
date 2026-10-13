'use strict';

const express = require('express');
const { ValidationError } = require('../db/errors');
const { recordResponse } = require('./business-crud-routes');

function expectedVersion(req) {
  const raw = req.get('If-Match');
  if (raw === undefined) throw new ValidationError('If-Match record version is required');
  return raw;
}
const AUDIT_ACTIONS = Object.freeze({
  'finalize-pi': 'FINALIZE_PI', 'revise-pi': 'REVISE_PI', 'generate-ci': 'GENERATE_CI',
  'confirm-ci-differences': 'CONFIRM_CI_DIFFERENCES', 'finalize-ci': 'FINALIZE_CI',
  'payment-tracking': 'UPDATE_PAYMENT_TRACKING', 'generate-packing-list': 'GENERATE_PACKING_LIST',
  'save-packing-list': 'UPDATE_PACKING_LIST', 'finalize-packing-list': 'FINALIZE_PACKING_LIST'
});
function createBusinessOperationRoutes(service, crudService, auditService) {
  const router = express.Router();
  for (const action of ['finalize-pi', 'revise-pi', 'generate-ci', 'confirm-ci-differences', 'finalize-ci', 'payment-tracking']) {
    router.post(`/orders/:id/${action}`, (req, res) => {
      crudService.requireActive('orders', req.params.id, req.user);
      const row = auditService.perform({ actor: req.user, action: AUDIT_ACTIONS[action], entityType: 'ORDER', entityId: req.params.id, ipAddress: req.ip },
        () => service.action(action, req.params.id, req.body, expectedVersion(req)));
      res.json(recordResponse(row));
    });
  }
  for (const action of ['generate-packing-list', 'save-packing-list', 'finalize-packing-list']) {
    router.post(`/orders/:id/${action}`, (req, res) => {
      crudService.requireActive('orders', req.params.id, req.user);
      const result = auditService.perform({ actor: req.user, action: AUDIT_ACTIONS[action], entityType: 'ORDER', entityId: req.params.id, ipAddress: req.ip }, () => {
        const value = service.packingAction(action, req.params.id, req.body, expectedVersion(req), req.body?.expectedPackingListVersion ?? 0);
        const owner = crudService.get('orders', req.params.id, req.user).owner_user_id;
        crudService.repositories.packingLists.setMetadata(value.packingList.payload.id, { owner_user_id: owner, order_id: req.params.id });
        return value;
      });
      res.json({ data: { order: result.order.payload, packingList: result.packingList.payload }, meta: { orderRowVersion: result.order.rowVersion, packingListRowVersion: result.packingList.rowVersion } });
    });
  }
  return router;
}

module.exports = { createBusinessOperationRoutes };
