import { describe, expect, test } from 'bun:test';
import {
  mapInboundRow,
  parseLabels,
  rowsToMailbox,
  serializeWorkspace
} from './shared';

describe('workspace shared compatibility contracts', () => {
  test('keeps malformed labels isolated and maps inbound messages to legacy ids', () => {
    expect(parseLabels('{not-json}')).toEqual([]);
    const profile = { name: 'Test User', role: 'Owner', email: 'owner@example.test', company: '', location: '', timezone: 'UTC', forwardingEnabled: false, signature: '' };
    const mailbox = rowsToMailbox([], [], [{
      email_id: 'in-1', from: 'Alice <alice@example.com>', to: 'founder@flaremail.dev', subject: 'Hello',
      timestamp: '2026-08-13T00:00:00.000Z', snippet: 'Preview', is_read: 0, is_starred: 1
    }], [], profile);
    expect(mailbox.inbox[0]?.id).toBe('email:in-1');
    expect(mailbox.inbox[0]?.source).toBe('inbound');
    expect(mapInboundRow({ email_id: 'in-2', from: 'bob@example.com', to: '', subject: '', timestamp: '2026-08-13T00:00:00.000Z', snippet: '', is_read: 1, is_starred: 0 }, profile).subject).toBe('(no subject)');
  });

  test('serializes a workspace session through the public payload shape', () => {
    const now = '2026-08-13T00:00:00.000Z';
    const session = { id: 'session-1', userId: 'user-1', profile: { name: '', role: '', email: '', company: '', location: '', timezone: 'UTC', forwardingEnabled: false, signature: '' }, mailbox: { inbox: [], sent: [], drafts: [] }, incomingSequence: 0, createdAt: now, updatedAt: now, storage: 'd1' as const };
    const payload = serializeWorkspace(session);
    expect(payload.profile.timezone).toBe('UTC');
    expect(payload.mailbox).toEqual({ inbox: [], sent: [], drafts: [] });
    expect(payload.metrics.draftsCount).toBe(0);
  });
});
