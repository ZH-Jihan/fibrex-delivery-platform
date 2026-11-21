// The menu is built from the feature manifests: groups merge by label in first-seen
// order, and the built NAV still lists every Phase 1 screen in the expected order.
import { describe, expect, it } from 'vitest';
import { buildNav, type WebModuleManifest } from './manifest';
import { NAV, WEB_MODULES } from './nav';

describe('buildNav', () => {
  it('merges groups with the same label and keeps first-seen order', () => {
    const a: WebModuleManifest = {
      key: 'a',
      nav: [
        { label: 'nav.admin', items: [{ to: '/x', label: 'nav.users', permission: 'x.read' }] },
        { label: 'nav.org', items: [{ to: '/y', label: 'nav.company', permission: 'y.read' }] },
      ],
    };
    const b: WebModuleManifest = {
      key: 'b',
      nav: [
        { label: 'nav.admin', items: [{ to: '/z', label: 'nav.audit', permission: 'z.read' }] },
      ],
    };
    expect(buildNav([a, b])).toEqual([
      {
        label: 'nav.admin',
        items: [
          { to: '/x', label: 'nav.users', permission: 'x.read' },
          { to: '/z', label: 'nav.audit', permission: 'z.read' },
        ],
      },
      { label: 'nav.org', items: [{ to: '/y', label: 'nav.company', permission: 'y.read' }] },
    ]);
  });

  it('builds the Phase 1 menu from the four feature manifests', () => {
    expect(WEB_MODULES.map((m) => m.key)).toEqual([
      'iam',
      'audit',
      'platform',
      'party',
      'performance',
      'platform',
      'gl',
    ]);
    expect(NAV.map((g) => [g.label, g.items.map((i) => i.to)])).toEqual([
      ['nav.admin', ['/users', '/roles', '/permission-matrix', '/audit', '/recycle-bin']],
      ['nav.work', ['/tasks', '/delegations']],
      [
        'nav.org',
        [
          '/organisation/company',
          '/organisation/branches',
          '/organisation/numbering',
          '/organisation/lookups',
          '/records',
          '/organisation/templates',
          '/organisation/formulas',
          '/organisation/rate-tables',
          '/organisation/state-machines',
          '/organisation/workflows',
          '/organisation/workflow-bindings',
          '/organisation/webhooks',
          '/organisation/events',
          '/data',
          '/organisation/record-types',
        ],
      ],
      [
        'nav.people.group',
        [
          '/people',
          '/employees',
          '/documents/expiring',
          '/documents/bulk',
          '/documents/expiry-settings',
        ],
      ],
      [
        'nav.performance.group',
        [
          '/performance/sync-sources',
          '/performance/sync-runs',
          '/performance/unmatched',
          '/settings/google-connection',
        ],
      ],
      ['nav.reports', ['/reports']],
      [
        'nav.ledger',
        [
          '/ledger/accounts',
          '/ledger/journals',
          '/ledger/manual-journals',
          '/ledger/simulate',
          '/ledger/cash-bank',
          '/ledger/statements',
          '/ledger/reconciliation',
          '/ledger/match-rules',
        ],
      ],
    ]);
    // Every entry has an icon and a permission; the shell relies on both.
    for (const item of NAV.flatMap((g) => g.items)) {
      expect(item.icon).toBeDefined();
      // Only the task inbox and the report page are open to every signed-in user: each lists
      // just what the API allows that person (their own tasks, the reports they may run).
      if (item.to !== '/tasks' && item.to !== '/reports') expect(item.permission).not.toBe('');
    }
  });
});
