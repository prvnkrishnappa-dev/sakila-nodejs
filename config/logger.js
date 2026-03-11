/**
 * @fileoverview Structured logger (Winston)  (v6)
 *
 * No changes from v5. All prior fixes carried forward:
 *   - FIX A6: no handleExceptions/handleRejections on Console transport
 *   - process.env.NODE_ENV read directly (no config/env import — avoids circular dep)
 *   - LOG_LEVEL defaults to 'http' in dev so Morgan access logs appear
 *   - JSON format in production (ELK / CloudWatch / Datadog compatible)
 *   - Coloured printf format in development with correlationId prefix
 */

'use strict';

const { createLogger, format, transports } = require('winston');

// Read directly from process.env — do NOT import config/env here.
// config/env requires logger at module load; importing it here would be circular.
const isProduction = process.env.NODE_ENV === 'production';
const logLevel     = process.env.LOG_LEVEL || (isProduction ? 'info' : 'http');

const { combine, timestamp, json, colorize, printf, errors } = format;

// ── Dev: coloured, human-readable ────────────────────────────────────────────
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

// ── Prod: newline-delimited JSON ──────────────────────────────────────────────
const prodFormat = combine(
  timestamp(),
  errors({ stack: true }),
  json(),
);

// ── Logger instance ───────────────────────────────────────────────────────────
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
 * @param {string} correlationId
 * @returns {import('winston').Logger}
 */
logger.withCorrelationId = (correlationId) =>
  logger.child({ correlationId });

module.exports = logger;
