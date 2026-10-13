'use strict';
const express = require('express');
const { requireAdmin } = require('../auth/authorization');

function audit(req, action, metadata = {}) {
  return { actor: req.user, action, entityType: 'USER', ipAddress: req.ip, metadata };
}
function createUserRoutes(userService, ownershipService, auditService) {
  const router = express.Router();
  router.use((req, res, next) => {
    requireAdmin(req.user);
    next();
  });
  router.get('/', (req, res) =>
    res.json({
      data: userService
        .listEmployees()
        .map((user) => ({ ...user, business: ownershipService.employeeSummary(user.id) })),
    }),
  );
  router.post('/', async (req, res, next) => {
    try {
      res
        .status(201)
        .json({ data: await userService.createEmployee(req.body, audit(req, 'CREATE_EMPLOYEE')) });
    } catch (err) {
      next(err);
    }
  });
  router.put('/:id', (req, res) =>
    res.json({
      data: userService.updateEmployee(req.params.id, req.body, audit(req, 'UPDATE_EMPLOYEE')),
    }),
  );
  router.post('/:id/disable', (req, res) =>
    res.json({
      data: userService.setStatus(req.params.id, 'DISABLED', audit(req, 'DISABLE_EMPLOYEE')),
    }),
  );
  router.post('/:id/enable', (req, res) =>
    res.json({
      data: userService.setStatus(req.params.id, 'ACTIVE', audit(req, 'ENABLE_EMPLOYEE')),
    }),
  );
  router.post('/:id/reset-password', async (req, res, next) => {
    try {
      res.json({
        data: await userService.resetEmployeePassword(
          req.params.id,
          req.body?.temporaryPassword,
          audit(req, 'RESET_EMPLOYEE_PASSWORD'),
        ),
      });
    } catch (err) {
      next(err);
    }
  });
  router.post('/:id/transfer-customer/:customerId', (req, res) => {
    const target = req.body?.ownerUserId ?? req.params.id;
    userService.requireEmployee(req.params.id);
    const result = auditService.perform(
      {
        actor: req.user,
        action: 'TRANSFER_OWNERSHIP',
        entityType: 'CUSTOMER',
        entityId: req.params.customerId,
        ipAddress: req.ip,
        metadata: { fromUserId: req.params.id, toUserId: target },
      },
      () => ownershipService.transferCustomer(req.params.customerId, target, req.params.id),
    );
    res.json({ data: result });
  });
  return router;
}
module.exports = { createUserRoutes };
