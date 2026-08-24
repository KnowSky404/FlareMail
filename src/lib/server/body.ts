import { truncateUtf8, utf8ByteLength } from '$lib/domain/utf8';

export const BODY_LIMITS = Object.freeze({
  projectionTextBytes: 128 * 1024,
  projectionHtmlBytes: 64 * 1024,
  snippetBytes: 4 * 1024,
  inlineBytes: 256 * 1024,
  canonicalBytes: 32 * 1024 * 1024
});

export type CanonicalBody = {
  version: 1;
  textBody: string;
  htmlBody: string;
};

export type PreparedBodyObject = {
  id: string;
  key: string;
  bytes: Uint8Array;
  sizeBytes: number;
  sha256: string;
  textBytes: number;
  htmlBytes: number;
  body: CanonicalBody;
};

const encoder = new TextEncoder();

export class BodyCanonicalLimitError extends Error {
  readonly code = 'BODY_CANONICAL_LIMIT';

  constructor(readonly limit: number, readonly actual: number) {
    super('Canonical mail body exceeds the configured byte limit.');
    this.name = 'BodyCanonicalLimitError';
  }
}

function hex(buffer: ArrayBuffer) {
  return [...new Uint8Array(buffer)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function safeSegment(value: string) {
  return value.replace(/[^A-Za-z0-9_-]/gu, '_').slice(0, 128) || 'unknown';
}

export async function prepareBodyObject(
  entityType: string,
  entityId: string,
  textBody: string,
  htmlBody = '',
  options: { canonicalBytes?: number } = {}
): Promise<PreparedBodyObject | null> {
  const body: CanonicalBody = { version: 1, textBody, htmlBody };
  const bytes = encoder.encode(JSON.stringify(body));
  if (bytes.byteLength <= BODY_LIMITS.inlineBytes) return null;
  const canonicalLimit = options.canonicalBytes ?? BODY_LIMITS.canonicalBytes;
  if (bytes.byteLength > canonicalLimit) {
    throw new BodyCanonicalLimitError(canonicalLimit, bytes.byteLength);
  }
  const digest = hex(await crypto.subtle.digest('SHA-256', bytes));
  const id = crypto.randomUUID();
  return {
    id,
    // The random object id keeps concurrent same-content writes isolated. A
    // content-only key would let a losing CAS delete the winner's R2 object.
    key: `body/v1/${safeSegment(entityType)}/${safeSegment(entityId)}/${id}-${digest}.json`,
    bytes,
    sizeBytes: bytes.byteLength,
    sha256: digest,
    textBytes: utf8ByteLength(textBody),
    htmlBytes: utf8ByteLength(htmlBody),
    body
  };
}

export function projectBody(textBody: string, htmlBody = '', snippet = '') {
  const text = truncateUtf8(textBody, BODY_LIMITS.projectionTextBytes);
  const html = truncateUtf8(htmlBody, BODY_LIMITS.projectionHtmlBytes);
  const projectedSnippet = truncateUtf8(snippet || text, BODY_LIMITS.snippetBytes);
  return { textBody: text, htmlBody: html, snippet: projectedSnippet };
}

export async function putBodyObject(bucket: R2Bucket, object: PreparedBodyObject) {
  await bucket.put(object.key, object.bytes, {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
    customMetadata: {
      bodyVersion: '1',
      bodyId: object.id,
      sha256: object.sha256,
      sizeBytes: String(object.sizeBytes)
    }
  });
}

export async function readBodyObject(bucket: R2Bucket, key: string, expectedSize: number, expectedSha256: string): Promise<CanonicalBody> {
  const object = await bucket.get(key);
  if (!object) throw new Error('BODY_OBJECT_NOT_FOUND');
  if (object.size !== expectedSize || object.size > BODY_LIMITS.canonicalBytes) throw new Error('BODY_OBJECT_INTEGRITY');
  const bytes = new Uint8Array(await object.arrayBuffer());
  const digest = hex(await crypto.subtle.digest('SHA-256', bytes));
  if (digest !== expectedSha256) throw new Error('BODY_OBJECT_INTEGRITY');
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new Error('BODY_OBJECT_INVALID'); }
  if (!parsed || typeof parsed !== 'object') throw new Error('BODY_OBJECT_INVALID');
  const value = parsed as Partial<CanonicalBody>;
  if (value.version !== 1 || typeof value.textBody !== 'string' || typeof value.htmlBody !== 'string') throw new Error('BODY_OBJECT_INVALID');
  return { version: 1, textBody: value.textBody, htmlBody: value.htmlBody };
}
