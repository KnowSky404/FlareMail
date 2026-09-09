/// <reference path="./generated-worker.d.ts" />

import app from '../build/_worker.js';
import type { CloudflareEnv } from '../src/lib/server/cloudflare';
import { handleInboundEmail } from '../src/lib/server/email';
import { dispatchTelegramOutbox } from '../src/lib/server/telegram/dispatcher';

export default {
  fetch(request, env, ctx) {
    return app.fetch(request, env, ctx);
  },

  email(message, env, ctx) {
    return handleInboundEmail(message, env, ctx);
  },

  scheduled(_controller, env, ctx) {
    ctx.waitUntil(dispatchTelegramOutbox(env, { limit: 10, timeBudgetMs: 20_000 }));
  }
} satisfies ExportedHandler<CloudflareEnv>;
