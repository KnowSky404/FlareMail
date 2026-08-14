export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

const DEFAULT_LIMIT = 5;
const DEFAULT_WINDOW_MS = 15 * 60 * 1000;

export function normalizeLoginEmail(value: string) {
  return value.trim().toLowerCase();
}

async function identityHash(key: string) {
  const normalized = key.trim().toLowerCase();
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function consumeLoginAttempt(
  db: D1Database,
  key: string,
  now = Date.now(),
  limit = DEFAULT_LIMIT,
  windowMs = DEFAULT_WINDOW_MS
): Promise<RateLimitResult> {
  const hash = await identityHash(key);
  const resetAt = now + windowMs;
  await db.prepare('DELETE FROM workspace_login_rate_limits WHERE reset_at <= ?').bind(now).run();
  const row = await db.prepare(`
    INSERT INTO workspace_login_rate_limits (identity_hash, attempt_count, window_started_at, reset_at, updated_at)
    VALUES (?, 1, ?, ?, ?)
    ON CONFLICT(identity_hash) DO UPDATE SET
      attempt_count = CASE
        WHEN workspace_login_rate_limits.reset_at <= excluded.window_started_at THEN 1
        ELSE MIN(workspace_login_rate_limits.attempt_count + 1, ?)
      END,
      window_started_at = CASE
        WHEN workspace_login_rate_limits.reset_at <= excluded.window_started_at THEN excluded.window_started_at
        ELSE workspace_login_rate_limits.window_started_at
      END,
      reset_at = CASE
        WHEN workspace_login_rate_limits.reset_at <= excluded.window_started_at THEN excluded.reset_at
        ELSE workspace_login_rate_limits.reset_at
      END,
      updated_at = excluded.updated_at
    RETURNING attempt_count, reset_at
  `).bind(hash, now, resetAt, now, limit + 1).first<{ attempt_count: number; reset_at: number }>();
  if (!row) throw new Error('Login rate limit state was not persisted.');
  return row.attempt_count <= limit
    ? { allowed: true, retryAfterSeconds: 0 }
    : { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((row.reset_at - now) / 1000)) };
}

export async function clearLoginAttempts(db: D1Database, key: string) {
  const hash = await identityHash(key);
  await db.prepare('DELETE FROM workspace_login_rate_limits WHERE identity_hash = ?').bind(hash).run();
}
