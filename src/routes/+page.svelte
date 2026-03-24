<script lang="ts">
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
</script>

<svelte:head>
  <title>FlareMail</title>
  <meta
    name="description"
    content="Cloudflare-native SvelteKit mailbox console backed by Workers, D1, R2, and Email Routing."
  />
</svelte:head>

<div class="relative overflow-hidden">
  <div class="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(255,211,105,0.14),transparent_38%)]"></div>

  <main class="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-10 px-6 py-10 md:px-10 lg:py-14">
    <section class="grid gap-8 lg:grid-cols-[1.15fr_0.85fr]">
      <div class="space-y-6">
        <p class="inline-flex rounded-full border border-white/15 bg-white/8 px-4 py-1 text-xs uppercase tracking-[0.32em] text-coral">
          Cloudflare Monolith
        </p>

        <div class="space-y-4">
          <h1 class="max-w-3xl font-display text-5xl leading-none tracking-tight text-paper md:text-7xl">
            FlareMail runs the UI, API, and inbound email pipeline from one Worker.
          </h1>
          <p class="max-w-2xl text-base leading-7 text-paper/72 md:text-lg">
            SvelteKit renders the dashboard, `/api/messages` exposes mailbox metadata, and the
            Worker `email()` handler writes inbound mail to D1 and R2 without splitting the app
            across services.
          </p>
        </div>

        <div class="grid gap-4 sm:grid-cols-3">
          <article class="rounded-3xl border border-white/12 bg-white/7 p-5 shadow-[0_20px_80px_rgba(0,0,0,0.25)] backdrop-blur">
            <p class="text-xs uppercase tracking-[0.28em] text-paper/50">Worker Topology</p>
            <p class="mt-3 text-2xl font-semibold text-paper">Single Worker</p>
            <p class="mt-3 text-sm leading-6 text-paper/68">
              SvelteKit UI, JSON API, and Email Routing ingress share one Cloudflare Worker
              entrypoint.
            </p>
          </article>

          <article class="rounded-3xl border border-white/12 bg-white/7 p-5 shadow-[0_20px_80px_rgba(0,0,0,0.25)] backdrop-blur">
            <p class="text-xs uppercase tracking-[0.28em] text-paper/50">D1 Binding</p>
            <p class="mt-3 text-2xl font-semibold text-paper">
              {data.dbBound ? 'Attached' : 'Missing'}
            </p>
            <p class="mt-3 text-sm leading-6 text-paper/68">
              {#if data.schemaReady}
                {data.totalMessages} stored message{data.totalMessages === 1 ? '' : 's'}
              {:else}
                Run the schema migration before reading mailbox metadata.
              {/if}
            </p>
          </article>

          <article class="rounded-3xl border border-white/12 bg-white/7 p-5 shadow-[0_20px_80px_rgba(0,0,0,0.25)] backdrop-blur">
            <p class="text-xs uppercase tracking-[0.28em] text-paper/50">R2 Binding</p>
            <p class="mt-3 text-2xl font-semibold text-paper">
              {data.bucketBound ? 'Attached' : 'Missing'}
            </p>
            <p class="mt-3 text-sm leading-6 text-paper/68">
              Inbound raw RFC822 payloads are stored as `.eml` objects for replay or auditing.
            </p>
          </article>
        </div>
      </div>

      <aside class="rounded-[2rem] border border-white/12 bg-black/22 p-6 shadow-[0_30px_90px_rgba(0,0,0,0.3)] backdrop-blur">
        <div class="flex items-center justify-between text-xs uppercase tracking-[0.3em] text-paper/50">
          <span>Mailbox Pulse</span>
          <span>{data.schemaReady ? 'Live' : 'Pending'}</span>
        </div>

        <div class="mt-8 space-y-6">
          <div class="rounded-3xl bg-white/6 p-5">
            <p class="text-sm text-paper/58">Latest subject</p>
            <p class="mt-3 text-2xl font-semibold text-paper">
              {data.lastSubject ?? 'No message captured yet'}
            </p>
          </div>

          <div class="rounded-3xl bg-white/6 p-5">
            <p class="text-sm text-paper/58">Latest timestamp</p>
            <p class="mt-3 text-lg text-paper">
              {data.lastTimestamp ?? 'Waiting for the first inbound delivery'}
            </p>
          </div>

          <div class="rounded-3xl border border-coral/25 bg-coral/10 p-5 text-sm leading-6 text-paper/82">
            <p class="font-semibold text-paper">Ready-to-wire resources</p>
            <p class="mt-2">Update the placeholder IDs in `wrangler.toml`, apply `schema.sql`, then connect Email Routing to this Worker.</p>
          </div>
        </div>
      </aside>
    </section>

    <section class="grid gap-6 lg:grid-cols-[0.95fr_1.05fr]">
      <article class="rounded-[2rem] border border-white/12 bg-white/7 p-6 backdrop-blur">
        <p class="text-xs uppercase tracking-[0.3em] text-paper/52">API Surface</p>
        <div class="mt-5 space-y-4 text-sm leading-7 text-paper/74">
          <p><code>GET /api/health</code> confirms that D1 and R2 bindings are visible to the Worker.</p>
          <p><code>GET /api/messages?limit=20</code> returns the latest stored metadata rows from D1.</p>
          <p>
            The same Worker module also exports <code>email(message, env, ctx)</code> so Cloudflare
            Email Routing can persist inbound mail without provisioning a second service.
          </p>
        </div>
      </article>

      <article class="rounded-[2rem] border border-white/12 bg-[#0b1220]/85 p-6 backdrop-blur">
        <p class="text-xs uppercase tracking-[0.3em] text-paper/52">Bun Workflow</p>
        <div class="mt-5 grid gap-3 text-sm text-paper/78">
          <div class="rounded-2xl border border-white/10 bg-white/5 px-4 py-3 font-mono">bun install</div>
          <div class="rounded-2xl border border-white/10 bg-white/5 px-4 py-3 font-mono">bun run dev</div>
          <div class="rounded-2xl border border-white/10 bg-white/5 px-4 py-3 font-mono">bun run build</div>
          <div class="rounded-2xl border border-white/10 bg-white/5 px-4 py-3 font-mono">bun run deploy</div>
        </div>
      </article>
    </section>
  </main>
</div>
