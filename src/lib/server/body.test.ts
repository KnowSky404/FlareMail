import { describe, expect, test } from 'bun:test';
import { utf8ByteLength, truncateUtf8 } from '$lib/domain/utf8';
import { BODY_LIMITS, BodyCanonicalLimitError, prepareBodyObject, projectBody, putBodyObject, readBodyObject } from './body';

class Bucket {
  private readonly values = new Map<string, Uint8Array>();
  async put(key: string, value: Uint8Array) { this.values.set(key, new Uint8Array(value)); }
  async get(key: string) {
    const bytes = this.values.get(key);
    if (!bytes) return null;
    return { size: bytes.byteLength, body: new Response(bytes.buffer as ArrayBuffer).body, arrayBuffer: async () => bytes.buffer } as unknown as R2Object;
  }
}

describe('canonical body storage', () => {
  test('counts and truncates UTF-8 without splitting emoji or CJK', () => {
    const value = 'ASCII 中文 😀';
    expect(utf8ByteLength(value)).toBe(17);
    expect(truncateUtf8(value, 12)).toBe('ASCII 中文');
    expect(utf8ByteLength(truncateUtf8('😀😀', 5))).toBe(4);
  });

  test('projects large HTML while preserving the full canonical body in R2', async () => {
    const text = '正文😀'.repeat(70_000);
    const html = `<p>${'内容中文'.repeat(40_000)}</p>`;
    const projected = projectBody(text, html, text);
    expect(utf8ByteLength(projected.textBody)).toBeLessThanOrEqual(BODY_LIMITS.projectionTextBytes);
    expect(utf8ByteLength(projected.htmlBody)).toBeLessThanOrEqual(BODY_LIMITS.projectionHtmlBytes);
    const object = await prepareBodyObject('workspace_message', 'message-1', text, html);
    expect(object?.key).toMatch(/^body\/v1\/workspace_message\/message-1\/[A-Za-z0-9_-]+-[a-f0-9]{64}\.json$/u);
    const bucket = new Bucket();
    await putBodyObject(bucket as unknown as R2Bucket, object!);
    const restored = await readBodyObject(bucket as unknown as R2Bucket, object!.key, object!.sizeBytes, object!.sha256);
    expect(restored).toEqual({ version: 1, textBody: text, htmlBody: html });
  });

  test('rejects a canonical envelope before an oversized object is written', async () => {
    await expect(prepareBodyObject('draft', 'draft-1', 'x'.repeat(BODY_LIMITS.inlineBytes), '', {
      canonicalBytes: BODY_LIMITS.inlineBytes
    })).rejects.toBeInstanceOf(BodyCanonicalLimitError);
  });

  test('isolates concurrent writes of identical content', async () => {
    const body = 'same body'.repeat(40_000);
    const first = await prepareBodyObject('draft', 'draft-1', body);
    const second = await prepareBodyObject('draft', 'draft-1', body);
    expect(first?.sha256).toBe(second?.sha256);
    expect(first?.key).not.toBe(second?.key);
  });
});
