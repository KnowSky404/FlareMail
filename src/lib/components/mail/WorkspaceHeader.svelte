<script lang="ts">
  import type { UserProfile } from '$lib/mock/mailbox';

  let {
    profile,
    banner,
    pending = false,
    unreadCount,
    draftCount,
    queuedCount,
    failedCount,
    runtimeLabel,
    onEditProfile,
    onCompose,
    onLogout
  }: {
    profile: UserProfile;
    banner: string;
    runtimeLabel: string;
    unreadCount: number;
    draftCount: number;
    queuedCount: number;
    failedCount: number;
    pending?: boolean;
    onEditProfile: () => void;
    onCompose: () => void;
    onLogout: () => void | Promise<void>;
  } = $props();
</script>

<header class="h-14 flex items-center justify-between border-b border-zinc-200 px-4 bg-white">
  <div class="flex items-center gap-4 flex-1">
    <div class="flex items-center gap-2 text-sm font-medium text-zinc-900 bg-zinc-100 px-3 py-1.5 rounded-md">
      <span class="h-1.5 w-1.5 rounded-full bg-blue-500"></span>
      <span>{profile.company}</span>
    </div>
    <div class="hidden items-center gap-2 text-[10px] font-bold uppercase tracking-wider text-zinc-500 lg:flex">
      <span class="rounded-md border border-zinc-200 bg-white px-2.5 py-1">{runtimeLabel}</span>
      <span class="rounded-md border border-zinc-200 bg-white px-2.5 py-1">未读 {unreadCount}</span>
      <span class="rounded-md border border-zinc-200 bg-white px-2.5 py-1">草稿 {draftCount}</span>
      {#if queuedCount > 0}
        <span class="rounded-md border border-zinc-200 bg-white px-2.5 py-1">队列 {queuedCount}</span>
      {/if}
      {#if failedCount > 0}
        <span class="rounded-md border border-red-200 bg-red-50 px-2.5 py-1 text-red-600">失败 {failedCount}</span>
      {/if}
    </div>
    <div class="hidden h-4 w-px bg-zinc-200 lg:block"></div>
    <p class="max-w-md truncate text-xs text-zinc-500">{banner}</p>
  </div>

  <div class="flex items-center gap-3">
    <button
      class="btn-primary flex items-center gap-2 !rounded-md !py-1.5 shadow-sm"
      disabled={pending}
      onclick={onCompose}
      type="button"
    >
      <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
        <path fill-rule="evenodd" d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z" clip-rule="evenodd" />
      </svg>
      写邮件
    </button>

    <div class="h-8 w-px bg-zinc-200 mx-1"></div>

    <button
      aria-label="打开个人资料设置"
      class="btn-ghost !p-2 rounded-md relative"
      onclick={onEditProfile}
      type="button"
    >
      <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
      </svg>
    </button>
    <button
      aria-label="退出登录"
      class="btn-ghost !p-2 rounded-md hover:text-zinc-900"
      onclick={onLogout}
      type="button"
    >
      <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
      </svg>
    </button>
  </div>
</header>
