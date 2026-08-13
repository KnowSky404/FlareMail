import { beforeEach, describe, expect, test } from 'bun:test';
import { clearLoginAttempts, consumeLoginAttempt, resetLoginRateLimitsForTests } from './rate-limit';

describe('login rate limiter', () => {
  beforeEach(resetLoginRateLimitsForTests);

  test('blocks attempts beyond the bounded window', () => {
    expect(consumeLoginAttempt('IP:USER', 1_000, 2, 10_000).allowed).toBe(true);
    expect(consumeLoginAttempt('ip:user', 1_001, 2, 10_000).allowed).toBe(true);
    expect(consumeLoginAttempt('ip:user', 1_002, 2, 10_000)).toEqual({ allowed: false, retryAfterSeconds: 10 });
    expect(consumeLoginAttempt('ip:user', 11_000, 2, 10_000).allowed).toBe(true);
  });

  test('can clear a successful identity', () => {
    consumeLoginAttempt('key', 1_000, 1, 10_000);
    clearLoginAttempts('key');
    expect(consumeLoginAttempt('key', 1_001, 1, 10_000).allowed).toBe(true);
  });
});
