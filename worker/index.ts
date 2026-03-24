import app from '../build/_worker.js';
import type { CloudflareEnv } from '../src/lib/server/cloudflare';
import { handleInboundEmail } from '../src/lib/server/email';

export default {
  fetch(request, env, ctx) {
    return app.fetch(request, env, ctx);
  },

  email(message, env, _ctx) {
    return handleInboundEmail(message, env);
  }
} satisfies ExportedHandler<CloudflareEnv>;
