import { describe, expect, test } from 'bun:test';
import { parseWorkspaceSyncEvent } from './workspace-sync';

describe('workspace cross-window sync events', () => {
  test('accepts state-only events and rejects malformed payloads', () => {
    expect(parseWorkspaceSyncEvent({ type: 'message-updated', id: 'm-1', body: 'secret' })).toEqual({ type: 'message-updated', id: 'm-1' });
    expect(parseWorkspaceSyncEvent({ type: 'mailbox-refresh' })).toEqual({ type: 'mailbox-refresh' });
    expect(parseWorkspaceSyncEvent({ type: 'session-ended', email: 'private@example.test' })).toEqual({ type: 'session-ended' });
    expect(parseWorkspaceSyncEvent({ type: 'message-updated', id: '' })).toBeNull();
    expect(parseWorkspaceSyncEvent({ type: 'unknown', id: 'm-1' })).toBeNull();
    expect(parseWorkspaceSyncEvent(null)).toBeNull();
  });
});
