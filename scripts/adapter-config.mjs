import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

// The upstream adapter still requires its own format. cf's public target is the source.
export function adapterOptions() {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const target = JSON.parse(readFileSync(`${root}cloudflare.local.json`, 'utf8'));
  const path = `${root}.cloudflare/adapter/config.json`;
  mkdirSync(`${root}.cloudflare/adapter`, { recursive: true });
  writeFileSync(path, JSON.stringify({
    name: 'flaremail-svelte-build',
    main: `${root}build/_worker.js`,
    compatibility_date: target.compatibilityDate,
    compatibility_flags: target.compatibilityFlags,
    assets: { directory: `${root}build`, binding: 'ASSETS' },
    vars: target.vars,
    d1_databases: [{ binding: 'DB', database_name: target.databaseName, database_id: target.databaseId }],
    r2_buckets: [{ binding: 'BUCKET', bucket_name: target.bucket }]
  }));
  return { config: path, platformProxy: { persist: { path: resolve(root, process.env.FLAREMAIL_STATE_DIR ?? '.cloudflare/state', 'v3') } } };
}
