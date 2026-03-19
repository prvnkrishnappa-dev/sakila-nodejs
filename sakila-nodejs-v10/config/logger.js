/**
 * @fileoverview Structured logger (Winston)
 *
 * Two output formats are selected at module load time based on NODE_ENV:
 *   production  — newline-delimited JSON (compatible with ELK, CloudWatch,
 *                 Datadog, and any structured log aggregator)
 *   development — coloured printf with timestamp prefix for human readability
 *
 * LOG_LEVEL defaults to 'http' in non-production environments so that Morgan
 * HTTP access log entries (written at level 'http') are visible by default.
 * In production the recommended level is 'info', which omits HTTP and debug.
 *
 * NODE_ENV is read directly from process.env — not from config/env — to
 * avoid a circular module dependency (config/env imports this logger).
 *
 * The Console transport is created without handleExceptions/handleRejections.
 * Those are handled at the process level in server.js so all error paths
 * funnel through the same logger instance and format.
 */

'use strict';

const { createLogger, format, transports } = require('winston');

const isProduction = process.env.NODE_ENV === 'production';
const logLevel     = process.env.LOG_LEVEL || (isProduction ? 'info' : 'http');

const { combine, timestamp, json, colorize, printf, errors } = format;

/** Human-readable format for local development. */
const devFormat = combine(
  colorize({ all: true }),
  timestamp({ format: 'HH:mm:ss.SSS' }),
  errors({ stack: true }),
  printf(({ level, message, timestamp: ts, stack, correlationId, ...meta }) => {
    const rid    = correlationId ? ` [${correlationId}]` : '';
    const extras = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    return `${ts}${rid} ${level}: ${stack || message}${extras}`;
  }),
);

/** Structured JSON format for production log aggregators. */
const prodFormat = combine(
  timestamp(),
  errors({ stack: true }),
  json(),
);

const logger = createLogger({
  level:  logLevel,
  format: isProduction ? prodFormat : devFormat,
  transports: [
    new transports.Console(),
  ],
  exitOnError: false,
});

/**
 * Create a child logger bound to a correlation ID.
 * All log entries from the child include the ID without explicit passing.
 *
 * @param {string} correlationId
 * @returns {import('winston').Logger}
 */
logger.withCorrelationId = (correlationId) =>
  logger.child({ correlationId });

module.exports = logger;
