import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'bun:test';
import {
  RUNTIME_FIXTURE_LIMITS,
  RUNTIME_FIXTURE_SIZES,
  RUNTIME_FIXTURE_SPECS,
  renderRuntimeFixture,
  renderRuntimeFixtureCase
} from './runtime-fixtures';
import { parseInboundMime } from '$lib/server/inbound/parser';

describe('runtime MIME fixtures', () => {
  test('renders deterministic RFC MIME payloads at the requested sizes', () => {
    const first = renderRuntimeFixture(RUNTIME_FIXTURE_SIZES.oneMiB);
    const second = renderRuntimeFixture(RUNTIME_FIXTURE_SIZES.oneMiB);
    expect(first.byteLength).toBe(1 * 1024 * 1024);
    expect(first).toEqual(second);
    expect(new TextDecoder().decode(first.slice(0, 400))).toContain('Content-Type: text/plain');
  });

  test('covers the small, medium, large, attachment, HTML, mismatch, and deep cases', () => {
    expect(RUNTIME_FIXTURE_SPECS.map(({ id }) => id)).toEqual([
      'runtime-1MiB',
      'runtime-5MiB',
      'runtime-near-raw-limit',
      'single-attachment-near-15MiB',
      'attachments-near-total-cap',
      'multiple-attachments',
      'html-cid',
      'content-length-mismatch',
      'attachment-checksum-mismatch',
      'deep-multipart'
    ]);
    expect(renderRuntimeFixtureCase('runtime-5MiB').actualContentLength).toBe(RUNTIME_FIXTURE_SIZES.fiveMiB);
    expect(renderRuntimeFixtureCase('runtime-near-raw-limit').actualContentLength).toBe(RUNTIME_FIXTURE_SIZES.nearRawLimit);
    const inbound = renderRuntimeFixtureCase('single-attachment-near-15MiB');
    expect(inbound.attachmentBytes).toBe(15 * 1024 * 1024 - 12);
    expect(inbound.attachmentBytes).toBeGreaterThan(RUNTIME_FIXTURE_LIMITS.attachmentPerFile);
    expect(inbound.actualContentLength).toBeLessThan(RUNTIME_FIXTURE_LIMITS.inboundRaw);
  });

  test('adds a stable, PII-free correlation header to every generated message', () => {
    for (const spec of RUNTIME_FIXTURE_SPECS) {
      const fixture = renderRuntimeFixtureCase(spec.id);
      const header = new TextDecoder().decode(fixture.payload.slice(0, 1024));
      expect(header).toContain(`X-FlareMail-Runtime-Correlation: flaremail-rc1-${spec.id.toLowerCase()}`);
      expect(header.match(/X-FlareMail-Runtime-Correlation: (\S+)/u)?.[1])
        .toMatch(/^flaremail-rc1-[a-z0-9-]{1,96}$/u);
    }
  });

  test('keeps decoded near-cap attachments below the per-file and total limits', () => {
    const fixture = renderRuntimeFixtureCase('attachments-near-total-cap');
    expect(fixture.attachmentBytes).toBe(RUNTIME_FIXTURE_LIMITS.attachmentTotal - 12);
    expect(fixture.attachmentBytes).toBeLessThanOrEqual(RUNTIME_FIXTURE_LIMITS.attachmentTotal);
    expect(fixture.attachmentBytes / 3).toBeLessThan(RUNTIME_FIXTURE_LIMITS.attachmentPerFile);
    expect(new TextDecoder().decode(fixture.payload)).toContain('near-total-cap-boundary');
  });

  test('includes multiple filenames, HTML CID metadata, and deep boundaries', () => {
    const multiple = new TextDecoder().decode(renderRuntimeFixtureCase('multiple-attachments').payload);
    expect(multiple).toContain('alpha.txt');
    expect(multiple).toContain('beta.bin');
    expect(multiple).toContain('会议🚀.txt');

    const htmlCid = new TextDecoder().decode(renderRuntimeFixtureCase('html-cid').payload);
    expect(htmlCid).toContain('cid:logo@example.test');
    expect(htmlCid).toContain('Content-ID: <logo@example.test>');

    const deep = new TextDecoder().decode(renderRuntimeFixtureCase('deep-multipart').payload);
    expect(deep.match(/deep-boundary-/gu)?.length).toBe(24);
  });

  test('renders HTML/CID as a real related subtree for the production parser', async () => {
    const payload = renderRuntimeFixtureCase('html-cid').payload;
    const parsed = await parseInboundMime(payload.slice().buffer, {
      maxAttachmentCount: 50,
      maxAttachmentSize: 15 * 1024 * 1024,
      maxAttachmentTotalSize: 24 * 1024 * 1024
    });
    expect(parsed.html).toContain('cid:logo@example.test');
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0]).toMatchObject({ filename: 'logo.png', inline: true, contentId: '<logo@example.test>' });
  });

  test('records deliberate content-length and checksum mismatch paths', () => {
    const lengthMismatch = renderRuntimeFixtureCase('content-length-mismatch');
    expect(lengthMismatch.declaredContentLength).not.toBe(lengthMismatch.actualContentLength);
    expect(new TextDecoder().decode(lengthMismatch.payload)).toContain('Content-Length: 97');

    const checksumMismatch = renderRuntimeFixtureCase('attachment-checksum-mismatch');
    expect(checksumMismatch.checksum?.expectedSha256).not.toBe(checksumMismatch.checksum?.actualSha256);
    expect(checksumMismatch.checksum?.expectedSha256).toHaveLength(64);
    expect(new TextDecoder().decode(checksumMismatch.payload)).toContain('X-Fixture-Expected-SHA256: ' + '0'.repeat(64));
  });

  test('does not access environment secrets', async () => {
    const source = await readFile(new URL('./runtime-fixtures.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('process.env');
    expect(source).not.toContain('SECRET');
    expect(source).not.toContain('API_KEY');
  });

  test('supports a safe default temporary output directory', async () => {
    const child = Bun.spawn(['bun', 'scripts/runtime-fixtures.ts'], { stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
    const report = JSON.parse(stdout) as { mode: string; reportOnly: boolean; output: string; generated: Array<{ sha256: string }> };
    expect(report.mode).toBe('offline');
    expect(report.reportOnly).toBe(true);
    expect(report.output).toMatch(/\/tmp\/flaremail-runtime-[^/]+$/u);
    expect(report.generated).toHaveLength(10);
    expect(report.generated.every(({ sha256 }) => /^[a-f0-9]{64}$/u.test(sha256))).toBe(true);
  });
});
