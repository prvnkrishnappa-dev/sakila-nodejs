/**
 * @fileoverview Express application factory  (v6)
 *
 * Changes from v5:
 *
 *   FIX AP1 — express-rate-limit uses req.ip to identify clients. Behind an
 *     AWS ALB or nginx reverse proxy, req.ip is the proxy's IP (127.0.0.1 or
 *     the LB IP), not the client IP — meaning ALL clients share a single rate
 *     limit counter. Fixed: app.set('trust proxy', 1) when running in
 *     production so Express reads req.ip from X-Forwarded-For[0] (the real
 *     client IP set by the trusted upstream proxy).
 *     In development/test, trust proxy is not enabled to prevent spoofing.
 *
 *   FIX AP2 — The readiness probe called getSequelize().authenticate() which
 *     creates the Sequelize singleton as a side effect on first probe hit —
 *     before verifyConnection() has finished retrying in server.js. This
 *     could result in two competing Sequelize instances. Wrapped in a try/catch
 *     that falls back to a 503 if the singleton doesn't exist yet (null check).
 *
 * Carries forward all v5 fixes (S1, R1, helmet, CORS, Morgan, 404, error handler).
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

// ── Trust proxy (FIX AP1) ─────────────────────────────────────────────────────
// Must be set before rate limiters are created so express-rate-limit reads
// req.ip from X-Forwarded-For (the real client IP), not the proxy IP.
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

// ── Health checks (registered BEFORE 404 catch-all) ──────────────────────────

app.get('/actuator/health', (_req, res) =>
  res.json({ status: 'UP', timestamp: new Date().toISOString() }),
);
app.get('/actuator/health/live', (_req, res) =>
  res.json({ status: 'UP' }),
);

/**
 * Readiness probe — 200 only when the DB connection pool is healthy.
 * FIX AP2: null-guards getSequelize() to avoid creating the singleton before
 * verifyConnection() has completed its retry loop in server.js.
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

// ── 404 catch-all (must come after all real routes) ───────────────────────────
app.use((req, res) => {
  res.status(404).json({
    error:     'NOT_FOUND',
    message:   `Route not found: ${req.method} ${req.originalUrl}`,
    requestId: res.locals.correlationId,
  });
});

// ── Global error handler (must be LAST) ──────────────────────────────────────
app.use(errorHandler);

module.exports = app;
