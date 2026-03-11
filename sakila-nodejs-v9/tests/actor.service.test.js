/**
 * @fileoverview Unit tests — ActorService  (v6)
 *
 * NEW tests for v6 fixes:
 *   - FIX SV1: actorId must be a positive integer (float/string rejected)
 *   - FIX SV2: getAllActors with NaN page/pageSize falls back to defaults
 *
 * Carries forward all v5 tests (TS2: get({ plain: true }) contract).
 */

'use strict';

const ActorService  = require('../services/actor.service');
const NotFoundError = require('../errors/not-found.error');

// ── Mock factories ────────────────────────────────────────────────────────────

const makeMockRepo = (overrides = {}) => ({
  findAll:    jest.fn(),
  findById:   jest.fn(),
  create:     jest.fn(),
  update:     jest.fn(),
  deleteById: jest.fn(),
  ...overrides,
});

const makeMockSequelize = () => ({
  transaction: jest.fn((cb) => cb({})),
});

/**
 * FIX TS2 (v5): get() asserts { plain: true } was passed.
 * @param {Object} [data]
 */
const fakeActor = (data = {}) => ({
  get: jest.fn((opts) => {
    if (!opts || opts.plain !== true) {
      throw new Error('actor.get() must be called with { plain: true }');
    }
    return {
      actor_id:    data.actor_id    ?? 1,
      first_name:  data.first_name  ?? 'PENELOPE',
      last_name:   data.last_name   ?? 'GUINESS',
      last_update: data.last_update ?? new Date('2006-02-15'),
    };
  }),
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ActorService', () => {

  describe('constructor', () => {
    it('throws TypeError if actorRepository is missing', () => {
      expect(() => new ActorService()).toThrow(TypeError);
    });
    it('throws TypeError if sequelize is missing', () => {
      expect(() => new ActorService(makeMockRepo())).toThrow(TypeError);
    });
  });

  describe('getAllActors()', () => {
    it('returns paginated envelope with mapped DTOs', async () => {
      const repo = makeMockRepo({
        findAll: jest.fn().mockResolvedValue({ rows: [fakeActor()], count: 1 }),
      });
      const svc    = new ActorService(repo, makeMockSequelize());
      const result = await svc.getAllActors({ page: 1, pageSize: 10 });
      expect(result).toMatchObject({ total: 1, page: 1, pageSize: 10 });
      expect(result.data).toHaveLength(1);
      expect(result.data[0]).toMatchObject({ actorId: 1, firstName: 'PENELOPE' });
    });

    it('clamps pageSize to maximum 100', async () => {
      const repo = makeMockRepo({
        findAll: jest.fn().mockResolvedValue({ rows: [], count: 0 }),
      });
      const svc    = new ActorService(repo, makeMockSequelize());
      const result = await svc.getAllActors({ page: 1, pageSize: 9999 });
      expect(result.pageSize).toBe(100);
      expect(repo.findAll).toHaveBeenCalledWith({ limit: 100, offset: 0 });
    });

    it('returns empty data array when there are no actors', async () => {
      const repo = makeMockRepo({
        findAll: jest.fn().mockResolvedValue({ rows: [], count: 0 }),
      });
      const svc    = new ActorService(repo, makeMockSequelize());
      const result = await svc.getAllActors();
      expect(result.data).toEqual([]);
      expect(result.total).toBe(0);
    });

    it('computes correct offset for page 3, pageSize 10', async () => {
      const repo = makeMockRepo({
        findAll: jest.fn().mockResolvedValue({ rows: [], count: 30 }),
      });
      const svc = new ActorService(repo, makeMockSequelize());
      await svc.getAllActors({ page: 3, pageSize: 10 });
      expect(repo.findAll).toHaveBeenCalledWith({ limit: 10, offset: 20 });
    });

    // FIX SV2: NaN inputs must not propagate to the repo
    it('falls back to defaults when page is NaN (FIX SV2)', async () => {
      const repo = makeMockRepo({
        findAll: jest.fn().mockResolvedValue({ rows: [], count: 0 }),
      });
      const svc = new ActorService(repo, makeMockSequelize());
      await svc.getAllActors({ page: NaN, pageSize: NaN });
      expect(repo.findAll).toHaveBeenCalledWith({ limit: 20, offset: 0 });
    });
  });

  describe('getActorById()', () => {
    it('returns DTO when actor exists', async () => {
      const repo = makeMockRepo({ findById: jest.fn().mockResolvedValue(fakeActor()) });
      const svc  = new ActorService(repo, makeMockSequelize());
      const dto  = await svc.getActorById(1);
      expect(dto).toMatchObject({ actorId: 1, firstName: 'PENELOPE', lastName: 'GUINESS' });
    });

    it('_toDTO calls actor.get({ plain: true })', async () => {
      const actor = fakeActor();
      const repo  = makeMockRepo({ findById: jest.fn().mockResolvedValue(actor) });
      const svc   = new ActorService(repo, makeMockSequelize());
      await svc.getActorById(1);
      expect(actor.get).toHaveBeenCalledWith({ plain: true });
    });

    it('throws NotFoundError when actor does not exist', async () => {
      const repo = makeMockRepo({ findById: jest.fn().mockResolvedValue(null) });
      const svc  = new ActorService(repo, makeMockSequelize());
      await expect(svc.getActorById(999)).rejects.toBeInstanceOf(NotFoundError);
    });

    it('NotFoundError.statusCode is 404', async () => {
      const repo = makeMockRepo({ findById: jest.fn().mockResolvedValue(null) });
      const svc  = new ActorService(repo, makeMockSequelize());
      await expect(svc.getActorById(999)).rejects.toMatchObject({ statusCode: 404 });
    });

    // FIX SV1: actorId type guard
    it('throws TypeError for float actorId (FIX SV1)', async () => {
      const repo = makeMockRepo();
      const svc  = new ActorService(repo, makeMockSequelize());
      await expect(svc.getActorById(1.7)).rejects.toThrow(TypeError);
    });

    it('throws TypeError for zero actorId (FIX SV1)', async () => {
      const repo = makeMockRepo();
      const svc  = new ActorService(repo, makeMockSequelize());
      await expect(svc.getActorById(0)).rejects.toThrow(TypeError);
    });

    it('throws TypeError for negative actorId (FIX SV1)', async () => {
      const repo = makeMockRepo();
      const svc  = new ActorService(repo, makeMockSequelize());
      await expect(svc.getActorById(-1)).rejects.toThrow(TypeError);
    });
  });

  describe('createActor()', () => {
    it('calls repo.create inside a transaction and returns DTO', async () => {
      const actor = fakeActor({ actor_id: 42, first_name: 'ED', last_name: 'CHASE' });
      const repo  = makeMockRepo({ create: jest.fn().mockResolvedValue(actor) });
      const seq   = makeMockSequelize();
      const svc   = new ActorService(repo, seq);

      const result = await svc.createActor({ firstName: 'ED', lastName: 'CHASE' });

      expect(seq.transaction).toHaveBeenCalled();
      expect(repo.create).toHaveBeenCalledWith({ firstName: 'ED', lastName: 'CHASE' }, {});
      expect(result).toMatchObject({ actorId: 42, firstName: 'ED', lastName: 'CHASE' });
    });
  });

  describe('updateActor()', () => {
    it('returns updated DTO when actor exists', async () => {
      const updated = fakeActor({ actor_id: 1, first_name: 'NICK', last_name: 'WAHLBERG' });
      const repo    = makeMockRepo({
        update: jest.fn().mockResolvedValue({ found: true, actor: updated }),
      });
      const svc    = new ActorService(repo, makeMockSequelize());
      const result = await svc.updateActor(1, { firstName: 'NICK', lastName: 'WAHLBERG' });
      expect(result.firstName).toBe('NICK');
    });

    it('throws NotFoundError when UpdateResult.found is false', async () => {
      const repo = makeMockRepo({
        update: jest.fn().mockResolvedValue({ found: false, actor: null }),
      });
      const svc = new ActorService(repo, makeMockSequelize());
      await expect(svc.updateActor(99, { firstName: 'X', lastName: 'Y' }))
        .rejects.toBeInstanceOf(NotFoundError);
    });

    // FIX SV1
    it('throws TypeError for non-integer actorId (FIX SV1)', async () => {
      const repo = makeMockRepo();
      const svc  = new ActorService(repo, makeMockSequelize());
      await expect(svc.updateActor(1.5, { firstName: 'X', lastName: 'Y' }))
        .rejects.toThrow(TypeError);
    });
  });

  describe('deleteActor()', () => {
    it('calls repo.deleteById inside a transaction when actor exists', async () => {
      const repo = makeMockRepo({
        findById:   jest.fn().mockResolvedValue(fakeActor()),
        deleteById: jest.fn().mockResolvedValue(true),
      });
      const seq = makeMockSequelize();
      const svc = new ActorService(repo, seq);

      await svc.deleteActor(1);

      expect(seq.transaction).toHaveBeenCalled();
      expect(repo.deleteById).toHaveBeenCalledWith(1, {});
    });

    it('throws NotFoundError when actor does not exist', async () => {
      const repo = makeMockRepo({ findById: jest.fn().mockResolvedValue(null) });
      const svc  = new ActorService(repo, makeMockSequelize());
      await expect(svc.deleteActor(999)).rejects.toBeInstanceOf(NotFoundError);
    });

    // FIX SV1
    it('throws TypeError for non-integer actorId (FIX SV1)', async () => {
      const repo = makeMockRepo();
      const svc  = new ActorService(repo, makeMockSequelize());
      await expect(svc.deleteActor(NaN)).rejects.toThrow(TypeError);
    });
  });

});
