import { describe, expect, test } from 'bun:test';
import {
  createMemoryWorkspaceSession,
  mapInboundRow,
  parseLabels,
  rowsToMailbox,
  serializeWorkspace
} from './shared';

describe('workspace shared compatibility contracts', () => {
  test('keeps malformed labels isolated and maps inbound messages to legacy ids', () => {
    expect(parseLabels('{not-json}')).toEqual([]);
    const session = createMemoryWorkspaceSession();
    const mailbox = rowsToMailbox([], [], [{
      email_id: 'in-1', from: 'Alice <alice@example.com>', to: 'founder@flaremail.dev', subject: 'Hello',
      timestamp: '2026-08-13T00:00:00.000Z', snippet: 'Preview', is_read: 0, is_starred: 1
    }], [], session.profile);
    expect(mailbox.inbox[0]?.id).toBe('email:in-1');
    expect(mailbox.inbox[0]?.source).toBe('inbound');
    expect(mapInboundRow({ email_id: 'in-2', from: 'bob@example.com', to: '', subject: '', timestamp: '2026-08-13T00:00:00.000Z', snippet: '', is_read: 1, is_starred: 0 }, session.profile).subject).toBe('(no subject)');
  });

  test('serializes the memory compatibility session through the public payload shape', () => {
    const session = createMemoryWorkspaceSession();
    const payload = serializeWorkspace(session);
    expect(payload.profile.timezone).toBe('UTC');
    expect(payload.mailbox).toEqual({ inbox: [], sent: [], drafts: [] });
    expect(payload.metrics.draftsCount).toBe(0);
  });
});
