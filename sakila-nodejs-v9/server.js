/**
 * @fileoverview Server bootstrap  (v6)
 *
 * No logic changes from v5. All prior fixes carried forward:
 *   - FIX S1 (v5): health routes live in app.js (before 404 catch-all)
 *   - FIX S2 (v5): process.on handlers at module scope, not inside start()
 *   - FIX S3 (v5): exit with code 1 on dirty DB close
 *   - keepAliveTimeout (65 s) and headersTimeout (66 s) for AWS ALB safety
 *   - Connection Map + socket.destroy() for graceful drain
 *   - Hard-timeout forceExit with unref()
 */

'use strict';

const app                                  = require('./app');
const { verifyConnection, closeSequelize } = require('./config/database');
const config                               = require('./config/env');
const logger                               = require('./config/logger');

// ── Process-level error guards (module scope — not inside start()) ────────────
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Promise rejection — exiting', { reason: String(reason) });
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception — exiting', { error: err.message, stack: err.stack });
  process.exit(1);
});

// ── Keep-alive tuning for AWS ALB ─────────────────────────────────────────────
const KEEP_ALIVE_TIMEOUT_MS = 65_000;
const HEADERS_TIMEOUT_MS    = 66_000;

// ── Bootstrap ─────────────────────────────────────────────────────────────────

async function start() {
  logger.info('Starting Sakila REST API', { version: '6.0.0', env: config.nodeEnv });

  await verifyConnection();

  const server = app.listen(config.port, () => {
    logger.info('Server listening', { port: config.port });
  });

  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout   = HEADERS_TIMEOUT_MS;

  // ── Graceful shutdown ──────────────────────────────────────────────────────
  const connections = new Map();
  server.on('connection', (socket) => {
    connections.set(socket, socket);
    socket.once('close', () => connections.delete(socket));
  });

  async function shutdown(signal) {
    logger.info(`${signal} received — beginning graceful shutdown`);

    const forceExit = setTimeout(() => {
      logger.error(`Shutdown timed out after ${config.shutdownTimeoutMs} ms — forcing exit`);
      process.exit(1);
    }, config.shutdownTimeoutMs);
    forceExit.unref();

    server.close(async () => {
      logger.info('HTTP server closed — draining DB pool');

      let dbCloseError = false;
      try {
        await closeSequelize();
      } catch (err) {
        logger.error('Error closing DB pool', { error: err.message });
        dbCloseError = true;
      }

      clearTimeout(forceExit);
      logger.info('Shutdown complete');
      process.exit(dbCloseError ? 1 : 0);
    });

    for (const socket of connections.values()) {
      socket.destroy();
    }
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}

// ── Entry point ───────────────────────────────────────────────────────────────

start().catch((err) => {
  console.error('[FATAL] Server failed to start:', err.message);
  process.exit(1);
});
