import { describe, expect, test } from 'bun:test';
import { ApiError } from '$lib/server/http/api';
import {
  decodeMailboxCursor,
  encodeMailboxCursor,
  parseMailboxQuery
} from './mailbox-query';

describe('mailbox query contract', () => {
  test('applies bounded defaults', () => {
    expect(parseMailboxQuery(new URLSearchParams())).toMatchObject({
      folder: 'inbox', limit: 40, query: '', filter: 'all', deliveryStatus: null, cursor: null
    });
  });

  test('round trips an opaque stable cursor', () => {
    const encoded = encodeMailboxCursor({
      folder: 'sent',
      timestamp: '2026-08-13T12:00:00.000Z',
      id: 'sent-live-2'
    });
    expect(decodeMailboxCursor(encoded, 'sent')).toEqual({
      version: 1,
      folder: 'sent',
      timestamp: '2026-08-13T12:00:00.000Z',
      id: 'sent-live-2'
    });
  });

  test('rejects cross-folder and malformed cursors', () => {
    const cursor = encodeMailboxCursor({
      folder: 'inbox', timestamp: '2026-08-13T12:00:00.000Z', id: 'email:1'
    });
    expect(() => decodeMailboxCursor(cursor, 'drafts')).toThrow(ApiError);
    expect(() => decodeMailboxCursor('not-json', 'inbox')).toThrow(ApiError);
  });

  test('validates filters, status, query and limits', () => {
    expect(() => parseMailboxQuery(new URLSearchParams('folder=spam'))).toThrow(ApiError);
    expect(() => parseMailboxQuery(new URLSearchParams('filter=read'))).toThrow(ApiError);
    expect(() => parseMailboxQuery(new URLSearchParams('folder=inbox&status=failed'))).toThrow(ApiError);
    expect(() => parseMailboxQuery(new URLSearchParams('limit=101'))).toThrow(ApiError);
    expect(() => parseMailboxQuery(new URLSearchParams(`q=${'x'.repeat(201)}`))).toThrow(ApiError);
  });
});
