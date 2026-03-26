<script lang="ts">
  import { demoCredentials, type LoginInput } from '$lib/mock/mailbox';

  let {
    runtimeLabel,
    dbBound,
    bucketBound,
    loginError = '',
    pending = false,
    onLogin
  }: {
    runtimeLabel: string;
    dbBound: boolean;
    bucketBound: boolean;
    totalMessages: number;
    lastSubject: string | null;
    loginError?: string;
    pending?: boolean;
    onLogin: (payload: LoginInput) => void | Promise<void>;
  } = $props();

  let email = $state(demoCredentials.email);
  let password = $state(demoCredentials.password);

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    await onLogin({ email, password, remember: true });
  }
</script>

<div class="flex min-h-screen items-center justify-center bg-zinc-50 p-6">
  <div class="w-full max-w-sm">
    <div class="mb-12 text-center">
      <div class="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-zinc-900 text-2xl font-black text-white shadow-xl">
        F
      </div>
      <h1 class="text-2xl font-bold tracking-tight text-zinc-900">Welcome to FlareMail</h1>
      <p class="mt-2 text-sm text-zinc-500">Minimalist email workspace on the edge.</p>
    </div>

    <form class="space-y-4" onsubmit={submit}>
      <div class="space-y-1">
        <label for="email" class="text-[10px] font-bold uppercase tracking-widest text-zinc-400 ml-1">Account</label>
        <input
          id="email"
          bind:value={email}
          class="w-full rounded-lg border border-zinc-200 bg-white px-4 py-3 text-sm outline-none transition-all focus:border-zinc-900 focus:ring-1 focus:ring-zinc-900"
          type="email"
          placeholder="email@example.com"
        />
      </div>

      <div class="space-y-1">
        <label for="password" class="text-[10px] font-bold uppercase tracking-widest text-zinc-400 ml-1">Password</label>
        <input
          id="password"
          bind:value={password}
          class="w-full rounded-lg border border-zinc-200 bg-white px-4 py-3 text-sm outline-none transition-all focus:border-zinc-900 focus:ring-1 focus:ring-zinc-900"
          type="password"
          placeholder="••••••••"
        />
      </div>

      {#if loginError}
        <p class="text-[11px] font-medium text-red-500 ml-1">{loginError}</p>
      {/if}

      <button
        class="w-full rounded-lg bg-zinc-900 py-3 text-sm font-bold text-white shadow-lg transition-all hover:bg-zinc-800 active:scale-[0.98] disabled:opacity-50"
        disabled={pending}
        type="submit"
      >
        {pending ? 'Authenticating...' : 'Sign In'}
      </button>
    </form>

    <div class="mt-12 flex flex-col gap-4 pt-8 border-t border-zinc-200">
      <div class="flex items-center justify-between text-[10px] font-bold uppercase tracking-widest text-zinc-400">
        <span>Runtime Status</span>
        <span class="text-zinc-300">{runtimeLabel}</span>
      </div>
      <div class="flex gap-2">
         <span class={`px-2 py-0.5 rounded text-[9px] font-bold border ${dbBound ? 'border-zinc-200 text-zinc-500' : 'border-red-100 text-red-400'}`}>D1 {dbBound ? 'ONLINE' : 'OFFLINE'}</span>
         <span class={`px-2 py-0.5 rounded text-[9px] font-bold border ${bucketBound ? 'border-zinc-200 text-zinc-500' : 'border-red-100 text-red-400'}`}>R2 {bucketBound ? 'ONLINE' : 'OFFLINE'}</span>
      </div>
    </div>
  </div>
</div>
