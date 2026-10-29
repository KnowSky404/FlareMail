import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { prepareAssets } from '../scripts/prepare-assets.mjs';
import { cloudflare } from '@cloudflare/vite-plugin';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  tsconfig: './tsconfig.json',
  server: { host: process.env.FLAREMAIL_DEV_HOST ?? '::', port: Number(process.env.FLAREMAIL_DEV_PORT ?? 8787), strictPort: true },
  resolve: { alias: { '$lib': fileURLToPath(new URL('../src/lib', import.meta.url)) } },
  plugins: [cloudflare({
    persistState: { path: resolve(fileURLToPath(new URL('../', import.meta.url)), process.env.FLAREMAIL_STATE_DIR ?? '.cloudflare/state') },
    inspectorPort: false,
    types: { generate: false }
  })],
  publicDir: prepareAssets(),
  build: { sourcemap: true }
});
