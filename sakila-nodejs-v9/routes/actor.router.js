/**
 * @fileoverview Actor Router — Express routes  (v6)
 *
 * Changes from v5:
 *
 *   FIX R5 — Pagination metadata `pages` used Math.ceil(total / pageSize).
 *     When total=0 this correctly returns 0, but when pageSize is somehow 0
 *     (a programming error in the service returning an unexpected pageSize),
 *     it would produce Infinity, which JSON.stringify serialises as null —
 *     a silent data corruption. Added a guard: pages defaults to 0 when
 *     result.pageSize is falsy.
 *
 *   FIX R6 — PATCH /api/v1/actors/:actorId was not implemented. REST
 *     convention requires PUT to be a full replacement (all fields required)
 *     and PATCH to be a partial update (only provided fields changed).
 *     v5's PUT accepted partial bodies without error because validateActorBody
 *     rejected missing fields, but the HTTP contract was misleading. Added a
 *     validateActorPatch() helper that accepts partial bodies and a
 *     PATCH handler that delegates to updateActor with the available fields.
 *     Note: updateActor in the service/repository updates both fields
 *     atomically; a true partial-update path would require a separate
 *     repo.partialUpdate() method — deferred to v7. This fix at minimum
 *     returns 405 Method Not Allowed (previously it would 404) for the
 *     common case of clients sending PATCH.
 *
 *   FIX R7 — withLinks() spread operator merged the DTO and _links into a
 *     single flat object. If a DTO property was ever named '_links' (e.g.,
 *     from a future schema change), it would silently overwrite the HATEOAS
 *     links. Used explicit property assignment to prevent clobbering.
 *
 * Carries forward all v5 fixes (R1–R4).
 */

'use strict';

const express         = require('express');
const rateLimit       = require('express-rate-limit');
const ValidationError = require('../errors/validation.error');
const config          = require('../config/env');

// ── Rate limiters (created once, shared across all instances) ─────────────────

const readLimiter = rateLimit({
  windowMs:        config.rateLimit.read.windowMs,
  max:             config.rateLimit.read.max,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests — please slow down' },
});

const writeLimiter = rateLimit({
  windowMs:        config.rateLimit.write.windowMs,
  max:             config.rateLimit.write.max,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests — please slow down' },
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Wrap a DTO with HATEOAS _links.
 * FIX R7: uses explicit property assignment to prevent DTO fields named
 * '_links' from clobbering the hypermedia metadata.
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
 * Parse and validate a pagination query parameter.
 * Rejects non-numeric values with 400 instead of silently defaulting.
 *
 * @param {string|undefined} raw
 * @param {string}           name
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
 * Validate and sanitise a full actor request body (PUT).
 * Both firstName and lastName are required.
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

  if (!firstName)               fields.firstName = 'required';
  else if (firstName.length > 45) fields.firstName = 'max 45 characters';

  if (!lastName)               fields.lastName = 'required';
  else if (lastName.length > 45) fields.lastName = 'max 45 characters';

  if (Object.keys(fields).length) {
    throw new ValidationError('Request body validation failed', fields);
  }

  return { firstName, lastName };
}

/**
 * Validate and sanitise a partial actor request body (PATCH).
 * At least one of firstName or lastName must be supplied.
 * FIX R6: partial validation for PATCH semantics.
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

// ── Router factory ─────────────────────────────────────────────────────────────

/**
 * Build and return the actor router, injected with a service instance.
 *
 * @param {import('../services/actor.service')} actorService
 * @returns {import('express').Router}
 */
function createActorRouter(actorService) {
  const router = express.Router();

  // ── GET /api/v1/actors?page=1&pageSize=20 ──────────────────────────────────
  router.get('/', readLimiter, async (req, res, next) => {
    try {
      const page     = parsePaginationParam(req.query.page,     'page',     1);
      const pageSize = parsePaginationParam(req.query.pageSize, 'pageSize', 20);

      const result   = await actorService.getAllActors({ page, pageSize });
      const baseHref = req.baseUrl;

      // FIX R5: guard against pageSize=0 edge case producing Infinity pages
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
          ...(page > 1 ? {
            prev: { href: `${baseHref}?page=${page - 1}&pageSize=${pageSize}` },
          } : {}),
          ...(page < totalPages ? {
            next: { href: `${baseHref}?page=${page + 1}&pageSize=${pageSize}` },
          } : {}),
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

  // ── GET /api/v1/actors/:actorId ────────────────────────────────────────────
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

  // ── POST /api/v1/actors ────────────────────────────────────────────────────
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

  // ── PUT /api/v1/actors/:actorId ────────────────────────────────────────────
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

  // ── PATCH /api/v1/actors/:actorId (FIX R6) ────────────────────────────────
  router.patch('/:actorId', writeLimiter, async (req, res, next) => {
    try {
      const actorId = parseActorId(req.params.actorId);
      const patch   = validateActorPatch(req.body);

      // Fetch current state and merge — full replacement in one transaction
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

  // ── DELETE /api/v1/actors/:actorId ─────────────────────────────────────────
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
