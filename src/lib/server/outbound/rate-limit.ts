import type { D1Database } from '@cloudflare/workers-types';

export interface OutboundRateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

export const DEFAULT_OUTBOUND_SEND_LIMIT = 10;
export const DEFAULT_OUTBOUND_SEND_WINDOW_MS = 60 * 1000;

/**
 * Consume one application-layer send slot for a workspace user.
 *
 * The row stores only the stable workspace user id and bounded counter
 * metadata. The UPSERT is the concurrency boundary: D1 serializes conflicting
 * writes for the primary key, and RETURNING gives us the resulting counter
 * without a race-prone read/modify/write sequence.
 */
export async function consumeOutboundRateLimit(
  db: D1Database,
  userId: string,
  now = Date.now(),
  limit = DEFAULT_OUTBOUND_SEND_LIMIT,
  windowMs = DEFAULT_OUTBOUND_SEND_WINDOW_MS
): Promise<OutboundRateLimitResult> {
  const normalizedUserId = userId.trim();
  if (!normalizedUserId) throw new Error('Outbound rate-limit user id is required.');
  if (!Number.isSafeInteger(now) || now < 0) throw new RangeError('Outbound rate-limit timestamp is invalid.');
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('Outbound rate-limit limit is invalid.');
  if (!Number.isSafeInteger(windowMs) || windowMs < 1) throw new RangeError('Outbound rate-limit window is invalid.');

  const resetAt = now + windowMs;
  if (!Number.isSafeInteger(resetAt)) throw new RangeError('Outbound rate-limit window exceeds timestamp range.');

  // Keep expired users from accumulating indefinitely. The per-row UPSERT
  // below also handles an expiry race when a concurrent request arrives.
  await db.prepare(`
    DELETE FROM workspace_outbound_rate_limits
    WHERE user_id IN (
      SELECT user_id FROM workspace_outbound_rate_limits
      WHERE reset_at <= ?
      ORDER BY reset_at, user_id
      LIMIT 100
    )
  `).bind(now).run();
  const row = await db.prepare(`
    INSERT INTO workspace_outbound_rate_limits (user_id, attempt_count, window_started_at, reset_at, updated_at)
    VALUES (?, 1, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      attempt_count = CASE
        WHEN workspace_outbound_rate_limits.reset_at <= excluded.window_started_at THEN 1
        ELSE MIN(workspace_outbound_rate_limits.attempt_count + 1, ?)
      END,
      window_started_at = CASE
        WHEN workspace_outbound_rate_limits.reset_at <= excluded.window_started_at THEN excluded.window_started_at
        ELSE workspace_outbound_rate_limits.window_started_at
      END,
      reset_at = CASE
        WHEN workspace_outbound_rate_limits.reset_at <= excluded.window_started_at THEN excluded.reset_at
        ELSE workspace_outbound_rate_limits.reset_at
      END,
      updated_at = excluded.updated_at
    RETURNING attempt_count, reset_at
  `).bind(normalizedUserId, now, resetAt, now, limit + 1).first<{ attempt_count: number; reset_at: number }>();

  if (!row) throw new Error('Outbound rate limit state was not persisted.');
  return row.attempt_count <= limit
    ? { allowed: true, retryAfterSeconds: 0 }
    : { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((row.reset_at - now) / 1000)) };
}

/** Alias kept explicit for callers that describe the operation as a send. */
export const consumeOutboundSend = consumeOutboundRateLimit;
