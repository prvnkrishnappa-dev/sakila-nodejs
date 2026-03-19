/**
 * @fileoverview Sequelize connection factory
 *
 * Manages a single Sequelize instance (lazy singleton) with:
 *   - Configurable connection pool (via config.db.pool)
 *   - Optional TLS (config.db.ssl) for encrypted database connections
 *   - 10 s dialect-level connect timeout to prevent indefinite hangs
 *   - Exponential-backoff retry with ±10 % jitter on startup
 *   - Idempotent, concurrency-safe close
 *
 * Retry strategy (verifyConnection):
 *   Jitter spreads retries across a fleet of containers that all restart
 *   simultaneously (e.g. Kubernetes rolling deploy), preventing a thundering
 *   herd against MySQL. Default schedule with 5 retries, 2 s base:
 *     attempt 1: immediate
 *     attempt 2: ~2 s  (±200 ms)
 *     attempt 3: ~4 s  (±400 ms)
 *     attempt 4: ~8 s  (±800 ms)
 *     attempt 5: ~16 s (±1.6 s) → throws if still failing
 *
 * Close safety (closeSequelize):
 *   A boolean _closing flag prevents concurrent SIGTERM + SIGINT signals from
 *   entering close() twice and triggering a double-close error. The singleton
 *   pointer is nulled inside finally so a future getSequelize() call can
 *   create a fresh instance (important in test environments).
 */

'use strict';

const { Sequelize } = require('sequelize');
const config        = require('./env');
const logger        = require('./logger');

/** @type {Sequelize|null} */
let _sequelize = null;

/** Prevents concurrent closeSequelize() callers from double-closing the pool. */
let _closing = false;

/**
 * Return the Sequelize singleton, creating it on first call.
 * @returns {Sequelize}
 */
function getSequelize() {
  if (_sequelize) return _sequelize;

  /** @type {import('sequelize').Options} */
  const options = {
    host:    config.db.host,
    port:    config.db.port,
    dialect: 'mysql',

    /** SQL logging: disabled in production; routed through Winston in development. */
    logging: config.isProduction
      ? false
      : (sql, timing) => logger.debug('SQL', { sql, durationMs: timing }),

    pool: {
      max:     config.db.pool.max,
      min:     config.db.pool.min,
      acquire: config.db.pool.acquire,
      idle:    config.db.pool.idle,
    },

    define: {
      underscored: true,
      timestamps:  false,
    },

    dialectOptions: {
      /** Hard connect timeout prevents indefinite hangs when MySQL is unreachable. */
      connectTimeout: 10_000,
      /** Opt-in TLS for managed database services (RDS, CloudSQL, Azure DB). */
      ...(config.db.ssl ? { ssl: { rejectUnauthorized: true } } : {}),
    },
  };

  _sequelize = new Sequelize(
    config.db.name,
    config.db.user,
    config.db.password,
    options,
  );

  return _sequelize;
}

/**
 * Close the connection pool and null the singleton.
 * Idempotent: concurrent or repeated calls are safe.
 *
 * @returns {Promise<void>}
 */
async function closeSequelize() {
  if (!_sequelize || _closing) return;
  _closing = true;
  const instance = _sequelize;
  try {
    await instance.close();
    logger.info('Database connection pool closed');
  } finally {
    if (_sequelize === instance) _sequelize = null;
    _closing = false;
  }
}

/**
 * Verify DB connectivity with exponential backoff + jitter.
 * Called once during server startup before any traffic is accepted.
 *
 * @returns {Promise<void>}
 * @throws {Error} after all retry attempts are exhausted
 */
async function verifyConnection() {
  const { maxAttempts, initialDelayMs } = config.db.retry;
  const seq = getSequelize();

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await seq.authenticate();
      logger.info('Database connection established', {
        host: config.db.host,
        port: config.db.port,
        db:   config.db.name,
        attempt,
      });
      return;
    } catch (err) {
      const isLast    = attempt === maxAttempts;
      const baseDelay = initialDelayMs * Math.pow(2, attempt - 1);
      const jitter    = baseDelay * 0.1 * (Math.random() * 2 - 1);  // ±10 %
      const delay     = Math.round(baseDelay + jitter);

      logger.warn('Database connection attempt failed', {
        attempt, maxAttempts,
        nextRetryMs: isLast ? null : delay,
        error: err.message,
      });

      if (isLast) {
        throw new Error(
          `Cannot connect to database after ${maxAttempts} attempts: ${err.message}`,
        );
      }

      await new Promise(r => setTimeout(r, delay));
    }
  }
}

module.exports = { getSequelize, closeSequelize, verifyConnection };
