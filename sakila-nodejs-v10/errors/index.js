/**
 * @fileoverview Application error hierarchy
 *
 * All domain errors extend AppError, which itself extends the built-in Error.
 * This gives the global error handler a single instanceof check to distinguish
 * expected operational errors (user input, missing resource, conflict) from
 * unexpected programming bugs.
 *
 * Error class hierarchy:
 *   AppError (base)
 *     ├─ NotFoundError   → HTTP 404 NOT_FOUND
 *     ├─ ValidationError → HTTP 400 VALIDATION_ERROR  (carries field map)
 *     └─ ConflictError   → HTTP 409 CONFLICT
 *
 * isOperational:
 *   true  — expected error (4xx); logged at WARN, message safe to expose to clients.
 *   false — programming bug (5xx); logged at ERROR, message masked in production.
 */

'use strict';

// ── AppError ──────────────────────────────────────────────────────────────────

/**
 * Base class for all application-level errors.
 *
 * @property {string}  name          - constructor name, e.g. 'NotFoundError'
 * @property {number}  statusCode    - HTTP status code
 * @property {string}  errorCode     - machine-readable code, e.g. 'NOT_FOUND'
 * @property {boolean} isOperational - true = expected; false = programming bug
 */
class AppError extends Error {
  /**
   * @param {string}  message
   * @param {number}  statusCode
   * @param {string}  [errorCode='INTERNAL_ERROR']
   * @param {boolean} [isOperational=true]
   */
  constructor(message, statusCode, errorCode = 'INTERNAL_ERROR', isOperational = true) {
    super(message);
    this.name          = this.constructor.name;
    this.statusCode    = statusCode;
    this.errorCode     = errorCode;
    this.isOperational = isOperational;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

// ── NotFoundError ─────────────────────────────────────────────────────────────

/** HTTP 404 — requested resource does not exist. */
class NotFoundError extends AppError {
  /** @param {string} message */
  constructor(message) {
    super(message, 404, 'NOT_FOUND');
  }
}

// ── ValidationError ───────────────────────────────────────────────────────────

/**
 * HTTP 400 — request input failed validation.
 * @property {Record<string, string>} fields - field → error message pairs
 */
class ValidationError extends AppError {
  /**
   * @param {string}                    message
   * @param {Record<string, string>}    [fields={}]
   */
  constructor(message, fields = {}) {
    super(message, 400, 'VALIDATION_ERROR');
    /** Strip undefined values so JSON serialisation never emits null for valid fields. */
    this.fields = Object.fromEntries(
      Object.entries(fields).filter(([, v]) => v !== undefined),
    );
  }
}

// ── ConflictError ─────────────────────────────────────────────────────────────

/** HTTP 409 — resource already exists (duplicate key). */
class ConflictError extends AppError {
  /** @param {string} message */
  constructor(message) {
    super(message, 409, 'CONFLICT');
  }
}

module.exports = { AppError, NotFoundError, ValidationError, ConflictError };
