/**
 * @fileoverview Unit tests — ActorRepository  (v10)
 *
 * Tests for repository-layer behaviour:
 *   - Constructor guard (ActorModel required)
 *   - findAll: default args, limit clamping [1, 200], offset floor
 *   - update: typed UpdateResult ({ found, actor })
 *   - deleteById: boolean return
 *   - findByFirstNameStartingWith: Sequelize where shape, LIKE escaping
 *   - findByFilmTitle: single-query subquery path, error when models absent
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

    it('clamps limit=0 to 1', async () => {
      const model = makeMockModel({
        findAndCountAll: jest.fn().mockResolvedValue({ rows: [], count: 0 }),
      });
      await new ActorRepository(model).findAll({ limit: 0 });
      expect(model.findAndCountAll.mock.calls[0][0].limit).toBe(1);
    });

    it('clamps limit=1000 to MAX_PAGE_SIZE=200', async () => {
      const model = makeMockModel({
        findAndCountAll: jest.fn().mockResolvedValue({ rows: [], count: 0 }),
      });
      await new ActorRepository(model).findAll({ limit: 1000 });
      expect(model.findAndCountAll.mock.calls[0][0].limit).toBe(200);
    });

    it('clamps negative offset to 0', async () => {
      const model = makeMockModel({
        findAndCountAll: jest.fn().mockResolvedValue({ rows: [], count: 0 }),
      });
      await new ActorRepository(model).findAll({ limit: 10, offset: -5 });
      expect(model.findAndCountAll.mock.calls[0][0].offset).toBe(0);
    });
  });

  describe('update() — typed UpdateResult', () => {
    it('returns { found: true, actor } when row is updated', async () => {
      const row   = fakeRow();
      const model = makeMockModel({
        update:   jest.fn().mockResolvedValue([1]),
        findByPk: jest.fn().mockResolvedValue(row),
      });
      const result = await new ActorRepository(model).update(1, { firstName: 'NICK', lastName: 'W' });
      expect(result).toEqual({ found: true, actor: row });
    });

    it('returns { found: false, actor: null } when 0 rows affected', async () => {
      const model = makeMockModel({ update: jest.fn().mockResolvedValue([0]) });
      const result = await new ActorRepository(model).update(999, { firstName: 'X', lastName: 'Y' });
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

  describe('findByFirstNameStartingWith() — LIKE escaping', () => {
    it('calls findAll with a Sequelize where clause (not a bare array)', async () => {
      const model = makeMockModel({ findAll: jest.fn().mockResolvedValue([]) });
      await new ActorRepository(model).findByFirstNameStartingWith('PEN');
      const callArg = model.findAll.mock.calls[0][0];
      expect(callArg.where).toBeDefined();
      expect(Array.isArray(callArg.where)).toBe(false);
    });

    it('escapes SQL LIKE wildcards in the prefix', async () => {
      const model = makeMockModel({ findAll: jest.fn().mockResolvedValue([]) });
      await new ActorRepository(model).findByFirstNameStartingWith('PEN%');
      const callArg = JSON.stringify(model.findAll.mock.calls[0][0]);
      expect(callArg).toContain('PEN\\\\\\\\%');
    });

    it('handles empty prefix without throwing', async () => {
      const model = makeMockModel({ findAll: jest.fn().mockResolvedValue([]) });
      await expect(new ActorRepository(model).findByFirstNameStartingWith('')).resolves.toEqual([]);
    });
  });

  describe('findByFilmTitle()', () => {
    it('throws when Film/FilmActor models were not injected', async () => {
      await expect(new ActorRepository(makeMockModel()).findByFilmTitle('ACADEMY DINOSAUR'))
        .rejects.toThrow();
    });

    it('calls Actor.findAll (single subquery) when Film/FilmActor are injected', async () => {
      const actorModel     = makeMockModel({ findAll: jest.fn().mockResolvedValue([]) });
      const filmModel      = { getTableName: () => 'film' };
      const filmActorModel = { getTableName: () => 'film_actor' };
      actorModel.sequelize = { escape: jest.fn(v => `'${v}'`) };

      const repo = new ActorRepository(actorModel, filmModel, filmActorModel);
      await repo.findByFilmTitle('ACADEMY DINOSAUR');

      expect(actorModel.findAll).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(actorModel.findAll.mock.calls[0][0].where)).toContain('film_actor');
    });
  });

});
