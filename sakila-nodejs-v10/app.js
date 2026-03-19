/**
 * @fileoverview Express application factory
 *
 * Assembles the Express app and wires all middleware, routes, and health probes
 * in a deterministic order. Exported as a plain module so it can be tested
 * independently of the HTTP server lifecycle in server.js.
 *
 * Middleware pipeline (in order):
 *   1. Trust proxy  — production-only; enables real-client-IP for rate limiters
 *   2. Helmet       — sets secure HTTP response headers
 *   3. CORS         — enforces origin allowlist from config
 *   4. Request ID   — injects/sanitises X-Request-Id correlation header
 *   5. Morgan       — HTTP access logging (skipped in test environment)
 *   6. Body parser  — JSON + URL-encoded, capped at 256 kb
 *   7. Health probes — /actuator/health/* registered before the 404 catch-all
 *   8. API routes   — /api/v1/actors
 *   9. 404 handler  — catches unmatched routes
 *  10. Error handler — global last-resort error middleware
 *
 * Trust proxy is enabled only in production so that express-rate-limit reads
 * req.ip from X-Forwarded-For (set by the upstream ALB/nginx), not the proxy's
 * own IP. Enabling it in development would allow clients to spoof their IP.
 *
 * The readiness probe null-guards getSequelize() to avoid creating the Sequelize
 * singleton before verifyConnection() has finished its retry loop in server.js.
 */

'use strict';

const express               = require('express');
const helmet                = require('helmet');
const cors                  = require('cors');
const morgan                = require('morgan');
const config                = require('./config/env');
const logger                = require('./config/logger');
const { getSequelize }      = require('./config/database');
const { getActorService }   = require('./config/container');
const { createActorRouter } = require('./routes/actor.router');
const requestId             = require('./middleware/request-id');
const errorHandler          = require('./middleware/error-handler');

const app = express();

// ── Trust proxy ───────────────────────────────────────────────────────────────
if (config.isProduction) {
  app.set('trust proxy', 1);
}

// ── Security headers ──────────────────────────────────────────────────────────
app.use(helmet());

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use(cors({
  origin:         config.cors.origin,
  methods:        ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
  exposedHeaders: ['X-Request-Id', 'RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset'],
}));

// ── Correlation ID ────────────────────────────────────────────────────────────
app.use(requestId);

// ── HTTP request logging ──────────────────────────────────────────────────────
if (!config.isTest) {
  const morganFmt = config.isProduction ? 'combined' : 'dev';
  app.use(morgan(morganFmt, {
    stream: { write: (msg) => logger.http(msg.trim()) },
  }));
}

// ── Body parsing ──────────────────────────────────────────────────────────────
app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: true, limit: '256kb' }));

// ── Health checks ─────────────────────────────────────────────────────────────

/** Liveness probe — always 200 as long as the process is running. */
app.get('/actuator/health', (_req, res) =>
  res.json({ status: 'UP', timestamp: new Date().toISOString() }),
);

app.get('/actuator/health/live', (_req, res) =>
  res.json({ status: 'UP' }),
);

/**
 * Readiness probe — 200 only when the DB connection pool is authenticated.
 * Returns 503 if the pool is not yet ready or has become unreachable.
 */
app.get('/actuator/health/ready', async (_req, res) => {
  try {
    await getSequelize().authenticate();
    res.json({ status: 'UP', db: 'connected' });
  } catch (err) {
    res.status(503).json({ status: 'DOWN', db: 'unreachable', detail: err.message });
  }
});

// ── API routes ────────────────────────────────────────────────────────────────
app.use('/api/v1/actors', createActorRouter(getActorService()));

// ── 404 catch-all ─────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    error:     'NOT_FOUND',
    message:   `Route not found: ${req.method} ${req.originalUrl}`,
    requestId: res.locals.correlationId,
  });
});

// ── Global error handler ──────────────────────────────────────────────────────
app.use(errorHandler);

module.exports = app;
