import { describe, expect, test } from 'bun:test';
import {
  assertAttachmentIntegrityTarget,
  AttachmentIntegrityCliError,
  main,
  parseAttachmentIntegrityArgs,
  runAttachmentIntegrityCli
} from './attachment-integrity';

describe('attachment-integrity CLI', () => {
  test('defaults to bounded local report-only mode and forwards cursor', async () => {
    const options = parseAttachmentIntegrityArgs(['--limit', '17', '--cursor', 'attachment-17', '--json']);
    expect(options).toMatchObject({ apply: false, remote: false, limit: 17, cursor: 'attachment-17', json: true });
    let forwarded: Record<string, unknown> | undefined;
    const report = await runAttachmentIntegrityCli(options, {
      bindings: { db: {} as D1Database, bucket: {} as R2Bucket },
      repair: async (_db, _bucket, repairOptions) => {
        forwarded = repairOptions;
        return { scanned: 0, updated: 0, rows: [], nextCursor: null };
      }
    });
    expect(report).toEqual({ scanned: 0, updated: 0, rows: [], nextCursor: null });
    expect(forwarded).toMatchObject({ limit: 17, afterId: 'attachment-17', apply: false });
  });

  test('requires explicit apply and remote flags in the parsed contract', () => {
    expect(parseAttachmentIntegrityArgs(['--apply', '--remote', '--config', 'wrangler.preview.toml', '--repair-mismatches']))
      .toMatchObject({ apply: true, remote: true, repairMismatches: true, config: 'wrangler.preview.toml' });
    expect(() => parseAttachmentIntegrityArgs(['--limit', '501'])).toThrow(AttachmentIntegrityCliError);
    expect(() => parseAttachmentIntegrityArgs(['--cursor', 'filename with spaces'])).toThrow(AttachmentIntegrityCliError);
  });

  test('audits a local Wrangler target without exposing object keys', async () => {
    const options = parseAttachmentIntegrityArgs(['--json']);
    const content = new TextEncoder().encode('hello');
    const commands: string[][] = [];
    const report = await runAttachmentIntegrityCli(options, {
      environment: { APP_ENV: 'development' },
      configSource: `[vars]\nAPP_ENV = "development"\n\n[[r2_buckets]]\nbinding = "BUCKET"\nbucket_name = "local-bucket"`,
      commandRunner: async (_executable, args) => {
        commands.push(args);
        return {
          exitCode: 0,
          stderr: '',
          stdout: JSON.stringify([{ results: [{
            id: 'attachment-1', user_id: 'owner-1', message_id: 'message-1',
            raw_key: 'inbound/2026-08-20/storage-1/message.eml',
            r2_key: 'inbound/2026-08-20/storage-1/attachments/attachment-1/file.txt',
            size: content.byteLength, sha256: null
          }], success: true }])
        };
      },
      objectReader: async (bucket, key) => {
        expect(bucket).toBe('local-bucket');
        expect(key).toEndWith('/attachments/attachment-1/file.txt');
        return { status: 'ok', bytes: content };
      }
    });
    expect(report).toMatchObject({ scanned: 1, updated: 0, nextCursor: 'attachment-1' });
    expect(report.rows).toEqual([{ id: 'attachment-1', messageId: 'message-1', status: 'legacy' }]);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain('--local');
  });

  test('updates only with apply and a guarded D1 statement', async () => {
    const options = parseAttachmentIntegrityArgs(['--apply']);
    const commands: string[][] = [];
    const report = await runAttachmentIntegrityCli(options, {
      configSource: `[vars]\nAPP_ENV = "development"\n\n[[r2_buckets]]\nbinding = "BUCKET"\nbucket_name = "local-bucket"`,
      commandRunner: async (_executable, args) => {
        commands.push(args);
        if (commands.length === 1) return {
          exitCode: 0, stderr: '', stdout: JSON.stringify([{ results: [{
            id: 'attachment-2', user_id: 'owner-1', message_id: 'message-2',
            raw_key: 'inbound/2026-08-20/storage-2/message.eml',
            r2_key: 'inbound/2026-08-20/storage-2/attachments/attachment-2/file.bin',
            size: 3, sha256: null
          }] }])
        };
        return { exitCode: 0, stderr: '', stdout: JSON.stringify([{ results: [], meta: { changes: 1 } }]) };
      },
      objectReader: async () => ({ status: 'ok', bytes: new Uint8Array([1, 2, 3]) })
    });
    expect(report.updated).toBe(1);
    expect(report.rows[0]?.status).toBe('updated');
    expect(commands).toHaveLength(2);
    expect(commands[1].join(' ')).toContain('sha256 IS NULL');
  });

  test('fails closed for production and non-preview remote targets', async () => {
    const remote = parseAttachmentIntegrityArgs(['--remote', '--config', 'wrangler.preview.toml']);
    expect(() => assertAttachmentIntegrityTarget(remote, { APP_ENV: 'production' })).toThrow(/refused/u);
    const productionConfig = parseAttachmentIntegrityArgs(['--remote', '--config', 'wrangler.deploy.toml']);
    expect(() => assertAttachmentIntegrityTarget(productionConfig, { APP_ENV: 'preview' })).toThrow(/refused/u);
    await expect(runAttachmentIntegrityCli(remote, {
      configSource: `[vars]\nAPP_ENV = "development"\n\n[[r2_buckets]]\nbinding = "BUCKET"\npreview_bucket_name = "preview-bucket"`
    })).rejects.toMatchObject({ code: 'PREVIEW_REQUIRED' });
    const result = await main(['--json', '--config', 'missing-wrangler.toml'], { APP_ENV: 'development' });
    expect(result).toBe(1);
  });
});
