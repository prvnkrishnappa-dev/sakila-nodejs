/**
 * @fileoverview Dependency Injection container  (v6)
 *
 * No logic changes from v5. All prior fixes carried forward:
 *   - FIX A5: isDefined('Actor') for idempotent model registration
 *   - Lazy singleton for ActorService
 *   - sequelize passed as second arg to ActorService
 *   - resetContainer() for test isolation
 */

'use strict';

const { getSequelize }                      = require('./database');
const { defineActorModel, ActorRepository } = require('../repositories/actor.repository');
const ActorService                          = require('../services/actor.service');

let _actorService = null;

/**
 * Return (or build) the ActorService singleton with all dependencies wired.
 *
 * Dependency graph:
 *   getSequelize()                 ← lazy DB singleton
 *     └─ defineActorModel()        ← idempotent: reuses existing if already registered
 *           └─ ActorRepository
 *                 └─ ActorService(repository, sequelize)
 *
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
 * Reset all singletons — call in test afterEach/afterAll.
 */
function resetContainer() {
  _actorService = null;
}

module.exports = {
  getActorService,
  resetContainer,
  /** Sequelize instance — server bootstrap and integration tests only */
  get sequelize() { return getSequelize(); },
};
