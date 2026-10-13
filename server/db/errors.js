'use strict';
class ConflictError extends Error {
  constructor(message = 'Record version conflict') { super(message); this.name = 'ConflictError'; this.statusCode = 409; this.expose = true; }
}
class ValidationError extends Error {
  constructor(message = 'Invalid business data') { super(message); this.name = 'ValidationError'; this.statusCode = 400; this.expose = true; }
}
class NotFoundError extends Error {
  constructor(message = 'Business record not found') { super(message); this.name = 'NotFoundError'; this.statusCode = 404; this.expose = true; }
}
class ForbiddenError extends Error {
  constructor(message = 'This operation is not permitted') { super(message); this.name = 'ForbiddenError'; this.statusCode = 403; this.expose = true; }
}
module.exports = { ConflictError, ValidationError, NotFoundError, ForbiddenError };
