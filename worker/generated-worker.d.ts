// The adapter creates this module during `vite build`; keep source checks independent of that output.
declare module '*build/_worker.js' {
  const worker: {
    fetch(
      request: Request,
      env: import('../src/lib/server/cloudflare').CloudflareEnv,
      ctx: ExecutionContext
    ): Promise<Response> | Response;
    scheduled(
      controller: ScheduledController,
      env: import('../src/lib/server/cloudflare').CloudflareEnv,
      ctx: ExecutionContext
    ): Promise<void> | void;
  };

  export default worker;
}
