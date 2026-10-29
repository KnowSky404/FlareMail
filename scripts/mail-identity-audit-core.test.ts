import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeD1 } from './cloudflare-target';
import { describe, expect, test } from 'bun:test';
import { buildMailIdentityDryRunReport, parseMailIdentityAuditArguments } from './mail-identity-audit-core';

describe('local mail identity migration audit', () => {
  test('normalizes explicit domain scope and rejects all remote modes', () => {
    expect(parseMailIdentityAuditArguments(['--domain', 'Example.Test.', '--domain=example.test', '--json', '--persist-to', '/tmp/local-copy']))
      .toEqual({ domains: ['example.test'], json: true, persistTo: '/tmp/local-copy' });
    expect(() => parseMailIdentityAuditArguments(['--remote'])).toThrow('local-only');
    expect(() => parseMailIdentityAuditArguments(['--domain', '--json'])).toThrow('--domain requires');
  });

  test('marks only explicit envelope recipients as address candidates and reports ownership conflicts', () => {
    const report = buildMailIdentityDryRunReport([
      { report_section: 'user', user_id: 'user-1', login_email: 'owner@gmail.test', profile_email: 'profile@gmail.test' },
      { report_section: 'user', user_id: 'user-2', login_email: 'second@example.test', profile_email: 'second@example.test' },
      { report_section: 'inbound_recipient', owner_id: 'user-1', email: 'sales@example.test', count: 2 },
      { report_section: 'inbound_recipient', owner_id: null, email: 'support@example.test', count: 1 },
      { report_section: 'outbound_sender', owner_id: 'user-1', email: 'owner@gmail.test', count: 4 },
      { report_section: 'owner_mapping', owner_id: 'missing-user' },
      { report_section: 'body_ownership', owner_id: null, count: 1 }
    ], ['example.test'], '2026-09-20T12:00:00.000Z');

    expect(report.owner.multipleHistoricalUsers).toBe(true);
    expect(report.owner.stableOwnerId).toBe('missing-user');
    expect(report.inbound.envelopeRecipients).toMatchObject([
      { email: 'sales@example.test', explicitDomainMatch: true, ownerExists: true },
      { email: 'support@example.test', explicitDomainMatch: true, ownerExists: false }
    ]);
    expect(report.outbound.fromAddresses[0]).toMatchObject({ email: 'owner@gmail.test', explicitDomainMatch: false });
    expect(report.storage.bodyObjectsWithoutOwnerCount).toBe(1);
    expect(report.safety).toMatchObject({ noWritesPerformed: true, profileAndLoginEmailsAreNotTreatedAsSenders: true });
  });
});


test('local cf audit preserves all SELECT result sets for historical users', async () => {
  const state = await mkdtemp(join(tmpdir(), 'flaremail-audit-batch-'));
  try {
    await executeD1({ persistTo: state }, [
      'CREATE TABLE workspace_users (id TEXT PRIMARY KEY, login_email TEXT, email TEXT)',
      "INSERT INTO workspace_users VALUES ('audit-user-1', '', ''), ('audit-user-2', '', '')"
    ]);
    const child = Bun.spawn(['bun', 'scripts/mail-identity-migration-dry-run.ts', '--persist-to', state, '--json'], { stdout: 'pipe', stderr: 'pipe' });
    const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    expect(code).toBe(0);
    expect(JSON.parse(stdout).owner.historicalUserCount).toBe(2);
  } finally { await rm(state, { recursive: true, force: true }); }
}, 30_000);
