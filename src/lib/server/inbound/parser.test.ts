import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'bun:test';
import {
  InboundMimeLimitError,
  parseInboundMime,
  type ParsedInboundEmail
} from './parser';

const fixture = async (name: string): Promise<ArrayBuffer> => {
  const bytes = await readFile(new URL(`../../../../tests/fixtures/eml/${name}.eml`, import.meta.url));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
};

const parseFixture = (name: string, options?: Parameters<typeof parseInboundMime>[1]) =>
  fixture(name).then((raw) => parseInboundMime(raw, options));

describe('inbound MIME parser', () => {
  test('parses RFC metadata, addresses and safe plain-text snippet', async () => {
    const parsed = await parseFixture('plain');

    expect(parsed).toMatchObject({
      messageId: '<plain-1@example.com>',
      inReplyTo: '<previous@example.com>',
      references: '<root@example.com> <previous@example.com>',
      subject: 'Plain message',
      date: '2026-08-13T10:00:00.000Z',
      from: { name: 'Alice Example', address: 'alice@example.com' },
      to: [{ name: 'Bob Example', address: 'bob@example.com' }],
      cc: [{ name: 'Carol Example', address: 'carol@example.com' }]
    });
    expect(parsed.text).toContain('This is a plain-text message.');
    expect(parsed.html).toBe('');
    expect(parsed.snippet).toBe('Hello Bob, This is a plain-text message.');
    expect(parsed.snippet).not.toContain('<');
  });

  test('retains both text and HTML parts for an alternative message', async () => {
    const parsed = await parseFixture('html-alternative');

    expect(parsed.text).toContain('Plain fallback body.');
    expect(parsed.html).toContain('<strong>HTML</strong>');
    expect(parsed.snippet).toBe('Plain fallback body.');
    expect(parsed.snippet).not.toContain('<strong>');
  });

  test('decodes UTF-8 quoted-printable headers and body', async () => {
    const parsed = await parseFixture('chinese-quoted-printable');

    expect(parsed.from).toEqual({ name: '你好', address: 'hello@example.com' });
    expect(parsed.subject).toBe('中文主题');
    expect(parsed.text).toContain('你好，这是 一封邮件。'.replace('这是 ', '这是'));
  });

  test('returns attachment bytes, metadata and size', async () => {
    const parsed = await parseFixture('base64-attachment');
    const attachment = parsed.attachments[0];

    expect(attachment).toMatchObject({
      filename: 'hello.bin',
      mimeType: 'application/octet-stream',
      contentId: null,
      inline: false,
      size: 12
    });
    expect(new TextDecoder().decode(attachment.content)).toBe('Hello, file!');
  });

  test('recognizes inline related content by CID without rendering it', async () => {
    const parsed = await parseFixture('inline-cid');
    const attachment = parsed.attachments[0];

    expect(parsed.html).toContain('cid:logo@example.com');
    expect(attachment).toMatchObject({
      filename: 'logo.png',
      mimeType: 'image/png',
      contentId: '<logo@example.com>',
      inline: true,
      size: 8
    });
    expect(parsed.snippet).toBe('Logo:');
  });

  test('walks nested multipart sections', async () => {
    const parsed = await parseFixture('nested-multipart');

    expect(parsed.text).toContain('Nested plain body.');
    expect(parsed.html).toContain('Nested HTML body.');
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0]?.filename).toBe('note.txt');
  });

  test('tolerates missing message-id and malformed header lines', async () => {
    const missingId = await parseFixture('missing-message-id');
    const malformed = await parseFixture('malformed-header');

    expect(missingId.messageId).toBeNull();
    expect(missingId.text).toContain('no Message-ID header');
    expect(malformed.subject).toBe('Tolerable');
    expect(malformed.text).toContain('body remains readable');
  });

  test('enforces attachment count, per-file size and total size with typed errors', async () => {
    const parsed = await parseFixture('base64-attachment');
    expect(parsed.attachments).toHaveLength(1);

    for (const options of [
      { maxAttachmentCount: 0 },
      { maxAttachmentSize: 11 },
      { maxAttachmentTotalSize: 11 }
    ]) {
      try {
        await parseFixture('base64-attachment', options);
        throw new Error('expected the configured MIME limit to fail');
      } catch (error) {
        expect(error).toBeInstanceOf(InboundMimeLimitError);
        expect((error as InboundMimeLimitError).code).toBe('INBOUND_MIME_LIMIT');
      }
    }

    await expect(parseFixture('oversize-attachment', { maxAttachmentSize: 8 })).rejects.toMatchObject({
      code: 'INBOUND_MIME_LIMIT',
      kind: 'attachment_size',
      limit: 8,
      actual: 10
    });
  });

  test('keeps the result transport-neutral and never exposes raw parser objects', async () => {
    const parsed: ParsedInboundEmail = await parseFixture('plain');

    expect(Object.keys(parsed).sort()).toEqual([
      'attachments',
      'cc',
      'date',
      'from',
      'html',
      'inReplyTo',
      'messageId',
      'references',
      'snippet',
      'subject',
      'text',
      'to'
    ]);
    expect(parsed.attachments[0]).toBeUndefined();
  });
});
