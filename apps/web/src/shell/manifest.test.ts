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
    expect(WEB_MODULES.map((m) => m.key)).toEqual(['iam', 'audit', 'platform', 'party']);
    expect(NAV.map((g) => [g.label, g.items.map((i) => i.to)])).toEqual([
      ['nav.admin', ['/users', '/roles', '/permission-matrix', '/audit', '/recycle-bin']],
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
          '/data',
          '/organisation/record-types',
        ],
      ],
      ['nav.people.group', ['/people']],
    ]);
    // Every entry has an icon and a permission; the shell relies on both.
    for (const item of NAV.flatMap((g) => g.items)) {
      expect(item.icon).toBeDefined();
      expect(item.permission).not.toBe('');
    }
  });
});
