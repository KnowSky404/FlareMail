/// <reference path="./generated-worker.d.ts" />

import app from '../build/_worker.js';
import type { CloudflareEnv } from '../src/lib/server/cloudflare';
import { handleInboundEmail } from '../src/lib/server/email';
import { isMcpMachinePath } from '../src/lib/server/mcp/config';
import { cleanupMcpRecords } from '../src/lib/server/mcp/store';
import { scheduleMaintenance } from '../src/lib/server/scheduled';

// The adapter emits its own runtime types; use this wrapper's generated contract.
const appFetch = app.fetch as unknown as NonNullable<ExportedHandler<CloudflareEnv>['fetch']>;

export default {
  async fetch(request, env, ctx) {
    if (isMcpMachinePath(new URL(request.url).pathname)) {
      const { handleMcpEndpoint } = await import('../src/lib/server/mcp/endpoint');
      return handleMcpEndpoint(request, env, ctx);
    }
    return appFetch(request, env, ctx);
  },

  email(message, env, ctx) {
    return handleInboundEmail(message, env, ctx);
  },

  scheduled(controller, env, ctx) {
    if (env.MCP_PUBLIC_URL && env.OAUTH_KV && new Date(controller.scheduledTime).getUTCMinutes() === 0) {
      ctx.waitUntil(cleanupMcpRecords(env.DB).catch(() => {
        console.error(JSON.stringify({ event: 'mcp_cleanup_failed' }));
      }));
    }
    scheduleMaintenance(env, ctx);
  }
} satisfies ExportedHandler<CloudflareEnv>;
