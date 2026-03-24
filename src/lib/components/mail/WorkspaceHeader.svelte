<script lang="ts">
  import type { UserProfile } from '$lib/mock/mailbox';

  let {
    profile,
    banner,
    runtimeLabel,
    unreadCount,
    starredCount,
    draftCount,
    totalMessages,
    pending = false,
    onReceive,
    onEditProfile,
    onCompose,
    onLogout
  }: {
    profile: UserProfile;
    banner: string;
    runtimeLabel: string;
    unreadCount: number;
    starredCount: number;
    draftCount: number;
    totalMessages: number;
    pending?: boolean;
    onReceive: () => void | Promise<void>;
    onEditProfile: () => void;
    onCompose: () => void;
    onLogout: () => void | Promise<void>;
  } = $props();
</script>

<section class="rounded-[2rem] border border-night/10 bg-shell/94 px-5 py-4 shadow-[0_20px_70px_rgba(32,27,22,0.06)] md:px-7">
  <div class="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
    <div class="space-y-2">
      <div class="flex flex-wrap items-center gap-3 text-[11px] uppercase tracking-[0.28em] text-mist">
        <span>FlareMail Workspace</span>
        <span>{runtimeLabel}</span>
        <span>{profile.company}</span>
      </div>
      <h1 class="font-display text-3xl leading-none tracking-[-0.04em] text-ink md:text-5xl">
        一个克制的邮件工作台，先把流程跑顺。
      </h1>
    </div>

    <div class="flex flex-wrap items-center gap-3">
      <button
        class="rounded-full border border-night/10 px-4 py-2 text-sm text-ink transition hover:border-accent hover:text-accent disabled:opacity-60"
        disabled={pending}
        onclick={onReceive}
        type="button"
      >
        模拟收信
      </button>
      <button
        class="rounded-full border border-night/10 px-4 py-2 text-sm text-ink transition hover:border-accent hover:text-accent disabled:opacity-60"
        disabled={pending}
        onclick={onEditProfile}
        type="button"
      >
        编辑资料
      </button>
      <button
        class="rounded-full bg-ink px-4 py-2 text-sm text-paper transition hover:bg-accent disabled:opacity-60"
        disabled={pending}
        onclick={onCompose}
        type="button"
      >
        写邮件
      </button>
      <button
        class="rounded-full border border-night/10 px-4 py-2 text-sm text-mist transition hover:border-night/20 hover:text-ink disabled:opacity-60"
        disabled={pending}
        onclick={onLogout}
        type="button"
      >
        退出
      </button>
    </div>
  </div>

  <div class="mt-4 flex flex-col gap-3 border-t border-night/8 pt-4 lg:flex-row lg:items-center lg:justify-between">
    <p class="text-sm text-mist">{banner}</p>
    <div class="flex flex-wrap gap-3 text-sm text-ink">
      <span class="rounded-full border border-night/10 px-3 py-1">未读 {unreadCount}</span>
      <span class="rounded-full border border-night/10 px-3 py-1">星标 {starredCount}</span>
      <span class="rounded-full border border-night/10 px-3 py-1">草稿 {draftCount}</span>
      <span class="rounded-full border border-night/10 px-3 py-1">真实消息 {totalMessages}</span>
    </div>
  </div>
</section>
