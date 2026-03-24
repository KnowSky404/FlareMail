import type { CloudflareEnv } from '../src/lib/server/cloudflare';

declare module '../build/_worker.js' {
  const worker: {
    fetch(request: Request, env: CloudflareEnv, ctx: ExecutionContext): Promise<Response> | Response;
  };

  export default worker;
}

export {};
