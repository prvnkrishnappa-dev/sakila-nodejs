/**
 * @fileoverview Router integration tests — ActorRouter  (v10)
 *
 * Tests for HTTP-layer behaviour:
 *   - GET /    : paginated envelope, HATEOAS links, pagination params, pages=0 guard
 *   - GET /:id : 200 with links, 404, 400 for invalid IDs
 *   - POST /   : 201 + Location, body validation (required, max-length, whitespace)
 *   - PUT /:id : 200, 404
 *   - PATCH /  : partial update merge, empty body 400, blank field 400, 404
 *   - DELETE / : 204, 404
 *   - X-Request-Id sanitisation: valid echo, CRLF rejection, oversized rejection
 */

'use strict';

jest.mock('../config/env', () => ({
  rateLimit: {
    read:  { windowMs: 60000, max: 10000 },
    write: { windowMs: 60000, max: 10000 },
  },
  cors:          { origin: false },
  isTest:        true,
  isProduction:  false,
  isDevelopment: false,
  logLevel:      'error',
}));

const request                   = require('supertest');
const express                   = require('express');
const { NotFoundError }         = require('../errors');
const errorHandler              = require('../middleware/error-handler');
const requestId                 = require('../middleware/request-id');
const { createActorRouter }     = require('../routes/actor.router');

// ── Stub ActorService ─────────────────────────────────────────────────────────
const mockService = {
  getAllActors: jest.fn(),
  getActorById: jest.fn(),
  createActor:  jest.fn(),
  updateActor:  jest.fn(),
  deleteActor:  jest.fn(),
};

const app = express();
app.use(express.json());
app.use(requestId);
app.use('/api/v1/actors', createActorRouter(mockService));
app.use(errorHandler);

// ── Fixtures ──────────────────────────────────────────────────────────────────
const actorDTO        = { actorId: 1, firstName: 'PENELOPE', lastName: 'GUINESS', lastUpdate: new Date() };
const paginatedResult = { data: [actorDTO], total: 1, page: 1, pageSize: 20 };

// ── GET / ─────────────────────────────────────────────────────────────────────
describe('GET /api/v1/actors', () => {
  it('returns 200 with paginated envelope', async () => {
    mockService.getAllActors.mockResolvedValue(paginatedResult);
    const res = await request(app).get('/api/v1/actors');
    expect(res.status).toBe(200);
    expect(res.body._embedded.actors).toHaveLength(1);
    expect(res.body.pagination).toMatchObject({ total: 1, page: 1 });
    expect(res.body._links.self.href).toContain('/api/v1/actors');
  });

  it('passes page and pageSize to service', async () => {
    mockService.getAllActors.mockResolvedValue({ ...paginatedResult, page: 2, pageSize: 5 });
    await request(app).get('/api/v1/actors?page=2&pageSize=5');
    expect(mockService.getAllActors).toHaveBeenCalledWith({ page: 2, pageSize: 5 });
  });

  it('returns X-Request-Id response header', async () => {
    mockService.getAllActors.mockResolvedValue(paginatedResult);
    const res = await request(app).get('/api/v1/actors');
    expect(res.headers['x-request-id']).toBeDefined();
  });

  it('returns 400 when page is non-numeric', async () => {
    const res = await request(app).get('/api/v1/actors?page=foo');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
    expect(res.body.fields.page).toBeDefined();
  });

  it('returns 400 when pageSize is non-numeric', async () => {
    const res = await request(app).get('/api/v1/actors?pageSize=bar');
    expect(res.status).toBe(400);
    expect(res.body.fields.pageSize).toBeDefined();
  });

  it('returns 400 when page is zero', async () => {
    expect((await request(app).get('/api/v1/actors?page=0')).status).toBe(400);
  });

  it('pagination.pages is 0 when total is 0 (not Infinity)', async () => {
    mockService.getAllActors.mockResolvedValue({ data: [], total: 0, page: 1, pageSize: 20 });
    const res = await request(app).get('/api/v1/actors');
    expect(res.status).toBe(200);
    expect(res.body.pagination.pages).toBe(0);
  });

  it('includes next link when more pages exist', async () => {
    mockService.getAllActors.mockResolvedValue({ data: [actorDTO], total: 40, page: 1, pageSize: 20 });
    const res = await request(app).get('/api/v1/actors?page=1&pageSize=20');
    expect(res.body._links.next).toBeDefined();
    expect(res.body._links.prev).toBeUndefined();
  });

  it('includes prev link when not on first page', async () => {
    mockService.getAllActors.mockResolvedValue({ data: [actorDTO], total: 40, page: 2, pageSize: 20 });
    const res = await request(app).get('/api/v1/actors?page=2&pageSize=20');
    expect(res.body._links.prev).toBeDefined();
  });
});

// ── GET /:actorId ─────────────────────────────────────────────────────────────
describe('GET /api/v1/actors/:actorId', () => {
  it('returns 200 with actor and HATEOAS links', async () => {
    mockService.getActorById.mockResolvedValue(actorDTO);
    const res = await request(app).get('/api/v1/actors/1');
    expect(res.status).toBe(200);
    expect(res.body._links.self.href).toContain('/api/v1/actors/1');
    expect(res.body.actorId).toBe(1);
  });

  it('returns 404 with NOT_FOUND error code', async () => {
    mockService.getActorById.mockRejectedValue(new NotFoundError('Actor not found: 999'));
    const res = await request(app).get('/api/v1/actors/999');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
    expect(res.body.requestId).toBeDefined();
  });

  it('returns 400 for non-integer actorId', async () => {
    const res = await request(app).get('/api/v1/actors/abc');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for negative actorId', async () => {
    expect((await request(app).get('/api/v1/actors/-5')).status).toBe(400);
  });

  it('returns 400 for zero actorId', async () => {
    expect((await request(app).get('/api/v1/actors/0')).status).toBe(400);
  });
});

// ── POST / ────────────────────────────────────────────────────────────────────
describe('POST /api/v1/actors', () => {
  it('returns 201 with Location header and HATEOAS links', async () => {
    mockService.createActor.mockResolvedValue(actorDTO);
    const res = await request(app).post('/api/v1/actors')
      .send({ firstName: 'PENELOPE', lastName: 'GUINESS' });
    expect(res.status).toBe(201);
    expect(res.headers.location).toContain('/api/v1/actors/1');
    expect(res.body._links.self.href).toContain('/1');
  });

  it('returns 400 when firstName is missing', async () => {
    const res = await request(app).post('/api/v1/actors').send({ lastName: 'GUINESS' });
    expect(res.status).toBe(400);
    expect(res.body.fields.firstName).toBe('required');
  });

  it('returns 400 when firstName exceeds 45 characters', async () => {
    const res = await request(app).post('/api/v1/actors')
      .send({ firstName: 'A'.repeat(46), lastName: 'GUINESS' });
    expect(res.status).toBe(400);
    expect(res.body.fields.firstName).toContain('45');
  });

  it('returns 400 when firstName is whitespace-only', async () => {
    const res = await request(app).post('/api/v1/actors')
      .send({ firstName: '   ', lastName: 'GUINESS' });
    expect(res.status).toBe(400);
    expect(res.body.fields.firstName).toBe('required');
  });

  it('trims surrounding whitespace before passing to service', async () => {
    mockService.createActor.mockResolvedValue(actorDTO);
    await request(app).post('/api/v1/actors')
      .send({ firstName: ' PENELOPE ', lastName: 'GUINESS' });
    expect(mockService.createActor).toHaveBeenCalledWith(
      expect.objectContaining({ firstName: 'PENELOPE' }),
    );
  });

  it('returns 400 when body is empty', async () => {
    const res = await request(app).post('/api/v1/actors').send({});
    expect(res.status).toBe(400);
    expect(res.body.fields).toHaveProperty('firstName');
    expect(res.body.fields).toHaveProperty('lastName');
  });
});

// ── PUT /:actorId ─────────────────────────────────────────────────────────────
describe('PUT /api/v1/actors/:actorId', () => {
  it('returns 200 with updated actor', async () => {
    mockService.updateActor.mockResolvedValue({ ...actorDTO, firstName: 'NICK' });
    const res = await request(app).put('/api/v1/actors/1')
      .send({ firstName: 'NICK', lastName: 'WAHLBERG' });
    expect(res.status).toBe(200);
    expect(res.body.firstName).toBe('NICK');
  });

  it('returns 404 when actor does not exist', async () => {
    mockService.updateActor.mockRejectedValue(new NotFoundError('Actor not found: 99'));
    const res = await request(app).put('/api/v1/actors/99')
      .send({ firstName: 'X', lastName: 'Y' });
    expect(res.status).toBe(404);
  });
});

// ── PATCH /:actorId ───────────────────────────────────────────────────────────
describe('PATCH /api/v1/actors/:actorId', () => {
  it('returns 200 when patching only firstName — merges existing lastName', async () => {
    mockService.getActorById.mockResolvedValue(actorDTO);
    mockService.updateActor.mockResolvedValue({ ...actorDTO, firstName: 'NICK' });
    const res = await request(app).patch('/api/v1/actors/1').send({ firstName: 'NICK' });
    expect(res.status).toBe(200);
    expect(mockService.updateActor).toHaveBeenCalledWith(
      1, expect.objectContaining({ firstName: 'NICK', lastName: 'GUINESS' }),
    );
  });

  it('returns 200 when patching only lastName — merges existing firstName', async () => {
    mockService.getActorById.mockResolvedValue(actorDTO);
    mockService.updateActor.mockResolvedValue({ ...actorDTO, lastName: 'WAHLBERG' });
    const res = await request(app).patch('/api/v1/actors/1').send({ lastName: 'WAHLBERG' });
    expect(res.status).toBe(200);
    expect(mockService.updateActor).toHaveBeenCalledWith(
      1, expect.objectContaining({ firstName: 'PENELOPE', lastName: 'WAHLBERG' }),
    );
  });

  it('returns 400 for empty PATCH body', async () => {
    const res = await request(app).patch('/api/v1/actors/1').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for blank firstName in PATCH', async () => {
    const res = await request(app).patch('/api/v1/actors/1').send({ firstName: '   ' });
    expect(res.status).toBe(400);
  });

  it('returns 404 when actor does not exist', async () => {
    mockService.getActorById.mockRejectedValue(new NotFoundError('Actor not found: 99'));
    const res = await request(app).patch('/api/v1/actors/99').send({ firstName: 'NICK' });
    expect(res.status).toBe(404);
  });
});

// ── DELETE /:actorId ──────────────────────────────────────────────────────────
describe('DELETE /api/v1/actors/:actorId', () => {
  it('returns 204 No Content', async () => {
    mockService.deleteActor.mockResolvedValue(undefined);
    const res = await request(app).delete('/api/v1/actors/1');
    expect(res.status).toBe(204);
    expect(res.body).toEqual({});
  });

  it('returns 404 when actor does not exist', async () => {
    mockService.deleteActor.mockRejectedValue(new NotFoundError('Actor not found: 99'));
    expect((await request(app).delete('/api/v1/actors/99')).status).toBe(404);
  });
});

// ── X-Request-Id sanitisation ─────────────────────────────────────────────────
describe('X-Request-Id sanitisation', () => {
  it('reflects a valid X-Request-Id back in the response', async () => {
    mockService.getActorById.mockResolvedValue(actorDTO);
    const res = await request(app).get('/api/v1/actors/1').set('X-Request-Id', 'my-id-123');
    expect(res.headers['x-request-id']).toBe('my-id-123');
  });

  it('replaces a CRLF-injected X-Request-Id with a fresh UUID', async () => {
    mockService.getActorById.mockResolvedValue(actorDTO);
    const res = await request(app).get('/api/v1/actors/1')
      .set('X-Request-Id', 'id\r\nX-Injected: evil');
    expect(res.headers['x-request-id']).not.toContain('\r\n');
    expect(res.headers['x-request-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('replaces an excessively long X-Request-Id with a fresh UUID', async () => {
    mockService.getActorById.mockResolvedValue(actorDTO);
    const res = await request(app).get('/api/v1/actors/1')
      .set('X-Request-Id', 'a'.repeat(200));
    expect(res.headers['x-request-id'].length).toBeLessThan(200);
  });
});
