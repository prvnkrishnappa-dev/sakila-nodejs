/**
 * @fileoverview ActorService — business logic layer  (v6)
 *
 * Changes from v5:
 *
 *   FIX SV1 — actorId parameters were accepted as-is without integer coercion
 *     in getActorById, updateActor, and deleteActor. The router validates and
 *     parses them before calling the service, but the service had no
 *     independent guard. A direct (non-router) caller — another service,
 *     an integration test, a future CLI — could pass a float (1.7) or a
 *     numeric string ('1'). Added Number.isInteger() guards with TypeError
 *     to make the service boundary explicit.
 *
 *   FIX SV2 — getAllActors({ page: NaN, pageSize: NaN }) was handled by the
 *     Math.max(1, Math.floor(NaN)) chain, which returns NaN because
 *     Math.floor(NaN) === NaN and Math.max(1, NaN) === NaN. The offset
 *     calculation then produced NaN, which Sequelize silently coerced to 0.
 *     Added explicit isNaN guards that fall back to the defaults before the
 *     Math.max/min clamps.
 *
 * Carries forward all v5 fixes (constructor validation, transaction wrapping,
 * UpdateResult reading, pagination envelope, _toDTO with plain:true).
 */

'use strict';

const NotFoundError = require('../errors/not-found.error');

/**
 * @typedef {Object} PaginationParams
 * @property {number} [page=1]
 * @property {number} [pageSize=20]
 */

/**
 * @typedef {Object} ActorDTO
 * @property {number} actorId
 * @property {string} firstName
 * @property {string} lastName
 * @property {Date}   lastUpdate
 */

class ActorService {
  /**
   * @param {import('../repositories/actor.repository').ActorRepository} actorRepository
   * @param {import('sequelize').Sequelize} sequelize
   */
  constructor(actorRepository, sequelize) {
    if (!actorRepository) throw new TypeError('ActorService: actorRepository is required');
    if (!sequelize)       throw new TypeError('ActorService: sequelize is required');
    /** @private */ this.repo      = actorRepository;
    /** @private */ this.sequelize = sequelize;
  }

  /**
   * FIX SV2: NaN inputs are replaced with defaults before clamping.
   *
   * @param {PaginationParams} [pagination]
   * @returns {Promise<{ data: ActorDTO[], total: number, page: number, pageSize: number }>}
   */
  async getAllActors({ page = 1, pageSize = 20 } = {}) {
    // FIX SV2: explicit NaN guard before arithmetic
    const rawPage     = isNaN(page)     ? 1  : page;
    const rawPageSize = isNaN(pageSize) ? 20 : pageSize;

    const safePage     = Math.max(1, Math.floor(rawPage));
    const safePageSize = Math.min(100, Math.max(1, Math.floor(rawPageSize)));
    const offset       = (safePage - 1) * safePageSize;

    const { rows, count } = await this.repo.findAll({ limit: safePageSize, offset });

    return {
      data:     rows.map(a => this._toDTO(a)),
      total:    count,
      page:     safePage,
      pageSize: safePageSize,
    };
  }

  /**
   * FIX SV1: actorId must be a positive integer.
   *
   * @param {number} actorId
   * @returns {Promise<ActorDTO>}
   * @throws {TypeError}      if actorId is not a positive integer
   * @throws {NotFoundError}  if actor does not exist
   */
  async getActorById(actorId) {
    this._assertActorId(actorId);
    const actor = await this.repo.findById(actorId);
    if (!actor) throw new NotFoundError(`Actor not found: ${actorId}`);
    return this._toDTO(actor);
  }

  /**
   * @param {{ firstName: string, lastName: string }} request
   * @returns {Promise<ActorDTO>}
   */
  async createActor({ firstName, lastName }) {
    return this.sequelize.transaction(async (t) => {
      const actor = await this.repo.create({ firstName, lastName }, t);
      return this._toDTO(actor);
    });
  }

  /**
   * FIX SV1: actorId must be a positive integer.
   *
   * @param {number} actorId
   * @param {{ firstName: string, lastName: string }} request
   * @returns {Promise<ActorDTO>}
   * @throws {TypeError}     if actorId is not a positive integer
   * @throws {NotFoundError} if actor does not exist
   */
  async updateActor(actorId, { firstName, lastName }) {
    this._assertActorId(actorId);
    return this.sequelize.transaction(async (t) => {
      const { found, actor } = await this.repo.update(actorId, { firstName, lastName }, t);
      if (!found) throw new NotFoundError(`Actor not found: ${actorId}`);
      return this._toDTO(actor);
    });
  }

  /**
   * FIX SV1: actorId must be a positive integer.
   *
   * @param {number} actorId
   * @returns {Promise<void>}
   * @throws {TypeError}     if actorId is not a positive integer
   * @throws {NotFoundError} if actor does not exist
   */
  async deleteActor(actorId) {
    this._assertActorId(actorId);
    return this.sequelize.transaction(async (t) => {
      const actor = await this.repo.findById(actorId, t);
      if (!actor) throw new NotFoundError(`Actor not found: ${actorId}`);
      await this.repo.deleteById(actorId, t);
    });
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /**
   * Assert that actorId is a positive integer.
   * FIX SV1: guards the service boundary independently of the router.
   *
   * @private
   * @param {number} actorId
   * @throws {TypeError}
   */
  _assertActorId(actorId) {
    if (!Number.isInteger(actorId) || actorId <= 0) {
      throw new TypeError(`actorId must be a positive integer, got: ${actorId}`);
    }
  }

  /**
   * @private
   * @param {import('sequelize').Model} actor
   * @returns {ActorDTO}
   */
  _toDTO(actor) {
    const d = actor.get({ plain: true });
    return {
      actorId:    d.actor_id,
      firstName:  d.first_name,
      lastName:   d.last_name,
      lastUpdate: d.last_update,
    };
  }
}

module.exports = ActorService;
