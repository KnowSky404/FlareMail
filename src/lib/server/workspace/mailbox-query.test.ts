import { describe, expect, test } from 'bun:test';
import { ApiError } from '$lib/server/http/api';
import {
  buildD1LikeSearchPattern,
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

  test('bounds the complete LIKE pattern by UTF-8 bytes', () => {
    expect(new TextEncoder().encode(buildD1LikeSearchPattern('x'.repeat(48))).byteLength).toBe(50);
    expect(() => buildD1LikeSearchPattern('x'.repeat(49))).toThrow(ApiError);
    expect(new TextEncoder().encode(buildD1LikeSearchPattern('中'.repeat(16))).byteLength).toBe(50);
    expect(() => buildD1LikeSearchPattern('中'.repeat(17))).toThrow(ApiError);
    expect(new TextEncoder().encode(buildD1LikeSearchPattern('😀'.repeat(12))).byteLength).toBe(50);
    expect(() => buildD1LikeSearchPattern('😀'.repeat(13))).toThrow(ApiError);
    expect(new TextEncoder().encode(buildD1LikeSearchPattern('e\u0301'.repeat(16))).byteLength).toBe(50);
    expect(() => buildD1LikeSearchPattern('e\u0301'.repeat(17))).toThrow(ApiError);
  });

  test('returns a stable localized typed error before repository execution', () => {
    try {
      parseMailboxQuery(new URLSearchParams(`q=${encodeURIComponent('中'.repeat(17))}`));
      throw new Error('expected query to be rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({ status: 400, code: 'QUERY_PATTERN_TOO_LARGE' });
      expect((error as ApiError).fieldErrors).toEqual({ query: ['当前搜索最多支持 48 个 UTF-8 字节。'] });
    }
  });
});
