import { describe, expect, test } from 'bun:test';
import { assertCsrfOrigin, isValidCsrfOrigin, validateCsrfOrigin } from './csrf';

describe('CSRF Origin validation', () => {
  test('requires matching Origin on mutating requests', () => {
    const request = (origin?: string) => new Request('https://mail.example.test/api/messages', {
      method: 'POST', headers: origin ? { Origin: origin } : undefined
    });
    expect(isValidCsrfOrigin(request('https://mail.example.test'), { appOrigin: 'https://mail.example.test' })).toBe(true);
    expect(validateCsrfOrigin(request('https://evil.example.test'), { appOrigin: 'https://mail.example.test' }).reason).toBe('origin-mismatch');
    expect(validateCsrfOrigin(request(), { appOrigin: 'https://mail.example.test' }).reason).toBe('missing-origin');
    expect(() => assertCsrfOrigin(request('https://evil.example.test'), { appOrigin: 'https://mail.example.test' })).toThrow();
  });

  test('allows safe methods and explicitly signed webhooks', () => {
    expect(isValidCsrfOrigin(new Request('https://mail.example.test/api/messages'))).toBe(true);
    expect(validateCsrfOrigin(new Request('https://mail.example.test/webhooks/resend', { method: 'POST' }), { webhook: true }).reason).toBe('webhook');
  });
});
