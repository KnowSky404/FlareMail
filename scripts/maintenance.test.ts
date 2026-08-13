import { describe, expect, test } from 'bun:test';
import {
  cutoffIso,
  d1Changes,
  d1Count,
  isManagedR2Key,
  maintenanceSql,
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
  });

  test('builds bounded, escaped cleanup SQL', () => {
    const cutoff = cutoffIso(new Date('2026-08-13T00:00:00.000Z'), 30);
    const sql = maintenanceSql({ sessions: cutoff, webhookEvents: cutoff });
    expect(sql.sessionCandidates).toContain('COUNT(*) AS count');
    expect(sql.apply).toContain('DELETE FROM workspace_sessions');
    expect(sql.apply).toContain('DELETE FROM workspace_outbound_events');
    expect(sql.apply).not.toContain('DROP');
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
    expect(isManagedR2Key(objects[2].key)).toBe(false);
  });
});
