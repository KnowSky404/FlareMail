<script lang="ts">
  import { cloneProfile, type UserProfile } from '$lib/mock/mailbox';

  let {
    profile,
    status = '',
    pending = false,
    onSave
  }: {
    profile: UserProfile;
    status?: string;
    pending?: boolean;
    onSave: (profile: UserProfile) => void | Promise<void>;
  } = $props();

  let form = $state<UserProfile>(cloneProfile());

  $effect(() => {
    form = cloneProfile(profile);
  });

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    await onSave(form);
  }
</script>

<section class="rounded-[2rem] border border-night/10 bg-shell/94 p-4 shadow-[0_20px_70px_rgba(32,27,22,0.04)] xl:col-span-2">
  <form class="rounded-[1.5rem] border border-night/10 bg-paper p-5 md:p-6" onsubmit={submit}>
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <p class="text-[11px] uppercase tracking-[0.28em] text-mist">资料编辑</p>
        <h2 class="mt-2 font-display text-3xl text-ink">管理个人信息</h2>
      </div>
      <button
        class="rounded-full bg-ink px-4 py-2 text-sm text-paper transition hover:bg-accent disabled:opacity-60"
        disabled={pending}
        type="submit"
      >
        {pending ? '保存中…' : '保存修改'}
      </button>
    </div>

    <div class="mt-6 grid gap-4 md:grid-cols-2">
      <label class="space-y-2">
        <span class="text-sm text-mist">姓名</span>
        <input bind:value={form.name} class="w-full rounded-2xl border border-night/10 bg-shell px-4 py-3 text-ink outline-none transition focus:border-accent" type="text" />
      </label>
      <label class="space-y-2">
        <span class="text-sm text-mist">职位</span>
        <input bind:value={form.role} class="w-full rounded-2xl border border-night/10 bg-shell px-4 py-3 text-ink outline-none transition focus:border-accent" type="text" />
      </label>
      <label class="space-y-2">
        <span class="text-sm text-mist">公司</span>
        <input bind:value={form.company} class="w-full rounded-2xl border border-night/10 bg-shell px-4 py-3 text-ink outline-none transition focus:border-accent" type="text" />
      </label>
      <label class="space-y-2">
        <span class="text-sm text-mist">邮箱</span>
        <input bind:value={form.email} class="w-full rounded-2xl border border-night/10 bg-shell px-4 py-3 text-ink outline-none transition focus:border-accent" type="email" />
      </label>
      <label class="space-y-2">
        <span class="text-sm text-mist">地区</span>
        <input bind:value={form.location} class="w-full rounded-2xl border border-night/10 bg-shell px-4 py-3 text-ink outline-none transition focus:border-accent" type="text" />
      </label>
      <label class="space-y-2">
        <span class="text-sm text-mist">时区</span>
        <input bind:value={form.timezone} class="w-full rounded-2xl border border-night/10 bg-shell px-4 py-3 text-ink outline-none transition focus:border-accent" type="text" />
      </label>
    </div>

    <label class="mt-4 flex items-center justify-between rounded-2xl border border-night/10 bg-shell px-4 py-3 text-sm text-ink">
      <span>开启自动转发到个人收件地址</span>
      <input bind:checked={form.forwardingEnabled} class="h-4 w-4 accent-accent" type="checkbox" />
    </label>

    <label class="mt-4 block space-y-2">
      <span class="text-sm text-mist">签名</span>
      <textarea
        bind:value={form.signature}
        class="min-h-40 w-full rounded-[1.5rem] border border-night/10 bg-shell px-4 py-3 text-sm leading-7 text-ink outline-none transition focus:border-accent"
      ></textarea>
    </label>

    {#if status}
      <p class="mt-4 rounded-2xl border border-accent/20 bg-accent/8 px-4 py-3 text-sm text-accent">
        {status}
      </p>
    {/if}
  </form>
</section>
