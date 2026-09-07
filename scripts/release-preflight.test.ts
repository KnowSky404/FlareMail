import { describe, expect, test } from 'bun:test';
import { renderHuman, runPreflight, type CommandRunner } from './release-preflight';

const successfulCommands: CommandRunner = async (_executable, args) => {
  if (args.includes('search:index')) return { exitCode: 0, stdout: JSON.stringify({ expectedDocuments: 0, projectedDocuments: 0, missingDocuments: 0, orphanedDocuments: 0 }) };
  if (args.includes('cleanup-report')) return { exitCode: 0, stdout: JSON.stringify({ queue: { pending: 0, processing: 0, retryable: 0, manualReview: 0, staleProcessing: 0 } }) };
  if (args.includes('maintenance')) return { exitCode: 0, stdout: JSON.stringify({ r2: {}, staleClaims: {}, deliveryReview: {} }) };
  return { exitCode: 0 };
};
const cleanGit = async () => ({ exitCode: 0, status: '', head: '0123456789abcdef0123456789abcdef01234567' });

describe('release preflight', () => {
  test('is local/read-only and emits stable categories without running commands in unit mode', async () => {
    const report = await runPreflight({ runCommands: false, gitInspector: cleanGit });
    expect(report).toMatchObject({ version: 1, target: 'local', readOnly: true, ok: true });
    expect(report.checks.map(({ category }) => category)).toEqual(expect.arrayContaining([
      'git', 'bun', 'install', 'audit', 'config', 'bindings', 'schema', 'health', 'fts', 'cleanup',
      'checksum', 'claims', 'attachments', 'delivery', 'search', 'check', 'typegen', 'build'
    ]));
    expect(report.checks.find(({ category }) => category === 'fts')).toMatchObject({
      status: 'PASS', details: { dataState: 'not-checked', expectedDocuments: null, missingDocuments: null }
    });
    expect(report.checks.find(({ category }) => category === 'schema')).toMatchObject({
      status: 'PASS', details: { snapshotAligned: true }
    });
    expect(report.checks.find(({ category }) => category === 'health')).toMatchObject({
      status: 'PASS', details: { missingTables: [] }
    });
    expect(report.checks.find(({ category }) => category === 'config')).toMatchObject({
      status: 'PASS', details: {
        browserOriginPolicy: 'request-url',
        officialResendOrigin: 'https://api.resend.com',
        resendCredentialPresent: false,
        webhookCredentialPresent: false
      }
    });
    expect(JSON.stringify(report)).not.toMatch(/CLOUDFLARE_API_TOKEN|RESEND_API_KEY|COOKIE|mail\.example\.com|@example\.com/iu);
  });

  test('fails a required command gate and keeps the human output classified', async () => {
    const report = await runPreflight({
      runCommands: true,
      gitInspector: cleanGit,
      commandRunner: async (_executable, args) => ({ exitCode: args.includes('build') ? 1 : 0 })
    });
    expect(report.ok).toBe(false);
    expect(report.checks.find(({ category }) => category === 'build')).toMatchObject({ status: 'FAIL' });
    expect(renderHuman(report)).toContain('FAIL build:');
  });

  test('accepts successful injected command gates without touching production state', async () => {
    const report = await runPreflight({ runCommands: true, gitInspector: cleanGit, commandRunner: successfulCommands });
    expect(report.ok).toBe(true);
    expect(report.checks.filter(({ category }) => ['check', 'typegen', 'build'].includes(category)).map(({ status }) => status))
      .toEqual(['PASS', 'PASS', 'PASS']);
  });

  test('fails dirty Git state and executes frozen install plus search verification gates', async () => {
    const dirty = await runPreflight({ runCommands: false, gitInspector: async () => ({
      exitCode: 0, status: ' M package.json', head: '0123456789abcdef0123456789abcdef01234567'
    }) });
    expect(dirty.ok).toBe(false);
    expect(dirty.checks.find(({ category }) => category === 'git')).toMatchObject({ status: 'FAIL' });

    const calls: string[][] = [];
    const commandRunner: CommandRunner = async (_executable, args) => {
      calls.push(args);
      if (args.includes('search:index')) return { exitCode: 0, stdout: JSON.stringify({ expectedDocuments: 2, projectedDocuments: 2, missingDocuments: 0, orphanedDocuments: 0 }) };
      if (args.includes('cleanup-report')) return { exitCode: 0, stdout: JSON.stringify({ queue: { pending: 0, processing: 0, retryable: 0, manualReview: 0, staleProcessing: 0 } }) };
      if (args.includes('maintenance')) return { exitCode: 0, stdout: JSON.stringify({ r2: { cleanupQueueRows: 0, expiredAttachmentRows: 0 }, staleClaims: { candidates: 0 }, deliveryReview: { staleSubmitting: 0, expiredReviewRequired: 0 } }) };
      return { exitCode: 0 };
    };
    const report = await runPreflight({ runCommands: true, gitInspector: cleanGit, commandRunner });
    expect(report.ok).toBe(true);
    expect(calls.some((args) => args.includes('--frozen-lockfile'))).toBe(true);
    expect(calls.some((args) => args.includes('search:index'))).toBe(true);
    expect(calls.some((args) => args.includes('cleanup-report'))).toBe(true);
    expect(report.checks.find(({ category }) => category === 'search')).toMatchObject({
      status: 'PASS', details: { expectedDocuments: 2, missingDocuments: 0, orphanedDocuments: 0 }
    });
    expect(report.checks.find(({ category }) => category === 'cleanup')).toMatchObject({
      status: 'PASS', details: { backlog: 0, retryable: 0, manualReview: 0, staleJobs: 0 }
    });
  });
});
