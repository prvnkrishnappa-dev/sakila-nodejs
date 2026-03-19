/**
 * @fileoverview Global error handler middleware
 *
 * This is the last middleware registered in app.js (4-argument signature
 * required by Express). It handles every error thrown or passed to next()
 * by route handlers.
 *
 * Error resolution order:
 *   1. If err is already an AppError subclass — use it directly.
 *   2. If err.name matches a known Sequelize error — map to a typed AppError.
 *   3. Otherwise — treat as an unhandled non-operational error (500).
 *
 * Sequelize → AppError mappings:
 *   SequelizeValidationError           → 400 VALIDATION_ERROR  (isOperational)
 *   SequelizeUniqueConstraintError     → 409 CONFLICT          (isOperational)
 *   SequelizeForeignKeyConstraintError → 400 VALIDATION_ERROR  (isOperational)
 *   SequelizeConnectionError (+ variants) → 503 DB_UNAVAILABLE (isOperational)
 *   SequelizeTimeoutError              → 503 DB_UNAVAILABLE    (isOperational)
 *   SequelizeDatabaseError             → 500 INTERNAL_ERROR    (non-operational)
 *
 * Logging strategy:
 *   - Operational errors (4xx, 503): logged at WARN. Raw Sequelize connection
 *     error messages are omitted from production logs to prevent credential
 *     paths or host details leaking into log aggregators.
 *   - Non-operational errors (500): logged at ERROR with full stack trace.
 *     The message is masked to a generic string in production responses.
 *
 * NODE_ENV is read directly from process.env to avoid importing config/env,
 * which would create a circular dependency through the logger.
 */

'use strict';

const { AppError, ValidationError, ConflictError } = require('../errors');
const logger = require('../config/logger');

const isProduction = process.env.NODE_ENV === 'production';

// ── Sequelize → AppError mapping ─────────────────────────────────────────────

/**
 * Map well-known Sequelize error names to typed AppErrors.
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
    case 'SequelizeTimeoutError':
      /** Pool-acquire timeout and connection failures are operational — expected under load. */
      return new AppError('Database temporarily unavailable', 503, 'DB_UNAVAILABLE', true);

    case 'SequelizeDatabaseError':
      /** Generic query errors are programming bugs — mask message in production. */
      return new AppError('An unexpected error occurred', 500, 'INTERNAL_ERROR', false);

    default:
      return null;
  }
}

// ── Error handler ─────────────────────────────────────────────────────────────

/**
 * Express 4-argument error handler. Must be registered LAST in app.js.
 *
 * @param {Error}                          err
 * @param {import('express').Request}      req
 * @param {import('express').Response}     res
 * @param {import('express').NextFunction} _next
 */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, _next) {
  const correlationId = res.locals.correlationId || 'unknown';
  const appErr        = err instanceof AppError ? err : mapSequelizeError(err);

  if (appErr) {
    const logMeta = {
      correlationId,
      errorCode:  appErr.errorCode,
      statusCode: appErr.statusCode,
      method:     req.method,
      path:       req.path,
    };
    /** Omit raw Sequelize connection messages from production logs (credential leak risk). */
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

  /** Unhandled / non-operational error — log full stack, mask response in production. */
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
