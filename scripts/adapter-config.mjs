import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { readCloudflareTarget } from './cloudflare-target.ts';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

// The upstream adapter still requires its own format. cf's selected local target is the source.
export function adapterOptions(useSelectedTarget = false) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const target = readCloudflareTarget(useSelectedTarget ? process.env.FLAREMAIL_CF_CONFIG ?? 'cloudflare.local.json' : 'cloudflare.local.json');
  const path = `${root}.cloudflare/adapter/config.json`;
  mkdirSync(`${root}.cloudflare/adapter`, { recursive: true, mode: 0o700 });
  chmodSync(`${root}.cloudflare/adapter`, 0o700);
  writeFileSync(path, JSON.stringify({
    name: 'flaremail-svelte-build',
    main: `${root}build/_worker.js`,
    compatibility_date: target.compatibilityDate,
    compatibility_flags: target.compatibilityFlags,
    assets: { directory: `${root}build`, binding: 'ASSETS' },
    vars: target.vars,
    secrets: { required: target.secrets ?? [] },
    d1_databases: [{ binding: 'DB', database_name: target.databaseName, database_id: target.databaseId }],
    r2_buckets: [{ binding: 'BUCKET', bucket_name: target.bucket }]
  }), { mode: 0o600 });
  chmodSync(path, 0o600);
  return { config: path, platformProxy: { persist: { path: resolve(root, process.env.FLAREMAIL_STATE_DIR ?? '.cloudflare/state', 'v3') } } };
}
