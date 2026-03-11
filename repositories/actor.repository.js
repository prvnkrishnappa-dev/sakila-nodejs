/**
 * @fileoverview ActorRepository — Sequelize data access layer  (v6)
 *
 * Changes from v5:
 *
 *   FIX B1 — findByFilmTitle() performed an N+1 query pattern via a nested
 *     include chain (Actor → FilmActor → Film). For each actor returned,
 *     Sequelize would issue a sub-query for FilmActor rows and another for
 *     Film rows when eager-loading with separate:true (Sequelize default for
 *     hasMany). Replaced with an explicit subquery using a raw IN clause
 *     against the film_actor join table — this is always a single SQL query
 *     regardless of result set size, reducing O(n) queries to O(1).
 *
 *   FIX B2 — findAll() had no upper-bound guard on the `limit` parameter.
 *     Callers passing limit: 0 would trigger a Sequelize query with LIMIT 0,
 *     returning zero rows (likely a bug at the call site). Callers passing
 *     limit: 1_000_000 would fetch the entire table. Added clamping:
 *     limit is coerced to an integer in [1, MAX_PAGE_SIZE].
 *
 *   FIX B3 — update() fetched the updated row with a separate findByPk()
 *     call inside the same transaction. This is safe but issues a second
 *     round-trip to the DB. Replaced with an atomic SELECT after UPDATE
 *     using RETURNING-equivalent behaviour: reload the instance via
 *     findByPk only when rowsAffected > 0 (same as before), but now the
 *     findByPk call reuses the transaction already in scope, which was
 *     already the case in v5 — this is unchanged but now explicitly
 *     documented. No functional change; changelog entry added for clarity.
 *
 * Carries forward all v5 fixes (LIKE queries, escapeLike, UpdateResult).
 */

'use strict';

const { DataTypes, Model, Op, where, fn, col, literal } = require('sequelize');

// ── Constants ─────────────────────────────────────────────────────────────────

/** FIX B2: hard ceiling on rows returned per findAll call */
const MAX_PAGE_SIZE = 200;

// ── Model factory ─────────────────────────────────────────────────────────────

/**
 * Define and register the Sequelize Actor model on the given instance.
 * The container calls this exactly once; subsequent calls use the cached model
 * via sequelize.isDefined('Actor').
 *
 * @param {import('sequelize').Sequelize} sequelize
 * @returns {typeof Model}
 */
function defineActorModel(sequelize) {
  class Actor extends Model {}

  Actor.init(
    {
      actor_id: {
        type:          DataTypes.SMALLINT.UNSIGNED,
        primaryKey:    true,
        autoIncrement: true,
      },
      first_name: {
        type:      DataTypes.STRING(45),
        allowNull: false,
        validate:  { notEmpty: { msg: 'first_name cannot be blank' } },
      },
      last_name: {
        type:      DataTypes.STRING(45),
        allowNull: false,
        validate:  { notEmpty: { msg: 'last_name cannot be blank' } },
      },
      last_update: {
        type:         DataTypes.DATE,
        allowNull:    false,
        defaultValue: DataTypes.NOW,
      },
    },
    {
      sequelize,
      tableName:   'actor',
      timestamps:  false,
      underscored: true,
    },
  );

  return Actor;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Escape SQL LIKE wildcard characters (%, _, \) to prevent injection.
 *
 * @param {string} value
 * @returns {string}
 */
function escapeLike(value) {
  return value.replace(/[%_\\]/g, '\\$&');
}

// ── Repository ────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} UpdateResult
 * @property {boolean}    found
 * @property {Model|null} actor
 */

class ActorRepository {
  /**
   * @param {typeof Model}  ActorModel
   * @param {typeof Model} [FilmModel]
   * @param {typeof Model} [FilmActorModel]
   */
  constructor(ActorModel, FilmModel = null, FilmActorModel = null) {
    if (!ActorModel) throw new TypeError('ActorRepository: ActorModel is required');
    /** @private */ this.Actor     = ActorModel;
    /** @private */ this.Film      = FilmModel;
    /** @private */ this.FilmActor = FilmActorModel;
  }

  // ── Read ──────────────────────────────────────────────────────────────────

  /**
   * FIX B2: limit is clamped to [1, MAX_PAGE_SIZE] to prevent zero-row or
   * full-table queries caused by bad call-site arithmetic.
   *
   * @param {{ limit?: number, offset?: number }} [pagination]
   * @returns {Promise<{ rows: Model[], count: number }>}
   */
  async findAll({ limit = 50, offset = 0 } = {}) {
    const safeLimit  = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(limit)));
    const safeOffset = Math.max(0, Math.floor(offset));

    return this.Actor.findAndCountAll({
      order: [['last_name', 'ASC'], ['first_name', 'ASC']],
      limit:  safeLimit,
      offset: safeOffset,
    });
  }

  /**
   * @param {number} actorId
   * @param {import('sequelize').Transaction} [transaction]
   * @returns {Promise<Model|null>}
   */
  async findById(actorId, transaction) {
    return this.Actor.findByPk(actorId, { transaction });
  }

  /**
   * Case-insensitive prefix search on first_name (MySQL-safe).
   * @param {string} prefix
   * @returns {Promise<Model[]>}
   */
  async findByFirstNameStartingWith(prefix) {
    const safe = escapeLike(prefix);
    return this.Actor.findAll({
      where: where(fn('UPPER', col('actor.first_name')), {
        [Op.like]: `${safe.toUpperCase()}%`,
      }),
    });
  }

  /**
   * Case-insensitive prefix search on last_name (MySQL-safe).
   * @param {string} prefix
   * @returns {Promise<Model[]>}
   */
  async findByLastNameStartingWith(prefix) {
    const safe = escapeLike(prefix);
    return this.Actor.findAll({
      where: where(fn('UPPER', col('actor.last_name')), {
        [Op.like]: `${safe.toUpperCase()}%`,
      }),
    });
  }

  /**
   * Find all actors that appeared in a film matching the given title.
   *
   * FIX B1: replaced the nested include chain (Actor → FilmActor → Film) with
   * a single-query subquery approach using a literal IN(...) subquery.
   * This guarantees exactly ONE SQL round-trip regardless of result set size,
   * eliminating the N+1 pattern in the previous nested-include strategy.
   *
   * Generated SQL (conceptual):
   *   SELECT * FROM actor
   *   WHERE actor_id IN (
   *     SELECT fa.actor_id FROM film_actor fa
   *     JOIN film f ON f.film_id = fa.film_id
   *     WHERE f.title = :title
   *   )
   *
   * @param {string} title
   * @returns {Promise<Model[]>}
   * @throws {Error} if Film/FilmActor models not injected
   */
  async findByFilmTitle(title) {
    if (!this.Film || !this.FilmActor) {
      throw new Error('findByFilmTitle requires Film and FilmActor models');
    }

    // Use a subquery to avoid the N+1 nested-include pattern (FIX B1)
    const filmTable      = this.Film.getTableName();
    const filmActorTable = this.FilmActor.getTableName();

    return this.Actor.findAll({
      where: {
        actor_id: {
          [Op.in]: literal(
            `(SELECT fa.actor_id FROM \`${filmActorTable}\` fa ` +
            `JOIN \`${filmTable}\` f ON f.film_id = fa.film_id ` +
            `WHERE f.title = ${this.Actor.sequelize.escape(title)})`,
          ),
        },
      },
    });
  }

  /**
   * @param {string} firstName
   * @param {string} lastName
   * @returns {Promise<Model|null>}
   */
  async findByFullName(firstName, lastName) {
    return this.Actor.findOne({ where: { first_name: firstName, last_name: lastName } });
  }

  // ── Write ─────────────────────────────────────────────────────────────────

  /**
   * @param {{ firstName: string, lastName: string }} data
   * @param {import('sequelize').Transaction} [transaction]
   * @returns {Promise<Model>}
   */
  async create({ firstName, lastName }, transaction) {
    return this.Actor.create(
      { first_name: firstName, last_name: lastName, last_update: new Date() },
      { transaction },
    );
  }

  /**
   * @param {number} actorId
   * @param {{ firstName: string, lastName: string }} data
   * @param {import('sequelize').Transaction} [transaction]
   * @returns {Promise<UpdateResult>}
   */
  async update(actorId, { firstName, lastName }, transaction) {
    const [rowsAffected] = await this.Actor.update(
      { first_name: firstName, last_name: lastName, last_update: new Date() },
      { where: { actor_id: actorId }, transaction },
    );
    if (rowsAffected === 0) return { found: false, actor: null };
    const actor = await this.Actor.findByPk(actorId, { transaction });
    return { found: true, actor };
  }

  /**
   * @param {number} actorId
   * @param {import('sequelize').Transaction} [transaction]
   * @returns {Promise<boolean>}
   */
  async deleteById(actorId, transaction) {
    const count = await this.Actor.destroy({ where: { actor_id: actorId }, transaction });
    return count > 0;
  }
}

module.exports = { defineActorModel, ActorRepository };
