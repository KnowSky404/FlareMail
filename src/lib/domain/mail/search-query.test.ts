import { describe, expect, test } from 'bun:test';
import { parseMailSearchQuery, SearchQueryParseError, SEARCH_QUERY_LIMITS } from './search-query';

const errorCode = (query: string) => {
  try { parseMailSearchQuery(query); } catch (error) { return (error as SearchQueryParseError).code; }
  return 'none';
};

describe('parseMailSearchQuery', () => {
  test('parses terms and all filters with deterministic duplicate handling', () => {
    expect(parseMailSearchQuery('会议 🚀 from:Alice from:Alice to:"Bob Example" is:unread is:unread has:attachment after:2026-01-01 before:2026-02-01 status:sent label:work label:work')).toEqual({
      terms: ['会议', '🚀'],
      filters: { from: ['Alice'], to: ['Bob Example'], cc: [], subject: [], is: ['unread'], hasAttachment: true, after: ['2026-01-01'], before: ['2026-02-01'], status: ['sent'], label: ['work'] }
    });
  });

  test('supports quoted values and escaped punctuation without producing query syntax', () => {
    expect(parseMailSearchQuery('subject:"hello \\"world\\"" from:foo\\:bar hello\\ world')).toEqual({
      terms: ['hello world'], filters: { from: ['foo:bar'], to: [], cc: [], subject: ['hello "world"'], is: [], hasAttachment: false, after: [], before: [], status: [], label: [] }
    });
  });

  test('rejects malformed and unsafe syntax with stable typed codes', () => {
    for (const [query, code] of [['foo:bar', 'unknown_operator'], ['from:', 'missing_value'], ['is:read', 'invalid_value'], ['after:2026-02-30', 'invalid_date'], ['status:ok', 'invalid_status'], ['has:file', 'invalid_value'], ['"unterminated', 'malformed_quotes']] as const) {
      expect(errorCode(query)).toBe(code);
    }
    expect(errorCode('before:2026-01-01; DROP TABLE mail')).toBe('invalid_date');
    expect(errorCode('DROP:TABLE')).toBe('unknown_operator');
  });

  test('enforces UTF-8 byte and token boundaries', () => {
    expect(errorCode('🚀'.repeat(Math.ceil(SEARCH_QUERY_LIMITS.maxUtf8Bytes / 4) + 1))).toBe('input_too_large');
    expect(errorCode(Array.from({ length: SEARCH_QUERY_LIMITS.maxTokens + 1 }, (_, i) => `t${i}`).join(' '))).toBe('too_many_tokens');
    expect(parseMailSearchQuery('你'.repeat(100))).toHaveProperty('terms');
  });
});
