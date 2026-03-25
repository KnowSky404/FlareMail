import { defineConfig } from 'vite';
import { sveltekit } from '@sveltejs/kit/vite';

export default defineConfig({
  plugins: [sveltekit()],
  ssr: {
    external: ['cloudflare:email']
  },
  build: {
    rollupOptions: {
      external: ['cloudflare:email']
    }
  }
});
