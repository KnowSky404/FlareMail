import { adapterOptions } from './adapter-config.mjs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, spyOn, test } from 'bun:test';
import { createDeployInvocation, parseDeployMode, requireDeployConfig, normalizeDeployArguments } from './deploy-command';
import { createD1Command, localDatabaseId, executeD1, normalizeD1Output, parseCloudflareTarget, projectRoot, readCloudflareTarget } from './cloudflare-target';
import localTarget from '../cloudflare.local.json';
import cloudflareConfig from '../cloudflare.config';
import { assertPauseConfiguration, assertProductionReleaseSource, assertSharedInboundPreview, assertSharedInboundProduction, fixedReservationHash, sharedInboundPreviewTargetHash, verifyProductionWorkerDev } from './shared-inbound-preview';

test('production source must match the exact PRE acceptance tree', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'flaremail-release-source-'));
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(['git', '-c', 'user.name=Release Test', '-c', 'user.email=release@example.test', ...args], { cwd: directory });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  try {
    git('init', '--quiet');
    await writeFile(join(directory, 'source.txt'), 'accepted\n');
    git('add', 'source.txt');
    git('commit', '--quiet', '-m', 'PRE acceptance');
    const acceptedPreviewCommit = git('rev-parse', 'HEAD');
    const equivalent = git('commit-tree', 'HEAD^{tree}', '-m', 'rebase result');
    git('checkout', '--quiet', '--detach', equivalent);
    expect(() => assertProductionReleaseSource(directory, { releaseCommit: equivalent, acceptedPreviewCommit })).not.toThrow();
    await writeFile(join(directory, 'source.txt'), 'differs\n');
    git('add', 'source.txt');
    git('commit', '--quiet', '-m', 'unaccepted edit');
    expect(() => assertProductionReleaseSource(directory, { releaseCommit: git('rev-parse', 'HEAD'), acceptedPreviewCommit }))
      .toThrow('INBOUND_PRODUCTION_RELEASE_DIFFERS_FROM_PRE_ACCEPTANCE');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('emergency pause keeps the same authentication variables, secrets and production cron', () => {
  const target = {
    ...localTarget, vars: { AUTH_MODE: 'access', PRE_INBOUND_ENABLED: 'false' },
    secrets: ['RESEND_API_KEY'], cron: ['* * * * *']
  };
  const active = {
    bindings: [{ name: 'AUTH_MODE', type: 'plain_text', text: 'access' }, { name: 'RESEND_API_KEY', type: 'secret_text' }],
    compatibilityDate: target.compatibilityDate, compatibilityFlags: target.compatibilityFlags, cron: target.cron
  };
  expect(() => assertPauseConfiguration(target, active)).not.toThrow();
  expect(() => assertPauseConfiguration({ ...target, vars: { ...target.vars, AUTH_MODE: 'local' } }, active))
    .toThrow('INBOUND_PRODUCTION_PAUSE_CONFIGURATION_CHANGED');
  expect(() => assertPauseConfiguration({ ...target, cron: [] }, active))
    .toThrow('INBOUND_PRODUCTION_PAUSE_CONFIGURATION_CHANGED');
});

test('production requires live historical URL isolation and keeps the main URL setting', async () => {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  process.env.CLOUDFLARE_ACCOUNT_ID = 'a'.repeat(32);
  const legacyToken = process.env.CF_API_TOKEN;
  delete process.env.CLOUDFLARE_API_TOKEN;
  process.env.CF_API_TOKEN = 'fixture-token';
  const fetch = spyOn(globalThis, 'fetch');
  try {
    fetch.mockResolvedValueOnce(Response.json({ success: true, result: { enabled: true, previews_enabled: true } }));
    await expect(verifyProductionWorkerDev(localTarget, projectRoot)).rejects.toThrow('INBOUND_PRODUCTION_VERSION_URLS_NOT_DISABLED');
    fetch.mockResolvedValueOnce(Response.json({ success: true, result: { enabled: true, previews_enabled: false } }));
    await expect(verifyProductionWorkerDev(localTarget, projectRoot)).resolves.toBe(true);
    expect(fetch.mock.calls[0]?.[1]?.headers).toEqual({ Authorization: 'Bearer fixture-token' });
  } finally {
    fetch.mockRestore();
    if (account === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID;
    else process.env.CLOUDFLARE_ACCOUNT_ID = account;
    if (token === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = token;
    if (legacyToken === undefined) delete process.env.CF_API_TOKEN;
    else process.env.CF_API_TOKEN = legacyToken;
  }
});

test('production activation requires the reviewed PRE and an active, paused protection deployment', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'flaremail-shared-prod-'));
  const file = join(directory, 'target.json');
  const proof = join(directory, 'proof.json');
  const env = { FLAREMAIL_CF_CONFIG: file, FLAREMAIL_INBOUND_PRODUCTION_PREFLIGHT: proof, CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32) };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  const production = { databaseId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', bucket: 'prod-bucket', deploymentId: 'current-prod' };
  const preview = { databaseId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', bucket: 'pre-bucket', deploymentId: 'accepted-pre', buildLabel: 'preview+' + 'c'.repeat(7) };
  const candidate = {
    ...localTarget, databaseId: production.databaseId, bucket: production.bucket,
    preInbound: { databaseId: preview.databaseId, databaseName: 'pre', bucket: preview.bucket },
    inboundRouting: { databaseId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', databaseName: 'routing', environment: 'production' as const },
    vars: { ...localTarget.vars, APP_ENV: 'production', APP_VERSION: 'production+' + 'e'.repeat(7), PRE_INBOUND_ENABLED: 'false' }
  };
  const evidence = {
    checkedAt: new Date().toISOString(), accountId: env.CLOUDFLARE_ACCOUNT_ID, previewName: 'mail-ai', workerName: candidate.name,
    production, preview, routingDatabaseId: candidate.inboundRouting.databaseId, registryVerified: true, ownerAcceptanceVerified: true,
    releaseCommit: 'e'.repeat(40), acceptedPreviewCommit: 'c'.repeat(40), versionUrlsDisabled: true, legacyOperationsQuiesced: true
  };
  Object.assign(process.env, env);
  try {
    await writeFile(file, JSON.stringify(candidate), { mode: 0o600 });
    await writeFile(proof, JSON.stringify({ ...evidence, phase: 'protect', targetHash: sharedInboundPreviewTargetHash(candidate) }), { mode: 0o600 });
    expect(assertSharedInboundProduction(readCloudflareTarget(file, true), proof)).toMatchObject({
      releaseCommit: evidence.releaseCommit, acceptedPreviewCommit: evidence.acceptedPreviewCommit
    });
    await expect(cloudflareConfig.worker({ mode: 'production', isPreview: false })).rejects.toThrow('INBOUND_PRODUCTION_RELEASE_SOURCE_NOT_VERIFIED');

    await writeFile(proof, JSON.stringify({ ...evidence, phase: 'pause', preview: undefined, acceptedPreviewCommit: undefined,
      ownerAcceptanceVerified: false, targetHash: sharedInboundPreviewTargetHash(candidate) }));
    expect(assertSharedInboundProduction(readCloudflareTarget(file, true), proof)).toMatchObject({ pauseOnly: true });

    const active = { ...candidate, vars: { ...candidate.vars, PRE_INBOUND_ENABLED: 'true' } };
    await writeFile(file, JSON.stringify(active));
    const activation = { ...evidence, phase: 'activate', targetHash: sharedInboundPreviewTargetHash(active),
      protectVersionId: 'bbbbbbbb-1234-4123-8123-bbbbbbbbbbbb', protectionActive: true, mailRoutesAndMappingsVerified: true, preCatchAllsVerified: true };
    await writeFile(proof, JSON.stringify({ ...activation, protectionActive: false }));
    await expect(cloudflareConfig.worker({ mode: 'production', isPreview: false })).rejects.toThrow('INBOUND_PRODUCTION_PREFLIGHT_INVALID');
    await writeFile(proof, JSON.stringify(activation));
    expect(assertSharedInboundProduction(readCloudflareTarget(file, true), proof)).toMatchObject({ releaseCommit: evidence.releaseCommit });
    await writeFile(proof, JSON.stringify({ ...evidence, phase: 'maintain', targetHash: sharedInboundPreviewTargetHash(active) }));
    expect(assertSharedInboundProduction(readCloudflareTarget(file, true), proof)).toMatchObject({ maintaining: true, protectVersionId: null });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test('allows only a verified, native read-only shared PRE build', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'flaremail-shared-pre-'));
  const file = join(directory, 'target.json');
  const receiptPath = join(directory, 'receipt.json');
  const previewCommit = 'c'.repeat(40);
  const env = { FLAREMAIL_CF_CONFIG: file, FLAREMAIL_INBOUND_PREVIEW_PREFLIGHT: receiptPath, CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32) };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  const candidate = {
    ...localTarget, databaseId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', bucket: 'preview-bucket', cron: [],
    vars: { ...localTarget.vars, APP_ENV: 'preview', APP_VERSION: 'preview+' + previewCommit.slice(0, 7), AUTO_REPLY_ENABLED: 'false', INBOUND_NOTIFICATION_ENABLED: 'false', TELEGRAM_ENABLED: 'false' },
    inboundRouting: { databaseId: '33333333-3333-4333-8333-333333333333', databaseName: 'routing', environment: 'preview' as const }
  };
  const receipt = {
    accountId: env.CLOUDFLARE_ACCOUNT_ID, workerName: candidate.name, previewName: 'mail-ai', previewCommit, checkedAt: new Date().toISOString(),
    targetHash: sharedInboundPreviewTargetHash(candidate), registryVerified: true, previewBaseVerified: true,
    routingDatabaseId: candidate.inboundRouting.databaseId,
    preview: { deploymentId: 'preview-version', databaseId: candidate.databaseId, bucket: candidate.bucket },
    production: { deploymentId: 'prod-version', databaseId: localTarget.databaseId, bucket: 'production-bucket', previewDelivery: null }
  };
  Object.assign(process.env, env);
  try {
    await writeFile(file, JSON.stringify(candidate), { mode: 0o600 });
    await writeFile(receiptPath, JSON.stringify(receipt), { mode: 0o600 });
    expect(assertSharedInboundPreview(readCloudflareTarget(file, true), receiptPath)).toMatchObject({ previewCommit, managementEnabled: false });
    await writeFile(receiptPath, JSON.stringify({ ...receipt, previewManagementAuthorized: true }));
    expect(() => assertSharedInboundPreview(readCloudflareTarget(file, true), receiptPath)).toThrow('INBOUND_PREVIEW_PREFLIGHT_INVALID');
    await writeFile(receiptPath, JSON.stringify(receipt));
    await expect(cloudflareConfig.worker({ mode: 'preview', isPreview: true })).rejects.toThrow('INBOUND_PREVIEW_RELEASE_SOURCE_NOT_VERIFIED');
    await expect(cloudflareConfig.worker({ mode: 'preview', isPreview: false })).rejects.toThrow('PRE_INBOUND_RELEASE_GUARDS_REQUIRED');
    await writeFile(receiptPath, JSON.stringify({ ...receipt, production: { ...receipt.production, databaseId: candidate.databaseId.toUpperCase() } }));
    await expect(cloudflareConfig.worker({ mode: 'preview', isPreview: true })).rejects.toThrow('INBOUND_PREVIEW_PREFLIGHT_INVALID');
    await writeFile(receiptPath, JSON.stringify({ ...receipt, production: { ...receipt.production, previewDelivery: {
      databaseId: localTarget.databaseId, bucket: candidate.bucket, routingDatabaseId: candidate.inboundRouting.databaseId
    } } }));
    await expect(cloudflareConfig.worker({ mode: 'preview', isPreview: true })).rejects.toThrow('INBOUND_PREVIEW_PREFLIGHT_INVALID');
    await writeFile(receiptPath, JSON.stringify({ ...receipt, checkedAt: '2000-01-01T00:00:00.000Z' }));
    await expect(cloudflareConfig.worker({ mode: 'preview', isPreview: true })).rejects.toThrow('INBOUND_PREVIEW_PREFLIGHT_INVALID');
    const fixed = { ...candidate, vars: { ...candidate.vars, PRE_INBOUND_RECIPIENT: 'pre@example.test' } };
    await writeFile(file, JSON.stringify(fixed));
    await writeFile(receiptPath, JSON.stringify({ ...receipt, targetHash: sharedInboundPreviewTargetHash(fixed) }));
    await expect(cloudflareConfig.worker({ mode: 'preview', isPreview: true })).rejects.toThrow('INBOUND_PREVIEW_PREFLIGHT_INVALID');
    await writeFile(receiptPath, JSON.stringify({ ...receipt, targetHash: sharedInboundPreviewTargetHash(fixed),
      fixedReservationHash: fixedReservationHash('  PRE@EXAMPLE.TEST ') }));
    expect(assertSharedInboundPreview(readCloudflareTarget(file, true), receiptPath)).toMatchObject({ previewCommit });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});

describe('global cf commands', () => {
  test('requires complete, isolated inbound storage and keeps deployment roles distinct', () => {
    const vars = { ...localTarget.vars, PRE_INBOUND_RECIPIENT: 'pre@example.test', PRE_INBOUND_ENABLED: 'false' };
    const preInbound = {
      databaseId: '11111111-1111-4111-8111-111111111111',
      databaseName: 'flaremail-pre',
      bucket: 'flaremail-pre'
    };
    const parse = (value: unknown) => parseCloudflareTarget(JSON.stringify(value));
    expect(parse({ ...localTarget, vars, preInbound }).preInbound).toEqual(preInbound);
    expect(() => parse({ ...localTarget, vars })).toThrow('PRE_INBOUND_CONFIGURATION_INVALID');
    expect(() => parse({ ...localTarget, vars: { ...vars, PRE_INBOUND_ENABLED: 'yes' }, preInbound })).toThrow('PRE_INBOUND_CONFIGURATION_INVALID');
    expect(() => parse({ ...localTarget, secrets: ['PRE_INBOUND_SETTINGS'] })).toThrow('PRE_INBOUND_CONFIGURATION_INVALID');
    expect(() => parse({ ...localTarget, preInbound })).toThrow('PRE_INBOUND_CONFIGURATION_INVALID');
    expect(() => parse({ ...localTarget, vars, preInbound: { ...preInbound, bucket: localTarget.bucket } })).toThrow('PRE_INBOUND_STORAGE_CONFIGURATION_INVALID');
    expect(() => parse({ ...localTarget, vars, preInbound: { ...preInbound, databaseId: localTarget.databaseId } })).toThrow('PRE_INBOUND_STORAGE_CONFIGURATION_INVALID');
    expect(() => parse({ ...localTarget, vars: { ...vars, APP_ENV: 'preview' }, preInbound })).toThrow('PRE_INBOUND_CONFIGURATION_INVALID');
    const { PRE_INBOUND_ENABLED: _enabled, ...previewVars } = vars;
    expect(parse({ ...localTarget, vars: { ...previewVars, APP_ENV: 'preview' } }).vars.PRE_INBOUND_RECIPIENT).toBe('pre@example.test');
  });
  test('separates production uploads from an offline prebuilt dry run', () => {
    const environment = { CLOUDFLARE_API_TOKEN: 'test-placeholder', PATH: '/global/bin' };
    expect(createDeployInvocation('deploy', environment)).toEqual({ command: 'cf', args: ['deploy', '--mode', 'production', '--provision=false'], env: environment });
    expect(createDeployInvocation('dry-run', environment).args).toEqual(['deploy', '--prebuilt', '--dry-run', '--provision=false']);
    expect(() => normalizeDeployArguments(['--profile', 'other-account'])).toThrow('controlled by this script');
  });
  test('fails closed for unsupported modes and missing private targets', () => {
    expect(() => parseDeployMode('preview')).toThrow('Unsupported deploy mode');
    expect(() => requireDeployConfig('cloudflare.deploy.json', () => false)).toThrow('Missing cloudflare.deploy.json');
    expect(() => readCloudflareTarget('cloudflare.local.json', true)).toThrow('Remote commands require');
  });
  test('uses cf raw SQL with an explicit local ID and isolated state', () => {
    expect(createD1Command({ persistTo: '/tmp/cf-fixture-state' }, 'SELECT 1')).toEqual([
      'cf', 'd1', 'raw', localDatabaseId, '--sql', 'SELECT 1', '--local', '--persist-to', '/tmp/cf-fixture-state'
    ]);
    expect(() => createD1Command({ database: 'another-database' }, 'SELECT 1')).toThrow('must match');
    const batch = createD1Command({}, ['SELECT 1', 'SELECT 2']);
    expect(batch).toContain('--batch');
    expect(JSON.parse(batch[batch.indexOf('--batch') + 1]!)).toEqual([{ sql: 'SELECT 1' }, { sql: 'SELECT 2' }]);
  });
  test('preserves named columns, nulls, batch results and metadata from cf raw', () => {
    expect(normalizeD1Output([{ success: true, results: { columns: ['value'], rows: [[42]] }, meta: { changes: 1 } }])).toEqual([{ success: true, results: [{ value: 42 }], meta: { changes: 1 } }]);
    expect(normalizeD1Output({ result: [{ columns: ['name', 'count'], rows: [['fixture', 2], [null, 0]], meta: { changes: 1 } }] })).toEqual({ result: [{ columns: ['name', 'count'], rows: [['fixture', 2], [null, 0]], results: [{ name: 'fixture', count: 2 }, { name: null, count: 0 }], meta: { changes: 1 } }] });
  });
});

test('native remote builds reject PRE reservations while local builds keep both bindings', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'flaremail-inbound-target-'));
  const previous = process.env.FLAREMAIL_CF_CONFIG;
  const vars = { ...localTarget.vars, PRE_INBOUND_RECIPIENT: 'pre@example.test', PRE_INBOUND_ENABLED: 'false' };
  const target = {
    ...localTarget,
    databaseId: '11111111-1111-4111-8111-111111111111',
    vars,
    preInbound: { databaseId: '22222222-2222-4222-8222-222222222222', databaseName: 'flaremail-pre', bucket: 'flaremail-pre' }
  };
  const file = join(directory, 'target.json');
  process.env.FLAREMAIL_CF_CONFIG = file;
  try {
    await writeFile(file, JSON.stringify(target), { mode: 0o600 });
    const local = await cloudflareConfig.worker({ mode: 'development', isPreview: false });
    expect(local.env.PRE_INBOUND_DB?.id).toBe(target.preInbound.databaseId);
    expect(local.env.PRE_INBOUND_BUCKET?.name).toBe(target.preInbound.bucket);
    const localAdapter = JSON.parse(await readFile(adapterOptions(true).config, 'utf8'));
    expect(localAdapter.d1_databases).toContainEqual({ binding: 'PRE_INBOUND_DB', database_name: target.preInbound.databaseName, database_id: target.preInbound.databaseId });
    expect(localAdapter.r2_buckets).toContainEqual({ binding: 'PRE_INBOUND_BUCKET', bucket_name: target.preInbound.bucket });
    await expect(cloudflareConfig.worker({ mode: 'development', isPreview: true })).rejects.toThrow('PRE_INBOUND_RELEASE_GUARDS_REQUIRED');

    await writeFile(file, JSON.stringify({ ...target, vars: { ...vars, APP_ENV: 'production' } }));
    await expect(cloudflareConfig.worker({ mode: 'production', isPreview: false })).rejects.toThrow('PRE_INBOUND_RELEASE_GUARDS_REQUIRED');

    const { PRE_INBOUND_ENABLED: _enabled, ...previewVars } = vars;
    await writeFile(file, JSON.stringify({ ...localTarget, ...target.preInbound, vars: { ...previewVars, APP_ENV: 'preview' } }));
    await expect(cloudflareConfig.worker({ mode: 'preview', isPreview: true })).rejects.toThrow('PRE_INBOUND_RELEASE_GUARDS_REQUIRED');

    const inboundRouting = { databaseId: '33333333-3333-4333-8333-333333333333', databaseName: 'routing', environment: 'production' };
    const dynamic = { ...target, vars: { ...localTarget.vars, PRE_INBOUND_ENABLED: 'true' }, inboundRouting };
    await writeFile(file, JSON.stringify(dynamic));
    const dynamicBuild = await cloudflareConfig.worker({ mode: 'development', isPreview: false });
    expect(dynamicBuild.env.INBOUND_ROUTING_DB?.id).toBe(inboundRouting.databaseId);
    expect(dynamicBuild.env.PRE_INBOUND_SETTINGS?.value).toEqual({ recipient: null, enabled: true });
    await expect(cloudflareConfig.worker({ mode: 'development', isPreview: true })).rejects.toThrow('PRE_INBOUND_RELEASE_GUARDS_REQUIRED');
    const child = Bun.spawn(['cf', 'build', '--mode', 'development'], {
      cwd: join(projectRoot, 'worker'),
      env: { ...process.env, FLAREMAIL_CF_CONFIG: file },
      stdout: 'ignore',
      stderr: 'pipe'
    });
    const [exitCode, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(exitCode).not.toBe(0);
    expect(error).toContain('PRE_INBOUND_RELEASE_GUARDS_REQUIRED');
    expect(() => parseCloudflareTarget(JSON.stringify({
      ...dynamic, inboundRouting: { ...inboundRouting, databaseId: target.preInbound.databaseId }
    }))).toThrow('INBOUND_ROUTING_CONFIGURATION_INVALID');

    await writeFile(file, JSON.stringify({ ...localTarget, ...target.preInbound, vars: previewVars,
      inboundRouting: { ...inboundRouting, environment: 'preview' } }));
    const previewApp = await cloudflareConfig.worker({ mode: 'development', isPreview: false });
    expect(previewApp.env.PRE_INBOUND_SETTINGS?.value).toEqual({ recipient: 'pre@example.test', enabled: false, previewApp: true });
    expect(previewApp.env.PRE_INBOUND_DB).toBeUndefined();
    const adapter = JSON.parse(await readFile(adapterOptions(true).config, 'utf8'));
    expect(adapter.vars.PRE_INBOUND_SETTINGS).toEqual(previewApp.env.PRE_INBOUND_SETTINGS?.value);

    await writeFile(file, JSON.stringify({ ...localTarget, ...target.preInbound, vars: previewVars }));
    const fixedApp = await cloudflareConfig.worker({ mode: 'development', isPreview: false });
    expect(fixedApp.env.DB.id).toBe(target.preInbound.databaseId);
    expect(fixedApp.env.INBOUND_ROUTING_DB).toBeUndefined();
    expect(fixedApp.env.PRE_INBOUND_SETTINGS?.value).toEqual(previewApp.env.PRE_INBOUND_SETTINGS?.value);
    expect(JSON.parse(await readFile(adapterOptions(true).config, 'utf8')).vars.PRE_INBOUND_SETTINGS)
      .toEqual(fixedApp.env.PRE_INBOUND_SETTINGS?.value);
  } finally {
    if (previous === undefined) delete process.env.FLAREMAIL_CF_CONFIG;
    else process.env.FLAREMAIL_CF_CONFIG = previous;
    await rm(directory, { recursive: true, force: true });
  }
});


test('normalizes secret files from the caller directory and rejects policy overrides', () => {
  expect(normalizeDeployArguments(['--secrets-file', '../release-secrets.json'], '/workspace/app')).toEqual(['--secrets-file', '/workspace/release-secrets.json']);
  expect(normalizeDeployArguments(['--secrets-file=../release-secrets.json'], '/workspace/app')).toEqual(['--secrets-file=/workspace/release-secrets.json']);
  expect(() => normalizeDeployArguments(['--secrets-file'])).toThrow('requires a path');
  expect(() => normalizeDeployArguments(['--provision=true'])).toThrow('controlled by this script');
});


test('cf consumes protected SQL files without inline query data in argv', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'flaremail-d1-file-'));
  try {
    const file = join(directory, 'credential request.sql');
    await writeFile(file, 'SELECT 42 AS safe_transport', { mode: 0o600 });
    const options = { config: 'cloudflare.local.json', persistTo: join(directory, 'state') };
    const command = createD1Command(options, `@${file}`);
    expect(command).toContain(`@${file}`);
    expect(command.join(' ')).not.toContain('safe_transport');
    const previous = process.env.FLAREMAIL_CF_CONFIG;
    try {
      process.env.FLAREMAIL_CF_CONFIG = '/does-not-exist-unrelated-worker-target.json';
      const results = JSON.parse(await executeD1(options, `@${file}`));
      expect(results[0].results[0].safe_transport).toBe(42);
    } finally {
      if (previous === undefined) delete process.env.FLAREMAIL_CF_CONFIG;
      else process.env.FLAREMAIL_CF_CONFIG = previous;
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 30_000);

test('the HMR adapter honors selected local targets while builds use the public target', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'flaremail-adapter-target-'));
  const previous = process.env.FLAREMAIL_CF_CONFIG;
  try {
    const target = JSON.parse(await readFile('cloudflare.local.json', 'utf8'));
    target.vars.OUTBOUND_FROM_NAME = 'Private local test';
    target.databaseId = '11111111-1111-4111-8111-111111111111';
    target.bucket = 'private-local-fixture';
    target.inboundRouting = { databaseId: '33333333-3333-4333-8333-333333333333', databaseName: 'routing', environment: 'preview' };
    target.secrets = ['SYNTHETIC_LOCAL_SECRET'];
    const file = join(directory, 'local.json');
    await writeFile(file, JSON.stringify(target), { mode: 0o600 });
    process.env.FLAREMAIL_CF_CONFIG = file;
    const development = adapterOptions(true);
    const generated = JSON.parse(await readFile(development.config, 'utf8'));
    expect(generated.vars.OUTBOUND_FROM_NAME).toBe('Private local test');
    expect(generated.d1_databases[0].database_id).toBe(target.databaseId);
    expect(generated.d1_databases[1]).toMatchObject({ binding: 'INBOUND_ROUTING_DB', database_id: target.inboundRouting.databaseId });
    expect(generated.vars.INBOUND_ROUTING_SCOPE).toEqual({ environment: 'preview' });
    expect(generated.r2_buckets[0].bucket_name).toBe(target.bucket);
    expect(generated.secrets.required).toEqual(['SYNTHETIC_LOCAL_SECRET']);
    const build = adapterOptions(false);
    expect(JSON.parse(await readFile(build.config, 'utf8')).d1_databases[0].database_id).toBe(localDatabaseId);
    target.vars.APP_ENV = 'production';
    delete target.inboundRouting;
    await writeFile(file, JSON.stringify(target), { mode: 0o600 });
    expect(() => adapterOptions(true)).toThrow('Local commands require');
  } finally {
    if (previous === undefined) delete process.env.FLAREMAIL_CF_CONFIG;
    else process.env.FLAREMAIL_CF_CONFIG = previous;
    adapterOptions(false);
    await rm(directory, { recursive: true, force: true });
  }
});
