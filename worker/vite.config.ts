import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { checkPreInboundRelease, defaultStatePath, projectRoot, readCloudflareTarget } from '../scripts/cloudflare-target.ts';
import { prepareAssets } from '../scripts/prepare-assets.mjs';
import { cloudflare } from '@cloudflare/vite-plugin';
import { fileURLToPath } from 'node:url';

export default defineConfig(({ command, mode }) => {
  // Development targets for PRE inbound are served by cf dev only.
  if (command === 'build' && mode !== 'production' && mode !== 'preview') {
    checkPreInboundRelease(readCloudflareTarget());
  }
  return {
    tsconfig: './tsconfig.json',
    server: { host: process.env.FLAREMAIL_DEV_HOST ?? '::', port: Number(process.env.FLAREMAIL_DEV_PORT ?? 8787), strictPort: true },
    resolve: { alias: [
      { find: '$lib', replacement: fileURLToPath(new URL('../src/lib', import.meta.url)) },
      { find: /^css-tree$/, replacement: 'css-tree/dist/csstree.esm' }
    ] },
    plugins: [cloudflare({
      persistState: { path: resolve(projectRoot, process.env.FLAREMAIL_STATE_DIR ?? defaultStatePath) },
      inspectorPort: false,
      types: { generate: false }
    })],
    publicDir: prepareAssets(),
    build: { sourcemap: true }
  };
});
