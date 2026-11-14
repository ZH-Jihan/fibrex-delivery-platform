// Tests for translate(): fallback to English, merge fields, direction, and key coverage.
import { describe, expect, it } from 'vitest';
import { bn } from './bn';
import { en } from './en';
import { hi } from './hi';
import { directionOf, translate } from './index';
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
