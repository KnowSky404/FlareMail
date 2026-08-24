import { describe, expect, test } from 'bun:test';
import {
  bodyMetadataDeleteSql,
  cutoffIso,
  cleanupCandidateSql,
  cleanupQueueSummary,
  cleanupReportSql,
  configuredCleanupBucket,
  d1Changes,
  d1Count,
  d1StatementResults,
  isManagedR2Key,
  maintenanceD1TargetFlag,
  maintenanceSql,
  metadataDeleteSql,
  orphanKeys,
  parseMaintenanceArgs,
  referencedKeys
} from './maintenance';

describe('maintenance CLI safety helpers', () => {
  test('defaults to local dry-run without reading secrets into options output', () => {
    const options = parseMaintenanceArgs([]);
    expect(options.remote).toBe(false);
    expect(options.apply).toBe(false);
    expect(options.r2Manifest).toBeNull();
    expect(options.trashRetentionDays).toBe(30);
  });

  test('builds bounded, escaped cleanup SQL', () => {
    const cutoff = cutoffIso(new Date('2026-08-13T00:00:00.000Z'), 30);
    const sql = maintenanceSql({ sessions: cutoff, webhookEvents: cutoff });
    expect(sql.sessionCandidates).toContain('COUNT(*) AS count');
    expect(sql.apply).toContain('DELETE FROM workspace_sessions');
    expect(sql.apply).toContain('DELETE FROM workspace_outbound_events');
    expect(sql.apply).toContain('DELETE FROM workspace_inbound_ingest_claims');
    expect(sql.staleClaimCandidates).toContain('workspace_inbound_ingest_claims');
    expect(sql.expiredReviewCandidates).toContain('24 hours');
    expect(sql.cleanupQueueKeys).toContain('workspace_r2_cleanup_queue');
    expect(sql.apply).not.toContain('DROP');
    expect(sql.trashCandidates).toContain('deleted_at');
  });

  test('parses D1 counts, changes and referenced keys without exposing rows', () => {
    expect(d1Count({ results: [{ count: 3 }] })).toBe(3);
    expect(d1Changes([{ meta: { changes: 2 } }, { meta: { changes: 1 } }])).toBe(3);
    expect(referencedKeys({ results: [{ key: 'inbound/one/message.eml' }, { key: '' }] })).toEqual(new Set(['inbound/one/message.eml']));
  });

  test('preserves and validates ordered D1 batch result sets', () => {
    const results = [
      { results: [{ count: 1 }], success: true, meta: { changes: 0 } },
      { results: [{ count: 2 }], success: true, meta: { changes: 0 } }
    ];
    expect(d1StatementResults(results, 2)).toEqual(results);
    expect(d1StatementResults({ result: results }, 2)).toEqual(results);
    expect(() => d1StatementResults(results, 1)).toThrow('2 result set(s) for 1 statement(s)');
    expect(() => d1StatementResults([{ success: false }], 1)).toThrow('1 result set(s) for 1 statement(s)');
  });

  test('reports only unreferenced keys and restricts apply deletion shape', () => {
    const objects = [
      { key: 'inbound/2026-08-01/abc/message.eml' },
      { key: 'inbound/2026-08-01/def/attachments/a/file.txt' },
      { key: 'unmanaged/important.txt' }
    ];
    expect(orphanKeys(objects, new Set(['inbound/2026-08-01/abc/message.eml']))).toEqual(objects.slice(1));
    expect(isManagedR2Key(objects[1].key)).toBe(true);
    expect(isManagedR2Key(`body/v1/workspace_message/message-1/object-id-${'a'.repeat(64)}.json`)).toBe(true);
    expect(isManagedR2Key('outbound/v1/2026-08-19/019d1234-5678-4abc-8def-0123456789ab/019d1234-5678-4abc-8def-1123456789ab.bin')).toBe(true);
    expect(isManagedR2Key(objects[2].key)).toBe(false);
  });

  test('deletes metadata only for reviewed managed body keys', () => {
    const key = `body/v1/draft/draft-1/object-id-${'a'.repeat(64)}.json`;
    expect(bodyMetadataDeleteSql([key, key, 'unmanaged/private'])).toEqual([
      `DELETE FROM mail_body_objects WHERE state = 'delete_pending' AND r2_key IN ('${key}')`
    ]);
  });

  test('deletes only expired outbound lifecycle metadata after the reviewed object delete', () => {
    const key = 'outbound/v1/2026-08-19/019d1234-5678-4abc-8def-0123456789ab/019d1234-5678-4abc-8def-1123456789ab.bin';
    expect(metadataDeleteSql([key, 'outbound/v1/not-managed.bin'])).toEqual([
      `DELETE FROM workspace_attachments WHERE state IN ('uploading', 'failed', 'delete_pending') AND r2_key IN ('${key}')`
    ]);
  });

  test('parses bounded cleanup commands with safe dry-run defaults', () => {
    expect(parseMaintenanceArgs(['cleanup-report'])).toMatchObject({ command: 'cleanup-report', apply: false, cleanupLimit: 50, cleanupMaxAttempts: 8 });
    expect(parseMaintenanceArgs(['cleanup-drain', '--limit', '7', '--max-attempts', '3', '--json'])).toMatchObject({ command: 'cleanup-drain', cleanupLimit: 7, cleanupMaxAttempts: 3, json: true });
    expect(() => parseMaintenanceArgs(['cleanup-drain', '--limit', '0'])).toThrow('--limit');
    expect(() => parseMaintenanceArgs(['cleanup-drain', '--limit', '501'])).toThrow('--limit');
    expect(() => parseMaintenanceArgs(['cleanup-drain', '--bucket', 'other-bucket'])).toThrow('--bucket');
  });

  test('derives cleanup buckets only from the selected BUCKET binding', () => {
    const localConfig = `[vars]\nAPP_ENV = "development"\n\n[[r2_buckets]]\nbinding = "BUCKET"\nbucket_name = "mail-local"\npreview_bucket_name = "mail-preview"`;
    const previewConfig = localConfig.replace('development', 'preview');
    expect(configuredCleanupBucket(localConfig, false)).toBe('mail-local');
    expect(configuredCleanupBucket(previewConfig, true)).toBe('mail-preview');
    expect(() => configuredCleanupBucket(`[vars]\nAPP_ENV = "production"\n\n[[r2_buckets]]\nbinding = "BUCKET"\nbucket_name = "mail-production"`, true)).toThrow('Production cleanup is refused');
    expect(() => configuredCleanupBucket(localConfig, true)).toThrow('APP_ENV=preview');
    expect(maintenanceD1TargetFlag({ command: 'cleanup-report', remote: true })).toBe('--preview');
    expect(maintenanceD1TargetFlag({ command: 'retention', remote: true })).toBe('--remote');
    expect(maintenanceD1TargetFlag({ command: 'cleanup-drain', remote: false })).toBe('--local');
  });

  test('cleanup SQL is bounded and never selects legacy keys for automatic deletion', () => {
    const now = '2026-08-20T00:00:00.000Z';
    expect(cleanupCandidateSql(now, 10)).toContain("object_kind <> 'legacy'");
    expect(cleanupCandidateSql(now, 10)).toContain('LIMIT 10');
    expect(cleanupReportSql(now).counts).toContain('GROUP BY status, object_kind');
    expect(cleanupReportSql(now).stale).toContain('lease_expires_at');
  });

  test('counts only non-legacy manual-review rows as retry eligible', () => {
    expect(cleanupQueueSummary({ results: [
      { status: 'manual_review', object_kind: 'legacy', count: 3 },
      { status: 'manual_review', object_kind: 'attachment', count: 2 },
      { status: 'completed', object_kind: 'raw', count: 4 }
    ] }, { results: [{ count: 1 }] })).toMatchObject({
      total: 9,
      manualReview: 5,
      retryEligible: 2,
      legacy: 3,
      staleProcessing: 1
    });
  });
});
