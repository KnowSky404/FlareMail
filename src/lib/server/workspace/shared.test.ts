import { describe, expect, test } from 'bun:test';
import {
  mapDraftRow,
  mapInboundRow,
  hasReliableThreadContext,
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
    expect(mapInboundRow({ email_id: 'in-2', from: 'bob@example.com', to: '', subject: '', timestamp: '2026-08-13T00:00:00.000Z', snippet: '', is_read: 1, is_starred: 0 }, profile).hasAttachments).toBeUndefined();
  });

  test('preserves valid inbound addresses with quoted display names', () => {
    const profile = { name: 'Owner', role: 'Owner', email: 'owner@example.test', company: '', location: '', timezone: 'UTC', forwardingEnabled: false, signature: '' };
    const row = { email_id: 'quoted', from: 'Alice "Ace" Smith <alice@example.test>', to: profile.email, subject: 'Hello', timestamp: '2026-08-13T00:00:00.000Z', snippet: '', is_read: 0, is_starred: 0, thread_key: 'hello::alice@example.test' };
    expect(mapInboundRow(row, profile)).toMatchObject({ fromName: 'Alice "Ace" Smith', fromEmail: 'alice@example.test', threadKey: row.thread_key });
  });

  test('preserves parsed sender addresses that cannot be added to the blocklist', () => {
    const profile = { name: 'Owner', role: 'Owner', email: 'owner@example.test', company: '', location: '', timezone: 'UTC', forwardingEnabled: false, signature: '' };
    const row = { email_id: 'special', from: '"a@b"@example.com', to: profile.email, subject: 'Hello', timestamp: '2026-08-13T00:00:00.000Z', snippet: '', is_read: 0, is_starred: 0, thread_key: 'legacy:special' };
    expect(mapInboundRow(row, profile)).toMatchObject({ fromEmail: '"a@b"@example.com', threadKey: null });
    expect(mapInboundRow({ ...row, from: 'José <josé@example.com>' }, profile)).toMatchObject({ fromName: 'José', fromEmail: 'josé@example.com', threadKey: null });
  });

  test('preserves angle brackets inside a quoted sender local part', () => {
    const profile = { name: 'Owner', role: 'Owner', email: 'owner@example.test', company: '', location: '', timezone: 'UTC', forwardingEnabled: false, signature: '' };
    const row = { email_id: 'quoted-angle', from: 'Alice <"a<b"@example.com>', to: profile.email, subject: 'Hello', timestamp: '2026-08-13T00:00:00.000Z', snippet: '', is_read: 0, is_starred: 0 };
    expect(mapInboundRow(row, profile)).toMatchObject({ fromName: 'Alice', fromEmail: '"a<b"@example.com' });
    expect(mapInboundRow({ ...row, from: 'Alice <"a>b"@example.com>' }, profile)).toMatchObject({ fromName: 'Alice', fromEmail: '"a>b"@example.com' });
  });

  test('preserves a legacy decoded display name containing an unquoted angle', () => {
    const profile = { name: 'Owner', role: 'Owner', email: 'owner@example.test', company: '', location: '', timezone: 'UTC', forwardingEnabled: false, signature: '' };
    const row = { email_id: 'legacy-angle', from: 'Alice < Team <alice@example.com>', to: profile.email, subject: 'Hello', timestamp: '2026-08-13T00:00:00.000Z', snippet: '', is_read: 0, is_starred: 0 };
    expect(mapInboundRow(row, profile)).toMatchObject({ fromName: 'Alice < Team', fromEmail: 'alice@example.com' });
  });

  test('does not mistake an unmatched angle inside a malformed address for its sender', () => {
    const profile = { name: 'Owner', role: 'Owner', email: 'owner@example.test', company: '', location: '', timezone: 'UTC', forwardingEnabled: false, signature: '' };
    const raw = 'Alice <"a<alice@example.com>';
    const row = { email_id: 'malformed-angle', from: raw, to: profile.email, subject: 'Hello', timestamp: '2026-08-13T00:00:00.000Z', snippet: '', is_read: 0, is_starred: 0 };
    expect(mapInboundRow(row, profile)).toMatchObject({ fromEmail: raw, threadKey: null });
  });

  test.each(['\u2028', '\u2029'])('preserves addresses after Unicode line separator %s in a display name', (separator) => {
    const profile = { name: 'Owner', role: 'Owner', email: 'owner@example.test', company: '', location: '', timezone: 'UTC', forwardingEnabled: false, signature: '' };
    const row = { email_id: 'unicode-name', from: `Alice${separator}Team <alice@example.com>`, to: profile.email, subject: 'Hello', timestamp: '2026-08-13T00:00:00.000Z', snippet: '', is_read: 0, is_starred: 0 };
    expect(mapInboundRow(row, profile)).toMatchObject({ fromName: `Alice${separator}Team`, fromEmail: 'alice@example.com' });
  });

  test('parses a long decoded display name without losing its sender', () => {
    const profile = { name: 'Owner', role: 'Owner', email: 'owner@example.test', company: '', location: '', timezone: 'UTC', forwardingEnabled: false, signature: '' };
    const name = `A${' '.repeat(81000)}B`;
    const row = { email_id: 'long-name', from: `${name} <alice@example.com>`, to: profile.email, subject: 'Hello', timestamp: '2026-08-13T00:00:00.000Z', snippet: '', is_read: 0, is_starred: 0 };
    expect(mapInboundRow(row, profile)).toMatchObject({ fromName: name, fromEmail: 'alice@example.com' });
  });

  test('requires a senderless stored key to match its valid RFC thread', () => {
    expect(hasReliableThreadContext('', { message_id: 'bogus', references: '<root@example.test>', thread_key: 'rfc:bogus' })).toBe(false);
    expect(hasReliableThreadContext('', { message_id: '<root@example.test>', thread_key: 'rfc:root@example.test' })).toBe(true);
    expect(hasReliableThreadContext('', { message_id: '<root@example.test>', thread_key: 'rfc:<root@example.test>' })).toBe(true);
    expect(hasReliableThreadContext('', { message_id: 'bogus', thread_key: 'rfc:bogus' })).toBe(false);
    expect(hasReliableThreadContext('alice@example.com', { message_id: 'bogus', thread_key: 'rfc:bogus' })).toBe(false);
    expect(hasReliableThreadContext('alice@example.com', { message_id: '<other@example.test>', thread_key: 'rfc:root@example.test' })).toBe(false);
    expect(hasReliableThreadContext('alice@example.com', { message_id: '<root@example.test>', thread_key: 'rfc:root@example.test' })).toBe(true);
    expect(hasReliableThreadContext('alice@example.com', { subject: 'RFC: Production rollout', thread_key: 'rfc: production rollout::alice@example.com' })).toBe(true);
    expect(hasReliableThreadContext('alice@example.com', { subject: 'Other subject', thread_key: 'rfc: production rollout::alice@example.com' })).toBe(false);
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
