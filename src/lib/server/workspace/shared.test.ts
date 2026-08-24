import { describe, expect, test } from 'bun:test';
import {
  mapDraftRow,
  mapInboundRow,
  parseLabels,
  rowsToMailbox,
  serializeWorkspace
} from './shared';
import type { WorkspaceDraftRow } from './shared';

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

  test('maps legacy draft recipient columns into canonical arrays', () => {
    const profile = { name: 'Test User', role: 'Owner', email: 'owner@example.test', company: '', location: '', timezone: 'UTC', forwardingEnabled: false, signature: '' };
    const draft = mapDraftRow({
      id: 'draft-legacy', to_email: 'Legacy@Example.test', cc: 'Copy One <copy@example.test>; copy2@example.test',
      to_json: null, cc_json: null, bcc_json: null, subject: 'Legacy draft', body: 'Body', is_starred: 0,
      created_at: '2026-08-13T00:00:00.000Z', updated_at: '2026-08-13T00:01:00.000Z', message_id: null,
      in_reply_to: null, references: null, thread_key: null, idempotency_key: null
    } satisfies WorkspaceDraftRow, profile);
    expect(draft.toAddresses).toEqual([{ name: '', email: 'legacy@example.test' }]);
    expect(draft.ccAddresses).toEqual([
      { name: 'Copy One', email: 'copy@example.test' },
      { name: '', email: 'copy2@example.test' }
    ]);
  });
});
