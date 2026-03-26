<script lang="ts">
  import type { MailFolder, UserProfile } from '$lib/mock/mailbox';

  type AppSection = MailFolder | 'profile';

  let {
    profile,
    activeSection,
    unreadCount,
    sentCount,
    draftCount,
    onSelectSection
  }: {
    profile: UserProfile;
    activeSection: AppSection;
    unreadCount: number;
    sentCount: number;
    draftCount: number;
    lastTimestamp: string | null;
    forwardingEnabled: boolean;
    onSelectSection: (section: AppSection) => void;
  } = $props();

  const navItems = $derived([
    {
      id: 'inbox',
      label: '收件箱',
      count: unreadCount,
      icon: 'M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z'
    },
    {
      id: 'sent',
      label: '已发送',
      count: sentCount,
      icon: 'M12 19l9 2-9-18-9 18 9-2zm0 0v-8'
    },
    {
      id: 'drafts',
      label: '草稿箱',
      count: draftCount,
      icon: 'M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z'
    },
    {
      id: 'profile',
      label: '个人资料',
      count: 0,
      icon: 'M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z'
    }
  ] as const);

  const profileInitial = $derived(profile.name.trim().charAt(0).toUpperCase() || 'F');
</script>

<aside class="w-20 flex-none flex flex-col items-center bg-zinc-950 py-4">
  <div class="mb-8 flex h-10 w-10 items-center justify-center rounded-lg bg-white text-xs font-black text-zinc-950 shadow-sm">
    FM
  </div>

  <nav class="flex flex-1 flex-col gap-4">
    {#each navItems as item}
      <button
        aria-label={item.label}
        class={`group relative flex h-16 w-14 flex-col items-center justify-center gap-1 rounded-xl transition-all ${
          activeSection === item.id ? 'bg-zinc-800 text-white' : 'text-zinc-500 hover:bg-zinc-800/50 hover:text-zinc-300'
        }`}
        title={item.label}
        type="button"
        onclick={() => onSelectSection(item.id as AppSection)}
      >
        <svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d={item.icon} />
        </svg>
        <span class="text-[10px] font-medium tracking-wide">{item.label}</span>
        
        {#if item.count > 0}
          <span class="absolute right-1.5 top-1.5 min-w-4 rounded-full bg-blue-500 px-1 text-center text-[9px] font-bold leading-4 text-white ring-2 ring-zinc-950">
            {item.count > 99 ? '99+' : item.count}
          </span>
        {/if}
      </button>
    {/each}
  </nav>

  <div class="mt-auto">
    <div class="flex h-10 w-10 items-center justify-center overflow-hidden rounded-full border border-zinc-800 bg-zinc-900 text-xs font-bold text-white">
      {profileInitial}
    </div>
  </div>
</aside>
