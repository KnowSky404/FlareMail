import { mkdir } from 'node:fs/promises';

const CRLF = '\r\n';

export const RUNTIME_FIXTURE_SIZES = {
  oneMiB: 1 * 1024 * 1024,
  fiveMiB: 5 * 1024 * 1024,
  nearRawLimit: 24 * 1024 * 1024
} as const;

const header = [
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

export function renderRuntimeFixture(size: number) {
  if (!Number.isSafeInteger(size) || size < header.length) {
    throw new Error('Fixture size must be a safe integer larger than the MIME header.');
  }
  const prefix = new TextEncoder().encode(header);
  const result = new Uint8Array(size);
  result.set(prefix);
  result.fill(0x41, prefix.byteLength);
  return result;
}

async function main() {
  const outputIndex = process.argv.indexOf('--output');
  const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined;
  if (!output) throw new Error('Usage: bun scripts/runtime-fixtures.ts --output /tmp/flaremail-runtime-fixtures');

  await mkdir(output, { recursive: true });
  await Bun.write(`${output}/runtime-1MiB.eml`, renderRuntimeFixture(RUNTIME_FIXTURE_SIZES.oneMiB));
  await Bun.write(`${output}/runtime-5MiB.eml`, renderRuntimeFixture(RUNTIME_FIXTURE_SIZES.fiveMiB));
  await Bun.write(`${output}/runtime-near-raw-limit.eml`, renderRuntimeFixture(RUNTIME_FIXTURE_SIZES.nearRawLimit));
  console.log(JSON.stringify({ output, fixtures: RUNTIME_FIXTURE_SIZES }));
}

if (import.meta.main) await main();
