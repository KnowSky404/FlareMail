import { cleanupMcpRecords } from '$lib/server/mcp/store';

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

const DEFAULT_LIMIT = 5;
const DEFAULT_WINDOW_MS = 15 * 60 * 1000;
let nextCleanupAt = 0;

export function normalizeLoginUsername(value: string) {
  return value.trim().normalize('NFKC').toLowerCase();
}

export function isValidLoginUsername(value: string) {
  const normalized = normalizeLoginUsername(value);
  return normalized.length >= 1 && normalized.length <= 128 && /^[\p{L}\p{N}][\p{L}\p{N}._@+-]*$/u.test(normalized);
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
  const saturated = () => db.prepare(`SELECT reset_at FROM workspace_login_rate_limits
    WHERE identity_hash = ? AND reset_at > ? AND attempt_count >= ?`)
    .bind(hash, now, limit).first<{ reset_at: number }>();
  const retry = (until: number): RateLimitResult => ({
    allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((until - now) / 1000))
  });
  const blocked = await saturated();
  if (blocked) return retry(blocked.reset_at);
  const row = await db.prepare(`
    INSERT INTO workspace_login_rate_limits (identity_hash, attempt_count, window_started_at, reset_at, updated_at)
    VALUES (?, 1, ?, ?, ?)
    ON CONFLICT(identity_hash) DO UPDATE SET
      attempt_count = CASE
        WHEN workspace_login_rate_limits.reset_at <= excluded.window_started_at THEN 1
        ELSE workspace_login_rate_limits.attempt_count + 1
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
    WHERE workspace_login_rate_limits.reset_at <= excluded.window_started_at
      OR workspace_login_rate_limits.attempt_count < ?
    RETURNING attempt_count, reset_at
  `).bind(hash, now, resetAt, now, limit).first<{ attempt_count: number; reset_at: number }>();
  if (!row) return retry((await saturated())?.reset_at ?? resetAt);

  // Cron-less deployments sweep expired records after a request has written its counter.
  if (now >= nextCleanupAt) {
    nextCleanupAt = now + DEFAULT_WINDOW_MS;
    await Promise.all([
      cleanupLoginAttempts(db, now).catch(() => console.error(JSON.stringify({ event: 'login_rate_limit_cleanup_failed' }))),
      cleanupMcpRecords(db, Math.floor(now / 1000)).catch(() => console.error(JSON.stringify({ event: 'mcp_cleanup_failed' })))
    ]);
  }
  return { allowed: true, retryAfterSeconds: 0 };
}

export async function cleanupLoginAttempts(db: D1Database, now = Date.now()) {
  await db.prepare(`DELETE FROM workspace_login_rate_limits
    WHERE identity_hash IN (SELECT identity_hash FROM workspace_login_rate_limits WHERE reset_at <= ? LIMIT 5000)`)
    .bind(now).run();
}

export async function clearLoginAttempts(db: D1Database, key: string) {
  const hash = await identityHash(key);
  await db.prepare('DELETE FROM workspace_login_rate_limits WHERE identity_hash = ?').bind(hash).run();
}
