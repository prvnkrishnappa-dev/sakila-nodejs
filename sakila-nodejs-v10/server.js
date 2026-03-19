/**
 * @fileoverview HTTP server bootstrap
 *
 * Responsibilities:
 *   1. Register process-level error guards (unhandledRejection, uncaughtException)
 *   2. Verify database connectivity with exponential-backoff retry
 *   3. Start the HTTP server and configure keep-alive tuning for AWS ALB
 *   4. Handle graceful shutdown on SIGTERM / SIGINT
 *
 * Keep-alive tuning:
 *   AWS ALB keeps connections open for 60 s. Setting keepAliveTimeout to 65 s
 *   ensures the server never drops a connection the ALB is still using.
 *   headersTimeout must exceed keepAliveTimeout to avoid a race where the
 *   parser resets before the keep-alive timeout fires.
 *
 * Graceful shutdown:
 *   On signal receipt, server.close() stops accepting new connections. All
 *   open sockets are destroyed immediately to drain in-flight requests quickly.
 *   The DB pool is closed after the server finishes. A hard-timeout timer
 *   (unref'd so it does not block the event loop) forces process.exit(1) if
 *   shutdown stalls beyond shutdownTimeoutMs.
 */

'use strict';

const app                                  = require('./app');
const { verifyConnection, closeSequelize } = require('./config/database');
const config                               = require('./config/env');
const logger                               = require('./config/logger');

// ── Process-level error guards ────────────────────────────────────────────────
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
  logger.info('Starting Sakila REST API', { version: '10.0.0', env: config.nodeEnv });

  await verifyConnection();

  const server = app.listen(config.port, () => {
    logger.info('Server listening', { port: config.port });
  });

  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout   = HEADERS_TIMEOUT_MS;

  // ── Graceful shutdown ──────────────────────────────────────────────────────

  /** Track all open sockets so we can destroy them during drain. */
  const connections = new Map();
  server.on('connection', (socket) => {
    connections.set(socket, socket);
    socket.once('close', () => connections.delete(socket));
  });

  async function shutdown(signal) {
    logger.info(`${signal} received — beginning graceful shutdown`);

    /** Hard-timeout: force exit if shutdown hangs. unref() prevents it from
     *  blocking the event loop if everything closes cleanly first. */
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
