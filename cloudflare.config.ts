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
    const config = process.env.FLAREMAIL_CF_CONFIG ?? (remote ? `cloudflare.${mode === 'production' ? 'deploy' : 'preview'}.json` : 'cloudflare.local.json');
    const target = readCloudflareTarget(config, remote);
    if (remote && target.vars.APP_ENV !== mode) throw new Error(`The ${mode} build requires APP_ENV=${mode}.`);
    const release = isPreview || remote ? checkPreInboundRelease(target, isPreview && mode === 'preview') : undefined;
    let workersDev: boolean | undefined;
    let observability = target.observability;
    if (release?.kind === 'production') {
      const { assertLiveNativePreview, assertProductionCatchAllRelease, readPauseObservability, verifyProductionWorkerDev } = await import('./scripts/shared-inbound-preview.ts');
      workersDev = await verifyProductionWorkerDev(target, projectRoot);
      if (release.source.pauseOnly) observability = await readPauseObservability(target, release.activeVersion, projectRoot);
      else {
        await assertLiveNativePreview(target, release.source, projectRoot);
        await assertProductionCatchAllRelease(target, release.activeVersion, projectRoot, Boolean(release.source.protectVersionId));
      }
    } else if (release?.kind === 'preview') {
      const { assertLivePreviewForPublish } = await import('./scripts/shared-inbound-preview.ts');
      await assertLivePreviewForPublish(target, release.source, projectRoot);
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
            ...(pauseRoutingWrites ? { readOnly: true as const } : {})
          })
        } : {}),
        ASSETS: bindings.assets()
      }
    };
  }
});
