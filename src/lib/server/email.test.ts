import { describe, expect, test } from 'bun:test';
import { createInboundDedupeKey, InboundRawLimitError, readBoundedRawEmail, resolveInboundCorrelationId } from './email';
import { sha256Hex } from './attachment-integrity';

const stream = (chunks: string[]) => new ReadableStream<Uint8Array>({
  start(controller) {
    for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
    controller.close();
  }
});

describe('inbound ingestion primitives', () => {
  test('reads the raw stream once and enforces declared and observed size', async () => {
    const raw = await readBoundedRawEmail(stream(['hello', ' world']), 11, 11);
    expect(new TextDecoder().decode(raw)).toBe('hello world');
    await expect(readBoundedRawEmail(stream(['ignored']), 20, 10)).rejects.toBeInstanceOf(InboundRawLimitError);
    await expect(readBoundedRawEmail(stream(['12345', '67890']), 0, 9)).rejects.toMatchObject({ code: 'INBOUND_RAW_LIMIT' });
  });

  test('deduplicates by normalized Message-ID plus recipient when available', async () => {
    const first = new TextEncoder().encode('first').buffer;
    const second = new TextEncoder().encode('second').buffer;
    expect(await createInboundDedupeKey('<ABC@example.test>', ' User@Example.test ', first))
      .toBe('rfc:abc@example.test:to:user@example.test');
    expect(await createInboundDedupeKey('<ABC@example.test>', 'user@example.test', second))
      .toBe('rfc:abc@example.test:to:user@example.test');
  });

  test('falls back to stable raw SHA-256 plus recipient', async () => {
    const raw = new TextEncoder().encode('same raw').buffer;
    expect(await createInboundDedupeKey(null, 'a@example.test', raw))
      .toBe(await createInboundDedupeKey(null, 'a@example.test', raw));
    expect(await createInboundDedupeKey(null, 'a@example.test', raw))
      .not.toBe(await createInboundDedupeKey(null, 'b@example.test', raw));
  });

  test('computes a stable lowercase SHA-256 for bounded attachment bytes', async () => {
    expect(await sha256Hex(new TextEncoder().encode('attachment bytes')))
      .toBe('2508f58332a50c3fee16cc39d28bd45b17d7c3d65ec32b7ebd024d55b7a1393d');
  });

  test('accepts only preview runtime correlation headers', () => {
    const valid = 'flaremail-rc1-multiple-attachments';
    expect(resolveInboundCorrelationId(new Headers({ 'X-FlareMail-Runtime-Correlation': valid }), 'preview')).toBe(valid);
    expect(resolveInboundCorrelationId(new Headers({ 'X-FlareMail-Runtime-Correlation': valid }), 'production')).not.toBe(valid);
    expect(resolveInboundCorrelationId(new Headers({ 'X-FlareMail-Runtime-Correlation': valid }))).not.toBe(valid);
    expect(resolveInboundCorrelationId(new Headers({ 'X-FlareMail-Runtime-Correlation': valid }), 'staging')).not.toBe(valid);
    expect(resolveInboundCorrelationId(new Headers({ 'X-FlareMail-Runtime-Correlation': 'operator-supplied' }), 'preview')).not.toBe('operator-supplied');
  });
});
