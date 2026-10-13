'use strict';
// Never log the request body, cookies, passwords, SQLite paths, or raw errors.
function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  const status =
    err.type === 'entity.too.large'
      ? 413
      : err.type === 'entity.parse.failed'
        ? 400
        : err.statusCode || 500;
  const message = err.expose
    ? err.message
    : status === 500
      ? '服务器暂时不可用'
      : '请求格式或大小无效';
  const body = { error: message };
  // Only deliberately exposed application errors may add a machine-readable code and details.
  if (err.expose && typeof err.code === 'string') body.code = err.code;
  if (err.expose && Array.isArray(err.blockers)) body.blockers = err.blockers;
  res.status(status).json(body);
}
module.exports = { errorHandler };
