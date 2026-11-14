/**
 * Unit tests for the pure parts of the database layer: soft-delete rules, the version
 * conflict diff, database-context validation and If-Match parsing.
 */
import { describe, expect, it } from 'vitest';
import { AppError } from '../http/errors.js';
import { parseIfMatch } from '../http/crud-router.js';
import { VersionConflictError, diffChanges } from './optimistic-lock.js';
import { PhysicalDeleteError, applySoftDeleteRules, findSoftDeleteModels } from './soft-delete.js';
import { UnitOfWork, currentUnit, validateDbContext } from './unit-of-work.js';
import type { PrismaDb } from './prisma.js';

const T = '018f3c1e-0000-7000-8000-000000000001';
const C = '018f3c1e-0000-7000-8000-000000000002';

describe('soft-delete rules', () => {
  const soft = new Set(['Branch']);

  it('finds the models that have a deletedAt column', () => {
    const models = findSoftDeleteModels();
    expect(models.has('Branch')).toBe(true);
    expect(models.has('Company')).toBe(true);
    // Append-only and reference tables have no soft delete.
    expect(models.has('LoginEvent')).toBe(false);
    expect(models.has('Currency')).toBe(false);
  });

  it('refuses physical deletes on every model', () => {
    expect(() => applySoftDeleteRules(soft, 'Branch', 'delete', { where: { id: '1' } })).toThrow(
      PhysicalDeleteError,
    );
    expect(() => applySoftDeleteRules(soft, 'Currency', 'deleteMany', {})).toThrow(
      PhysicalDeleteError,
    );
  });

  it('adds deletedAt: null to reads and bulk updates', () => {
    for (const op of ['findMany', 'findFirst', 'findUnique', 'count', 'updateManyAndReturn']) {
      expect(applySoftDeleteRules(soft, 'Branch', op, { where: { code: 'HQ' } })).toEqual({
        where: { code: 'HQ', deletedAt: null },
      });
    }
    expect(applySoftDeleteRules(soft, 'Branch', 'findMany', undefined)).toEqual({
      where: { deletedAt: null },
    });
  });

  it('keeps an explicit deletedAt filter, but not an undefined one', () => {
    const bin = { where: { deletedAt: { not: null } } };
    expect(applySoftDeleteRules(soft, 'Branch', 'findMany', bin)).toEqual(bin);
    expect(
      applySoftDeleteRules(soft, 'Branch', 'findMany', { where: { deletedAt: undefined } }),
    ).toEqual({ where: { deletedAt: null } });
  });

  it('leaves models without soft delete and other operations alone', () => {
    const args = { where: { code: 'QAR' } };
    expect(applySoftDeleteRules(soft, 'Currency', 'findMany', args)).toBe(args);
    expect(applySoftDeleteRules(soft, 'Branch', 'create', { data: {} })).toEqual({ data: {} });
  });
});

describe('version conflict diff', () => {
  it('lists only submitted fields whose current value differs', () => {
    const current = { name: 'Head office', code: 'HQ', address: null, version: 3 };
    expect(diffChanges({ name: 'Main office', code: 'HQ', address: undefined }, current)).toEqual([
      { field: 'name', yours: 'Main office', current: 'Head office' },
    ]);
  });

  it('compares dates and nested JSON by value, ignoring key order', () => {
    const when = new Date('2026-01-02T03:04:05.000Z');
    const current = { at: when, meta: { a: 1, b: [1, 2] } };
    expect(
      diffChanges({ at: '2026-01-02T03:04:05.000Z', meta: { b: [1, 2], a: 1 } }, current),
    ).toEqual([]);
    expect(diffChanges({ meta: { a: 1, b: [2, 1] } }, current)).toHaveLength(1);
  });

  it('is a 409 that carries the current record through the given mapping', () => {
    const err = new VersionConflictError(1, { id: 'x', version: 2, secret: 's' }, []);
    const shown = err.presentedWith((row) => ({ id: row.id }));
    expect(shown.status).toBe(409);
    expect(shown.code).toBe('version_conflict');
    expect(shown.extras).toMatchObject({
      expectedVersion: 1,
      currentVersion: 2,
      current: { id: 'x' },
    });
  });
});

describe('database context', () => {
  it('accepts UUIDs', () => {
    expect(() => {
      validateDbContext({ tenantId: T, companyIds: [C], userId: T });
    }).not.toThrow();
  });

  it('rejects anything that is not a UUID, including array-literal injection', () => {
    expect(() => {
      validateDbContext({ tenantId: 'abc', companyIds: [] });
    }).toThrow(/tenantId/);
    expect(() => {
      validateDbContext({ tenantId: T, companyIds: [`${C},${T}`] });
    }).toThrow(/companyIds/);
    expect(() => {
      validateDbContext({ tenantId: T, companyIds: [], userId: "'; DROP" });
    }).toThrow(/userId/);
  });

  it('never opens a transaction for an invalid context or an anonymous request', async () => {
    let opened = 0;
    const prisma = {
      $transaction: () => {
        opened += 1;
        return Promise.resolve();
      },
    } as unknown as PrismaDb;
    const uow = new UnitOfWork(prisma);
    expect(() =>
      uow.runAs({ tenantId: 'nope', companyIds: [] }, () => Promise.resolve()),
    ).toThrow();
    // No request context at all: 401, not a tenant-less transaction.
    expect(() => uow.run(() => Promise.resolve())).toThrow(AppError);
    expect(opened).toBe(0);
    await Promise.resolve();
  });

  it('has no current unit outside a unit of work', () => {
    expect(() => currentUnit()).toThrow(/No unit of work/);
  });
});

describe('If-Match', () => {
  it('reads plain, quoted and weak versions', () => {
    expect(parseIfMatch('3')).toBe(3);
    expect(parseIfMatch('"12"')).toBe(12);
    expect(parseIfMatch('W/"7"')).toBe(7);
  });

  it('gives 428 when missing and 400 when malformed', () => {
    const status = (value: string | undefined): number => {
      try {
        parseIfMatch(value);
      } catch (err) {
        if (err instanceof AppError) return err.status;
      }
      return 0;
    };
    expect(status(undefined)).toBe(428);
    expect(status('  ')).toBe(428);
    expect(status('*')).toBe(400);
    expect(status('"abc"')).toBe(400);
  });
});
