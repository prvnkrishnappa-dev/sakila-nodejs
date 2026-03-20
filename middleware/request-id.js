'use strict';

const { v4: uuidv4 } = require('uuid');

/**
 * Max length accepted for a caller-supplied X-Request-Id.
 * RFC 7231 does not prescribe a limit; 128 chars is generous for any UUID/ULID/custom format.
 */
const MAX_REQUEST_ID_LENGTH = 128;

/**
 * Allowlist regex — printable ASCII excluding chars that can break HTTP header values
 * (control characters, CR, LF, null).
 */
const SAFE_REQUEST_ID_RE = /^[\x20-\x7E]+$/;

/**
 * Sanitise and validate an incoming X-Request-Id header value.
 *
 * FIX M1: v5 forwarded the raw header value directly into the response and
 * into every log line without sanitisation. A malicious caller could inject:
 *   - Newline sequences (CRLF injection / HTTP response splitting)
 *   - Excessively long strings (amplify log storage / DoS)
 *   - Non-printable control characters (log forging)
 * Fixed: reject (return null) if the value is too long or contains
 * non-printable characters; fall through to a fresh UUID.
 *
 * @param {string|undefined} raw
 * @returns {string|null}  sanitised value, or null if invalid
 */
function sanitiseRequestId(raw) {
  if (!raw || typeof raw !== 'string') return null;
  if (raw.length > MAX_REQUEST_ID_LENGTH) return null;
  if (!SAFE_REQUEST_ID_RE.test(raw)) return null;
  return raw;
}

/**
 * Attach a correlation ID to every request.
 *
 * Reads X-Request-Id from the incoming request (set by upstream proxy/ALB),
 * validates it (FIX M1), or generates a fresh UUID v4. Writes it to:
 *   - res.locals.correlationId  (available to all downstream middleware)
 *   - X-Request-Id response header  (returned to caller for support queries)
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
