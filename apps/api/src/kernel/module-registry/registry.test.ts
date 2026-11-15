/**
 * Unit tests for the module registry: the checks that make a wrong manifest fail at
 * start-up (duplicate module, foreign keys, unknown permission reference, registering
 * after mount) and the aggregation main.ts relies on.
 */
import { Router } from 'express';
import { describe, expect, it } from 'vitest';
import { permission } from '../permissions/catalogue.js';
import type { ModuleManifest } from './manifest.js';
import { ModuleRegistry, ModuleRegistryError } from './registry.js';

const KERNEL = [permission('iam', 'iam.user', 'read', 'View users')];

function loans(extra: Partial<ModuleManifest> = {}): ModuleManifest {
  return {
    key: 'loans',
    label: 'Loans',
    permissions: [permission('loans', 'loans.loan', 'read', 'View loans')],
    nav: [
      { path: '/loans', labelKey: 'nav.loans', groupKey: 'nav.money', permission: 'loans.loan.read' },
    ],
    eventTypes: [{ key: 'loans.loan.approved', moduleKey: 'loans', label: 'Loan approved' }],
    ...extra,
  };
}

describe('ModuleRegistry', () => {
  it('aggregates permissions, event types, nav and summaries in registration order', () => {
    const registry = new ModuleRegistry({ kernelPermissions: KERNEL });
    registry.register(loans());
    registry.register({
      key: 'fund',
      label: 'Fund',
      permissions: [permission('fund', 'fund.investor', 'read', 'View investors')],
    });
    expect(registry.permissions().map((p) => p.key)).toEqual([
      'loans.loan.read',
      'fund.investor.read',
    ]);
    expect(registry.eventTypes().map((e) => e.key)).toEqual(['loans.loan.approved']);
    expect(registry.nav().map((n) => n.path)).toEqual(['/loans']);
    expect(registry.summaries()).toEqual([
      {
        key: 'loans',
        label: 'Loans',
        permissions: ['loans.loan.read'],
        nav: loans().nav,
        settings: [],
        reports: [],
        eventTypes: ['loans.loan.approved'],
      },
      {
        key: 'fund',
        label: 'Fund',
        permissions: ['fund.investor.read'],
        nav: [],
        settings: [],
        reports: [],
        eventTypes: [],
      },
    ]);
  });

  it('refuses a module registered twice, a bad key, and keys that belong to another module', () => {
    const registry = new ModuleRegistry();
    registry.register(loans());
    expect(() => {
      registry.register(loans());
    }).toThrow(ModuleRegistryError);
    expect(() => {
      registry.register({ key: 'Loans-2', label: 'x', permissions: [] });
    }).toThrow(/lower-case/);
    expect(() => {
      registry.register({
        key: 'fund',
        label: 'Fund',
        permissions: [permission('loans', 'loans.loan', 'update', 'Change loans')],
      });
    }).toThrow(/module key 'loans'/);
    expect(() => {
      registry.register({
        key: 'fund',
        label: 'Fund',
        permissions: [],
        eventTypes: [{ key: 'x', moduleKey: 'loans', label: 'x' }],
      });
    }).toThrow(/event type 'x'/);
    expect(() => {
      registry.register({
        key: 'fund',
        label: 'Fund',
        permissions: [
          permission('fund', 'fund.investor', 'read', 'a'),
          permission('fund', 'fund.investor', 'read', 'b'),
        ],
      });
    }).toThrow(/twice/);
  });

  it('mounts routers in order, checks permission references, and is sealed afterwards', () => {
    const registry = new ModuleRegistry({ kernelPermissions: KERNEL });
    const first = Router();
    const second = Router();
    registry.register(loans({ routers: [first] }));
    registry.register({
      key: 'fund',
      label: 'Fund',
      permissions: [],
      routers: [second],
      // Points at a kernel permission: allowed.
      settings: [{ key: 'fund.x', label: 'x', path: '/x', permission: 'iam.user.read' }],
    });
    const mounted: unknown[] = [];
    const api = { use: (r: unknown) => mounted.push(r) } as unknown as Router;
    registry.mount(api);
    expect(mounted).toEqual([first, second]);
    expect(() => {
      registry.register({ key: 'late', label: 'Late', permissions: [] });
    }).toThrow(/after the routers were mounted/);
    expect(() => {
      registry.mount(api);
    }).toThrow(/already mounted/);

    const broken = new ModuleRegistry();
    broken.register(
      loans({
        nav: [
          {
            path: '/loans',
            labelKey: 'nav.loans',
            groupKey: 'nav.money',
            permission: 'loans.loan.approve',
          },
        ],
      }),
    );
    expect(() => {
      broken.mount(api);
    }).toThrow(/menu entry \/loans needs unknown permission 'loans.loan.approve'/);
  });
});
