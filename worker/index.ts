/// <reference path="./generated-worker.d.ts" />

import app from '../build/_worker.js';
import type { CloudflareEnv } from '../src/lib/server/cloudflare';
import { handleInboundEmail } from '../src/lib/server/email';
import { cleanupLoginAttempts } from '../src/lib/server/auth/rate-limit';
import { isMcpMachinePath, mcpPaths } from '../src/lib/server/mcp/config';
import { cleanupMcpRecords } from '../src/lib/server/mcp/store';
import { scheduleMaintenance } from '../src/lib/server/scheduled';

// The adapter emits its own runtime types; use this wrapper's generated contract.
const appFetch = app.fetch as unknown as NonNullable<ExportedHandler<CloudflareEnv>['fetch']>;
let nextRequestCleanupAt = 0;
let nextScheduledCleanupAt = 0;

function scheduleExpiredRecordsCleanup(db: D1Database, ctx: ExecutionContext) {
  ctx.waitUntil(cleanupLoginAttempts(db).catch(() => {
    console.error(JSON.stringify({ event: 'login_rate_limit_cleanup_failed' }));
  }));
  ctx.waitUntil(cleanupMcpRecords(db).catch(() => {
    console.error(JSON.stringify({ event: 'mcp_cleanup_failed' }));
  }));
}

export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    let response: Response;
    if (isMcpMachinePath(path)) {
      const { handleMcpEndpoint } = await import('../src/lib/server/mcp/endpoint');
      response = await handleMcpEndpoint(request, env, ctx);
    } else {
      response = await appFetch(request, env, ctx);
    }
    if (env.APP_ENV !== 'production' && env.DB && request.method === 'POST' &&
        (path === '/api/workspace/session' || (path === mcpPaths.resource && response.ok)) &&
        Date.now() >= nextRequestCleanupAt) {
      nextRequestCleanupAt = Date.now() + 15 * 60 * 1000;
      scheduleExpiredRecordsCleanup(env.DB, ctx);
    }
    return response;
  },

  email(message, env, ctx) {
    return handleInboundEmail(message, env, ctx);
  },

  scheduled(controller, env, ctx) {
    if (env.DB && controller.scheduledTime >= nextScheduledCleanupAt) {
      nextScheduledCleanupAt = controller.scheduledTime + 60 * 60 * 1000;
      scheduleExpiredRecordsCleanup(env.DB, ctx);
    }
    scheduleMaintenance(env, ctx);
  }
} satisfies ExportedHandler<CloudflareEnv>;
