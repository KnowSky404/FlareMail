import { describe, expect, test } from 'bun:test';
import {
  bodyMetadataDeleteSql,
  cutoffIso,
  d1Changes,
  d1Count,
  isManagedR2Key,
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
      `DELETE FROM mail_body_objects WHERE state = 'delete_pending' AND r2_key IN ('${key}')`,
      `DELETE FROM workspace_r2_cleanup_queue WHERE r2_key IN ('${key}')`
    ]);
  });

  test('deletes only expired outbound lifecycle metadata after the reviewed object delete', () => {
    const key = 'outbound/v1/2026-08-19/019d1234-5678-4abc-8def-0123456789ab/019d1234-5678-4abc-8def-1123456789ab.bin';
    expect(metadataDeleteSql([key, 'outbound/v1/not-managed.bin'])).toEqual([
      `DELETE FROM workspace_attachments WHERE state IN ('uploading', 'failed', 'delete_pending') AND r2_key IN ('${key}')`,
      `DELETE FROM workspace_r2_cleanup_queue WHERE r2_key IN ('${key}')`
    ]);
  });
});
