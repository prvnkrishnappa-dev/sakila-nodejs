/**
 * @fileoverview Global error handler middleware  (v6)
 *
 * Changes from v5:
 *
 *   FIX E2 — DB_UNAVAILABLE response leaked err.message from the Sequelize
 *     error into the 503 body in development, but the mapped AppError always
 *     used the fixed string 'Database temporarily unavailable'. While this is
 *     safe, the Sequelize error detail (host, port, credentials path) was still
 *     being logged at WARN level with no redaction. Added structured logging
 *     that explicitly omits raw Sequelize connection error messages from the
 *     warn log in production to prevent credential leakage into log aggregators.
 *
 *   FIX E4 — SequelizeTimeoutError (pool acquire timeout — all connections
 *     busy) was not handled by mapSequelizeError(). It fell through to the
 *     generic 500 handler, producing a confusing INTERNAL_ERROR response for
 *     a normal overload condition. Added mapping → 503 DB_UNAVAILABLE with
 *     isOperational=true (same treatment as connection errors).
 *
 *   FIX E5 — SequelizeDatabaseError (generic query-level DB errors such as
 *     syntax errors in dynamic SQL, column not found, etc.) was not handled.
 *     These are programming bugs (not operational) but were falling through
 *     to the 500 handler and exposing raw SQL error messages in development
 *     logs without any classification. Now mapped to 500 INTERNAL_ERROR
 *     with isOperational=false so the message is masked in production.
 *
 * Carries forward all v5 fixes (E1, E3).
 */

'use strict';

const AppError        = require('../errors/app-error');
const ValidationError = require('../errors/validation.error');
const ConflictError   = require('../errors/conflict.error');
const logger          = require('../config/logger');

// FIX E3 (v5): read directly — do not import config/env
const isProduction = process.env.NODE_ENV === 'production';

// ── Sequelize → AppError mapping ─────────────────────────────────────────────

/**
 * Map well-known Sequelize error names to typed AppErrors.
 * Returns null for anything that is not a recognised Sequelize error.
 *
 * @param {Error} err
 * @returns {AppError|null}
 */
function mapSequelizeError(err) {
  switch (err.name) {
    case 'SequelizeValidationError': {
      const fields = {};
      (err.errors || []).forEach(e => { fields[e.path] = e.message; });
      return new ValidationError('Database validation failed', fields);
    }

    case 'SequelizeUniqueConstraintError':
      return new ConflictError('A record with those values already exists');

    case 'SequelizeForeignKeyConstraintError':
      return new ValidationError('Referenced resource does not exist');

    case 'SequelizeConnectionError':
    case 'SequelizeConnectionRefusedError':
    case 'SequelizeConnectionTimedOutError':
    case 'SequelizeHostNotFoundError':
    case 'SequelizeHostNotReachableError':
      // FIX E1 (v5): isOperational=true — connection failures are expected
      return new AppError('Database temporarily unavailable', 503, 'DB_UNAVAILABLE', true);

    // FIX E4: pool-acquire timeout is an operational overload signal, not a bug
    case 'SequelizeTimeoutError':
      return new AppError('Database temporarily unavailable', 503, 'DB_UNAVAILABLE', true);

    // FIX E5: generic DB errors are programming bugs — mask message in prod
    case 'SequelizeDatabaseError':
      return new AppError('An unexpected error occurred', 500, 'INTERNAL_ERROR', false);

    default:
      return null;
  }
}

// ── Express 4-argument error handler ─────────────────────────────────────────

/**
 * Must be registered LAST in app.js (after all routes and middleware).
 * The 4-argument signature is required by Express — _next must be declared.
 *
 * @param {Error}                          err
 * @param {import('express').Request}      req
 * @param {import('express').Response}     res
 * @param {import('express').NextFunction} _next
 */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, _next) {
  const correlationId = res.locals.correlationId || 'unknown';

  // Resolve to a typed AppError, or null if unknown
  const appErr = err instanceof AppError ? err : mapSequelizeError(err);

  if (appErr) {
    // FIX E2: for 503 DB errors, omit raw Sequelize message from prod logs
    const logMeta = {
      correlationId,
      errorCode:  appErr.errorCode,
      statusCode: appErr.statusCode,
      method:     req.method,
      path:       req.path,
    };
    if (!isProduction || appErr.statusCode !== 503) {
      logMeta.originalError = err !== appErr ? err.message : undefined;
    }

    logger.warn(appErr.message, logMeta);

    const body = {
      error:     appErr.errorCode,
      message:   appErr.message,
      requestId: correlationId,
    };

    if (appErr instanceof ValidationError && Object.keys(appErr.fields).length) {
      body.fields = appErr.fields;
    }

    return res.status(appErr.statusCode).json(body);
  }

  // Non-operational / unexpected error — log full stack, mask message in prod
  logger.error('Unhandled error', {
    correlationId,
    error:  err.message,
    stack:  err.stack,
    method: req.method,
    path:   req.path,
  });

  return res.status(500).json({
    error:     'INTERNAL_ERROR',
    message:   isProduction ? 'An unexpected error occurred' : err.message,
    requestId: correlationId,
  });
}

module.exports = errorHandler;
