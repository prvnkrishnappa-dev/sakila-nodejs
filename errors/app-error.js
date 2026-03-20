'use strict';

/**
 * Base class for all application-level errors.
 *
 * Subclass hierarchy:
 *   AppError
 *     ├─ NotFoundError   (404)
 *     ├─ ValidationError (400)
 *     └─ ConflictError   (409)
 *
 * @property {string}  name          - constructor name, e.g. 'NotFoundError'
 * @property {number}  statusCode    - HTTP status code
 * @property {string}  errorCode     - machine-readable code, e.g. 'NOT_FOUND'
 * @property {boolean} isOperational - true = expected error; false = programming bug
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

module.exports = AppError;
