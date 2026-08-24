import { readFile } from 'node:fs/promises';
import {
  createLocalWranglerEnvironment,
  inheritWranglerEnvironment
} from './wrangler-environment';
import {
  CLEANUP_BACKOFF_MAX_MS,
  CLEANUP_DEFAULT_LIMIT,
  CLEANUP_DEFAULT_MAX_ATTEMPTS,
  classifyCleanupKey,
  cleanupKeyHasEntityScope,
  cleanupBackoffMs
} from '../src/lib/server/workspace/r2-cleanup';

type MaintenanceOptions = {
  command: 'retention' | 'cleanup-report' | 'cleanup-drain' | 'cleanup-retry';
  remote: boolean;
  apply: boolean;
  json: boolean;
  config: string;
  database: string;
  bucket: string;
  sessionRetentionDays: number;
  webhookRetentionDays: number;
  trashRetentionDays: number;
  r2Manifest: string | null;
  cleanupLimit: number;
  cleanupMaxAttempts: number;
};

type R2Object = { key: string; size?: number; uploaded?: string };

type MaintenanceReport = {
  mode: 'dry-run' | 'apply';
  target: 'local' | 'remote';
  cutoffs: { sessions: string; webhookEvents: string; trash: string };
  sessions: { candidates: number; deleted: number };
  webhookEvents: { candidates: number; deleted: number };
  trash: { candidates: number; deleted: number; note: string };
  staleClaims: { candidates: number; deleted: number };
  deliveryReview: { staleSubmitting: number; approachingExpiry: number; expiredReviewRequired: number };
  r2: {
    inventory: 'manifest' | 'unavailable';
    referenced: number;
    objects: number | null;
    orphaned: number | null;
    deleted: number;
    metadataDeleted: number;
    expiredAttachmentRows: number;
    cleanupQueueRows: number;
    skippedUnsafeDeletes: number;
    note?: string;
  };
};

const usage = `Usage: bun scripts/maintenance.ts [options]

Options:
  --remote                       Target remote D1/R2 (default: local)
  --apply                        Apply deletes (requires explicit --apply)
  --config <path>               Wrangler config path
  --database <name>             D1 database name (default: flaremail-db)
  --bucket <name>               R2 bucket name (default: flaremail-bucket)
  --session-retention-days <n>  Keep revoked/expired sessions for n days (default: 30)
  --webhook-retention-days <n>  Keep webhook events for n days (default: 180)
  --trash-retention-days <n>    Report trash older than n days (default: 30; dry-run)
  --r2-manifest <path>          JSON inventory of R2 objects (for offline/reviewed runs)
  cleanup-report                Report queue counts without exposing object keys
  cleanup-drain                 Drain a bounded queue batch (dry-run unless --apply)
  cleanup-retry                 Requeue a bounded manual-review batch (dry-run unless --apply)
  --limit <n>                   Cleanup batch size (default: 50)
  --max-attempts <n>            Cleanup attempt ceiling (default: 8)
  --dry-run                     Explicitly keep cleanup commands read-only
  --json                        Print machine-readable output
  --help                        Show this help

R2 cleanup always requires a separately reviewed JSON inventory. Without one,
R2 is reported as unavailable and no R2 deletion can occur.
`;

const hasFlag = (args: string[], flag: string) => args.includes(flag);

function optionValue(args: string[], flag: string) {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value.`);
  return value;
}

function positiveDays(value: string | undefined, flag: string, fallback: number) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 36_500) {
    throw new Error(`${flag} must be an integer between 0 and 36500.`);
  }
  return parsed;
}

function boundedPositive(value: string | undefined, flag: string, fallback: number, maximum: number) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${flag} must be an integer between 1 and ${maximum}.`);
  }
  return parsed;
}

export function parseMaintenanceArgs(args: string[]): MaintenanceOptions {
  if (hasFlag(args, '--help')) {
    console.log(usage);
    process.exit(0);
  }
  const remote = hasFlag(args, '--remote');
  const apply = hasFlag(args, '--apply');
  const command = (args.find((arg) => ['cleanup-report', 'cleanup-drain', 'cleanup-retry'].includes(arg)) ?? 'retention') as MaintenanceOptions['command'];
  const config = optionValue(args, '--config') ?? (remote ? 'wrangler.deploy.toml' : 'wrangler.toml');
  const bucketOption = optionValue(args, '--bucket');
  if (command !== 'retention' && bucketOption !== undefined) throw new Error('--bucket is not accepted by cleanup commands; use the configured FlareMail BUCKET binding.');
  return {
    remote,
    apply,
    command,
    json: hasFlag(args, '--json'),
    config,
    database: optionValue(args, '--database') ?? 'flaremail-db',
    bucket: bucketOption ?? 'flaremail-bucket',
    sessionRetentionDays: positiveDays(optionValue(args, '--session-retention-days'), '--session-retention-days', 30),
    webhookRetentionDays: positiveDays(optionValue(args, '--webhook-retention-days'), '--webhook-retention-days', 180),
    trashRetentionDays: positiveDays(optionValue(args, '--trash-retention-days'), '--trash-retention-days', 30),
    r2Manifest: optionValue(args, '--r2-manifest') ?? null,
    cleanupLimit: boundedPositive(optionValue(args, '--limit'), '--limit', CLEANUP_DEFAULT_LIMIT, 500),
    cleanupMaxAttempts: boundedPositive(optionValue(args, '--max-attempts'), '--max-attempts', CLEANUP_DEFAULT_MAX_ATTEMPTS, 100)
  };
}

function configuredValue(source: string, key: string) {
  return source.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"\\s*$`, 'mu'))?.[1] ?? null;
}

export function configuredCleanupBucket(source: string, remote: boolean) {
  const vars = source.split(/^\[vars\]\s*$/mu)[1]?.split(/^\[/mu, 1)[0] ?? '';
  const appEnv = configuredValue(vars, 'APP_ENV')?.toLowerCase() ?? null;
  if (appEnv === 'production') throw new Error('Production cleanup is refused; use a separately reviewed operator workflow.');
  if (remote && appEnv !== 'preview') throw new Error('Remote cleanup requires an explicit APP_ENV=preview config.');
  if (!remote && appEnv !== 'development' && appEnv !== 'test') throw new Error('Local cleanup requires an APP_ENV=development or test config.');
  const block = source.split(/^\[\[r2_buckets\]\]\s*$/mu).slice(1)
    .map((part) => part.split(/^\[\[/mu, 1)[0])
    .find((part) => configuredValue(part, 'binding') === 'BUCKET') ?? '';
  const key = remote && appEnv === 'preview' ? 'preview_bucket_name' : 'bucket_name';
  const bucket = configuredValue(block, key);
  if (!bucket || !/^[A-Za-z0-9][A-Za-z0-9._-]{1,62}$/u.test(bucket)) {
    throw new Error('The selected Wrangler config does not contain a valid FlareMail BUCKET binding.');
  }
  return bucket;
}

const sqlLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`;

export function cutoffIso(now = new Date(), retentionDays: number) {
  return new Date(now.getTime() - retentionDays * 86_400_000).toISOString();
}

export function maintenanceSql(cutoffs: { sessions: string; webhookEvents: string; trash?: string }) {
  const sessionCutoff = sqlLiteral(cutoffs.sessions);
  const webhookCutoff = sqlLiteral(cutoffs.webhookEvents);
  const trashCutoff = sqlLiteral(cutoffs.trash ?? cutoffs.sessions);
  return {
    sessionCandidates: `SELECT COUNT(*) AS count FROM workspace_sessions WHERE (revoked_at IS NOT NULL AND datetime(revoked_at) <= datetime(${sessionCutoff})) OR (expires_at IS NOT NULL AND datetime(expires_at) <= datetime(${sessionCutoff}))`,
    webhookCandidates: `SELECT COUNT(*) AS count FROM workspace_outbound_events WHERE datetime(created_at) <= datetime(${webhookCutoff})`,
    trashCandidates: `SELECT (SELECT COUNT(*) FROM workspace_messages WHERE deleted_at IS NOT NULL AND datetime(deleted_at) <= datetime(${trashCutoff})) + (SELECT COUNT(*) FROM workspace_drafts WHERE deleted_at IS NOT NULL AND datetime(deleted_at) <= datetime(${trashCutoff})) + (SELECT COUNT(*) FROM workspace_email_states WHERE deleted_at IS NOT NULL AND datetime(deleted_at) <= datetime(${trashCutoff})) AS count`,
    staleClaimCandidates: `SELECT COUNT(*) AS count FROM workspace_inbound_ingest_claims WHERE status = 'processing' AND datetime(updated_at) <= datetime('now', '-15 minutes')`,
    staleSubmittingCandidates: `SELECT COUNT(*) AS count FROM workspace_delivery_attempts WHERE status = 'submitting' AND completed_at IS NULL AND datetime(started_at) <= datetime('now', '-15 minutes')`,
    approachingExpiryCandidates: `SELECT COUNT(*) AS count FROM workspace_delivery_attempts WHERE status IN ('submitting', 'delayed', 'failed') AND datetime(started_at) > datetime('now', '-24 hours') AND datetime(started_at) <= datetime('now', '-23 hours')`,
    expiredReviewCandidates: `SELECT COUNT(*) AS count FROM workspace_delivery_attempts WHERE status IN ('submitting', 'delayed', 'failed') AND datetime(started_at) <= datetime('now', '-24 hours')`,
    expiredAttachmentKeys: `SELECT r2_key AS key FROM workspace_attachments WHERE state IN ('uploading', 'failed', 'delete_pending') AND delete_after IS NOT NULL AND datetime(delete_after) <= datetime('now')`,
    cleanupQueueKeys: `SELECT r2_key AS key FROM workspace_r2_cleanup_queue`,
    references: `SELECT raw_key AS key FROM email_messages WHERE raw_key <> '' UNION SELECT r2_key AS key FROM workspace_attachments WHERE r2_key <> '' AND (state = 'ready' OR (state IN ('uploading', 'failed', 'delete_pending') AND (delete_after IS NULL OR datetime(delete_after) > datetime('now')))) UNION SELECT r2_key AS key FROM mail_body_objects WHERE state = 'active' OR (state = 'delete_pending' AND (delete_after IS NULL OR datetime(delete_after) > datetime('now')))`,
    apply: `DELETE FROM workspace_sessions WHERE (revoked_at IS NOT NULL AND datetime(revoked_at) <= datetime(${sessionCutoff})) OR (expires_at IS NOT NULL AND datetime(expires_at) <= datetime(${sessionCutoff})); DELETE FROM workspace_outbound_events WHERE datetime(created_at) <= datetime(${webhookCutoff}); DELETE FROM workspace_inbound_ingest_claims WHERE status = 'processing' AND datetime(updated_at) <= datetime('now', '-15 minutes');`
  };
}

function parseJsonOutput(output: string): unknown {
  const trimmed = output.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const lines = trimmed.split('\n').map((line) => line.trim()).filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        return JSON.parse(lines[index]);
      } catch {
        // Wrangler may print a progress line before its JSON result.
      }
    }
  }
  throw new Error('The command did not return valid JSON.');
}

export function d1Rows(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap((item) => d1Rows(item));
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.results)) return record.results;
  if (Array.isArray(record.result)) return record.result.flatMap((item) => d1Rows(item));
  return [];
}

export function d1Count(value: unknown) {
  const row = d1Rows(value)[0];
  if (!row || typeof row !== 'object') return 0;
  const count = Number((row as Record<string, unknown>).count);
  return Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

export function d1Changes(value: unknown) {
  const values = Array.isArray(value) ? value : [value];
  return values.reduce((total, item) => {
    if (!item || typeof item !== 'object') return total;
    const meta = (item as Record<string, unknown>).meta;
    if (!meta || typeof meta !== 'object') return total;
    const changes = Number((meta as Record<string, unknown>).changes);
    return total + (Number.isSafeInteger(changes) && changes >= 0 ? changes : 0);
  }, 0);
}

export function d1StatementResults(value: unknown, expectedStatements: number) {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : null;
  const results = Array.isArray(value)
    ? value
    : record && Array.isArray(record.result)
      ? record.result
      : [value];
  if (results.length !== expectedStatements || results.some((item) => {
    if (!item || typeof item !== 'object') return true;
    const result = item as Record<string, unknown>;
    return result.success === false || (!Array.isArray(result.results) && !result.meta);
  })) {
    throw new Error(`D1 returned ${results.length} result set(s) for ${expectedStatements} statement(s).`);
  }
  return results;
}

export function maintenanceD1TargetFlag(options: Pick<MaintenanceOptions, 'command' | 'remote'>) {
  if (!options.remote) return '--local';
  return options.command === 'retention' ? '--remote' : '--preview';
}

export function referencedKeys(value: unknown) {
  return new Set(d1Rows(value).flatMap((row) => {
    if (!row || typeof row !== 'object') return [];
    const key = (row as Record<string, unknown>).key;
    return typeof key === 'string' && key.length > 0 ? [key] : [];
  }));
}

export function orphanKeys(objects: R2Object[], references: Set<string>) {
  const seen = new Set<string>();
  return objects.filter((object) => {
    if (!object.key || references.has(object.key) || seen.has(object.key)) return false;
    seen.add(object.key);
    return true;
  });
}

export function isManagedR2Key(key: string) {
  const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}';
  return new RegExp(`^(?:inbound\\/\\d{4}-\\d{2}-\\d{2}\\/[A-Za-z0-9_-]+(?:\\/message\\.eml|\\/attachments\\/[A-Za-z0-9_-]+\\/[^/]+)|outbound\\/v1\\/\\d{4}-\\d{2}-\\d{2}\\/${uuid}\\/${uuid}\\.bin|body\\/v1\\/[A-Za-z0-9_-]+\\/[A-Za-z0-9_-]+\\/[A-Za-z0-9_-]+-[a-f0-9]{64}\\.json)$`, 'u').test(key);
}

export function metadataDeleteSql(keys: string[]) {
  const bodyKeys = [...new Set(keys.filter((key) => /^body\/v1\//u.test(key) && isManagedR2Key(key)))];
  const attachmentKeys = [...new Set(keys.filter((key) => /^outbound\/v1\//u.test(key) && isManagedR2Key(key)))];
  const statements: string[] = [];
  for (let index = 0; index < bodyKeys.length; index += 50) {
    const values = bodyKeys.slice(index, index + 50).map(sqlLiteral).join(', ');
    statements.push(`DELETE FROM mail_body_objects WHERE state = 'delete_pending' AND r2_key IN (${values})`);
  }
  for (let index = 0; index < attachmentKeys.length; index += 50) {
    const values = attachmentKeys.slice(index, index + 50).map(sqlLiteral).join(', ');
    statements.push(`DELETE FROM workspace_attachments WHERE state IN ('uploading', 'failed', 'delete_pending') AND r2_key IN (${values})`);
  }
  // Cleanup queue rows are append-only lifecycle history. Keep completed and
  // retry/manual-review evidence; the queue drain owns status transitions.
  return statements;
}

export const bodyMetadataDeleteSql = metadataDeleteSql;

async function runWrangler(args: string[], remote: boolean) {
  const child = Bun.spawn(['bun', 'x', 'wrangler', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: remote ? inheritWranglerEnvironment() : createLocalWranglerEnvironment()
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited
  ]);
  if (exitCode !== 0) {
    void stderr;
    throw new Error(`Wrangler command failed with exit code ${exitCode}.`);
  }
  return stdout;
}

async function executeD1(options: MaintenanceOptions, sql: string, write = false) {
  const args = ['d1', 'execute', options.database, maintenanceD1TargetFlag(options), '--config', options.config, '--command', sql, '--json'];
  if (write) args.push('--yes');
  return parseJsonOutput(await runWrangler(args, options.remote));
}

async function executeD1Batch(options: MaintenanceOptions, statements: string[], write = false) {
  if (statements.length === 0) return [];
  const sql = statements.map((statement) => statement.replace(/;\s*$/u, '')).join('; ');
  return d1StatementResults(await executeD1(options, sql, write), statements.length);
}

function manifestKeys(value: unknown): R2Object[] {
  const source = Array.isArray(value) ? value : value && typeof value === 'object' && Array.isArray((value as Record<string, unknown>).objects)
    ? (value as Record<string, unknown>).objects
    : [];
  return source.flatMap((item) => {
    if (typeof item === 'string') return [{ key: item }];
    if (!item || typeof item !== 'object' || typeof (item as Record<string, unknown>).key !== 'string') return [];
    const record = item as Record<string, unknown>;
    return [{ key: record.key as string, ...(typeof record.size === 'number' ? { size: record.size } : {}), ...(typeof record.uploaded === 'string' ? { uploaded: record.uploaded } : {}) }];
  });
}

async function readManifest(path: string) {
  let content: string;
  try {
    content = await readFile(path, 'utf8');
  } catch {
    throw new Error(`Unable to read R2 manifest: ${path}.`);
  }
  try {
    return manifestKeys(JSON.parse(content));
  } catch {
    throw new Error(`R2 manifest is not valid JSON: ${path}.`);
  }
}

async function listR2Objects(options: MaintenanceOptions): Promise<{ inventory: MaintenanceReport['r2']['inventory']; objects: R2Object[]; note?: string }> {
  if (options.r2Manifest) return { inventory: 'manifest', objects: await readManifest(options.r2Manifest) };
  return {
    inventory: 'unavailable',
    objects: [],
    note: 'R2 orphan analysis requires a reviewed --r2-manifest inventory.'
  };
}

async function deleteR2Objects(options: MaintenanceOptions, objects: R2Object[]) {
  let deleted = 0;
  let skippedUnsafeDeletes = 0;
  const deletedKeys: string[] = [];
  for (const object of objects) {
    if (!isManagedR2Key(object.key)) {
      skippedUnsafeDeletes += 1;
      continue;
    }
    await runWrangler(
      ['r2', 'object', 'delete', `${options.bucket}/${object.key}`, options.remote ? '--remote' : '--local', '--config', options.config],
      options.remote
    );
    deleted += 1;
    deletedKeys.push(object.key);
  }
  return { deleted, skippedUnsafeDeletes, deletedKeys };
}

type CleanupMaintenanceReport = {
  command: 'cleanup-report' | 'cleanup-drain' | 'cleanup-retry';
  mode: 'dry-run' | 'apply';
  target: 'local' | 'remote';
  limit: number;
  maxAttempts: number;
  queue: {
    total: number;
    pending: number;
    processing: number;
    retryable: number;
    completed: number;
    manualReview: number;
    retryEligible: number;
    staleProcessing: number;
    legacy: number;
  };
  drain?: { selected: number; claimed: number; completed: number; retryable: number; manualReview: number; lostClaim: number; skipped: number };
  requeued?: number;
};

export function cleanupReportSql(now: string) {
  return {
    counts: `SELECT status, object_kind, COUNT(*) AS count FROM workspace_r2_cleanup_queue GROUP BY status, object_kind`,
    stale: `SELECT COUNT(*) AS count FROM workspace_r2_cleanup_queue WHERE status = 'processing' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ${sqlLiteral(now)}`
  };
}

export function cleanupCandidateSql(now: string, limit: number) {
  return `SELECT id, owner_user_id, entity_id, source_id, source_owner_user_id, source_entity_id, r2_key, status, attempt_count, max_attempts, object_kind FROM workspace_r2_cleanup_queue WHERE status IN ('pending', 'retryable') AND object_kind <> 'legacy' AND attempt_count < max_attempts AND (next_attempt_at IS NULL OR next_attempt_at <= ${sqlLiteral(now)}) ORDER BY next_attempt_at ASC, created_at ASC, id ASC LIMIT ${Math.max(1, Math.min(500, Math.trunc(limit)))};`;
}

export function cleanupQueueSummary(countResult: unknown, staleResult: unknown) {
  const rows = d1Rows(countResult).flatMap((row) => {
    if (!row || typeof row !== 'object') return [];
    const value = row as Record<string, unknown>;
    return [{ status: String(value.status), objectKind: String(value.object_kind), count: Number(value.count ?? 0) }];
  });
  const count = (status: string) => rows.filter((row) => row.status === status).reduce((sum, row) => sum + row.count, 0);
  return {
    total: rows.reduce((sum, row) => sum + row.count, 0),
    pending: count('pending'),
    processing: count('processing'),
    retryable: count('retryable'),
    completed: count('completed'),
    manualReview: count('manual_review'),
    retryEligible: rows.filter((row) => row.status === 'manual_review' && row.objectKind !== 'legacy').reduce((sum, row) => sum + row.count, 0),
    staleProcessing: d1Count(staleResult),
    legacy: rows.filter((row) => row.objectKind === 'legacy').reduce((sum, row) => sum + row.count, 0)
  };
}

function cleanupLog(event: string, detail: Record<string, string | number>) {
  console.log(JSON.stringify({ event, ...detail }));
}

async function runCleanupMaintenance(options: MaintenanceOptions): Promise<CleanupMaintenanceReport> {
  let configSource: string;
  try { configSource = await readFile(options.config, 'utf8'); } catch {
    throw new Error('Unable to read the selected Wrangler config.');
  }
  options = { ...options, bucket: configuredCleanupBucket(configSource, options.remote) };
  const now = new Date().toISOString();
  const reportSql = cleanupReportSql(now);
  const [countResult, staleResult] = await executeD1Batch(options, [reportSql.counts, reportSql.stale]);
  const queue = cleanupQueueSummary(countResult, staleResult);
  const report: CleanupMaintenanceReport = {
    command: options.command as CleanupMaintenanceReport['command'],
    mode: options.apply ? 'apply' : 'dry-run',
    target: options.remote ? 'remote' : 'local',
    limit: options.cleanupLimit,
    maxAttempts: options.cleanupMaxAttempts,
    queue
  };
  if (options.command === 'cleanup-report') return report;
  if (options.command === 'cleanup-retry') {
    if (options.apply) {
      const result = await executeD1(options, `UPDATE workspace_r2_cleanup_queue SET status = 'retryable', attempt_count = 0, max_attempts = ${options.cleanupMaxAttempts}, next_attempt_at = ${sqlLiteral(now)}, claim_token = NULL, lease_expires_at = NULL, last_error = NULL, completed_at = NULL, updated_at = ${sqlLiteral(now)} WHERE id IN (SELECT id FROM workspace_r2_cleanup_queue WHERE status = 'manual_review' AND object_kind <> 'legacy' ORDER BY created_at ASC, id ASC LIMIT ${Math.max(1, Math.min(500, options.cleanupLimit))})`, true);
      report.requeued = d1Changes(result);
    } else report.requeued = Math.min(queue.retryEligible, options.cleanupLimit);
    return report;
  }
  if (!options.apply) {
    report.drain = { selected: d1Rows(await executeD1(options, cleanupCandidateSql(now, options.cleanupLimit))).length, claimed: 0, completed: 0, retryable: 0, manualReview: 0, lostClaim: 0, skipped: 0 };
    return report;
  }
  await executeD1(options, `UPDATE workspace_r2_cleanup_queue SET status = CASE WHEN attempt_count >= max_attempts THEN 'manual_review' ELSE 'retryable' END, next_attempt_at = ${sqlLiteral(now)}, claim_token = NULL, lease_expires_at = NULL, last_error = 'stale_lease', updated_at = ${sqlLiteral(now)} WHERE status = 'processing' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ${sqlLiteral(now)}`, true);
  await executeD1(options, `UPDATE workspace_r2_cleanup_queue SET status = 'manual_review', last_error = 'r2_delete_failed', updated_at = ${sqlLiteral(now)} WHERE status IN ('pending', 'retryable') AND attempt_count >= max_attempts`, true);
  const candidates = d1Rows(await executeD1(options, cleanupCandidateSql(now, options.cleanupLimit))) as Array<Record<string, unknown>>;
  const drain = { selected: candidates.length, claimed: 0, completed: 0, retryable: 0, manualReview: 0, lostClaim: 0, skipped: 0 };
  for (const candidate of candidates) {
    const id = typeof candidate.id === 'string' ? candidate.id : '';
    const key = typeof candidate.r2_key === 'string' ? candidate.r2_key : '';
    const kind = typeof candidate.object_kind === 'string' ? candidate.object_kind : 'legacy';
    const entityId = typeof candidate.entity_id === 'string' ? candidate.entity_id : '';
    const sourceId = typeof candidate.source_id === 'string' ? candidate.source_id : '';
    const sourceOwnerUserId = typeof candidate.source_owner_user_id === 'string' ? candidate.source_owner_user_id : '';
    const sourceEntityId = typeof candidate.source_entity_id === 'string' ? candidate.source_entity_id : '';
    if (!id || !key || !entityId || !sourceId || sourceOwnerUserId !== String(candidate.owner_user_id ?? '') || sourceEntityId !== entityId || classifyCleanupKey(key) !== kind || !cleanupKeyHasEntityScope(key, entityId, sourceId)) {
      if (id) await executeD1(options, `UPDATE workspace_r2_cleanup_queue SET status = 'manual_review', last_error = 'invalid_key_scope', claim_token = NULL, lease_expires_at = NULL, updated_at = ${sqlLiteral(now)} WHERE id = ${sqlLiteral(id)} AND status IN ('pending', 'retryable')`, true);
      drain.manualReview += 1;
      continue;
    }
    const token = crypto.randomUUID();
    const lease = new Date(Date.parse(now) + 5 * 60 * 1000).toISOString();
    const claimed = await executeD1(options, `UPDATE workspace_r2_cleanup_queue SET status = 'processing', attempt_count = attempt_count + 1, claim_token = ${sqlLiteral(token)}, lease_expires_at = ${sqlLiteral(lease)}, updated_at = ${sqlLiteral(now)} WHERE id = ${sqlLiteral(id)} AND status IN ('pending', 'retryable') AND object_kind <> 'legacy' AND attempt_count < max_attempts AND (next_attempt_at IS NULL OR next_attempt_at <= ${sqlLiteral(now)})`, true);
    if (d1Changes(claimed) !== 1) { drain.skipped += 1; continue; }
    drain.claimed += 1;
    const started = Date.now();
    try {
      await runWrangler(['r2', 'object', 'delete', `${options.bucket}/${key}`, options.remote ? '--remote' : '--local', '--config', options.config], options.remote);
      const finalized = await executeD1(options, `UPDATE workspace_r2_cleanup_queue SET status = 'completed', completed_at = ${sqlLiteral(now)}, claim_token = NULL, lease_expires_at = NULL, last_error = NULL, updated_at = ${sqlLiteral(now)} WHERE id = ${sqlLiteral(id)} AND status = 'processing' AND claim_token = ${sqlLiteral(token)}`, true);
      if (d1Changes(finalized) === 1) { drain.completed += 1; cleanupLog('cleanup_completed', { jobId: id, objectKind: kind, attempt: Number(candidate.attempt_count ?? 0) + 1, durationMs: Date.now() - started }); }
      else { drain.lostClaim += 1; }
    } catch {
      const attempt = Number(candidate.attempt_count ?? 0) + 1;
      const terminal = attempt >= Number(candidate.max_attempts ?? options.cleanupMaxAttempts);
      const next = new Date(Date.parse(now) + Math.min(CLEANUP_BACKOFF_MAX_MS, cleanupBackoffMs(attempt))).toISOString();
      const failed = await executeD1(options, `UPDATE workspace_r2_cleanup_queue SET status = ${sqlLiteral(terminal ? 'manual_review' : 'retryable')}, next_attempt_at = ${sqlLiteral(next)}, claim_token = NULL, lease_expires_at = NULL, last_error = 'r2_delete_failed', updated_at = ${sqlLiteral(now)} WHERE id = ${sqlLiteral(id)} AND status = 'processing' AND claim_token = ${sqlLiteral(token)}`, true);
      if (d1Changes(failed) === 1) {
        if (terminal) drain.manualReview += 1; else drain.retryable += 1;
        cleanupLog(terminal ? 'cleanup_manual_review' : 'cleanup_retry_scheduled', { jobId: id, objectKind: kind, attempt, durationMs: Date.now() - started, errorCode: 'r2_delete_failed' });
      } else drain.lostClaim += 1;
    }
  }
  report.drain = drain;
  return report;
}

function reportOutput(report: MaintenanceReport, json: boolean) {
  if (json) return console.log(JSON.stringify(report));
  console.log(`Maintenance ${report.mode} (${report.target})`);
  console.log(`Sessions: ${report.sessions.candidates} candidate(s), ${report.sessions.deleted} deleted.`);
  console.log(`Webhook events: ${report.webhookEvents.candidates} candidate(s), ${report.webhookEvents.deleted} deleted.`);
  console.log(`Trash: ${report.trash.candidates} candidate(s), ${report.trash.deleted} deleted (${report.trash.note}).`);
  console.log(`Inbound claims: ${report.staleClaims.candidates} stale candidate(s), ${report.staleClaims.deleted} deleted.`);
  console.log(`Delivery review: ${report.deliveryReview.staleSubmitting} stale submitting, ${report.deliveryReview.approachingExpiry} approaching expiry, ${report.deliveryReview.expiredReviewRequired} expired review-required.`);
  if (report.r2.objects === null) console.log(`R2: inventory unavailable (${report.r2.note ?? 'no inventory'}).`);
  else console.log(`R2: ${report.r2.objects} object(s), ${report.r2.orphaned} orphan(s), ${report.r2.deleted} deleted, ${report.r2.metadataDeleted} metadata row(s) deleted.`);
  console.log(`Outbound attachments: ${report.r2.expiredAttachmentRows} expired failed/delete-pending row(s).`);
  console.log(`R2 cleanup queue: ${report.r2.cleanupQueueRows} durable retry row(s).`);
  if (report.r2.skippedUnsafeDeletes > 0) console.log(`R2 skipped ${report.r2.skippedUnsafeDeletes} unmanaged object(s).`);
}

function cleanupReportOutput(report: CleanupMaintenanceReport, json: boolean) {
  if (json) return console.log(JSON.stringify(report));
  console.log(`Cleanup ${report.command} ${report.mode} (${report.target})`);
  console.log(`Queue: ${report.queue.pending} pending, ${report.queue.processing} processing, ${report.queue.retryable} retryable, ${report.queue.manualReview} manual review, ${report.queue.completed} completed.`);
  console.log(`Stale processing: ${report.queue.staleProcessing}; retry-eligible manual review: ${report.queue.retryEligible}; legacy/manual anomalies: ${report.queue.legacy}.`);
  if (report.drain) console.log(`Drain: ${report.drain.selected} selected, ${report.drain.claimed} claimed, ${report.drain.completed} completed, ${report.drain.retryable} retryable, ${report.drain.manualReview} manual review, ${report.drain.lostClaim} lost claim, ${report.drain.skipped} skipped.`);
  if (report.requeued !== undefined) console.log(`Requeued: ${report.requeued}.`);
}

export async function runMaintenance(options: MaintenanceOptions) {
  if (options.command !== 'retention') return runCleanupMaintenance(options);
  const cutoffs = {
    sessions: cutoffIso(new Date(), options.sessionRetentionDays),
    webhookEvents: cutoffIso(new Date(), options.webhookRetentionDays),
    trash: cutoffIso(new Date(), options.trashRetentionDays)
  };
  const sql = maintenanceSql(cutoffs);
  const [stateResults, r2Inventory] = await Promise.all([
    executeD1Batch(options, [
      sql.sessionCandidates,
      sql.webhookCandidates,
      sql.trashCandidates,
      sql.staleClaimCandidates,
      sql.staleSubmittingCandidates,
      sql.approachingExpiryCandidates,
      sql.expiredReviewCandidates,
      sql.references,
      sql.expiredAttachmentKeys,
      sql.cleanupQueueKeys
    ]),
    listR2Objects(options)
  ]);
  const [sessionCount, webhookCount, trashCount, staleClaimCount, staleSubmittingCount, approachingExpiryCount, expiredReviewCount, referencesResult, expiredAttachmentResult, cleanupQueueResult] = stateResults;
  const references = referencedKeys(referencesResult);
  const expiredAttachmentKeys = referencedKeys(expiredAttachmentResult);
  const cleanupQueueKeys = referencedKeys(cleanupQueueResult);
  const orphaned = r2Inventory.inventory === 'unavailable' ? [] : orphanKeys(r2Inventory.objects, references);
  const applyD1 = options.apply
    ? await executeD1Batch(options, sql.apply.split(';').map((statement) => statement.trim()).filter(Boolean), true)
    : null;
  const r2DeleteResult = options.apply && r2Inventory.inventory !== 'unavailable'
    ? await deleteR2Objects(options, orphaned)
    : { deleted: 0, skippedUnsafeDeletes: 0, deletedKeys: [] };
  const inventoryKeys = new Set(r2Inventory.objects.map((object) => object.key));
  const deletedKeys = new Set(r2DeleteResult.deletedKeys);
  const reconciledLifecycleKeys = r2Inventory.inventory === 'unavailable'
    ? []
    : [...new Set([...expiredAttachmentKeys, ...cleanupQueueKeys])]
      .filter((key) => !inventoryKeys.has(key) || deletedKeys.has(key));
  const metadataDeletes = options.apply
    ? await executeD1Batch(options, metadataDeleteSql([...r2DeleteResult.deletedKeys, ...reconciledLifecycleKeys]), true)
    : [];
  const report: MaintenanceReport = {
    mode: options.apply ? 'apply' : 'dry-run',
    target: options.remote ? 'remote' : 'local',
    cutoffs,
    sessions: { candidates: d1Count(sessionCount), deleted: options.apply ? d1Changes(applyD1?.[0]) : 0 },
    webhookEvents: { candidates: d1Count(webhookCount), deleted: options.apply ? d1Changes(applyD1?.[1]) : 0 },
    trash: { candidates: d1Count(trashCount), deleted: 0, note: 'Trash cleanup is intentionally dry-run here; use the owned trash API so body, attachment and R2 lifecycles are coordinated.' },
    staleClaims: { candidates: d1Count(staleClaimCount), deleted: options.apply ? d1Changes(applyD1?.[2]) : 0 },
    deliveryReview: {
      staleSubmitting: d1Count(staleSubmittingCount),
      approachingExpiry: d1Count(approachingExpiryCount),
      expiredReviewRequired: d1Count(expiredReviewCount)
    },
    r2: {
      inventory: r2Inventory.inventory,
      referenced: references.size,
      objects: r2Inventory.inventory === 'unavailable' ? null : r2Inventory.objects.length,
      orphaned: r2Inventory.inventory === 'unavailable' ? null : orphaned.length,
      deleted: r2DeleteResult.deleted,
      metadataDeleted: d1Changes(metadataDeletes),
      expiredAttachmentRows: expiredAttachmentKeys.size,
      cleanupQueueRows: cleanupQueueKeys.size,
      skippedUnsafeDeletes: r2DeleteResult.skippedUnsafeDeletes,
      ...(r2Inventory.note ? { note: r2Inventory.note } : {})
    }
  };
  return report;
}

if (import.meta.main) {
  try {
    const options = parseMaintenanceArgs(process.argv.slice(2));
    const report = await runMaintenance(options);
    if (options.command === 'retention') reportOutput(report as MaintenanceReport, options.json);
    else cleanupReportOutput(report as CleanupMaintenanceReport, options.json);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Maintenance failed.');
    process.exitCode = 1;
  }
}

export type { MaintenanceOptions, MaintenanceReport, R2Object, CleanupMaintenanceReport };
