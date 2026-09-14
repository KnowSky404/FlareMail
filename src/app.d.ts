/// <reference types="@sveltejs/kit" />
/// <reference types="@sveltejs/adapter-cloudflare" />
/// <reference path="../worker-configuration.d.ts" />

import type { CloudflareEnv } from './lib/server/cloudflare';
import type { WorkspaceContext } from './lib/server/workspace';
import type { RuntimeUnavailableState } from './lib/domain/runtime-state';
import type { Locale } from './lib/i18n';

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
      requestId?: string;
      runtimeState?: RuntimeUnavailableState;
      workspaceSessionId?: string | null;
      workspaceSessionToken?: string | null;
      workspaceSession?: WorkspaceContext | null;
      locale?: Locale;
    }

    interface Error {
      message: string;
      requestId: string;
    }
  }
}

export {};
