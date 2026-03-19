/**
 * @fileoverview X-Request-Id correlation ID middleware
 *
 * Attaches a correlation ID to every request for distributed tracing. The ID
 * is propagated through the response header and res.locals so downstream
 * middleware, service handlers, and the error handler can include it in
 * log entries and response bodies.
 *
 * ID selection logic:
 *   1. If the incoming X-Request-Id header passes sanitisation, use it. This
 *      allows upstream proxies (ALB, nginx, API gateway) to inject their own
 *      trace IDs and have them flow through the entire request lifecycle.
 *   2. Otherwise, generate a fresh UUID v4.
 *
 * Sanitisation rules (CRLF-injection and DoS prevention):
 *   - Must be a non-empty string
 *   - Length ≤ MAX_REQUEST_ID_LENGTH (128 chars — generous for UUID/ULID/custom)
 *   - Must match SAFE_REQUEST_ID_RE: printable ASCII only (0x20–0x7E)
 *   Values that fail any rule are silently discarded; a fresh UUID is used.
 *   This prevents:
 *     - HTTP response splitting via embedded CR/LF sequences
 *     - Log forging via embedded non-printable control characters
 *     - Log-storage DoS via oversized header values
 */

'use strict';

const { v4: uuidv4 } = require('uuid');

const MAX_REQUEST_ID_LENGTH = 128;

/** Printable ASCII only — excludes control chars, CR, LF, and NUL. */
const SAFE_REQUEST_ID_RE = /^[\x20-\x7E]+$/;

/**
 * Sanitise an incoming X-Request-Id header value.
 *
 * @param {string|undefined} raw
 * @returns {string|null} sanitised value, or null if invalid
 */
function sanitiseRequestId(raw) {
  if (!raw || typeof raw !== 'string') return null;
  if (raw.length > MAX_REQUEST_ID_LENGTH) return null;
  if (!SAFE_REQUEST_ID_RE.test(raw)) return null;
  return raw;
}

/**
 * Express middleware: assign a correlation ID to every request.
 *
 * @param {import('express').Request}      req
 * @param {import('express').Response}     res
 * @param {import('express').NextFunction} next
 */
function requestId(req, res, next) {
  const id = sanitiseRequestId(req.headers['x-request-id']) ?? uuidv4();
  res.locals.correlationId = id;
  res.setHeader('X-Request-Id', id);
  next();
}

module.exports = requestId;
