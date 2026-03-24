/// <reference types="@sveltejs/kit" />
/// <reference types="@sveltejs/adapter-cloudflare" />
/// <reference types="@cloudflare/workers-types" />

import type { CloudflareEnv } from './lib/server/cloudflare';

declare global {
  namespace App {
    interface Platform {
      env: CloudflareEnv;
      cf?: IncomingRequestCfProperties;
      ctx: ExecutionContext;
      context: ExecutionContext;
      caches: CacheStorage;
    }
  }
}

export {};
