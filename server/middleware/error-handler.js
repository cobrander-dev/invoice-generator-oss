'use strict';
// Never log the request body, cookies, passwords, SQLite paths, or raw errors.
function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  const status = err.type === 'entity.too.large' ? 413 : err.type === 'entity.parse.failed' ? 400 : err.statusCode || 500;
  const message = err.expose ? err.message : status === 500 ? '服务器暂时不可用' : '请求格式或大小无效';
  res.status(status).json({ error: message });
}
module.exports = { errorHandler };
