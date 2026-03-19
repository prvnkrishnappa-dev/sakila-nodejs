/**
 * @fileoverview ActorRepository — Sequelize data access layer
 *
 * Encapsulates all SQL for the actor domain. No business logic lives here;
 * the repository is a pure data-access object that translates domain intents
 * into Sequelize calls and returns Sequelize Model instances to the service.
 *
 * Key design decisions:
 *
 *   Model definition (defineActorModel):
 *     Registered under the name 'Actor' on the Sequelize instance. The
 *     container checks sequelize.isDefined('Actor') before calling this to
 *     keep model registration idempotent across multiple container resets
 *     in test environments.
 *
 *   LIKE query safety (escapeLike):
 *     SQL LIKE wildcards (%, _, \) in user-supplied strings are escaped before
 *     interpolation. Combined with fn('UPPER', ...) / Op.like, this produces
 *     case-insensitive, injection-safe prefix searches without requiring
 *     full-text indexes.
 *
 *   Pagination guard (findAll):
 *     limit is clamped to [1, MAX_PAGE_SIZE] to prevent zero-row queries
 *     (bug at call site) and full-table scans (malicious or accidental large
 *     page size). The service applies its own separate clamp; two independent
 *     layers are intentional.
 *
 *   Film title search (findByFilmTitle):
 *     Uses a single subquery (literal IN) instead of a nested include chain.
 *     The include approach issues one query per actor row returned (N+1); the
 *     subquery approach is always exactly one SQL round-trip regardless of
 *     result set size. Film and FilmActor models must be injected; an error
 *     is thrown if they are absent to make the dependency explicit.
 *
 *   Update result (UpdateResult):
 *     Repository returns { found, actor } to let the service distinguish
 *     "not found" (404) from successful update without catching an exception.
 */

'use strict';

const { DataTypes, Model, Op, where, fn, col, literal } = require('sequelize');

/** Hard ceiling on rows returned per findAll call. */
const MAX_PAGE_SIZE = 200;

// ── Model factory ─────────────────────────────────────────────────────────────

/**
 * Define and register the Sequelize Actor model on the given instance.
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
 * Escape SQL LIKE wildcard characters (%, _, \) to prevent wildcard injection.
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
   * @param {typeof Model} [FilmModel]      - required for findByFilmTitle
   * @param {typeof Model} [FilmActorModel] - required for findByFilmTitle
   */
  constructor(ActorModel, FilmModel = null, FilmActorModel = null) {
    if (!ActorModel) throw new TypeError('ActorRepository: ActorModel is required');
    /** @private */ this.Actor     = ActorModel;
    /** @private */ this.Film      = FilmModel;
    /** @private */ this.FilmActor = FilmActorModel;
  }

  // ── Read ──────────────────────────────────────────────────────────────────

  /**
   * Paginated actor list ordered by last_name, first_name.
   * limit is clamped to [1, MAX_PAGE_SIZE] as a secondary defence against
   * bad call-site arithmetic (the service layer applies its own clamp).
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
   * Case-insensitive prefix search on first_name.
   * UPPER() + Op.like avoids full-text indexes while remaining MySQL-safe.
   *
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
   * Case-insensitive prefix search on last_name.
   *
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
   * A literal IN subquery is used rather than a nested Sequelize include chain
   * to guarantee exactly ONE SQL round-trip regardless of result set size.
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
   * @throws {Error} if Film / FilmActor models were not injected
   */
  async findByFilmTitle(title) {
    if (!this.Film || !this.FilmActor) {
      throw new Error('findByFilmTitle requires Film and FilmActor models');
    }

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
   * Full update of firstName and lastName.
   * Returns { found: false } without throwing when the row does not exist,
   * allowing the service to issue a typed NotFoundError.
   *
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
   * @returns {Promise<boolean>} true if a row was deleted
   */
  async deleteById(actorId, transaction) {
    const count = await this.Actor.destroy({ where: { actor_id: actorId }, transaction });
    return count > 0;
  }
}

module.exports = { defineActorModel, ActorRepository };
