/**
 * @fileoverview Type-safe configuration management  (v6)
 *
 * Changes from v5:
 *
 *   FIX A7 — RATE_LIMIT_* and SHUTDOWN_TIMEOUT_MS now validated as positive
 *     integers at the schema level using Joi.number().integer().positive().
 *     Previously a value of "0" or "-1" would pass (Joi positive() rejects 0).
 *     Added min(1) to all ms-window fields to make the guard explicit.
 *
 *   FIX A8 — parseOrigins() did not validate individual origins when called
 *     at config-build time. The Joi custom validator validated them during
 *     Joi.validate(), but parseOrigins() (called after validation) split and
 *     returned the raw strings without re-checking. If someone mutated
 *     process.env.CORS_ORIGIN after validation (unlikely but possible in tests
 *     via jest.resetModules), they could inject an unchecked origin.
 *     Fixed: parseOrigins() now calls isValidOrigin() on each part and throws
 *     on invalid input, giving a deterministic failure rather than passing
 *     a bad origin to the cors() middleware.
 *
 *   FIX A9 — DB_POOL_MIN was not constrained to be ≤ DB_POOL_MAX. A config
 *     where DB_POOL_MIN=20, DB_POOL_MAX=5 would silently create an invalid
 *     pool. Added a Joi.custom() cross-field validation on the root schema.
 *
 *   FIX A10 — NODE_ENV accepted only the three hard-coded values, but the
 *     looksLikeProduction safety warning read DB_HOST from the validated env
 *     and compared against IPv6 '::1'. The check was also missing DB_HOST
 *     values like '127.0.0.1' with explicit port as a hostname (e.g.,
 *     '127.0.0.1'). Extracted LOCAL_DB_HOSTS into a Set for O(1) lookup
 *     and easy extensibility.
 *
 * Carries forward all v5 fixes (A1–A6).
 */

'use strict';

require('dotenv').config({ override: false });

const Joi = require('joi');

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Validate that origin is a proper http(s) URL (no path, no wildcard).
 * Uses the platform URL constructor — zero per-call schema allocation.
 *
 * @param {string} origin
 * @returns {boolean}
 */
function isValidOrigin(origin) {
  try {
    const u = new URL(origin);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Parse and validate a comma-separated origin string.
 * FIX A8: throws TypeError on any invalid origin found at build-time.
 *
 * Returns:
 *   false      = block all cross-origin requests (CORS disabled)
 *   string     = single allowed origin
 *   string[]   = multiple allowed origins
 *
 * @param {string} raw
 * @returns {false|string|string[]}
 */
function parseOrigins(raw) {
  if (!raw || !raw.trim()) return false;
  const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
  // FIX A8: re-validate each part at build time
  const invalid = parts.filter(o => !isValidOrigin(o));
  if (invalid.length > 0) {
    throw new TypeError(
      `CORS_ORIGIN contains invalid origin(s): ${invalid.join(', ')}`,
    );
  }
  return parts.length === 1 ? parts[0] : parts;
}

// ── Hostname-based local-DB detection (FIX A10) ───────────────────────────────
const LOCAL_DB_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

// ── Joi schema ────────────────────────────────────────────────────────────────

const schema = Joi.object({

  // ── Application ──────────────────────────────────────────────────────────────
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),

  PORT: Joi.number().integer().min(1).max(65535).default(8080),

  // ── Database ──────────────────────────────────────────────────────────────────
  DB_HOST:     Joi.string().hostname().default('localhost'),
  DB_PORT:     Joi.number().integer().min(1).max(65535).default(3306),
  DB_NAME:     Joi.string().min(1).default('sakila'),
  DB_USER:     Joi.string().min(1).default('root'),

  // FIX A1 (v5): clean conditional branch for production vs non-production.
  DB_PASSWORD: Joi.alternatives().conditional('NODE_ENV', {
    is:   'production',
    then: Joi.string()
      .min(8)
      .invalid('undefined', 'null', 'password', 'changeme', 'secret')
      .required()
      .messages({
        'string.min':   'DB_PASSWORD must be at least 8 characters in production',
        'any.required': 'DB_PASSWORD is required in production',
        'any.invalid':  'DB_PASSWORD must not be a placeholder value',
      }),
    otherwise: Joi.string()
      .allow('')
      .invalid('undefined', 'null')
      .default('')
      .messages({
        'any.invalid': 'DB_PASSWORD must not be the literal string "undefined" or "null"',
      }),
  }),

  DB_POOL_MAX:        Joi.number().integer().min(1).max(100).default(10),
  // FIX A9: min(0) keeps 0 valid (no warm connections), cross-field check below
  DB_POOL_MIN:        Joi.number().integer().min(0).default(2),
  DB_POOL_ACQUIRE_MS: Joi.number().integer().positive().default(30000),
  DB_POOL_IDLE_MS:    Joi.number().integer().positive().default(10000),

  DB_CONNECT_RETRIES:  Joi.number().integer().min(1).max(20).default(5),
  DB_CONNECT_RETRY_MS: Joi.number().integer().positive().default(2000),

  // ── Security ─────────────────────────────────────────────────────────────────
  // FIX A2 (v5): custom validator uses URL constructor, not nested Joi schema.
  CORS_ORIGIN: Joi.string()
    .allow('')
    .default('')
    .custom((value, helpers) => {
      if (!value || !value.trim()) return value;
      const origins = value.split(',').map(s => s.trim()).filter(Boolean);
      const invalid = origins.filter(o => !isValidOrigin(o));
      if (invalid.length > 0) return helpers.error('any.invalid');
      return value;
    })
    .messages({
      'any.invalid':
        'CORS_ORIGIN must be empty or a comma-separated list of valid http/https URLs',
    }),

  // FIX A7: explicit min(1) makes zero/negative values a hard validation error
  RATE_LIMIT_READ_WINDOW_MS:  Joi.number().integer().min(1).default(60000),
  RATE_LIMIT_READ_MAX:        Joi.number().integer().min(1).default(300),
  RATE_LIMIT_WRITE_WINDOW_MS: Joi.number().integer().min(1).default(60000),
  RATE_LIMIT_WRITE_MAX:       Joi.number().integer().min(1).default(60),

  // ── Observability ─────────────────────────────────────────────────────────────
  LOG_LEVEL: Joi.string()
    .valid('error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly')
    .default('http'),

  // ── Shutdown ─────────────────────────────────────────────────────────────────
  SHUTDOWN_TIMEOUT_MS: Joi.number().integer().min(1).default(10000),

})
  // FIX A9: cross-field constraint — DB_POOL_MIN must not exceed DB_POOL_MAX
  .custom((obj, helpers) => {
    if (obj.DB_POOL_MIN > obj.DB_POOL_MAX) {
      return helpers.error('any.invalid', {
        message: `DB_POOL_MIN (${obj.DB_POOL_MIN}) must be ≤ DB_POOL_MAX (${obj.DB_POOL_MAX})`,
      });
    }
    return obj;
  })
  .unknown(true);

// ── Validate — fail hard on startup if config is invalid ─────────────────────

const { error, value: env } = schema.validate(process.env, {
  abortEarly:   false,
  convert:      true,
  stripUnknown: false,
});

if (error) {
  const details = error.details.map(d => `  • ${d.message}`).join('\n');
  console.error(`\n[FATAL] Configuration validation failed:\n${details}\n`);
  process.exit(1);
}

// ── Runtime NODE_ENV safety warning (FIX A10: Set-based lookup) ──────────────
if (!LOCAL_DB_HOSTS.has(env.DB_HOST) && env.NODE_ENV !== 'production') {
  console.warn(
    `\n[WARN] NODE_ENV="${env.NODE_ENV}" but DB_HOST="${env.DB_HOST}" ` +
    `looks like a remote database.\n` +
    `      Set NODE_ENV=production to activate production safeguards.\n`,
  );
}

// ── Typedefs (JSDoc) ─────────────────────────────────────────────────────────

/**
 * @typedef {Object} DbPoolConfig
 * @property {number} max
 * @property {number} min
 * @property {number} acquire  - ms to wait for a free connection before error
 * @property {number} idle     - ms a connection can sit idle before release
 */

/**
 * @typedef {Object} DbRetryConfig
 * @property {number} maxAttempts    - number of connect attempts before giving up
 * @property {number} initialDelayMs - base delay; doubles on each retry (backoff)
 */

/**
 * @typedef {Object} DbConfig
 * @property {string}        host
 * @property {number}        port
 * @property {string}        name
 * @property {string}        user
 * @property {string}        password
 * @property {DbPoolConfig}  pool
 * @property {DbRetryConfig} retry
 */

/**
 * @typedef {Object} CorsConfig
 * @property {false|string|string[]} origin
 */

/**
 * @typedef {Object} RateLimitBucket
 * @property {number} windowMs
 * @property {number} max
 */

/**
 * @typedef {Object} RateLimitConfig
 * @property {RateLimitBucket} read   - applied to GET endpoints
 * @property {RateLimitBucket} write  - applied to POST / PUT / DELETE endpoints
 */

/**
 * @typedef {Object} AppConfig
 * @property {'development'|'production'|'test'} nodeEnv
 * @property {number}          port
 * @property {boolean}         isProduction
 * @property {boolean}         isDevelopment
 * @property {boolean}         isTest
 * @property {DbConfig}        db
 * @property {CorsConfig}      cors
 * @property {RateLimitConfig} rateLimit
 * @property {string}          logLevel
 * @property {number}          shutdownTimeoutMs
 */

// ── Build frozen config object ────────────────────────────────────────────────

/** @type {Readonly<AppConfig>} */
const config = Object.freeze({
  nodeEnv:       env.NODE_ENV,
  port:          env.PORT,
  isProduction:  env.NODE_ENV === 'production',
  isDevelopment: env.NODE_ENV === 'development',
  isTest:        env.NODE_ENV === 'test',

  db: Object.freeze({
    host:     env.DB_HOST,
    port:     env.DB_PORT,
    name:     env.DB_NAME,
    user:     env.DB_USER,
    password: env.DB_PASSWORD,
    pool: Object.freeze({
      max:     env.DB_POOL_MAX,
      min:     env.DB_POOL_MIN,
      acquire: env.DB_POOL_ACQUIRE_MS,
      idle:    env.DB_POOL_IDLE_MS,
    }),
    retry: Object.freeze({
      maxAttempts:    env.DB_CONNECT_RETRIES,
      initialDelayMs: env.DB_CONNECT_RETRY_MS,
    }),
  }),

  cors: Object.freeze({
    // parseOrigins now throws on invalid input (FIX A8)
    origin: parseOrigins(env.CORS_ORIGIN),
  }),

  rateLimit: Object.freeze({
    read: Object.freeze({
      windowMs: env.RATE_LIMIT_READ_WINDOW_MS,
      max:      env.RATE_LIMIT_READ_MAX,
    }),
    write: Object.freeze({
      windowMs: env.RATE_LIMIT_WRITE_WINDOW_MS,
      max:      env.RATE_LIMIT_WRITE_MAX,
    }),
  }),

  logLevel:          env.LOG_LEVEL,
  shutdownTimeoutMs: env.SHUTDOWN_TIMEOUT_MS,
});

/**
 * Return the validated, frozen application config.
 * @returns {Readonly<AppConfig>}
 */
function getConfig() {
  return config;
}

module.exports = config;
module.exports.getConfig = getConfig;
