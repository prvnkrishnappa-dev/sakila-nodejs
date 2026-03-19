/**
 * @fileoverview Unit tests — error-handler middleware  (v10)
 *
 * Tests for Sequelize error mapping and AppError subclass handling:
 *   - SequelizeValidationError          → 400 VALIDATION_ERROR  (with fields)
 *   - SequelizeUniqueConstraintError    → 409 CONFLICT
 *   - SequelizeForeignKeyConstraintError → 400 VALIDATION_ERROR
 *   - SequelizeConnectionError (+ variants) → 503 DB_UNAVAILABLE
 *   - SequelizeTimeoutError             → 503 DB_UNAVAILABLE
 *   - SequelizeDatabaseError            → 500 INTERNAL_ERROR
 *   - Unknown error                     → 500 INTERNAL_ERROR
 *   - NotFoundError, ValidationError, ConflictError → correct status/code/fields
 *   - requestId always present in response body
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
const { AppError, NotFoundError, ValidationError, ConflictError } = require('../errors');

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

describe('Sequelize error mapping', () => {

  it('maps SequelizeValidationError → 400 VALIDATION_ERROR with fields', async () => {
    const err = makeSequelizeError('SequelizeValidationError', [
      { path: 'first_name', message: 'first_name cannot be blank' },
    ]);
    const res = await request(buildApp(() => { throw err; })).get('/test');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
    expect(res.body.fields.first_name).toBe('first_name cannot be blank');
  });

  it('maps SequelizeUniqueConstraintError → 409 CONFLICT', async () => {
    const res = await request(buildApp(() => { throw makeSequelizeError('SequelizeUniqueConstraintError'); })).get('/test');
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('CONFLICT');
  });

  it('maps SequelizeForeignKeyConstraintError → 400 VALIDATION_ERROR', async () => {
    const res = await request(buildApp(() => { throw makeSequelizeError('SequelizeForeignKeyConstraintError'); })).get('/test');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('maps SequelizeConnectionError → 503 DB_UNAVAILABLE', async () => {
    const res = await request(buildApp(() => { throw makeSequelizeError('SequelizeConnectionError'); })).get('/test');
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('DB_UNAVAILABLE');
    expect(res.body.message).toBe('Database temporarily unavailable');
  });

  it('maps SequelizeConnectionRefusedError → 503 DB_UNAVAILABLE', async () => {
    const res = await request(buildApp(() => { throw makeSequelizeError('SequelizeConnectionRefusedError'); })).get('/test');
    expect(res.status).toBe(503);
  });

  it('maps SequelizeConnectionTimedOutError → 503 DB_UNAVAILABLE', async () => {
    const res = await request(buildApp(() => { throw makeSequelizeError('SequelizeConnectionTimedOutError'); })).get('/test');
    expect(res.status).toBe(503);
  });

  it('maps SequelizeTimeoutError → 503 DB_UNAVAILABLE (pool exhaustion)', async () => {
    const res = await request(buildApp(() => { throw makeSequelizeError('SequelizeTimeoutError'); })).get('/test');
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('DB_UNAVAILABLE');
  });

  it('maps SequelizeDatabaseError → 500 INTERNAL_ERROR', async () => {
    const res = await request(buildApp(() => { throw makeSequelizeError('SequelizeDatabaseError'); })).get('/test');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('INTERNAL_ERROR');
  });

  it('returns 500 INTERNAL_ERROR for unrecognised errors', async () => {
    const res = await request(buildApp(() => { throw new Error('Something unexpected'); })).get('/test');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('INTERNAL_ERROR');
  });

});

// ── AppError subtype handling ─────────────────────────────────────────────────

describe('AppError subtypes', () => {

  it('returns 404 for NotFoundError', async () => {
    const res = await request(buildApp(() => { throw new NotFoundError('Actor not found: 1'); })).get('/test');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
    expect(res.body.requestId).toBe('test-req-id');
  });

  it('returns 400 with fields for ValidationError', async () => {
    const res = await request(buildApp(() => {
      throw new ValidationError('Validation failed', { firstName: 'required' });
    })).get('/test');
    expect(res.status).toBe(400);
    expect(res.body.fields.firstName).toBe('required');
  });

  it('returns 409 for ConflictError', async () => {
    const res = await request(buildApp(() => { throw new ConflictError('Already exists'); })).get('/test');
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('CONFLICT');
  });

  it('includes requestId in every error response', async () => {
    const res = await request(buildApp(() => { throw new NotFoundError('x'); })).get('/test');
    expect(res.body.requestId).toBe('test-req-id');
  });

  it('omits fields key when ValidationError has no fields', async () => {
    const res = await request(buildApp(() => { throw new ValidationError('No fields'); })).get('/test');
    expect(res.body).not.toHaveProperty('fields');
  });

});
