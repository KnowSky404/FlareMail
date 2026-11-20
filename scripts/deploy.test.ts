import { adapterOptions } from './adapter-config.mjs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, spyOn, test } from 'bun:test';
import { createDeployInvocation, parseDeployMode, requireDeployConfig, normalizeDeployArguments } from './deploy-command';
import { createD1Command, localDatabaseId, executeD1, normalizeD1Output, parseCloudflareTarget, projectRoot, readCloudflareTarget } from './cloudflare-target';
import localTarget from '../cloudflare.local.json';
import cloudflareConfig from '../cloudflare.config';
import { assertActiveProductionForRelease, assertLiveNativePreview, assertLivePreviewForPublish, assertProductionCatchAllRelease, assertProductionOwnershipCoverage, assertUnchangedProductionConfiguration, assertProductionReleaseSource, assertSharedInboundPreview, assertSharedInboundProduction, fixedReservationHash, pinCloudflareReleaseIdentity, sharedInboundPreviewTargetHash, verifyProductionWorkerDev } from './shared-inbound-preview';

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
  expect(() => assertUnchangedProductionConfiguration(target, active)).not.toThrow();
  expect(() => assertUnchangedProductionConfiguration({ ...target, vars: { ...target.vars, AUTH_MODE: 'local' } }, active))
    .toThrow('INBOUND_PRODUCTION_CUTOVER_CONFIGURATION_CHANGED');
  expect(() => assertUnchangedProductionConfiguration({ ...target, cron: [] }, active))
    .toThrow('INBOUND_PRODUCTION_CUTOVER_CONFIGURATION_CHANGED');
});

test('ordinary releases pin the account already selected by cf', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'flaremail-cf-account-'));
  const variables = ['PATH', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_AUTH_PROFILE'] as const;
  const previous = Object.fromEntries(variables.map(name => [name, process.env[name]]));
  const accounts = [{ id: 'a'.repeat(32) }, { id: 'b'.repeat(32) }];
  try {
    await mkdir(join(directory, 'bin'));
    await mkdir(join(directory, 'dist'));
    await writeFile(join(directory, 'package.json'), '{"name":"cf","version":"1.0.0-rc.1"}');
    const identity = JSON.stringify({ authenticated: true, accounts, profile: { name: 'selected-profile' } });
    await writeFile(join(directory, 'bin/cf'), `#!/bin/sh\nprintf '%s\\n' '${identity}'\n`, { mode: 0o700 });
    await writeFile(join(directory, 'dist/context-BiFPu-hE.mjs'),
      `export async function a() { return process.env.CLOUDFLARE_AUTH_PROFILE === 'selected-profile' ? '${accounts[1]!.id}' : undefined; }`);
    process.env.PATH = join(directory, 'bin') + ':' + previous.PATH;
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_AUTH_PROFILE;
    expect(() => pinCloudflareReleaseIdentity(projectRoot, true)).not.toThrow();
    expect(String(process.env.CLOUDFLARE_ACCOUNT_ID)).toBe(accounts[1]!.id);
  } finally {
    for (const name of variables) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
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

test('production verifies the live PRE address reservation as well as its bindings', async () => {
  const runDirectory = await mkdtemp(join(tmpdir(), 'flaremail-preview-capacity-'));
  const priorPath = process.env.PATH;
  const priorAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
  const priorToken = process.env.CLOUDFLARE_API_TOKEN;
  process.env.CLOUDFLARE_ACCOUNT_ID = 'a'.repeat(32);
  process.env.CLOUDFLARE_API_TOKEN = 'fixture-token';
  const target = {
    ...localTarget, vars: { PRE_INBOUND_RECIPIENT: 'expected@example.test' },
    preInbound: { databaseId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', databaseName: 'pre', bucket: 'pre-bucket' },
    inboundRouting: { databaseId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', databaseName: 'routing', environment: 'production' as const }
  };
  const proof = { previewDeploymentId: 'pre-deploy', previewBuildLabel: 'preview+abcdef0' };
  const fetch = spyOn(globalThis, 'fetch');
  const mockLive = (recipient: string, scope: { readOnly?: boolean; previewCatchAllCapacity?: number } = { readOnly: true }) => {
    const respond = (result: unknown) => fetch.mockResolvedValueOnce(Response.json({ success: true, result }));
    respond({ id: 'worker-id' });
    respond([{ id: 'pre-id', slug: 'mail-ai' }]);
    respond({ id: proof.previewDeploymentId, env: {
      APP_ENV: { text: 'preview' }, APP_VERSION: { text: proof.previewBuildLabel },
      DB: { database_id: target.preInbound.databaseId }, BUCKET: { bucket_name: target.preInbound.bucket },
      INBOUND_ROUTING_DB: { database_id: target.inboundRouting.databaseId }, PRE_INBOUND_SETTINGS: { json: { recipient } },
      INBOUND_ROUTING_SCOPE: { json: { environment: 'preview', ...scope } }
    } });
  };
  try {
    mockLive('another@example.test');
    await expect(assertLiveNativePreview(target, proof, projectRoot)).rejects.toThrow('INBOUND_PRODUCTION_PREVIEW_DEPLOYMENT_CHANGED');
    mockLive('expected@example.test');
    await expect(assertLiveNativePreview(target, proof, projectRoot)).resolves.toBe(0);
    mockLive('expected@example.test', { previewCatchAllCapacity: 239 });
    await expect(assertLiveNativePreview(target, proof, projectRoot)).resolves.toBe(239);
    const preview = { ...target, databaseId: target.preInbound.databaseId, bucket: target.preInbound.bucket };
    const management = { previewDeploymentId: proof.previewDeploymentId, managementEnabled: true };
    mockLive('expected@example.test');
    fetch.mockResolvedValueOnce(Response.json({ success: true, result: { schedules: [{ cron: '0 0 * * *' }] } }));
    await expect(assertLivePreviewForPublish(preview, management, projectRoot)).rejects
      .toThrow('INBOUND_PREVIEW_PRODUCTION_OBSERVER_NOT_CONFIGURED');
    await writeFile(join(runDirectory, 'cf'), `#!/bin/sh\nprintf '%s\\n' '[{"success":true,"results":{"columns":["count"],"rows":[[0]]}}]'\n`, { mode: 0o700 });
    process.env.PATH = runDirectory + ':' + priorPath;
    mockLive('expected@example.test');
    fetch.mockResolvedValueOnce(Response.json({ success: true, result: { schedules: [{ cron: '* * * * *' }] } }));
    await expect(assertLivePreviewForPublish(preview, management, projectRoot)).resolves.toBe(239);
  } finally {
    if (priorPath === undefined) delete process.env.PATH;
    else process.env.PATH = priorPath;
    await rm(runDirectory, { recursive: true, force: true });
    fetch.mockRestore();
    if (priorAccount === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID;
    else process.env.CLOUDFLARE_ACCOUNT_ID = priorAccount;
    if (priorToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = priorToken;
  }
});

test('protection requires fresh mailbox and catch-all ownership coverage in both mail databases', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'flaremail-protection-inventory-'));
  const previousPath = process.env.PATH;
  process.env.PATH = directory + ':' + previousPath;
  const target = {
    ...localTarget, vars: { PRE_INBOUND_RECIPIENT: 'reserved@example.test' },
    preInbound: { databaseId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', databaseName: 'pre', bucket: 'pre-bucket' },
    inboundRouting: { databaseId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', databaseName: 'routing', environment: 'production' as const }
  };
  const fixture = (id: string, rows: string[][], registered = false) => writeFile(join(directory, id), JSON.stringify([
    { success: true, results: { columns: registered ? ['kind', 'route_key', 'environment'] : ['kind', 'route_key'], rows } }
  ]));
  const mailbox = ['mailbox', 'new@example.test'];
  const catchAll = ['catch_all', 'example.test'];
  const reservation = ['mailbox', 'reserved@example.test', 'preview'];
  const previewMailbox = ['mailbox', 'pre@example.test'];
  const registry = (rows: string[][]) => fixture(target.inboundRouting.databaseId, rows, true);
  const coverage = () => assertProductionOwnershipCoverage(target);
  const blocked = 'INBOUND_PRODUCTION_ROUTING_INVENTORY_NOT_VERIFIED';
  try {
    await writeFile(join(directory, 'cf'), `#!/bin/sh
[ "$1:$2:$4" = 'd1:raw:--sql' ] || exit 1
cat '${directory}/'"$3"
`, { mode: 0o700 });
    await fixture(target.databaseId, [mailbox, catchAll]);
    await fixture(target.preInbound.databaseId, [previewMailbox]);
    await registry([[...catchAll, 'production'], [...previewMailbox, 'preview'], reservation]);
    await expect(coverage()).rejects.toThrow(blocked);
    const claims = [[...mailbox, 'production'], [...catchAll, 'production'], [...previewMailbox, 'preview']];
    await registry(claims);
    await expect(coverage()).rejects.toThrow(blocked);
    await registry([...claims, reservation]);
    await expect(coverage()).resolves.toBeUndefined();
    await fixture(target.preInbound.databaseId, [previewMailbox, catchAll]);
    await expect(coverage()).rejects.toThrow(blocked);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
});

test('activation requires the active protection version to block identity writes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'flaremail-protection-release-'));
  const environment = { PATH: directory + ':' + process.env.PATH, CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32) };
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  const target = {
    ...localTarget,
    vars: { ...localTarget.vars, APP_VERSION: 'production+abcd123' },
    preInbound: { databaseId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', databaseName: 'pre', bucket: 'pre-bucket' },
    inboundRouting: { databaseId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', databaseName: 'routing', environment: 'production' as const }
  };
  const protectVersionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const source = { protectVersionId, releaseCommit: '', acceptedPreviewCommit: '', deploymentId: 'deployment', previewDeploymentId: '', previewBuildLabel: '', protecting: false, maintaining: false, pauseOnly: false, resuming: false };
  const deployments = { deployments: [{ id: source.deploymentId, versions: [{ version_id: protectVersionId, percentage: 100 }] }] };
  const bindings = [
    { name: 'DB', database_id: target.databaseId }, { name: 'BUCKET', bucket_name: target.bucket },
    { name: 'PRE_INBOUND_DB', database_id: target.preInbound.databaseId }, { name: 'PRE_INBOUND_BUCKET', bucket_name: target.preInbound.bucket },
    { name: 'INBOUND_ROUTING_DB', database_id: target.inboundRouting.databaseId },
    { name: 'APP_VERSION', text: target.vars.APP_VERSION },
    { name: 'PRE_INBOUND_SETTINGS', json: { enabled: false } }
  ];
  const mockScope = (scope: { environment: string; readOnly?: boolean }) => writeFile(join(directory, 'versions'),
    JSON.stringify({ bindings: [...bindings, { name: 'INBOUND_ROUTING_SCOPE', json: JSON.stringify(scope) }] }));
  try {
    await writeFile(join(directory, 'deployments'), JSON.stringify(deployments));
    await writeFile(join(directory, 'cf'), `#!/bin/sh\n[ "$1" = 'workers' ] || exit 1\ncat '${directory}/'"$2"\n`, { mode: 0o700 });
    for (const scope of [{ environment: 'production' }, { environment: 'preview', readOnly: true }]) {
      await mockScope(scope);
      expect(() => assertActiveProductionForRelease(target, source)).toThrow('INBOUND_PRODUCTION_ACTIVE_PROTECTION_REQUIRED');
    }
    await mockScope({ environment: 'production', readOnly: true });
    expect(assertActiveProductionForRelease(target, source).routingReadOnly).toBe(true);
    const resume = { ...source, protectVersionId: null, resuming: true };
    expect(() => assertActiveProductionForRelease(target, resume)).toThrow('INBOUND_PRODUCTION_ACTIVE_PROTECTION_REQUIRED');
    await mockScope({ environment: 'production' });
    expect(assertActiveProductionForRelease(target, resume).routingReadOnly).toBe(false);
    expect(() => assertActiveProductionForRelease({ ...target, vars: { ...target.vars, APP_VERSION: 'production+different' } }, resume))
      .toThrow('INBOUND_PRODUCTION_ACTIVE_PROTECTION_REQUIRED');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test('activation requires PRE catch-all observations produced after the protection deployment', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'flaremail-activation-'));
  const environment = {
    CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_API_TOKEN: 'fixture-token',
    PATH: directory + ':' + process.env.PATH, FLAREMAIL_TEST_D1_FIXTURES: directory
  };
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  const target = {
    ...localTarget, vars: { PRE_INBOUND_ENABLED: 'true' }, bucket: 'prod-bucket', cron: ['* * * * *'],
    secrets: ['CLOUDFLARE_EMAIL_ROUTING_TOKEN'],
    preInbound: { databaseId: 'b'.repeat(8) + '-bbbb-4bbb-8bbb-bbbbbbbbbbbb', databaseName: 'pre', bucket: 'preview-bucket' },
    inboundRouting: { databaseId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', databaseName: 'routing', environment: 'production' as const }
  };
  const active = {
    id: 'version', percentage: 100, bindings: [{ name: 'CLOUDFLARE_EMAIL_ROUTING_TOKEN', type: 'secret_text' }],
    routingReadOnly: true, deployedAt: Date.now() - 60_000,
    compatibilityDate: target.compatibilityDate, compatibilityFlags: target.compatibilityFlags
  };
  const domain = {
    domain_name: 'mail.example.test', worker_name: target.name, catch_all_target: 'this_worker',
    catch_all_checked_at: new Date(active.deployedAt - 1).toISOString(), last_error_code: null, last_error_at: null
  };
  const fetch = spyOn(globalThis, 'fetch');
  const mockRequests = async () => {
    fetch.mockResolvedValueOnce(Response.json({ success: true, result: { schedules: [{ cron: target.cron[0] }] } }));
    await writeFile(join(directory, target.preInbound.databaseId), JSON.stringify([
      { success: true, results: { columns: Object.keys(domain), rows: [Object.values(domain)] } }
    ]));
  };
  try {
    await writeFile(join(directory, 'cf'), `#!/bin/sh
[ "$1:$2:$4" = 'd1:raw:--sql' ] || exit 1
cat "$FLAREMAIL_TEST_D1_FIXTURES/$3"
`, { mode: 0o700 });
    await expect(assertProductionCatchAllRelease(target, active, projectRoot, false))
      .rejects.toThrow('INBOUND_PRODUCTION_ROUTING_REGISTRY_NOT_READY');
    await writeFile(join(directory, target.inboundRouting.databaseId), JSON.stringify([
      { success: true, results: { columns: ['route_key'], rows: [[domain.domain_name]] } }
    ]));
    await mockRequests();
    await expect(assertProductionCatchAllRelease(target, active, projectRoot))
      .rejects.toThrow('INBOUND_PRODUCTION_PREVIEW_CATCH_ALL_REFRESH_NOT_VERIFIED');
    domain.catch_all_checked_at = new Date(active.deployedAt + 1).toISOString();
    await mockRequests();
    await expect(assertProductionCatchAllRelease(target, active, projectRoot))
      .rejects.toThrow('INBOUND_PRODUCTION_PREVIEW_CATCH_ALL_REFRESH_NOT_VERIFIED');
    Object.assign(domain, { last_error_code: 'preview_catch_all_cron_verified', last_error_at: domain.catch_all_checked_at });
    await mockRequests();
    await expect(assertProductionCatchAllRelease(target, active, projectRoot)).resolves.toBeUndefined();
    await expect(assertProductionCatchAllRelease({ ...target, cron: ['0 0 * * *'] }, active, projectRoot, false))
      .rejects.toThrow('INBOUND_PRODUCTION_PREVIEW_CATCH_ALL_CRON_CAPACITY');
    await expect(assertProductionCatchAllRelease({ ...target, cron: ['*/5 * * * *'] }, active, projectRoot, false))
      .resolves.toBeUndefined();
    await expect(assertProductionCatchAllRelease({ ...target, secrets: ['CLOUDFLARE_EMAIL_ROUTING_READ_TOKEN'] }, active, projectRoot, false))
      .rejects.toThrow('INBOUND_PRODUCTION_PREVIEW_CATCH_ALL_CREDENTIAL_CHANGED');
    await mockRequests();
    await expect(assertProductionCatchAllRelease(target, { ...active, routingReadOnly: false, deployedAt: Date.now() }, projectRoot))
      .resolves.toBeUndefined();
    await writeFile(join(directory, target.preInbound.databaseId), JSON.stringify([
      { success: true, results: { columns: Object.keys(domain), rows: [] } }
    ]));
    const mailboxOnly = { ...target, secrets: [] };
    const mailboxOnlyActive = { ...active, bindings: [] };
    await expect(assertProductionCatchAllRelease(mailboxOnly, mailboxOnlyActive, projectRoot, false)).resolves.toBeUndefined();
    await expect(assertProductionCatchAllRelease(mailboxOnly, mailboxOnlyActive, projectRoot, false, 3))
      .rejects.toThrow('INBOUND_PRODUCTION_PREVIEW_CATCH_ALL_CREDENTIAL_CHANGED');
    await expect(assertProductionCatchAllRelease({ ...target, cron: ['0 * * * *'] }, active, projectRoot, false, 4))
      .rejects.toThrow('INBOUND_PRODUCTION_PREVIEW_CATCH_ALL_CRON_CAPACITY');
    await expect(assertProductionCatchAllRelease(target, active, projectRoot, false)).resolves.toBeUndefined();
  } finally {
    fetch.mockRestore();
    await rm(directory, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('production activation requires the reviewed PRE and an active, paused protection deployment', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'flaremail-shared-prod-'));
  const file = join(directory, 'target.json');
  const proof = join(directory, 'proof.json');
  const env = { FLAREMAIL_CF_CONFIG: file, FLAREMAIL_INBOUND_PRODUCTION_PREFLIGHT: proof, CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32) };
  const recipient = 'legacy-pre@example.test';
  const reservation = fixedReservationHash(recipient);
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  const production = { databaseId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', bucket: 'prod-bucket', deploymentId: 'current-prod', fixedReservationHash: reservation };
  const preview = { databaseId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', bucket: 'pre-bucket', deploymentId: 'accepted-pre', buildLabel: 'preview+' + 'c'.repeat(7), fixedReservationHash: reservation };
  const candidate = {
    ...localTarget, databaseId: production.databaseId, bucket: production.bucket,
    preInbound: { databaseId: preview.databaseId, databaseName: 'pre', bucket: preview.bucket },
    inboundRouting: { databaseId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', databaseName: 'routing', environment: 'production' as const },
    vars: { ...localTarget.vars, APP_ENV: 'production', APP_VERSION: 'production+' + 'e'.repeat(7),
      PRE_INBOUND_ENABLED: 'false', PRE_INBOUND_RECIPIENT: recipient }
  };
  const evidence = {
    checkedAt: new Date().toISOString(), accountId: env.CLOUDFLARE_ACCOUNT_ID, previewName: 'mail-ai', workerName: candidate.name,
    production, preview, routingDatabaseId: candidate.inboundRouting.databaseId, registryVerified: true, ownerAcceptanceVerified: true,
    releaseCommit: 'e'.repeat(40), acceptedPreviewCommit: 'c'.repeat(40), versionUrlsDisabled: true, legacyOperationsQuiesced: true
  };
  Object.assign(process.env, env);
  try {
    await writeFile(file, JSON.stringify(candidate), { mode: 0o600 });
    const protect = { ...evidence, phase: 'protect', targetHash: sharedInboundPreviewTargetHash(candidate) };
    await writeFile(proof, JSON.stringify({ ...protect, production: { ...production, fixedReservationHash: null } }), { mode: 0o600 });
    expect(() => assertSharedInboundProduction(readCloudflareTarget(file, true), proof)).toThrow('INBOUND_PRODUCTION_PREFLIGHT_INVALID');
    await writeFile(proof, JSON.stringify(protect));
    await expect(cloudflareConfig.worker({ mode: 'production', isPreview: true })).rejects.toThrow('NATIVE_PREVIEW_REQUIRES_PREVIEW_MODE');
    expect(assertSharedInboundProduction(readCloudflareTarget(file, true), proof)).toMatchObject({
      releaseCommit: evidence.releaseCommit, acceptedPreviewCommit: evidence.acceptedPreviewCommit
    });
    await expect(cloudflareConfig.worker({ mode: 'production', isPreview: false })).rejects.toThrow('INBOUND_PRODUCTION_RELEASE_SOURCE_NOT_VERIFIED');
    await writeFile(proof, JSON.stringify({ ...protect, ownerAcceptanceVerified: false }));
    expect(() => assertSharedInboundProduction(readCloudflareTarget(file, true), proof)).toThrow('INBOUND_PRODUCTION_PREFLIGHT_INVALID');
    await writeFile(proof, JSON.stringify({ ...protect, ownerAcceptanceVerified: false, ownerDelegatedAcceptance: true }));
    expect(assertSharedInboundProduction(readCloudflareTarget(file, true), proof)).toMatchObject({ protecting: true });

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
    await writeFile(proof, JSON.stringify({ ...evidence, phase: 'resume', targetHash: sharedInboundPreviewTargetHash(active), legacyOperationsQuiesced: false }));
    expect(assertSharedInboundProduction(readCloudflareTarget(file, true), proof)).toMatchObject({ resuming: true, protectVersionId: null });

    const { PRE_INBOUND_RECIPIENT: _recipient, ...unreservedVars } = candidate.vars;
    const unreserved = { ...candidate, vars: unreservedVars };
    const unreservedProof = { ...protect, targetHash: sharedInboundPreviewTargetHash(unreserved),
      production: { ...production, fixedReservationHash: null }, preview: { ...preview, fixedReservationHash: null } };
    await writeFile(file, JSON.stringify(unreserved));
    await writeFile(proof, JSON.stringify(unreservedProof));
    expect(() => assertSharedInboundProduction(readCloudflareTarget(file, true), proof)).toThrow('INBOUND_PRODUCTION_PREFLIGHT_INVALID');
    await writeFile(proof, JSON.stringify({ ...unreservedProof, legacyFixedRecipientAbsent: true }));
    expect(assertSharedInboundProduction(readCloudflareTarget(file, true), proof)).toMatchObject({ protecting: true });
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
  const env = {
    FLAREMAIL_CF_CONFIG: file, FLAREMAIL_INBOUND_PREVIEW_PREFLIGHT: receiptPath,
    CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_API_TOKEN: 'fixture-token'
  };
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
    const recovery = { ...receipt, preview: { ...receipt.preview, deploymentId: null }, production: {
      ...receipt.production, previewDelivery: { databaseId: candidate.databaseId, bucket: candidate.bucket, routingDatabaseId: candidate.inboundRouting.databaseId }
    } };
    await writeFile(receiptPath, JSON.stringify(recovery));
    expect(assertSharedInboundPreview(readCloudflareTarget(file, true), receiptPath)).toMatchObject({
      previewDeploymentId: null, expectsDelivery: true, managementEnabled: false
    });
    await writeFile(receiptPath, JSON.stringify({ ...recovery, production: receipt.production }));
    expect(() => assertSharedInboundPreview(readCloudflareTarget(file, true), receiptPath)).toThrow('INBOUND_PREVIEW_PREFLIGHT_INVALID');
    await writeFile(receiptPath, JSON.stringify(receipt));
    const fetch = spyOn(globalThis, 'fetch');
    try {
      fetch.mockResolvedValueOnce(Response.json({ success: true, result: {
        id: 'worker-id', previews_base_config: { env: { CLOUDFLARE_EMAIL_ROUTING_TOKEN: { type: 'secret_text' } } }
      } }));
      fetch.mockResolvedValueOnce(Response.json({ success: true, result: [{ id: 'preview-id', slug: 'mail-ai' }] }));
      fetch.mockResolvedValueOnce(Response.json({ success: true, result: {
        id: receipt.preview.deploymentId, env: {
          APP_ENV: { text: 'preview' }, DB: { database_id: candidate.databaseId }, BUCKET: { bucket_name: candidate.bucket }
        }
      } }));
      await expect(assertLivePreviewForPublish(readCloudflareTarget(file, true), {
        previewDeploymentId: receipt.preview.deploymentId, managementEnabled: false
      }, projectRoot)).rejects.toThrow('INBOUND_PREVIEW_DEPLOYMENT_CHANGED');
    } finally {
      fetch.mockRestore();
    }
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
    const oldFixed = {
      ...receipt, targetHash: sharedInboundPreviewTargetHash(fixed), fixedReservationHash: fixedReservationHash('pre@example.test'),
      production: { ...receipt.production, previewDelivery: {
        databaseId: fixed.databaseId, bucket: fixed.bucket, routingDatabaseId: null,
        fixedReservationHash: fixedReservationHash('pre@example.test')
      } }
    };
    await writeFile(receiptPath, JSON.stringify(oldFixed));
    expect(assertSharedInboundPreview(readCloudflareTarget(file, true), receiptPath)).toMatchObject({
      expectsDelivery: true, legacyFixedDelivery: true, managementEnabled: false
    });
    await writeFile(receiptPath, JSON.stringify({ ...oldFixed, previewManagementAuthorized: true }));
    expect(() => assertSharedInboundPreview(readCloudflareTarget(file, true), receiptPath)).toThrow('INBOUND_PREVIEW_PREFLIGHT_INVALID');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test('read-only recovery requires a missing Preview, a safe Base and the live ownership table', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'flaremail-preview-recovery-'));
  const env = { CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_API_TOKEN: 'fixture-token', PATH: directory + ':' + process.env.PATH };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  const target = { ...localTarget, inboundRouting: { databaseId: '33333333-3333-4333-8333-333333333333', databaseName: 'routing', environment: 'preview' as const } };
  const recovery = { previewDeploymentId: null, managementEnabled: false };
  const fetch = spyOn(globalThis, 'fetch');
  const mock = (result: unknown) => fetch.mockResolvedValueOnce(Response.json({ success: true, result }));
  try {
    Object.assign(process.env, env);
    mock({ id: 'worker-id', previews_base_config: { env: { DB: { type: 'd1' } } } });
    mock([]);
    await expect(assertLivePreviewForPublish(target, recovery, projectRoot)).rejects.toThrow('INBOUND_PREVIEW_DEPLOYMENT_CHANGED');
    mock({ id: 'worker-id' });
    mock([{ id: 'pre-id', slug: 'mail-ai' }]);
    mock({ id: 'its-current-deployment' });
    await expect(assertLivePreviewForPublish(target, recovery, projectRoot)).rejects.toThrow('INBOUND_PREVIEW_DEPLOYMENT_CHANGED');
    const cf = join(directory, 'cf');
    await writeFile(cf, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
    mock({ id: 'worker-id' });
    mock([]);
    await expect(assertLivePreviewForPublish(target, recovery, projectRoot)).rejects.toThrow('INBOUND_PREVIEW_ROUTING_REGISTRY_NOT_READY');
    mock({ id: 'worker-id' });
    mock([{ id: 'pre-id', slug: 'mail-ai' }]);
    mock({ id: 'current-deployment', env: {
      APP_ENV: { text: 'preview' }, DB: { database_id: target.databaseId }, BUCKET: { bucket_name: target.bucket }
    } });
    await expect(assertLivePreviewForPublish(target, { ...recovery, previewDeploymentId: 'current-deployment' }, projectRoot))
      .rejects.toThrow('INBOUND_PREVIEW_ROUTING_REGISTRY_NOT_READY');
    await writeFile(cf, `#!/bin/sh\nprintf '%s\\n' '[{"success":true,"results":{"columns":["kind","route_key","environment"],"rows":[]}}]'\n`);
    mock({ id: 'worker-id', previews_base_config: { env: { AI_SETTINGS_KEY: { type: 'secret_text' } } } });
    mock([]);
    await expect(assertLivePreviewForPublish(target, recovery, projectRoot)).resolves.toBe(0);
  } finally {
    fetch.mockRestore();
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
    await expect(cloudflareConfig.worker({ mode: 'development', isPreview: true })).rejects.toThrow('NATIVE_PREVIEW_REQUIRES_PREVIEW_MODE');

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
    await expect(cloudflareConfig.worker({ mode: 'development', isPreview: true })).rejects.toThrow('NATIVE_PREVIEW_REQUIRES_PREVIEW_MODE');
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
  expect(normalizeDeployArguments(['--secretsFile', '../release-secrets.json'], '/workspace/app')).toEqual(['--secrets-file', '/workspace/release-secrets.json']);
  expect(normalizeDeployArguments(['--secretsFile=../release-secrets.json'], '/workspace/app')).toEqual(['--secrets-file=/workspace/release-secrets.json']);
  expect(() => normalizeDeployArguments(['--secrets-file'])).toThrow('requires a path');
  expect(() => normalizeDeployArguments(['--provision=true'])).toThrow('controlled by this script');
  expect(() => normalizeDeployArguments(['--dispatch-namespace=other'])).toThrow('controlled by this script');
  expect(() => normalizeDeployArguments(['--dispatchNamespace', 'other'])).toThrow('controlled by this script');
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
