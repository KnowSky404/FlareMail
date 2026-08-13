interface AttemptWindow {
  count: number;
  resetAt: number;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

const attempts = new Map<string, AttemptWindow>();
const DEFAULT_LIMIT = 5;
const DEFAULT_WINDOW_MS = 15 * 60 * 1000;
const MAX_TRACKED_IDENTITIES = 10_000;

function pruneAttempts(now: number) {
  if (attempts.size < MAX_TRACKED_IDENTITIES) return;
  for (const [key, window] of attempts) {
    if (window.resetAt <= now) attempts.delete(key);
  }
  while (attempts.size >= MAX_TRACKED_IDENTITIES) {
    const oldestKey = attempts.keys().next().value as string | undefined;
    if (!oldestKey) break;
    attempts.delete(oldestKey);
  }
}

export function consumeLoginAttempt(
  key: string,
  now = Date.now(),
  limit = DEFAULT_LIMIT,
  windowMs = DEFAULT_WINDOW_MS
): RateLimitResult {
  pruneAttempts(now);
  const normalizedKey = key.trim().toLowerCase();
  const current = attempts.get(normalizedKey);
  if (!current || current.resetAt <= now) {
    attempts.set(normalizedKey, { count: 1, resetAt: now + windowMs });
    return { allowed: true, retryAfterSeconds: 0 };
  }
  if (current.count >= limit) {
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000)) };
  }
  current.count += 1;
  return { allowed: true, retryAfterSeconds: 0 };
}

export function clearLoginAttempts(key: string) {
  attempts.delete(key.trim().toLowerCase());
}

export function resetLoginRateLimitsForTests() {
  attempts.clear();
}
