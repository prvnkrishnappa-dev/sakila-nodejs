/**
 * @fileoverview Actor Router — Express route definitions
 *
 * Exposes the actor domain over HTTP. Accepts and validates request inputs,
 * delegates business logic to ActorService, and formats HAL-style JSON
 * responses with hypermedia links.
 *
 * Route summary:
 *   GET    /api/v1/actors              — paginated actor list
 *   GET    /api/v1/actors/:actorId     — single actor by ID
 *   POST   /api/v1/actors              — create actor
 *   PUT    /api/v1/actors/:actorId     — full replacement update
 *   PATCH  /api/v1/actors/:actorId     — partial update (firstName or lastName)
 *   DELETE /api/v1/actors/:actorId     — delete actor
 *
 * Rate limiting:
 *   Read endpoints (GET) use readLimiter (default: 300 req/min/IP).
 *   Write endpoints (POST/PUT/PATCH/DELETE) use writeLimiter (default: 60 req/min/IP).
 *   Limits are configured via RATE_LIMIT_* env vars. In production,
 *   app.set('trust proxy', 1) must be active for the limiter to read the
 *   real client IP from X-Forwarded-For rather than the proxy IP.
 *
 * PATCH semantics:
 *   A true partial update requires a partialUpdate() method on the repository.
 *   The current implementation reads the existing record first and merges the
 *   supplied fields before calling updateActor(). This is correct and atomic
 *   within a transaction but uses two DB round-trips. A native PATCH path
 *   (UPDATE only supplied columns) is deferred to a future version.
 *
 * HATEOAS (_links):
 *   withLinks() uses Object.assign rather than spread to prevent a hypothetical
 *   future DTO field named '_links' from silently clobbering the hypermedia
 *   metadata.
 *
 * Pagination pages edge case:
 *   Math.ceil(0 / pageSize) = 0 (correct). Math.ceil(n / 0) = Infinity, which
 *   JSON.stringify coerces to null. The totalPages calculation guards against
 *   a falsy pageSize to produce 0 instead of Infinity.
 */

'use strict';

const express                = require('express');
const rateLimit              = require('express-rate-limit');
const { ValidationError }    = require('../errors');
const config                 = require('../config/env');

// ── Rate limiters ─────────────────────────────────────────────────────────────

/** Applied to all GET endpoints. */
const readLimiter = rateLimit({
  windowMs:        config.rateLimit.read.windowMs,
  max:             config.rateLimit.read.max,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests — please slow down' },
});

/** Applied to all mutation endpoints (POST / PUT / PATCH / DELETE). */
const writeLimiter = rateLimit({
  windowMs:        config.rateLimit.write.windowMs,
  max:             config.rateLimit.write.max,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests — please slow down' },
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Decorate a DTO with HAL-style _links.
 * Object.assign is used instead of spread to prevent DTO fields named '_links'
 * from clobbering the hypermedia metadata.
 *
 * @param {Object} data
 * @param {string} selfHref
 * @param {string} baseHref
 * @returns {Object}
 */
function withLinks(data, selfHref, baseHref) {
  return Object.assign({}, data, {
    _links: {
      self:   { href: selfHref },
      actors: { href: baseHref },
    },
  });
}

/**
 * Parse and validate a positive-integer path parameter.
 *
 * @param {string} raw
 * @returns {number}
 * @throws {ValidationError}
 */
function parseActorId(raw) {
  const id = parseInt(raw, 10);
  if (!Number.isInteger(id) || id <= 0) {
    throw new ValidationError('actorId must be a positive integer', { actorId: 'invalid' });
  }
  return id;
}

/**
 * Parse and validate a pagination query string parameter.
 * Rejects non-numeric values with 400 instead of silently defaulting.
 *
 * @param {string|undefined} raw
 * @param {string}           name         - parameter name (for error messages)
 * @param {number}           defaultValue
 * @returns {number}
 * @throws {ValidationError}
 */
function parsePaginationParam(raw, name, defaultValue) {
  if (raw === undefined || raw === '') return defaultValue;
  const n = parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1) {
    throw new ValidationError(
      `${name} must be a positive integer`,
      { [name]: 'must be a positive integer' },
    );
  }
  return n;
}

/**
 * Validate a full actor body (PUT — both fields required).
 *
 * @param {unknown} body
 * @returns {{ firstName: string, lastName: string }}
 * @throws {ValidationError}
 */
function validateActorBody(body) {
  const raw       = body ?? {};
  const firstName = typeof raw.firstName === 'string' ? raw.firstName.trim() : '';
  const lastName  = typeof raw.lastName  === 'string' ? raw.lastName.trim()  : '';

  const fields = {};

  if (!firstName)                fields.firstName = 'required';
  else if (firstName.length > 45) fields.firstName = 'max 45 characters';

  if (!lastName)                fields.lastName = 'required';
  else if (lastName.length > 45) fields.lastName = 'max 45 characters';

  if (Object.keys(fields).length) {
    throw new ValidationError('Request body validation failed', fields);
  }

  return { firstName, lastName };
}

/**
 * Validate a partial actor body (PATCH — at least one field required).
 *
 * @param {unknown} body
 * @returns {{ firstName?: string, lastName?: string }}
 * @throws {ValidationError}
 */
function validateActorPatch(body) {
  const raw = body ?? {};

  const firstName = typeof raw.firstName === 'string' ? raw.firstName.trim() : undefined;
  const lastName  = typeof raw.lastName  === 'string' ? raw.lastName.trim()  : undefined;

  const fields = {};

  if (firstName !== undefined && firstName.length === 0) fields.firstName = 'must not be blank';
  if (firstName !== undefined && firstName.length > 45)  fields.firstName = 'max 45 characters';
  if (lastName  !== undefined && lastName.length  === 0) fields.lastName  = 'must not be blank';
  if (lastName  !== undefined && lastName.length  > 45)  fields.lastName  = 'max 45 characters';

  if (firstName === undefined && lastName === undefined) {
    throw new ValidationError(
      'PATCH body must include at least one of firstName or lastName',
      { body: 'at least one field required' },
    );
  }

  if (Object.keys(fields).length) {
    throw new ValidationError('Request body validation failed', fields);
  }

  return { firstName, lastName };
}

// ── Router factory ────────────────────────────────────────────────────────────

/**
 * Build and return the actor router, injected with a service instance.
 *
 * @param {import('../services/actor.service')} actorService
 * @returns {import('express').Router}
 */
function createActorRouter(actorService) {
  const router = express.Router();

  // ── GET /api/v1/actors ────────────────────────────────────────────────────
  router.get('/', readLimiter, async (req, res, next) => {
    try {
      const page     = parsePaginationParam(req.query.page,     'page',     1);
      const pageSize = parsePaginationParam(req.query.pageSize, 'pageSize', 20);

      const result   = await actorService.getAllActors({ page, pageSize });
      const baseHref = req.baseUrl;

      /** Guard against falsy pageSize producing Infinity pages. */
      const totalPages = result.pageSize > 0
        ? Math.ceil(result.total / result.pageSize)
        : 0;

      return res.status(200).json({
        _embedded: {
          actors: result.data.map(a =>
            withLinks(a, `${baseHref}/${a.actorId}`, baseHref),
          ),
        },
        _links: {
          self: { href: `${baseHref}?page=${page}&pageSize=${pageSize}` },
          ...(page > 1          ? { prev: { href: `${baseHref}?page=${page - 1}&pageSize=${pageSize}` } } : {}),
          ...(page < totalPages ? { next: { href: `${baseHref}?page=${page + 1}&pageSize=${pageSize}` } } : {}),
        },
        pagination: {
          total:    result.total,
          page:     result.page,
          pageSize: result.pageSize,
          pages:    totalPages,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  // ── GET /api/v1/actors/:actorId ───────────────────────────────────────────
  router.get('/:actorId', readLimiter, async (req, res, next) => {
    try {
      const actorId = parseActorId(req.params.actorId);
      const actor   = await actorService.getActorById(actorId);
      return res.status(200).json(
        withLinks(actor, `${req.baseUrl}/${actorId}`, req.baseUrl),
      );
    } catch (err) {
      next(err);
    }
  });

  // ── POST /api/v1/actors ───────────────────────────────────────────────────
  router.post('/', writeLimiter, async (req, res, next) => {
    try {
      const body     = validateActorBody(req.body);
      const actor    = await actorService.createActor(body);
      const selfHref = `${req.baseUrl}/${actor.actorId}`;
      return res.status(201).location(selfHref).json(
        withLinks(actor, selfHref, req.baseUrl),
      );
    } catch (err) {
      next(err);
    }
  });

  // ── PUT /api/v1/actors/:actorId ───────────────────────────────────────────
  router.put('/:actorId', writeLimiter, async (req, res, next) => {
    try {
      const actorId = parseActorId(req.params.actorId);
      const body    = validateActorBody(req.body);
      const actor   = await actorService.updateActor(actorId, body);
      return res.status(200).json(
        withLinks(actor, `${req.baseUrl}/${actorId}`, req.baseUrl),
      );
    } catch (err) {
      next(err);
    }
  });

  // ── PATCH /api/v1/actors/:actorId ─────────────────────────────────────────
  router.patch('/:actorId', writeLimiter, async (req, res, next) => {
    try {
      const actorId = parseActorId(req.params.actorId);
      const patch   = validateActorPatch(req.body);

      /** Fetch current state, merge supplied fields, then perform full update. */
      const current = await actorService.getActorById(actorId);
      const merged  = {
        firstName: patch.firstName !== undefined ? patch.firstName : current.firstName,
        lastName:  patch.lastName  !== undefined ? patch.lastName  : current.lastName,
      };

      const actor = await actorService.updateActor(actorId, merged);
      return res.status(200).json(
        withLinks(actor, `${req.baseUrl}/${actorId}`, req.baseUrl),
      );
    } catch (err) {
      next(err);
    }
  });

  // ── DELETE /api/v1/actors/:actorId ────────────────────────────────────────
  router.delete('/:actorId', writeLimiter, async (req, res, next) => {
    try {
      const actorId = parseActorId(req.params.actorId);
      await actorService.deleteActor(actorId);
      return res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createActorRouter };
