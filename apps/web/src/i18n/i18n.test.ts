// Tests for translate(): fallback to English, merge fields, direction, and key coverage.
import { describe, expect, it } from 'vitest';
import { bn } from './bn';
import { en } from './en';
import { hi } from './hi';
import { directionOf, translate, translateOr } from './index';
import { ne } from './ne';
import { ur } from './ur';

describe('i18n', () => {
  it('uses the language text and falls back to English for a missing key', () => {
    expect(translate('hi', 'auth.signIn')).toBe('साइन इन');
    expect(translate('hi', 'auth.setupTitle')).toBe(en['auth.setupTitle']);
  });

  it('fills {merge} fields and leaves unknown ones visible', () => {
    expect(translate('en', 'shell.welcome', { name: 'Asha' })).toBe('Welcome, Asha');
    expect(translate('en', 'shell.welcome', {})).toBe('Welcome, {name}');
  });

  it('translates run-time keys and falls back to the database text', () => {
    expect(translateOr('bn', 'module.iam', 'x')).toBe(bn['module.iam']);
    expect(translateOr('hi', 'module.iam', 'x')).toBe(en['module.iam']);
    expect(translateOr('bn', 'module.unknown', 'From database')).toBe('From database');
  });

  it('marks Urdu as right-to-left and the rest as left-to-right', () => {
    expect(directionOf('ur')).toBe('rtl');
    for (const code of ['en', 'bn', 'hi', 'ne']) expect(directionOf(code)).toBe('ltr');
  });

  it('only translates keys that exist in English', () => {
    for (const table of [bn, ur, hi, ne]) {
      for (const key of Object.keys(table)) expect(key in en).toBe(true);
    }
  });
});

// Phase 4 screens (rows 4.5 to 4.10): every language must carry every key, with the same
// {placeholders} as English, so staff never see English fragments or a broken merge field.
const PHASE4_PREFIXES = [
  'mapping.',
  'runs.',
  'unmatched.',
  'perfReports.',
  'perfPerson.',
  'summary.',
  'callSheet.',
  'sheetDetails.',
  'personTracking.',
  'statusDiff.',
  'fdb.',
  'employees.platformIds',
];
const PHASE4_EXACT = [
  'nav.syncRuns',
  'nav.unmatched',
  'nav.perfDaily',
  'nav.perfCycle',
  'nav.perfTopBottom',
  'nav.perfSummary',
  'nav.callSheet',
  'nav.statusDiff',
  'nav.fdbCheck',
  'common.previous',
  'common.next',
  'common.remove',
  'syncSource.mapping',
  'employees.tab.performance',
  'employees.tab.tracking',
];
const phase4Keys = Object.keys(en).filter(
  (key) => PHASE4_EXACT.includes(key) || PHASE4_PREFIXES.some((prefix) => key.startsWith(prefix)),
);
const placeholders = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort().join(',');

describe('i18n Phase 4 completeness', () => {
  const languages: Record<string, Record<string, string | undefined>> = { bn, ur, hi, ne };

  it('finds the Phase 4 keys', () => {
    expect(phase4Keys.length).toBeGreaterThan(400);
  });

  for (const [code, table] of Object.entries(languages)) {
    it(`${code} has every Phase 4 key`, () => {
      expect(phase4Keys.filter((key) => !table[key])).toEqual([]);
    });

    it(`${code} keeps the same placeholders as English`, () => {
      const wrong = Object.keys(table).filter(
        (key) =>
          key in en &&
          placeholders(table[key] ?? '') !==
            placeholders(String((en as Record<string, string>)[key])),
      );
      expect(wrong).toEqual([]);
    });
  }
});
