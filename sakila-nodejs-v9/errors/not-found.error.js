'use strict';
const AppError = require('./app-error');

/** HTTP 404 — requested resource does not exist. */
class NotFoundError extends AppError {
  /** @param {string} message */
  constructor(message) {
    super(message, 404, 'NOT_FOUND');
  }
}

module.exports = NotFoundError;
