import { describe, expect, test } from 'bun:test';
import { generateSessionToken, hashSessionToken } from './token';

describe('session token helpers', () => {
  test('generates at least 256 bits of URL-safe entropy', () => {
    const token = generateSessionToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(token.length).toBeGreaterThanOrEqual(43);
    expect(generateSessionToken()).not.toBe(token);
  });

  test('hashes deterministically with SHA-256 base64url', async () => {
    expect(await hashSessionToken('hello')).toBe('LPJNul-wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ');
    await expect(hashSessionToken('')).rejects.toThrow();
  });
});
