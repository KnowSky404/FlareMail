import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CRLF = '\r\n';
const encoder = new TextEncoder();

export const MIB = 1024 * 1024;

export const RUNTIME_FIXTURE_SIZES = {
  oneMiB: 1 * MIB,
  fiveMiB: 5 * MIB,
  nearRawLimit: 24 * MIB
} as const;

export const RUNTIME_FIXTURE_LIMITS = {
  inboundRaw: 24 * MIB,
  inboundSingleAttachmentNear: 15 * MIB,
  attachmentPerFile: 8 * MIB,
  attachmentTotal: 12 * MIB,
  maxFixtureBytes: 24 * MIB
} as const;

export type RuntimeFixtureId =
  | 'runtime-1MiB'
  | 'runtime-5MiB'
  | 'runtime-near-raw-limit'
  | 'single-attachment-near-15MiB'
  | 'attachments-near-total-cap'
  | 'multiple-attachments'
  | 'html-cid'
  | 'content-length-mismatch'
  | 'attachment-checksum-mismatch'
  | 'deep-multipart';

export type RuntimeFixtureSpec = {
  id: RuntimeFixtureId;
  filename: `${string}.eml`;
  description: string;
  declaredContentLength?: number;
  attachmentBytes: number;
  multipartDepth: number;
};

export type RuntimeFixtureCase = RuntimeFixtureSpec & {
  payload: Uint8Array;
  actualContentLength: number;
  checksum?: { expectedSha256: string; actualSha256: string };
};

const plainHeader = [
  'From: fixture-sender@example.test',
  'To: fixture-recipient@example.test',
  'Message-ID: <runtime-fixture@example.test>',
  'Date: Thu, 14 Aug 2026 00:00:00 +0000',
  'Subject: FlareMail runtime budget fixture',
  'MIME-Version: 1.0',
  'Content-Type: text/plain; charset=utf-8',
  '',
  ''
].join(CRLF);

const fixtureSpecs: readonly RuntimeFixtureSpec[] = [
  {
    id: 'runtime-1MiB',
    filename: 'runtime-1MiB.eml',
    description: 'small plain-text message',
    attachmentBytes: 0,
    multipartDepth: 0
  },
  {
    id: 'runtime-5MiB',
    filename: 'runtime-5MiB.eml',
    description: 'medium plain-text message',
    attachmentBytes: 0,
    multipartDepth: 0
  },
  {
    id: 'runtime-near-raw-limit',
    filename: 'runtime-near-raw-limit.eml',
    description: 'large plain-text message near the raw fixture limit',
    attachmentBytes: 0,
    multipartDepth: 0
  },
  {
    id: 'single-attachment-near-15MiB',
    filename: 'single-attachment-near-15MiB.eml',
    description: 'inbound-only single attachment just below 15 MiB decoded bytes',
    attachmentBytes: RUNTIME_FIXTURE_LIMITS.inboundSingleAttachmentNear - 12,
    multipartDepth: 1
  },
  {
    id: 'attachments-near-total-cap',
    filename: 'attachments-near-total-cap.eml',
    description: 'outbound-only three files whose decoded total is just below the 12 MiB cap',
    attachmentBytes: RUNTIME_FIXTURE_LIMITS.attachmentTotal - 12,
    multipartDepth: 1
  },
  {
    id: 'multiple-attachments',
    filename: 'multiple-attachments.eml',
    description: 'multiple small files with distinct names and content types',
    attachmentBytes: 3 * 1024,
    multipartDepth: 1
  },
  {
    id: 'html-cid',
    filename: 'html-cid.eml',
    description: 'HTML alternative with an inline Content-ID resource',
    attachmentBytes: 256,
    multipartDepth: 2
  },
  {
    id: 'content-length-mismatch',
    filename: 'content-length-mismatch.eml',
    description: 'payload whose declared Content-Length is deliberately wrong',
    declaredContentLength: 97,
    attachmentBytes: 0,
    multipartDepth: 0
  },
  {
    id: 'attachment-checksum-mismatch',
    filename: 'attachment-checksum-mismatch.eml',
    description: 'attachment metadata with a deterministic wrong digest',
    attachmentBytes: 512,
    multipartDepth: 1
  },
  {
    id: 'deep-multipart',
    filename: 'deep-multipart.eml',
    description: 'nested multipart structure for parser depth and boundary checks',
    attachmentBytes: 64,
    multipartDepth: 8
  }
];

export const RUNTIME_FIXTURE_SPECS = fixtureSpecs;

export function runtimeFixtureCorrelationId(id: RuntimeFixtureId | 'runtime-plain') {
  return `flaremail-rc1-${id.toLowerCase()}`;
}

function runtimeMessageHeaders(correlationId: string, extra: string[] = []) {
  return [
    'From: fixture-sender@example.test',
    'To: fixture-recipient@example.test',
    `X-FlareMail-Runtime-Correlation: ${correlationId}`,
    ...extra
  ];
}

function repeatedBytes(size: number, seed = 0x41) {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('Fixture byte size must be a non-negative safe integer.');
  const result = new Uint8Array(size);
  result.fill(seed);
  return result;
}

function base64(bytes: Uint8Array) {
  // Avoid a spread into arguments: the near-cap fixture intentionally exercises
  // multi-megabyte inputs and must not overflow the call stack.
  let encoded = '';
  const chunkSize = 49_152;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.byteLength));
    let binary = '';
    for (const byte of chunk) binary += String.fromCharCode(byte);
    encoded += btoa(binary);
  }
  return encoded.replace(/(.{1,76})/gu, `$1${CRLF}`);
}

function mimePart(headers: string[], body: string) {
  return `${headers.join(CRLF)}${CRLF}${CRLF}${body}`;
}

function multipart(parts: string[], subtype: string, boundary: string) {
  return [
    `Content-Type: multipart/${subtype}; boundary="${boundary}"`,
    '',
    ...parts.flatMap((part) => [`--${boundary}`, part]),
    `--${boundary}--`,
    ''
  ].join(CRLF);
}

function attachmentPart(filename: string, contentType: string, bytes: Uint8Array, extra: string[] = []) {
  return mimePart([
    `Content-Type: ${contentType}; name="${filename}"`,
    `Content-Disposition: attachment; filename="${filename}"`,
    'Content-Transfer-Encoding: base64',
    ...extra
  ], base64(bytes));
}

function plainMessage(size: number, correlationId = runtimeFixtureCorrelationId('runtime-plain')) {
  const prefix = encoder.encode([
    plainHeader.split(CRLF).slice(0, 2).join(CRLF),
    `X-FlareMail-Runtime-Correlation: ${correlationId}`,
    plainHeader.split(CRLF).slice(2).join(CRLF)
  ].join(CRLF));
  if (!Number.isSafeInteger(size) || size < prefix.byteLength) {
    throw new Error('Fixture size must be a safe integer larger than the MIME header.');
  }
  const result = new Uint8Array(size);
  result.set(prefix);
  result.fill(0x41, prefix.byteLength);
  return result;
}

/** Preserve the original fixture API while making all byte output deterministic. */
export function renderRuntimeFixture(size: number) {
  return plainMessage(size);
}

function textPayload(value: string) {
  return encoder.encode(value);
}

function renderMultipartFixture(spec: RuntimeFixtureSpec, correlationId: string) {
  switch (spec.id) {
    case 'single-attachment-near-15MiB': {
      const body = multipart([
        attachmentPart('inbound-near-15MiB.bin', 'application/octet-stream', repeatedBytes(spec.attachmentBytes, 0x49))
      ], 'mixed', 'inbound-single-attachment-boundary');
      return textPayload([
        ...runtimeMessageHeaders(correlationId, ['Subject: Inbound single attachment near 15 MiB']),
        'MIME-Version: 1.0',
        body
      ].join(CRLF));
    }
    case 'attachments-near-total-cap': {
      const each = Math.floor(spec.attachmentBytes / 3);
      const sizes = [each, each, spec.attachmentBytes - each * 2];
      const body = multipart(sizes.map((size, index) => attachmentPart(`near-cap-${index + 1}.bin`, 'application/octet-stream', repeatedBytes(size, 0x30 + index))), 'mixed', 'near-total-cap-boundary');
      return textPayload([
        ...runtimeMessageHeaders(correlationId, ['Subject: Attachments near total cap']),
        'MIME-Version: 1.0',
        body
      ].join(CRLF));
    }
    case 'multiple-attachments': {
      const body = multipart([
        attachmentPart('alpha.txt', 'text/plain', repeatedBytes(1024, 0x61)),
        attachmentPart('beta.bin', 'application/octet-stream', repeatedBytes(1024, 0x62)),
        attachmentPart('会议🚀.txt', 'text/plain', textPayload('deterministic unicode filename\n'))
      ], 'mixed', 'multiple-attachments-boundary');
      return textPayload([
        ...runtimeMessageHeaders(correlationId, ['Subject: Multiple attachments']),
        'MIME-Version: 1.0',
        body
      ].join(CRLF));
    }
    case 'html-cid': {
      const related = multipart([
        mimePart(['Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: 8bit'], '<html><body><img src="cid:logo@example.test"></body></html>'),
        attachmentPart('logo.png', 'image/png', repeatedBytes(256, 0x89), ['Content-Disposition: inline', 'Content-ID: <logo@example.test>'])
      ], 'related', 'html-cid-related-boundary');
      const body = multipart([
        mimePart(['Content-Type: text/plain; charset=utf-8'], 'Plain alternative'),
        related
      ], 'alternative', 'html-cid-alternative-boundary');
      return textPayload([...runtimeMessageHeaders(correlationId, ['Subject: HTML CID', 'MIME-Version: 1.0']), body].join(CRLF));
    }
    case 'content-length-mismatch':
      return textPayload([
        ...runtimeMessageHeaders(correlationId),
        'Content-Length: 97',
        'Subject: Deliberate Content-Length mismatch',
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'actual bytes are deliberately not ninety-seven bytes'
      ].join(CRLF));
    case 'attachment-checksum-mismatch':
      return textPayload([
        ...runtimeMessageHeaders(correlationId, ['Subject: Deliberate attachment checksum mismatch']),
        'MIME-Version: 1.0',
        multipart([attachmentPart('checksum.bin', 'application/octet-stream', repeatedBytes(512, 0x5a), ['X-Fixture-Expected-SHA256: ' + '0'.repeat(64)])], 'mixed', 'checksum-mismatch-boundary')
      ].join(CRLF));
    case 'deep-multipart': {
      let nested = mimePart(['Content-Type: text/plain; charset=utf-8'], 'deep leaf');
      for (let depth = spec.multipartDepth; depth >= 1; depth -= 1) nested = multipart([nested], 'mixed', `deep-boundary-${depth}`);
      return textPayload([...runtimeMessageHeaders(correlationId, ['Subject: Deep multipart', 'MIME-Version: 1.0']), nested].join(CRLF));
    }
    default:
      throw new Error(`No multipart renderer for ${spec.id}.`);
  }
}

export function renderRuntimeFixtureCase(id: RuntimeFixtureId): RuntimeFixtureCase {
  const spec = fixtureSpecs.find((candidate) => candidate.id === id);
  if (!spec) throw new Error(`Unknown runtime fixture: ${id}`);
  const payload = id === 'runtime-1MiB'
    ? plainMessage(RUNTIME_FIXTURE_SIZES.oneMiB, runtimeFixtureCorrelationId(id))
    : id === 'runtime-5MiB'
      ? plainMessage(RUNTIME_FIXTURE_SIZES.fiveMiB, runtimeFixtureCorrelationId(id))
      : id === 'runtime-near-raw-limit'
        ? plainMessage(RUNTIME_FIXTURE_SIZES.nearRawLimit, runtimeFixtureCorrelationId(id))
        : renderMultipartFixture(spec, runtimeFixtureCorrelationId(id));
  return {
    ...spec,
    payload,
    actualContentLength: payload.byteLength,
    ...(id === 'content-length-mismatch' ? { declaredContentLength: 97 } : {}),
    ...(id === 'attachment-checksum-mismatch' ? {
      checksum: {
        expectedSha256: '0'.repeat(64),
        actualSha256: 'a863e21577e54cd763729803a621804da4b5030afa35bcf879ea3b3413488a66'
      }
    } : {})
  };
}

export function renderAllRuntimeFixtureCases() {
  return fixtureSpecs.map((spec) => renderRuntimeFixtureCase(spec.id));
}

async function main() {
  const outputIndex = process.argv.indexOf('--output');
  const requestedOutput = outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined;
  if (outputIndex >= 0 && (!requestedOutput || requestedOutput.startsWith('--'))) throw new Error('--output requires a directory.');
  const output = requestedOutput ?? await mkdtemp(join(tmpdir(), 'flaremail-runtime-'));
  await mkdir(output, { recursive: true });
  const generated: Array<RuntimeFixtureSpec & { bytes: number; sha256: string; path: string }> = [];
  for (const spec of fixtureSpecs) {
    const fixture = renderRuntimeFixtureCase(spec.id);
    const path = join(output, spec.filename);
    await Bun.write(path, fixture.payload);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', fixture.payload));
    const sha256 = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    generated.push({ ...spec, bytes: fixture.payload.byteLength, sha256, path });
  }
  console.log(JSON.stringify({ mode: 'offline', reportOnly: true, output, generated }, null, 2));
}

if (import.meta.main) await main();
