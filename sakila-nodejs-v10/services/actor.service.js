/**
 * @fileoverview ActorService — business logic layer
 *
 * Orchestrates actor operations: validates inputs at the service boundary,
 * delegates persistence to ActorRepository, wraps mutations in database
 * transactions, and converts Sequelize Model instances to plain ActorDTOs.
 *
 * Design decisions:
 *
 *   Boundary validation (_assertActorId):
 *     actorId is validated independently of the router. The router already
 *     parses and validates it, but direct callers (other services, CLI tools,
 *     integration tests) may bypass the router. Validating here makes the
 *     service self-contained and its API contract explicit.
 *
 *   NaN pagination guard (getAllActors):
 *     Math.max(1, Math.floor(NaN)) evaluates to NaN, which Sequelize silently
 *     coerces to 0. Explicit isNaN guards replace NaN inputs with defaults
 *     before the clamping arithmetic so the behaviour is deterministic.
 *
 *   Transaction wrapping:
 *     All write operations (create, update, delete) run inside managed
 *     transactions. Sequelize managed transactions auto-commit on return and
 *     auto-rollback on throw, so the service never calls commit/rollback
 *     explicitly — error handling is transparent.
 *
 *   DTO projection (_toDTO):
 *     get({ plain: true }) extracts a plain JavaScript object from the
 *     Sequelize Model instance, shedding proxy overhead and preventing
 *     accidental mutation of the underlying model state. Column names
 *     (snake_case) are remapped to camelCase for the API contract.
 */

'use strict';

const { NotFoundError } = require('../errors');

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
   * Paginated actor list.
   * Page and pageSize are clamped to valid ranges after NaN-guarding.
   *
   * @param {PaginationParams} [pagination]
   * @returns {Promise<{ data: ActorDTO[], total: number, page: number, pageSize: number }>}
   */
  async getAllActors({ page = 1, pageSize = 20 } = {}) {
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
   * @param {number} actorId
   * @returns {Promise<ActorDTO>}
   * @throws {TypeError}     if actorId is not a positive integer
   * @throws {NotFoundError} if actor does not exist
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
   * Full replacement update. PATCH semantics (merge) are handled in the router
   * by fetching current state and merging before calling this method.
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
   * Validates the service boundary independently of the router.
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
   * Project a Sequelize Model to a plain ActorDTO.
   * get({ plain: true }) strips the proxy and returns raw column values.
   *
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
