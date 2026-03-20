/**
 * @fileoverview Unit tests — error-handler middleware  (v6)
 *
 * NEW tests for v6 fixes:
 *   - FIX E4: SequelizeTimeoutError → 503 DB_UNAVAILABLE (pool exhaustion)
 *   - FIX E5: SequelizeDatabaseError → 500 INTERNAL_ERROR (query bug)
 *
 * Carries forward all v5 tests (TS3: mapSequelizeError direct unit tests).
 */

'use strict';

jest.mock('../config/env', () => ({
  isProduction:  false,
  isDevelopment: true,
  isTest:        true,
  logLevel:      'error',
}));

jest.mock('../config/logger', () => ({
  warn:  jest.fn(),
  error: jest.fn(),
  info:  jest.fn(),
  http:  jest.fn(),
  debug: jest.fn(),
  child: jest.fn().mockReturnThis(),
}));

const request      = require('supertest');
const express      = require('express');
const errorHandler = require('../middleware/error-handler');
const AppError     = require('../errors/app-error');
const NotFoundError   = require('../errors/not-found.error');
const ValidationError = require('../errors/validation.error');
const ConflictError   = require('../errors/conflict.error');

function makeSequelizeError(name, extraErrors = []) {
  const err  = new Error(`Sequelize error: ${name}`);
  err.name   = name;
  err.errors = extraErrors;
  return err;
}

function buildApp(throwFn) {
  const app = express();
  app.use((req, res, next) => { res.locals.correlationId = 'test-req-id'; next(); });
  app.get('/test', (_req, _res, next) => {
    try { throwFn(); } catch (e) { next(e); }
  });
  app.use(errorHandler);
  return app;
}

// ── Sequelize error mapping ───────────────────────────────────────────────────

describe('mapSequelizeError()', () => {

  it('maps SequelizeValidationError → 400 VALIDATION_ERROR', async () => {
    const err = makeSequelizeError('SequelizeValidationError', [
      { path: 'first_name', message: 'first_name cannot be blank' },
    ]);
    const app = buildApp(() => { throw err; });
    const res = await request(app).get('/test');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
    expect(res.body.fields.first_name).toBe('first_name cannot be blank');
  });

  it('maps SequelizeUniqueConstraintError → 409 CONFLICT', async () => {
    const err = makeSequelizeError('SequelizeUniqueConstraintError');
    const app = buildApp(() => { throw err; });
    const res = await request(app).get('/test');
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('CONFLICT');
  });

  it('maps SequelizeForeignKeyConstraintError → 400 VALIDATION_ERROR', async () => {
    const err = makeSequelizeError('SequelizeForeignKeyConstraintError');
    const app = buildApp(() => { throw err; });
    const res = await request(app).get('/test');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('maps SequelizeConnectionError → 503 DB_UNAVAILABLE', async () => {
    const err = makeSequelizeError('SequelizeConnectionError');
    const app = buildApp(() => { throw err; });
    const res = await request(app).get('/test');
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('DB_UNAVAILABLE');
    expect(res.body.message).toBe('Database temporarily unavailable');
  });

  it('maps SequelizeConnectionRefusedError → 503 DB_UNAVAILABLE', async () => {
    const err = makeSequelizeError('SequelizeConnectionRefusedError');
    const app = buildApp(() => { throw err; });
    const res = await request(app).get('/test');
    expect(res.status).toBe(503);
  });

  it('maps SequelizeConnectionTimedOutError → 503 DB_UNAVAILABLE', async () => {
    const err = makeSequelizeError('SequelizeConnectionTimedOutError');
    const app = buildApp(() => { throw err; });
    const res = await request(app).get('/test');
    expect(res.status).toBe(503);
  });

  // FIX E4: pool acquire timeout must not fall through to 500
  it('maps SequelizeTimeoutError → 503 DB_UNAVAILABLE (FIX E4)', async () => {
    const err = makeSequelizeError('SequelizeTimeoutError');
    const app = buildApp(() => { throw err; });
    const res = await request(app).get('/test');
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('DB_UNAVAILABLE');
  });

  // FIX E5: generic DB query errors should not produce INTERNAL_ERROR 500 with SQL details
  it('maps SequelizeDatabaseError → 500 INTERNAL_ERROR (FIX E5)', async () => {
    const err = makeSequelizeError('SequelizeDatabaseError');
    const app = buildApp(() => { throw err; });
    const res = await request(app).get('/test');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('INTERNAL_ERROR');
  });

  it('returns 500 for unknown errors (not a Sequelize error)', async () => {
    const err = new Error('Something completely unexpected');
    const app = buildApp(() => { throw err; });
    const res = await request(app).get('/test');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('INTERNAL_ERROR');
  });

});

// ── AppError subclass mapping ──────────────────────────────────────────────────

describe('errorHandler() — AppError subtypes', () => {

  it('returns correct status for NotFoundError', async () => {
    const app = buildApp(() => { throw new NotFoundError('Actor not found: 1'); });
    const res = await request(app).get('/test');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
    expect(res.body.requestId).toBe('test-req-id');
  });

  it('returns field errors for ValidationError', async () => {
    const app = buildApp(() => {
      throw new ValidationError('Validation failed', { firstName: 'required' });
    });
    const res = await request(app).get('/test');
    expect(res.status).toBe(400);
    expect(res.body.fields.firstName).toBe('required');
  });

  it('returns 409 for ConflictError', async () => {
    const app = buildApp(() => { throw new ConflictError('Already exists'); });
    const res = await request(app).get('/test');
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('CONFLICT');
  });

  it('includes requestId in every error response', async () => {
    const app = buildApp(() => { throw new NotFoundError('x'); });
    const res = await request(app).get('/test');
    expect(res.body.requestId).toBe('test-req-id');
  });

  it('does not include fields key when ValidationError has no fields', async () => {
    const app = buildApp(() => { throw new ValidationError('Empty fields'); });
    const res = await request(app).get('/test');
    expect(res.body).not.toHaveProperty('fields');
  });

});
