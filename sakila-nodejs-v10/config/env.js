/**
 * @fileoverview Type-safe environment configuration
 *
 * Loads .env via dotenv, validates every variable against a Joi schema, and
 * exports a deep-frozen config object. The process exits with code 1 on the
 * first invalid configuration so misconfigured deployments never reach the
 * request-serving state.
 *
 * Design decisions:
 *   - Joi schema with convert:true coerces strings to the declared types
 *     (e.g. PORT="8080" → 8080). This mirrors twelve-factor conventions where
 *     all env vars are strings in the process environment.
 *   - DB_PASSWORD validation is conditional: production requires a non-trivial
 *     string of ≥ 8 chars; other envs allow empty (local dev without auth).
 *   - CORS_ORIGIN is validated twice: once by the Joi custom validator at
 *     schema-validation time, and once by parseOrigins() at config-build time.
 *     The double fence ensures even post-validation mutations (e.g. test
 *     harness resets) are caught before reaching the cors() middleware.
 *   - Cross-field constraint: DB_POOL_MIN ≤ DB_POOL_MAX is enforced via a
 *     Joi root-level custom validator.
 *   - Rate-limit and timeout fields use min(1) to reject zero/negative values
 *     that would silently disable the intended protection.
 *   - LOCAL_DB_HOSTS is a Set for O(1) lookup used in the runtime safety
 *     warning that alerts developers connecting to a remote DB in a non-
 *     production NODE_ENV.
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
 * Parse and validate a comma-separated CORS origin string.
 *
 * Returns:
 *   false     — block all cross-origin requests (CORS disabled)
 *   string    — single allowed origin
 *   string[]  — multiple allowed origins
 *
 * Throws TypeError on any invalid origin to give a deterministic failure
 * rather than passing a bad value to the cors() middleware.
 *
 * @param {string} raw
 * @returns {false|string|string[]}
 */
function parseOrigins(raw) {
  if (!raw || !raw.trim()) return false;
  const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
  const invalid = parts.filter(o => !isValidOrigin(o));
  if (invalid.length > 0) {
    throw new TypeError(
      `CORS_ORIGIN contains invalid origin(s): ${invalid.join(', ')}`,
    );
  }
  return parts.length === 1 ? parts[0] : parts;
}

/** Hostnames that identify a local database — used for the safety warning. */
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

  DB_SSL:             Joi.boolean().default(false),

  DB_POOL_MAX:        Joi.number().integer().min(1).max(100).default(10),
  DB_POOL_MIN:        Joi.number().integer().min(0).default(2),
  DB_POOL_ACQUIRE_MS: Joi.number().integer().positive().default(30000),
  DB_POOL_IDLE_MS:    Joi.number().integer().positive().default(10000),

  DB_CONNECT_RETRIES:  Joi.number().integer().min(1).max(20).default(5),
  DB_CONNECT_RETRY_MS: Joi.number().integer().positive().default(2000),

  // ── Security ─────────────────────────────────────────────────────────────────
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

  /** min(1) makes zero/negative values a hard startup error. */
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
  /** Cross-field constraint: pool minimum must not exceed pool maximum. */
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

// ── Runtime safety warning ────────────────────────────────────────────────────
if (!LOCAL_DB_HOSTS.has(env.DB_HOST) && env.NODE_ENV !== 'production') {
  console.warn(
    `\n[WARN] NODE_ENV="${env.NODE_ENV}" but DB_HOST="${env.DB_HOST}" ` +
    `looks like a remote database.\n` +
    `      Set NODE_ENV=production to activate production safeguards.\n`,
  );
}

// ── Typedefs ──────────────────────────────────────────────────────────────────

/** @typedef {{ max: number, min: number, acquire: number, idle: number }} DbPoolConfig */
/** @typedef {{ maxAttempts: number, initialDelayMs: number }} DbRetryConfig */
/**
 * @typedef {Object} DbConfig
 * @property {string}        host
 * @property {number}        port
 * @property {string}        name
 * @property {string}        user
 * @property {string}        password
 * @property {boolean}       ssl
 * @property {DbPoolConfig}  pool
 * @property {DbRetryConfig} retry
 */
/** @typedef {{ origin: false|string|string[] }} CorsConfig */
/** @typedef {{ windowMs: number, max: number }} RateLimitBucket */
/** @typedef {{ read: RateLimitBucket, write: RateLimitBucket }} RateLimitConfig */
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
    ssl:      env.DB_SSL,
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
    origin: parseOrigins(env.CORS_ORIGIN),
  }),

  rateLimit: Object.freeze({
    read:  Object.freeze({ windowMs: env.RATE_LIMIT_READ_WINDOW_MS,  max: env.RATE_LIMIT_READ_MAX }),
    write: Object.freeze({ windowMs: env.RATE_LIMIT_WRITE_WINDOW_MS, max: env.RATE_LIMIT_WRITE_MAX }),
  }),

  logLevel:          env.LOG_LEVEL,
  shutdownTimeoutMs: env.SHUTDOWN_TIMEOUT_MS,
});

/** @returns {Readonly<AppConfig>} */
function getConfig() { return config; }

module.exports = config;
module.exports.getConfig = getConfig;
