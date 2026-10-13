'use strict';
const { loadConfig } = require('./config');
const { createApp } = require('./app');

async function main() {
  process.umask(0o077);
  const config = loadConfig();
  const runtime = await createApp(config);
  const httpServer = runtime.app.listen(config.port, config.host, () => {
    console.log(`Authenticated application server listening on ${config.host}:${config.port}. SQLite business storage enabled.`);
  });
  httpServer.on('error', () => { runtime.close(); console.error('Server could not start'); process.exitCode = 1; });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    httpServer.close(() => { runtime.close(); });
    httpServer.closeIdleConnections();
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
if (require.main === module) main().catch(() => { console.error('Server initialization failed; check configuration and auth database permissions.'); process.exitCode = 1; });
module.exports = { main };
