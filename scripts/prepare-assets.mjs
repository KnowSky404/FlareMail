import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The Svelte adapter's directory also contains server code. Never expose it as assets.
export function prepareAssets() {
  const source = fileURLToPath(new URL('../build/', import.meta.url));
  const destination = fileURLToPath(new URL('../.cloudflare/assets/', import.meta.url));
  if (!existsSync(join(source, '_worker.js'))) throw new Error('Build the Svelte application first: bun run build:app.');
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source)) {
    if (['_worker.js', '_routes.json', '.assetsignore'].includes(entry)) continue;
    cpSync(join(source, entry), join(destination, entry), {
      recursive: true, dereference: false, filter: (path) => !path.endsWith('.map')
    });
  }
  return destination;
}
