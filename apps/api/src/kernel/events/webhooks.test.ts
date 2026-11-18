/**
 * Unit tests for webhook signing and the "where may a webhook point" rules (row 2.12).
 */
import { describe, expect, it } from 'vitest';
import {
  checkWebhookUrl,
  isInternalAddress,
  signWebhook,
  verifyWebhookSignature,
} from './webhooks.js';

describe('webhook signature', () => {
  const secret = 'whsec_test_secret';
  const body = '{"id":"e1","type":"system.test"}';

  it('verifies a fresh signature and refuses a changed body, secret or old timestamp', () => {
    const now = 1_800_000_000;
    const header = signWebhook(secret, now, body);
    expect(header).toMatch(/^t=1800000000,v1=[0-9a-f]{64}$/);
    expect(verifyWebhookSignature(secret, header, body, now)).toBe(true);
    expect(verifyWebhookSignature(secret, header, `${body} `, now)).toBe(false);
    expect(verifyWebhookSignature('whsec_other', header, body, now)).toBe(false);
    expect(verifyWebhookSignature(secret, header, body, now + 301)).toBe(false);
    expect(verifyWebhookSignature(secret, 'garbage', body, now)).toBe(false);
  });

  it('binds the timestamp into the signature', () => {
    const header = signWebhook(secret, 100, body);
    const moved = header.replace('t=100', 't=200');
    expect(verifyWebhookSignature(secret, moved, body, 200)).toBe(false);
  });
});

describe('webhook URL rules', () => {
  it('requires https to a public host in production', () => {
    expect(checkWebhookUrl('https://hooks.example.com/in', false)).toBeNull();
    expect(checkWebhookUrl('http://hooks.example.com/in', false)).toMatch(/https/);
    expect(checkWebhookUrl('https://localhost/in', false)).toMatch(/public/);
    expect(checkWebhookUrl('https://10.1.2.3/in', false)).toMatch(/public/);
    expect(checkWebhookUrl('https://[::1]/in', false)).toMatch(/public/);
    expect(checkWebhookUrl('https://user:pw@hooks.example.com/', false)).toMatch(/user/);
    expect(checkWebhookUrl('not a url', false)).toMatch(/valid/);
  });

  it('allows http and local receivers in development', () => {
    expect(checkWebhookUrl('http://127.0.0.1:9000/hook', true)).toBeNull();
    expect(checkWebhookUrl('ftp://example.com/', true)).toMatch(/https/);
  });

  it('knows internal addresses', () => {
    for (const ip of [
      '127.0.0.1',
      '10.0.0.1',
      '172.16.5.4',
      '192.168.1.1',
      '169.254.169.254',
      '0.0.0.0',
      '::1',
      'fd00::1',
      'fe80::1',
      '::ffff:10.0.0.1',
    ]) {
      expect(isInternalAddress(ip)).toBe(true);
    }
    for (const ip of ['8.8.8.8', '172.32.0.1', '2001:4860:4860::8888']) {
      expect(isInternalAddress(ip)).toBe(false);
    }
  });
});
