import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import adapter from '@sveltejs/adapter-cloudflare';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { adapterOptions } from './scripts/adapter-config.mjs';

export default defineConfig(({ command }) => ({
  // The portable ESM bundle embeds CSS grammar data instead of loading JSON
  // with createRequire, which breaks after bundling into a Worker.
  resolve: { alias: [{ find: /^css-tree$/, replacement: 'css-tree/dist/csstree.esm' }] },
  plugins: [tailwindcss(), sveltekit({
    preprocess: vitePreprocess(),
    alias: { '$lib': 'src/lib' },
    adapter: adapter(adapterOptions(command === 'serve')),
    csp: {
      mode: 'nonce',
      directives: {
        'default-src': ['self'],
        'base-uri': ['self'],
        'connect-src': ['self'],
        'font-src': ['self'],
        'form-action': ['self'],
        'frame-ancestors': ['none'],
        'img-src': ['self', 'data:'],
        'object-src': ['none'],
        'script-src': ['self'],
        'style-src': ['self', 'unsafe-inline']
      }
    }
  })],
  ssr: { noExternal: true, external: ['cloudflare:email'] },
  build: { rolldownOptions: { external: ['cloudflare:email'] } }
}));
