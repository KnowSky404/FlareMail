import { describe, expect, test } from 'bun:test';
import { getDummyPasswordHash, hashPassword, isPasswordHash, verifyPassword } from './password';

describe('password hashing', () => {
  test('uses a random salt and verifies the original password', async () => {
    const first = await hashPassword('correct horse battery 电池');
    const second = await hashPassword('correct horse battery 电池');
    expect(first).not.toBe(second);
    expect(await verifyPassword('correct horse battery 电池', first)).toBe(true);
    expect(await verifyPassword('wrong password', first)).toBe(false);
    expect(first.split('$')[2].length).toBeGreaterThanOrEqual(22);
  });

  test('rejects empty passwords and malformed encodings', async () => {
    await expect(hashPassword('')).rejects.toThrow();
    expect(await verifyPassword('password', 'not-a-password-hash')).toBe(false);
    expect(await verifyPassword('password', 'pbkdf2-sha256-v1$600000$%%%$%%%')).toBe(false);
  });

  test('verifies hashes created by the legacy Web Crypto implementation', async () => {
    const legacyHash =
      'pbkdf2-sha256-v1$600000$AAECAwQFBgcICQoLDA0ODw$02wAMUTtqiu8pMvsNmwTaNjvhhhyWVBLlqybmudsrPg';
    expect(await verifyPassword('correct horse battery 电池', legacyHash)).toBe(true);
    expect(await verifyPassword('wrong password', legacyHash)).toBe(false);
  });

  test('provides a valid non-secret dummy hash for unknown accounts', async () => {
    const dummyHash = getDummyPasswordHash();
    expect(isPasswordHash(dummyHash)).toBe(true);
    expect(await verifyPassword('any candidate password', dummyHash)).toBe(false);
  });
});
