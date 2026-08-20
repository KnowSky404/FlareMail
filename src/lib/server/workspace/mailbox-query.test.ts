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
      id: 'sent-live-2',
      query: '',
      filter: 'all',
      deliveryStatus: null
    });
    expect(decodeMailboxCursor(encoded, 'sent', 'sent', {
      query: '', filter: 'all', deliveryStatus: null
    })).toEqual({
      version: 2,
      folder: 'sent',
      timestamp: '2026-08-13T12:00:00.000Z',
      id: 'sent-live-2',
      query: '',
      filter: 'all',
      deliveryStatus: null
    });
  });

  test('rejects cross-folder and malformed cursors', () => {
    const cursor = encodeMailboxCursor({
      folder: 'inbox', timestamp: '2026-08-13T12:00:00.000Z', id: 'email:1',
      query: '', filter: 'all', deliveryStatus: null
    });
    expect(() => decodeMailboxCursor(cursor, 'drafts', 'drafts', { query: '', filter: 'all', deliveryStatus: null })).toThrow(ApiError);
    expect(() => decodeMailboxCursor('not-json', 'inbox', 'inbox', { query: '', filter: 'all', deliveryStatus: null })).toThrow(ApiError);
  });

  test('rejects a cursor reused with different search or filters', () => {
    const cursor = encodeMailboxCursor({
      folder: 'sent', timestamp: '2026-08-13T12:00:00.000Z', id: 'email:1',
      query: 'from:alice@example.test', filter: 'unread', deliveryStatus: 'failed'
    });
    expect(() => parseMailboxQuery(new URLSearchParams(`folder=sent&q=${encodeURIComponent('from:other@example.test')}&filter=unread&status=failed&cursor=${encodeURIComponent(cursor)}`)))
      .toThrow(ApiError);
    expect(() => parseMailboxQuery(new URLSearchParams(`folder=sent&q=${encodeURIComponent('from:alice@example.test')}&filter=all&status=failed&cursor=${encodeURIComponent(cursor)}`)))
      .toThrow(ApiError);
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

  test('routes long Unicode input to FTS and returns stable parser errors before repository execution', () => {
    expect(parseMailboxQuery(new URLSearchParams(`q=${encodeURIComponent('中'.repeat(17))}`)).search?.terms)
      .toEqual(['中'.repeat(17)]);
    try {
      parseMailboxQuery(new URLSearchParams(`q=${encodeURIComponent('unknown:value')}`));
      throw new Error('expected query to be rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({ status: 400, code: 'INVALID_SEARCH_QUERY' });
      expect((error as ApiError).fieldErrors).toEqual({ query: ['搜索表达式包含不支持的操作符。'] });
    }
  });
});
