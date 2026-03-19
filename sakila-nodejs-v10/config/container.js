/**
 * @fileoverview Dependency Injection container
 *
 * Wires the application's object graph and exposes a single factory per
 * domain aggregate. All dependencies are constructed lazily on first use so
 * that module load (e.g. in tests) does not trigger database I/O.
 *
 * Dependency graph for the actor domain:
 *   getSequelize()          ← lazy DB singleton (config/database)
 *     └─ defineActorModel() ← idempotent: reuses 'Actor' if already registered
 *           └─ ActorRepository
 *                 └─ ActorService(repository, sequelize)
 *
 * The sequelize instance is passed to ActorService so service methods can
 * wrap write operations in managed transactions without importing the DB
 * module directly (keeps the service layer testable with a mock).
 *
 * resetContainer() nulls all singletons for test isolation. Call it in
 * afterEach / afterAll hooks that reset the database module mock.
 */

'use strict';

const { getSequelize }                      = require('./database');
const { defineActorModel, ActorRepository } = require('../repositories/actor.repository');
const ActorService                          = require('../services/actor.service');

let _actorService = null;

/**
 * Return (or build) the ActorService singleton with all dependencies wired.
 * @returns {ActorService}
 */
function getActorService() {
  if (_actorService) return _actorService;

  const sequelize = getSequelize();

  const ActorModel = sequelize.isDefined('Actor')
    ? sequelize.model('Actor')
    : defineActorModel(sequelize);

  const actorRepository = new ActorRepository(ActorModel);
  _actorService         = new ActorService(actorRepository, sequelize);

  return _actorService;
}

/**
 * Reset all singletons — call in test afterEach / afterAll.
 */
function resetContainer() {
  _actorService = null;
}

module.exports = {
  getActorService,
  resetContainer,
  /** Sequelize instance — server bootstrap and integration tests only. */
  get sequelize() { return getSequelize(); },
};
