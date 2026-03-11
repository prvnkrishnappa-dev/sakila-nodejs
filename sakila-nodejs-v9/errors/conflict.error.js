'use strict';
const AppError = require('./app-error');

/** HTTP 409 — resource already exists (duplicate key). */
class ConflictError extends AppError {
  /** @param {string} message */
  constructor(message) {
    super(message, 409, 'CONFLICT');
  }
}

module.exports = ConflictError;
