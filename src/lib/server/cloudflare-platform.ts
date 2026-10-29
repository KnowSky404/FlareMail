/** SvelteKit 3's Cloudflare adapter exposes bindings through cloudflare:workers. */
export async function resolveCloudflarePlatform(existing: App.Platform | undefined): Promise<App.Platform | undefined> {
  if (existing) return existing;
  try {
    const { env, waitUntil } = await import('cloudflare:workers');
    const context = { waitUntil };
    return { env, ctx: context, context, caches } as App.Platform;
  } catch {
    // Tests and non-Worker runtimes retain the existing unavailable-state behavior.
    return undefined;
  }
}
