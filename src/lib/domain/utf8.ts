/** Return the number of UTF-8 encoded bytes in a string. */
export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/** Return a prefix that fits within a UTF-8 byte budget without splitting text. */
export function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0 || !value) return '';
  if (utf8ByteLength(value) <= maxBytes) return value;
  let bytes = 0;
  let end = 0;
  for (const codePoint of value) {
    const size = utf8ByteLength(codePoint);
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += codePoint.length;
  }
  return value.slice(0, end);
}

export interface BoundedUtf8Result {
  value: string;
  bytes: number;
  maxBytes: number;
  ok: boolean;
}

/**
 * Check a value against a byte limit without truncating it. Truncation could
 * split user-visible text or change a search expression, so callers must
 * reject the value when `ok` is false.
 */
export function boundedUtf8(value: string, maxBytes: number): BoundedUtf8Result {
  const bytes = utf8ByteLength(value);
  return { value, bytes, maxBytes, ok: bytes <= maxBytes };
}
