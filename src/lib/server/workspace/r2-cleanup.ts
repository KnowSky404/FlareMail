import type { CloudflareEnv } from '$lib/server/cloudflare';

export const CLEANUP_STATUSES = ['pending', 'processing', 'retryable', 'completed', 'manual_review'] as const;
export type CleanupStatus = typeof CLEANUP_STATUSES[number];
export type CleanupObjectKind = 'raw' | 'attachment' | 'body' | 'legacy';

export const CLEANUP_DEFAULT_MAX_ATTEMPTS = 8;
export const CLEANUP_DEFAULT_LIMIT = 50;
export const CLEANUP_DEFAULT_CONCURRENCY = 4;
export const CLEANUP_LEASE_MS = 5 * 60 * 1000;
export const CLEANUP_BACKOFF_BASE_MS = 30 * 1000;
export const CLEANUP_BACKOFF_MAX_MS = 6 * 60 * 60 * 1000;

const UUID = '[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}';
const DATE = '\\d{4}-\\d{2}-\\d{2}';
const SEGMENT = '[A-Za-z0-9_-]+';
const SAFE_ERROR_CODES = new Set([
  'r2_unavailable',
  'r2_delete_failed',
  'invalid_key_scope',
  'stale_lease',
  'd1_finalize_failed',
  'lost_claim'
]);
const MAX_CLEANUP_KEY_LENGTH = 1024;

export type CleanupQueueRow = {
  id: string;
  owner_user_id: string;
  entity_id: string;
  r2_key: string;
  reason: 'trash_delete';
  status: CleanupStatus;
  attempt_count: number;
  max_attempts: number;
  next_attempt_at: string;
  claim_token: string | null;
  lease_expires_at: string | null;
  last_error: string | null;
  completed_at: string | null;
  object_kind: CleanupObjectKind;
  source_id: string | null;
  source_owner_user_id: string | null;
  source_entity_id: string | null;
  created_at: string;
  updated_at: string;
};

export type CleanupLogEvent = {
  event: 'cleanup_claimed' | 'cleanup_completed' | 'cleanup_retry_scheduled' | 'cleanup_manual_review' | 'cleanup_backlog_summary';
  jobId?: string;
  objectKind?: CleanupObjectKind;
  attempt?: number;
  durationMs?: number;
  result?: string;
  errorCode?: string;
  count?: number;
  pending?: number;
  processing?: number;
  retryable?: number;
  completed?: number;
  manualReview?: number;
  staleProcessing?: number;
};

export type CleanupLogger = (event: CleanupLogEvent) => void;

export type CleanupReport = {
  total: number;
  pending: number;
  processing: number;
  retryable: number;
  completed: number;
  manualReview: number;
  staleProcessing: number;
  legacy: number;
  oldestPendingAt: string | null;
};

export type CleanupDrainOptions = {
  limit?: number;
  concurrency?: number;
  ownerUserId?: string;
  entityId?: string;
  keys?: ReadonlySet<string>;
  now?: Date;
  apply?: boolean;
  logger?: CleanupLogger;
};

export type CleanupDrainResult = {
  selected: number;
  claimed: number;
  completed: number;
  retryable: number;
  manualReview: number;
  lostClaim: number;
  skipped: number;
};

const asIso = (value = new Date()) => value.toISOString();
const defaultCleanupLogger: CleanupLogger = (event) => console.log(JSON.stringify(event));

export function classifyCleanupKey(key: string): CleanupObjectKind {
  if (key.length === 0 || key.length > MAX_CLEANUP_KEY_LENGTH || key.split('/').length > 8) return 'legacy';
  if (new RegExp(`^inbound/${DATE}/${SEGMENT}/message\\.eml$`, 'u').test(key)) return 'raw';
  if (new RegExp(`^inbound/${DATE}/${SEGMENT}/attachments/${SEGMENT}/[^/]+$`, 'u').test(key)) return 'attachment';
  if (new RegExp(`^outbound/v1/${DATE}/${UUID}/${UUID}\\.bin$`, 'u').test(key)) return 'attachment';
  if (new RegExp(`^body/v1/${SEGMENT}/${SEGMENT}/${SEGMENT}-[a-f0-9]{64}\\.json$`, 'u').test(key)) return 'body';
  return 'legacy';
}

function safeEntitySegment(value: string) {
  return value.replace(/[^A-Za-z0-9_-]/gu, '_').slice(0, 128) || 'unknown';
}

export function cleanupKeyHasEntityScope(key: string, entityId: string, sourceId: string | null) {
  const kind = classifyCleanupKey(key);
  const parts = key.split('/');
  if (!sourceId) return false;
  if (kind === 'raw') return parts[2] === entityId && sourceId === entityId;
  if (kind === 'attachment' && parts[0] === 'inbound') return parts[2] === entityId && parts[4] === sourceId;
  if (kind === 'body') return parts[3] === safeEntitySegment(entityId) && parts[4]?.startsWith(`${sourceId}-`) === true;
  // Outbound attachment keys carry the attachment id, not the parent message
  // id. The caller must establish its owner/entity relation from D1 before the
  // parent row is removed.
  return kind === 'attachment' && parts[0] === 'outbound' && parts[3] === sourceId;
}

export function cleanupBackoffMs(attempt: number) {
  const exponent = Math.max(0, Math.min(20, Math.trunc(attempt) - 1));
  return Math.min(CLEANUP_BACKOFF_MAX_MS, CLEANUP_BACKOFF_BASE_MS * (2 ** exponent));
}

function safeErrorCode(value: string) {
  return SAFE_ERROR_CODES.has(value) ? value : 'r2_delete_failed';
}

export function createCleanupEnqueueStatement(
  db: D1Database,
  input: {
    id: string;
    ownerUserId: string;
    entityId: string;
    sourceId: string;
    sourceOwnerUserId: string;
    sourceEntityId: string;
    r2Key: string;
    now?: string;
    maxAttempts?: number;
  }
) {
  const now = input.now ?? asIso();
  const maxAttempts = Number.isSafeInteger(input.maxAttempts) && (input.maxAttempts ?? 0) > 0
    ? input.maxAttempts
    : CLEANUP_DEFAULT_MAX_ATTEMPTS;
  const relationValid = input.sourceOwnerUserId === input.ownerUserId && input.sourceEntityId === input.entityId;
  const objectKind = relationValid && cleanupKeyHasEntityScope(input.r2Key, input.entityId, input.sourceId) ? classifyCleanupKey(input.r2Key) : 'legacy';
  const initialStatus = objectKind === 'legacy' ? 'manual_review' : 'pending';
  const initialError = objectKind === 'legacy' ? 'invalid_key_scope' : null;
  return db.prepare(`
    INSERT INTO workspace_r2_cleanup_queue
      (id, owner_user_id, entity_id, r2_key, reason, status, attempt_count, max_attempts,
       next_attempt_at, object_kind, source_id, source_owner_user_id, source_entity_id, last_error, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'trash_delete', ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(r2_key) DO NOTHING
  `).bind(input.id, input.ownerUserId, input.entityId, input.r2Key, initialStatus, maxAttempts, now, objectKind, input.sourceId, input.sourceOwnerUserId, input.sourceEntityId, initialError, now, now);
}

function boundedLimit(value: number | undefined) {
  if (value === undefined) return CLEANUP_DEFAULT_LIMIT;
  return Math.max(1, Math.min(500, Math.trunc(value)));
}

export async function getCleanupReport(db: D1Database, now = new Date(), logger?: CleanupLogger): Promise<CleanupReport> {
  const timestamp = asIso(now);
  const result = await db.prepare(`
    SELECT status, object_kind, COUNT(*) AS count,
      MIN(CASE WHEN status IN ('pending', 'retryable', 'processing') THEN created_at END) AS oldest_pending_at
    FROM workspace_r2_cleanup_queue
    GROUP BY status, object_kind
  `).all<{ status: CleanupStatus; object_kind: CleanupObjectKind; count: number; oldest_pending_at: string | null }>();
  const rows = result.results ?? [];
  const counts = (status: CleanupStatus) => rows.filter((row) => row.status === status).reduce((sum, row) => sum + Number(row.count || 0), 0);
  const staleResult = await db.prepare(`
    SELECT COUNT(*) AS count FROM workspace_r2_cleanup_queue
    WHERE status = 'processing' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
  `).bind(timestamp).first<{ count: number }>();
  const oldest = rows.map((row) => row.oldest_pending_at).filter((value): value is string => Boolean(value)).sort()[0] ?? null;
  const report: CleanupReport = {
    total: rows.reduce((sum, row) => sum + Number(row.count || 0), 0),
    pending: counts('pending'),
    processing: counts('processing'),
    retryable: counts('retryable'),
    completed: counts('completed'),
    manualReview: counts('manual_review'),
    staleProcessing: Number(staleResult?.count ?? 0),
    legacy: rows.filter((row) => row.object_kind === 'legacy').reduce((sum, row) => sum + Number(row.count || 0), 0),
    oldestPendingAt: oldest
  };
  logger?.({ event: 'cleanup_backlog_summary', pending: report.pending, processing: report.processing, retryable: report.retryable, completed: report.completed, manualReview: report.manualReview, staleProcessing: report.staleProcessing, count: report.total });
  return report;
}

async function recoverStaleJobs(db: D1Database, now: string) {
  return db.prepare(`
    UPDATE workspace_r2_cleanup_queue
    SET status = CASE WHEN attempt_count >= max_attempts THEN 'manual_review' ELSE 'retryable' END,
        next_attempt_at = ?, claim_token = NULL, lease_expires_at = NULL,
        last_error = CASE WHEN attempt_count >= max_attempts THEN 'stale_lease' ELSE 'stale_lease' END,
        updated_at = ?
    WHERE status = 'processing' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
  `).bind(now, now, now).run();
}

async function markExhaustedJobs(db: D1Database, now: string) {
  return db.prepare(`
    UPDATE workspace_r2_cleanup_queue
    SET status = 'manual_review', last_error = 'r2_delete_failed',
        claim_token = NULL, lease_expires_at = NULL, updated_at = ?
    WHERE status IN ('pending', 'retryable') AND attempt_count >= max_attempts
  `).bind(now).run();
}

async function candidateRows(db: D1Database, options: CleanupDrainOptions, now: string) {
  const conditions = [
    `status IN ('pending', 'retryable')`,
    `object_kind <> 'legacy'`,
    `attempt_count < max_attempts`,
    `(next_attempt_at IS NULL OR next_attempt_at <= ?)`
  ];
  const values: unknown[] = [now];
  if (options.ownerUserId) { conditions.push('owner_user_id = ?'); values.push(options.ownerUserId); }
  if (options.entityId) { conditions.push('entity_id = ?'); values.push(options.entityId); }
  if (options.keys?.size) {
    conditions.push(`r2_key IN (${Array.from(options.keys).map(() => '?').join(', ')})`);
    values.push(...Array.from(options.keys));
  }
  const result = await db.prepare(`
    SELECT id, owner_user_id, entity_id, r2_key, reason, status, attempt_count, max_attempts,
      next_attempt_at, claim_token, lease_expires_at, last_error, completed_at, object_kind, source_id,
      source_owner_user_id, source_entity_id,
      created_at, updated_at
    FROM workspace_r2_cleanup_queue
    WHERE ${conditions.join(' AND ')}
    ORDER BY next_attempt_at ASC, created_at ASC, id ASC
    LIMIT ?
  `).bind(...values, boundedLimit(options.limit)).all<CleanupQueueRow>();
  return result.results ?? [];
}

async function claimJob(db: D1Database, row: CleanupQueueRow, now: string) {
  const token = crypto.randomUUID();
  const lease = new Date(Date.parse(now) + CLEANUP_LEASE_MS).toISOString();
  const result = await db.prepare(`
    UPDATE workspace_r2_cleanup_queue
    SET status = 'processing', attempt_count = attempt_count + 1,
        claim_token = ?, lease_expires_at = ?, updated_at = ?
    WHERE id = ? AND status IN ('pending', 'retryable')
      AND object_kind <> 'legacy' AND attempt_count < max_attempts
      AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
  `).bind(token, lease, now, row.id, now).run();
  if (Number(result.meta?.changes ?? 0) !== 1) return null;
  const claimed = await db.prepare(`
    SELECT id, owner_user_id, entity_id, r2_key, reason, status, attempt_count, max_attempts,
      next_attempt_at, claim_token, lease_expires_at, last_error, completed_at, object_kind, source_id,
      source_owner_user_id, source_entity_id,
      created_at, updated_at
    FROM workspace_r2_cleanup_queue WHERE id = ? AND claim_token = ? AND status = 'processing'
  `).bind(row.id, token).first<CleanupQueueRow>();
  return claimed ?? null;
}

async function finalizeJob(db: D1Database, job: CleanupQueueRow, now: string) {
  const result = await db.prepare(`
    UPDATE workspace_r2_cleanup_queue
    SET status = 'completed', completed_at = ?, claim_token = NULL,
        lease_expires_at = NULL, last_error = NULL, updated_at = ?
    WHERE id = ? AND status = 'processing' AND claim_token = ?
  `).bind(now, now, job.id, job.claim_token).run();
  return Number(result.meta?.changes ?? 0) === 1;
}

async function failJob(db: D1Database, job: CleanupQueueRow, now: string, errorCode: string) {
  const safe = safeErrorCode(errorCode);
  const terminal = job.attempt_count >= job.max_attempts;
  const next = new Date(Date.parse(now) + cleanupBackoffMs(job.attempt_count)).toISOString();
  const result = await db.prepare(`
    UPDATE workspace_r2_cleanup_queue
    SET status = ?, next_attempt_at = ?, claim_token = NULL,
        lease_expires_at = NULL, last_error = ?, updated_at = ?
    WHERE id = ? AND status = 'processing' AND claim_token = ?
  `).bind(terminal ? 'manual_review' : 'retryable', next, safe, now, job.id, job.claim_token).run();
  return { changed: Number(result.meta?.changes ?? 0) === 1, terminal, errorCode: safe };
}

async function quarantineJob(db: D1Database, job: CleanupQueueRow, now: string, errorCode: string) {
  const result = await db.prepare(`
    UPDATE workspace_r2_cleanup_queue
    SET status = 'manual_review', last_error = ?, claim_token = NULL,
        lease_expires_at = NULL, updated_at = ?
    WHERE id = ? AND status = 'processing' AND claim_token = ?
  `).bind(safeErrorCode(errorCode), now, job.id, job.claim_token).run();
  return Number(result.meta?.changes ?? 0) === 1;
}

async function processJob(env: CloudflareEnv | undefined, db: D1Database, job: CleanupQueueRow, options: CleanupDrainOptions, result: CleanupDrainResult) {
  const startedAt = Date.now();
  const logger = options.logger ?? defaultCleanupLogger;
  const now = asIso(options.now ?? new Date());
  if (job.source_owner_user_id !== job.owner_user_id || job.source_entity_id !== job.entity_id || classifyCleanupKey(job.r2_key) !== job.object_kind || !cleanupKeyHasEntityScope(job.r2_key, job.entity_id, job.source_id)) {
    const quarantined = await quarantineJob(db, job, now, 'invalid_key_scope');
    if (quarantined) result.manualReview += 1; else result.lostClaim += 1;
    logger?.({ event: 'cleanup_manual_review', jobId: job.id, objectKind: job.object_kind, attempt: job.attempt_count, durationMs: Date.now() - startedAt, result: quarantined ? 'invalid_key_scope' : 'lost_claim', errorCode: 'invalid_key_scope' });
    return;
  }
  if (!env?.BUCKET) {
    const failed = await failJob(db, job, now, 'r2_unavailable');
    if (failed.changed && failed.terminal) result.manualReview += 1;
    else if (failed.changed) result.retryable += 1;
    else result.lostClaim += 1;
    logger?.({ event: failed.terminal ? 'cleanup_manual_review' : 'cleanup_retry_scheduled', jobId: job.id, objectKind: job.object_kind, attempt: job.attempt_count, durationMs: Date.now() - startedAt, result: failed.changed ? 'r2_unavailable' : 'lost_claim', errorCode: failed.errorCode });
    return;
  }
  try {
    await env.BUCKET.delete(job.r2_key);
  } catch {
    const failed = await failJob(db, job, now, 'r2_delete_failed');
    if (failed.changed && failed.terminal) result.manualReview += 1;
    else if (failed.changed) result.retryable += 1;
    else result.lostClaim += 1;
    logger?.({ event: failed.terminal ? 'cleanup_manual_review' : 'cleanup_retry_scheduled', jobId: job.id, objectKind: job.object_kind, attempt: job.attempt_count, durationMs: Date.now() - startedAt, result: failed.changed ? failed.errorCode : 'lost_claim', errorCode: failed.errorCode });
    return;
  }
  let completed = false;
  try { completed = await finalizeJob(db, job, now); } catch { completed = false; }
  if (completed) {
    result.completed += 1;
    logger?.({ event: 'cleanup_completed', jobId: job.id, objectKind: job.object_kind, attempt: job.attempt_count, durationMs: Date.now() - startedAt, result: 'completed' });
  } else {
    result.lostClaim += 1;
    logger?.({ event: 'cleanup_retry_scheduled', jobId: job.id, objectKind: job.object_kind, attempt: job.attempt_count, durationMs: Date.now() - startedAt, result: 'lost_claim', errorCode: 'lost_claim' });
  }
}

export async function drainCleanupQueue(env: CloudflareEnv | undefined, db: D1Database, options: CleanupDrainOptions = {}): Promise<CleanupDrainResult> {
  const now = asIso(options.now ?? new Date());
  const result: CleanupDrainResult = { selected: 0, claimed: 0, completed: 0, retryable: 0, manualReview: 0, lostClaim: 0, skipped: 0 };
  if (options.apply !== true) {
    result.selected = (await candidateRows(db, options, now)).length;
    return result;
  }
  await recoverStaleJobs(db, now);
  await markExhaustedJobs(db, now);
  const candidates = await candidateRows(db, options, now);
  result.selected = candidates.length;
  let cursor = 0;
  const concurrency = Math.max(1, Math.min(CLEANUP_DEFAULT_CONCURRENCY, Math.trunc(options.concurrency ?? CLEANUP_DEFAULT_CONCURRENCY)));
  const worker = async () => {
    while (cursor < candidates.length) {
      const row = candidates[cursor++];
      if (!row) return;
      const job = await claimJob(db, row, now);
      if (!job) { result.skipped += 1; continue; }
      result.claimed += 1;
      (options.logger ?? defaultCleanupLogger)({ event: 'cleanup_claimed', jobId: job.id, objectKind: job.object_kind, attempt: job.attempt_count });
      await processJob(env, db, job, options, result);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, () => worker()));
  return result;
}

export async function retryManualCleanupJobs(db: D1Database, options: { limit?: number; maxAttempts?: number; now?: Date } = {}) {
  const now = asIso(options.now ?? new Date());
  const maxAttempts = Number.isSafeInteger(options.maxAttempts) && (options.maxAttempts ?? 0) > 0 ? options.maxAttempts : CLEANUP_DEFAULT_MAX_ATTEMPTS;
  return db.prepare(`
    UPDATE workspace_r2_cleanup_queue
    SET status = 'retryable', attempt_count = 0, max_attempts = ?,
        next_attempt_at = ?, claim_token = NULL, lease_expires_at = NULL,
        last_error = NULL, completed_at = NULL, updated_at = ?
    WHERE id IN (
      SELECT id FROM workspace_r2_cleanup_queue
      WHERE status = 'manual_review' AND object_kind <> 'legacy'
      ORDER BY created_at ASC, id ASC LIMIT ?
    )
  `).bind(maxAttempts, now, now, boundedLimit(options.limit)).run();
}
