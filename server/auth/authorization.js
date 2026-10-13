'use strict';
const { ForbiddenError, NotFoundError } = require('../db/errors');

function isAdmin(actor) {
  return actor?.role === 'ADMIN';
}
function requireAdmin(actor) {
  if (!isAdmin(actor)) throw new ForbiddenError('Administrator permission is required');
  return actor;
}
function requireActive(actor) {
  if (!actor || actor.status !== 'ACTIVE') throw new ForbiddenError('Account is disabled');
  return actor;
}
function requireOwned(row, actor) {
  if (!row) throw new NotFoundError('Record not found');
  if (!isAdmin(actor) && row.owner_user_id !== actor.id)
    throw new NotFoundError('Record not found');
  return row;
}

module.exports = { isAdmin, requireAdmin, requireActive, requireOwned };
