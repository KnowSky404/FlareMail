import { describe, expect, test } from 'bun:test';
import { buildMailIdentityDryRunReport, parseMailIdentityAuditArguments } from './mail-identity-audit-core';

describe('local mail identity migration audit', () => {
  test('normalizes explicit domain scope and rejects all remote modes', () => {
    expect(parseMailIdentityAuditArguments(['--domain', 'Example.Test.', '--domain=example.test', '--json']))
      .toEqual({ domains: ['example.test'], json: true });
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
