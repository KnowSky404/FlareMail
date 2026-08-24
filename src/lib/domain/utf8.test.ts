import { describe, expect, test } from 'bun:test';
import { boundedUtf8, truncateUtf8, utf8ByteLength } from './utf8';

describe('UTF-8 byte bounds', () => {
  test('counts encoded bytes rather than JavaScript code units', () => {
    expect(utf8ByteLength('ascii')).toBe(5);
    expect(utf8ByteLength('中文')).toBe(6);
    expect(utf8ByteLength('😀')).toBe(4);
    expect(utf8ByteLength('e\u0301')).toBe(3);
  });

  test('reports bounded values without truncation', () => {
    expect(boundedUtf8('中'.repeat(4), 12)).toMatchObject({ bytes: 12, ok: true, value: '中'.repeat(4) });
    expect(boundedUtf8('😀'.repeat(3), 11)).toMatchObject({ bytes: 12, ok: false });
  });

  test('truncates on code point boundaries', () => {
    expect(truncateUtf8('😀😀😀', 5)).toBe('😀');
    expect(truncateUtf8('中文😀', 7)).toBe('中文');
    expect(utf8ByteLength(truncateUtf8('e\u0301😀', 4))).toBeLessThanOrEqual(4);
  });
});
