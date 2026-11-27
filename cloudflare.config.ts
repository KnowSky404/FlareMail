import { bindings, defineConfig, triggers, type TextBinding } from '@cloudflare/config/public';
import localTarget from './cloudflare.local.json' with { type: 'json' };
import { fileURLToPath } from 'node:url';

export default defineConfig({
  // Resource API commands read account defaults without evaluating Worker bindings.
  worker: async ({ isPreview, mode }) => {
    if (isPreview && mode !== 'preview') throw new Error('NATIVE_PREVIEW_REQUIRES_PREVIEW_MODE');
    // The Vite plugin blocks static config dependencies from serving as Worker modules.
    const { checkPreInboundRelease, cloudflarePreInboundSettings, projectRoot, readCloudflareTarget } = await import('./scripts/cloudflare-target.ts');
    const remote = mode === 'production' || mode === 'preview';
    if (remote) {
      const { assertReleaseHistory } = await import('./scripts/release-version.ts');
      assertReleaseHistory(projectRoot);
    }
    const config = process.env.FLAREMAIL_CF_CONFIG ?? (remote ? `cloudflare.${mode === 'production' ? 'deploy' : 'preview'}.json` : 'cloudflare.local.json');
    const target = readCloudflareTarget(config, remote);
    if (remote && target.vars.APP_ENV !== mode) throw new Error(`The ${mode} build requires APP_ENV=${mode}.`);
    const release = isPreview || remote ? checkPreInboundRelease(target, isPreview && mode === 'preview') : undefined;
    let workersDev: boolean | undefined;
    let previewCatchAllCapacity = 0;
    let observability = target.observability;
    if (release?.kind === 'production') {
      const { assertLiveNativePreview, assertProductionCatchAllRelease, assertProductionOwnershipCoverage, readPauseObservability, verifyProductionWorkerDev } = await import('./scripts/shared-inbound-preview.ts');
      workersDev = await verifyProductionWorkerDev(target, projectRoot);
      if (release.source.pauseOnly) observability = await readPauseObservability(target, release.activeVersion, projectRoot);
      else {
        const cutover = release.source.protecting || Boolean(release.source.protectVersionId);
        const activePreviewCapacity = await assertLiveNativePreview(target, release.source, projectRoot, cutover);
        await assertProductionCatchAllRelease(target, release.activeVersion, projectRoot, Boolean(release.source.protectVersionId) || release.source.resuming, activePreviewCapacity);
        if (release.source.resuming) observability = await readPauseObservability(target, release.activeVersion, projectRoot);
        if (cutover || release.source.resuming) {
          await assertProductionOwnershipCoverage(target);
        }
      }
    } else if (release?.kind === 'preview') {
      const { assertLivePreviewForPublish } = await import('./scripts/shared-inbound-preview.ts');
      previewCatchAllCapacity = await assertLivePreviewForPublish(target, release.source, projectRoot);
    }
    const { PRE_INBOUND_RECIPIENT: _recipient, PRE_INBOUND_ENABLED: _enabled, ...vars } = target.vars;
    const preInboundSettings = cloudflarePreInboundSettings(target);
    const pauseRoutingWrites = (isPreview && (release?.kind !== 'preview' || !release.source.managementEnabled)) ||
      (release?.kind === 'production' && (release.source.protecting ||
        (release.source.pauseOnly && release.activeVersion.routingReadOnly)));
    if (!remote && process.env.FLAREMAIL_E2E === 'true') {
      Object.assign(vars, {
        APP_ENV: 'development', AUTH_MODE: 'local', ALLOW_FAKE_SERVICES: 'true', OUTBOUND_PROVIDER: 'demo',
        AUTO_REPLY_ENABLED: 'false', INBOUND_NOTIFICATION_ENABLED: 'false', TELEGRAM_ENABLED: 'false',
        OUTBOUND_FROM_EMAIL: 'e2e@flaremail.test', OUTBOUND_FROM_NAME: 'FlareMail E2E',
        RESEND_WEBHOOK_SECRET: process.env.FLAREMAIL_E2E_WEBHOOK_SECRET ?? ''
      });
      if (process.env.FLAREMAIL_E2E_MCP === 'true') {
        const origin = `http://127.0.0.1:${process.env.FLAREMAIL_DEV_PORT ?? 4173}`;
        Object.assign(vars, {
          APP_BASE_URL: origin,
          MCP_PUBLIC_URL: `${origin}/mcp`,
          MCP_ALLOWED_REDIRECT_URIS: `${origin}/mcp-test-callback`
        });
      }
    }
    const env = Object.fromEntries(Object.entries(vars).map(([key, value]) => [key, bindings.text(value)])) as { [Key in keyof typeof localTarget.vars]: TextBinding };
    return {
      name: target.name,
      entrypoint: fileURLToPath(new URL('./worker/index.ts', import.meta.url)),
      compatibilityDate: target.compatibilityDate,
      compatibilityFlags: target.compatibilityFlags,
      observability,
      ...(workersDev === undefined ? {} : { workersDev, previewUrls: false }),
      triggers: target.cron.map((schedule) => triggers.scheduled({ schedule })),
      env: {
        ...env,
        ...Object.fromEntries((target.secrets ?? []).map((name) => [name, bindings.secret()])),
        DB: bindings.d1({ name: target.databaseName, id: target.databaseId }),
        BUCKET: bindings.r2({ name: target.bucket }),
        ...(target.oauthKvId ? { OAUTH_KV: bindings.kv({ id: target.oauthKvId }) } : {}),
        ...(preInboundSettings ? { PRE_INBOUND_SETTINGS: bindings.json(preInboundSettings) } : {}),
        ...(target.preInbound ? {
          PRE_INBOUND_DB: bindings.d1({ name: target.preInbound.databaseName, id: target.preInbound.databaseId }),
          PRE_INBOUND_BUCKET: bindings.r2({ name: target.preInbound.bucket })
        } : {}),
        ...(target.inboundRouting ? {
          INBOUND_ROUTING_DB: bindings.d1({ name: target.inboundRouting.databaseName, id: target.inboundRouting.databaseId }),
          INBOUND_ROUTING_SCOPE: bindings.json({
            environment: target.inboundRouting.environment,
            ...(target.inboundRouting.environment === 'production' ? { workerName: target.name } : {}),
            ...(previewCatchAllCapacity ? { previewCatchAllCapacity } : {}),
            ...(pauseRoutingWrites ? { readOnly: true as const } : {})
          })
        } : {}),
        ASSETS: bindings.assets()
      }
    };
  }
});
