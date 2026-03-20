/**
 * @fileoverview Sequelize connection factory  (v6)
 *
 * Changes from v5:
 *
 *   FIX D1 — verifyConnection() backoff had no jitter. Under simultaneous
 *     container restarts (e.g., Kubernetes rolling deploy) all instances
 *     would retry at exactly the same interval, causing a thundering herd
 *     against MySQL. Added ±10 % random jitter to each delay.
 *
 *   FIX D2 — dialectOptions.ssl was not configurable. Any production
 *     deployment requiring TLS connections to the database (AWS RDS,
 *     GCP CloudSQL, Azure DB) had no path to enable SSL without forking
 *     the file. Added DB_SSL env var support (read via config.db.ssl).
 *     When config.db.ssl is true, ssl: { rejectUnauthorized: true } is
 *     set; when false (default) ssl is omitted entirely.
 *
 *   FIX D3 — closeSequelize() did not guard against concurrent callers.
 *     Two simultaneous SIGTERM + SIGINT signals (possible in some process
 *     managers) could both enter the try block before _sequelize was
 *     nulled, causing a double-close error. Added a closing flag.
 *
 * Carries forward all v5 fixes (A3, A4):
 *   - FIX A3: removed dead _initPromise variable
 *   - FIX A4: removed invalid pool.evict key
 *   - Lazy singleton with null-after-close race guard
 *   - verifyConnection() with exponential backoff
 *   - dialectOptions.connectTimeout
 */

'use strict';

const { Sequelize } = require('sequelize');
const config        = require('./env');
const logger        = require('./logger');

/** @type {Sequelize|null} */
let _sequelize = null;

/** FIX D3: guard against concurrent closeSequelize() calls */
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
      connectTimeout: 10_000,  // 10 s — prevents indefinite hang on lost DB
      // FIX D2: opt-in TLS for production databases (RDS, CloudSQL, etc.)
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
 * Close the pool and null the singleton AFTER close resolves.
 * FIX D3: concurrent callers are serialised — only the first proceeds.
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
 * Verify DB connectivity with exponential backoff + jitter retry.
 *
 * FIX D1: each delay is jittered ±10 % to spread thundering-herd retries
 * across a fleet of containers restarting simultaneously.
 *
 * Backoff schedule (default: 5 retries, 2 s initial, ±200 ms jitter):
 *   attempt 1: immediate
 *   attempt 2: ~2 s  (1.8–2.2 s)
 *   attempt 3: ~4 s  (3.6–4.4 s)
 *   attempt 4: ~8 s  (7.2–8.8 s)
 *   attempt 5: ~16 s (14.4–17.6 s) → throws if still failing
 *
 * @returns {Promise<void>}
 * @throws {Error} after all retries exhausted
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
      const isLast = attempt === maxAttempts;
      // FIX D1: add ±10 % jitter to the base exponential delay
      const baseDelay  = initialDelayMs * Math.pow(2, attempt - 1);
      const jitter     = baseDelay * 0.1 * (Math.random() * 2 - 1);  // ±10 %
      const delay      = Math.round(baseDelay + jitter);

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
