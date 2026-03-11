'use strict';
const AppError = require('./app-error');

/**
 * HTTP 400 — request input failed validation.
 * @property {Record<string, string>} fields - field name → error message (no undefined values)
 */
class ValidationError extends AppError {
  /**
   * @param {string} message
   * @param {Record<string, string>} [fields={}]
   */
  constructor(message, fields = {}) {
    super(message, 400, 'VALIDATION_ERROR');
    // Strip any undefined values so JSON serialisation never emits null for valid fields
    this.fields = Object.fromEntries(
      Object.entries(fields).filter(([, v]) => v !== undefined),
    );
  }
}

module.exports = ValidationError;
