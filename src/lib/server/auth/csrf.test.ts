import { describe, expect, test } from 'bun:test';
import { assertCsrfOrigin, isValidCsrfOrigin, validateCsrfOrigin } from './csrf';

describe('CSRF Origin validation', () => {
  test('accepts same-origin mutations on every incoming Worker hostname', () => {
    const request = (url: string, origin?: string) => new Request(url, {
      method: 'POST', headers: origin ? { Origin: origin } : undefined
    });

    for (const origin of [
      'https://flaremail.example.workers.dev',
      'https://mail.example.test',
      'https://mail-secondary.example.test'
    ]) {
      expect(isValidCsrfOrigin(request(`${origin}/api/messages`, origin))).toBe(true);
    }
  });

  test('rejects cross-origin, port-mismatched, malformed, and missing origins', () => {
    const request = (origin?: string) => new Request('https://mail.example.test/api/messages', {
      method: 'POST', headers: origin ? { Origin: origin } : undefined
    });

    expect(validateCsrfOrigin(request('https://evil.example.test')).reason).toBe('origin-mismatch');
    expect(validateCsrfOrigin(request('https://mail.example.test:8443')).reason).toBe('origin-mismatch');
    expect(validateCsrfOrigin(request('null')).reason).toBe('invalid-origin');
    expect(validateCsrfOrigin(request()).reason).toBe('missing-origin');
    expect(() => assertCsrfOrigin(request('https://evil.example.test'))).toThrow();
  });

  test('allows safe methods and explicitly signed webhooks', () => {
    expect(isValidCsrfOrigin(new Request('https://mail.example.test/api/messages'))).toBe(true);
    expect(validateCsrfOrigin(new Request('https://mail.example.test/webhooks/resend', { method: 'POST' }), { webhook: true }).reason).toBe('webhook');
  });
});
