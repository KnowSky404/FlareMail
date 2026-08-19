/// <reference types="@sveltejs/kit" />
/// <reference types="@sveltejs/adapter-cloudflare" />
/// <reference path="../worker-configuration.d.ts" />

import type { CloudflareEnv } from './lib/server/cloudflare';
import type { WorkspaceContext } from './lib/server/workspace';

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
      workspaceSessionToken?: string | null;
      workspaceSession?: WorkspaceContext | null;
    }
  }
}

export {};
