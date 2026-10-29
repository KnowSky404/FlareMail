import { bindings, defineConfig, triggers, type TextBinding } from '@cloudflare/config/public';
import localTarget from './cloudflare.local.json' with { type: 'json' };
import { fileURLToPath } from 'node:url';
import { readCloudflareTarget } from './scripts/cloudflare-target.ts';

export default defineConfig({
  // Resource API commands read account defaults without evaluating Worker bindings.
  worker: ({ mode }) => {
    const remote = mode === 'production' || mode === 'preview';
    const config = process.env.FLAREMAIL_CF_CONFIG ?? (remote ? `cloudflare.${mode === 'production' ? 'deploy' : 'preview'}.json` : 'cloudflare.local.json');
    const target = readCloudflareTarget(config, remote);
    if (remote && target.vars.APP_ENV !== mode) throw new Error(`The ${mode} build requires APP_ENV=${mode}.`);
    const vars = { ...target.vars };
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
      observability: target.observability,
      triggers: target.cron.map((schedule) => triggers.scheduled({ schedule })),
      env: {
        ...env,
        ...Object.fromEntries((target.secrets ?? []).map((name) => [name, bindings.secret()])),
        DB: bindings.d1({ name: target.databaseName, id: target.databaseId }),
        BUCKET: bindings.r2({ name: target.bucket }),
        ASSETS: bindings.assets()
      }
    };
  }
});
