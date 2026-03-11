/**
 * @fileoverview Unit tests — ActorRepository  (v6)
 *
 * NEW tests for v6 fixes:
 *   - FIX B1: findByFilmTitle uses a single subquery (not nested include)
 *   - FIX B2: findAll clamps limit to [1, MAX_PAGE_SIZE=200]
 *   - General: limit=0 is coerced to 1; negative offset is coerced to 0
 *
 * Carries forward all v5 tests.
 */

'use strict';

const { ActorRepository } = require('../repositories/actor.repository');

const makeMockModel = (overrides = {}) => ({
  findAll:         jest.fn(),
  findAndCountAll: jest.fn(),
  findByPk:        jest.fn(),
  findOne:         jest.fn(),
  create:          jest.fn(),
  update:          jest.fn(),
  destroy:         jest.fn(),
  ...overrides,
});

const fakeRow = (data = {}) => ({
  get: jest.fn(() => ({
    actor_id:    data.actor_id   ?? 1,
    first_name:  data.first_name ?? 'PENELOPE',
    last_name:   data.last_name  ?? 'GUINESS',
    last_update: new Date(),
  })),
  ...data,
});

describe('ActorRepository', () => {

  describe('constructor', () => {
    it('throws TypeError when ActorModel is not provided', () => {
      expect(() => new ActorRepository()).toThrow(TypeError);
    });
  });

  describe('findAll()', () => {
    it('calls findAndCountAll with correct limit and offset', async () => {
      const model = makeMockModel({
        findAndCountAll: jest.fn().mockResolvedValue({ rows: [], count: 0 }),
      });
      const repo = new ActorRepository(model);
      await repo.findAll({ limit: 10, offset: 20 });
      expect(model.findAndCountAll).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 10, offset: 20 }),
      );
    });

    it('uses default limit=50 and offset=0 when called with no args', async () => {
      const model = makeMockModel({
        findAndCountAll: jest.fn().mockResolvedValue({ rows: [], count: 0 }),
      });
      const repo = new ActorRepository(model);
      await repo.findAll();
      expect(model.findAndCountAll).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 50, offset: 0 }),
      );
    });

    // FIX B2: limit clamping
    it('clamps limit=0 to 1 (FIX B2)', async () => {
      const model = makeMockModel({
        findAndCountAll: jest.fn().mockResolvedValue({ rows: [], count: 0 }),
      });
      const repo = new ActorRepository(model);
      await repo.findAll({ limit: 0 });
      const called = model.findAndCountAll.mock.calls[0][0];
      expect(called.limit).toBe(1);
    });

    it('clamps limit=1000 to MAX_PAGE_SIZE=200 (FIX B2)', async () => {
      const model = makeMockModel({
        findAndCountAll: jest.fn().mockResolvedValue({ rows: [], count: 0 }),
      });
      const repo = new ActorRepository(model);
      await repo.findAll({ limit: 1000 });
      const called = model.findAndCountAll.mock.calls[0][0];
      expect(called.limit).toBe(200);
    });

    it('clamps negative offset to 0', async () => {
      const model = makeMockModel({
        findAndCountAll: jest.fn().mockResolvedValue({ rows: [], count: 0 }),
      });
      const repo = new ActorRepository(model);
      await repo.findAll({ limit: 10, offset: -5 });
      const called = model.findAndCountAll.mock.calls[0][0];
      expect(called.offset).toBe(0);
    });
  });

  describe('update() — typed UpdateResult', () => {
    it('returns { found: true, actor } when row is updated', async () => {
      const row   = fakeRow();
      const model = makeMockModel({
        update:   jest.fn().mockResolvedValue([1]),
        findByPk: jest.fn().mockResolvedValue(row),
      });
      const repo   = new ActorRepository(model);
      const result = await repo.update(1, { firstName: 'NICK', lastName: 'W' });
      expect(result).toEqual({ found: true, actor: row });
    });

    it('returns { found: false, actor: null } when 0 rows affected', async () => {
      const model = makeMockModel({
        update: jest.fn().mockResolvedValue([0]),
      });
      const repo   = new ActorRepository(model);
      const result = await repo.update(999, { firstName: 'X', lastName: 'Y' });
      expect(result).toEqual({ found: false, actor: null });
    });
  });

  describe('deleteById()', () => {
    it('returns true when the row is deleted', async () => {
      const model = makeMockModel({ destroy: jest.fn().mockResolvedValue(1) });
      expect(await new ActorRepository(model).deleteById(1)).toBe(true);
    });

    it('returns false when the row does not exist', async () => {
      const model = makeMockModel({ destroy: jest.fn().mockResolvedValue(0) });
      expect(await new ActorRepository(model).deleteById(999)).toBe(false);
    });
  });

  describe('findByFirstNameStartingWith() — LIKE query fix + escaping', () => {
    it('calls findAll with a Sequelize where clause (not a bare array)', async () => {
      const model = makeMockModel({ findAll: jest.fn().mockResolvedValue([]) });
      const repo  = new ActorRepository(model);
      await repo.findByFirstNameStartingWith('PEN');
      expect(model.findAll).toHaveBeenCalled();
      const callArg = model.findAll.mock.calls[0][0];
      expect(callArg.where).toBeDefined();
      expect(Array.isArray(callArg.where)).toBe(false);
    });

    it('escapes SQL LIKE wildcards in the prefix', async () => {
      const model = makeMockModel({ findAll: jest.fn().mockResolvedValue([]) });
      const repo  = new ActorRepository(model);
      await repo.findByFirstNameStartingWith('PEN%');
      expect(model.findAll).toHaveBeenCalled();
      const callArg = JSON.stringify(model.findAll.mock.calls[0][0]);
      expect(callArg).toContain('PEN\\\\%');
    });

    it('handles empty prefix without throwing', async () => {
      const model = makeMockModel({ findAll: jest.fn().mockResolvedValue([]) });
      const repo  = new ActorRepository(model);
      await expect(repo.findByFirstNameStartingWith('')).resolves.toEqual([]);
    });
  });

  describe('findByFilmTitle()', () => {
    it('throws when Film/FilmActor models were not injected', async () => {
      const model = makeMockModel();
      const repo  = new ActorRepository(model);
      await expect(repo.findByFilmTitle('ACADEMY DINOSAUR')).rejects.toThrow();
    });

    // FIX B1: subquery approach calls Actor.findAll — not a nested include chain
    it('calls Actor.findAll (single-query subquery) when Film/FilmActor are injected (FIX B1)', async () => {
      const actorModel = makeMockModel({ findAll: jest.fn().mockResolvedValue([]) });
      // Minimal Film/FilmActor stubs with getTableName() and escape()
      const filmModel      = { getTableName: () => 'film' };
      const filmActorModel = { getTableName: () => 'film_actor' };
      // Attach a mock sequelize.escape to the actor model's sequelize property
      actorModel.sequelize = { escape: jest.fn(v => `'${v}'`) };

      const repo = new ActorRepository(actorModel, filmModel, filmActorModel);
      await repo.findByFilmTitle('ACADEMY DINOSAUR');

      expect(actorModel.findAll).toHaveBeenCalledTimes(1);
      const callArg = actorModel.findAll.mock.calls[0][0];
      // The where clause must use Op.in with a literal subquery string
      expect(callArg.where).toBeDefined();
      expect(JSON.stringify(callArg.where)).toContain('film_actor');
    });
  });

});
