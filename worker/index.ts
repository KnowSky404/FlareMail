/// <reference path="./generated-worker.d.ts" />

import app from '../build/_worker.js';
import type { CloudflareEnv } from '../src/lib/server/cloudflare';
import { handleInboundEmail } from '../src/lib/server/email';
import { scheduleMaintenance } from '../src/lib/server/scheduled';

// The adapter emits its own runtime types; use this wrapper's generated contract.
const appFetch = app.fetch as unknown as NonNullable<ExportedHandler<CloudflareEnv>['fetch']>;

export default {
  fetch(request, env, ctx) {
    return appFetch(request, env, ctx);
  },

  email(message, env, ctx) {
    return handleInboundEmail(message, env, ctx);
  },

  scheduled(_controller, env, ctx) {
    scheduleMaintenance(env, ctx);
  }
} satisfies ExportedHandler<CloudflareEnv>;
