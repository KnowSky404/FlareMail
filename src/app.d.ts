/// <reference types="@sveltejs/kit" />
/// <reference types="@sveltejs/adapter-cloudflare" />
/// <reference types="@cloudflare/workers-types" />

import type { CloudflareEnv } from './lib/server/cloudflare';
import type { MockWorkspaceSession } from './lib/server/workspace';

declare global {
  namespace App {
    interface Platform {
      env: CloudflareEnv;
      cf?: IncomingRequestCfProperties;
      ctx: ExecutionContext;
      context: ExecutionContext;
      caches: CacheStorage;
    }

    interface Locals {
      workspaceSessionId?: string | null;
      workspaceSession?: MockWorkspaceSession | null;
    }
  }
}

export {};
