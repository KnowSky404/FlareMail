<script lang="ts">
  import { RefreshCw } from '@lucide/svelte';
  import { IconButton } from '$lib/components/ui';
  import MailFilterBar, { type MailFilter } from './MailFilterBar.svelte';
  import MailSearchBar from './MailSearchBar.svelte';
  import type { MailboxSection } from '$lib/domain/mail';

  type AppSection = MailboxSection | 'trash' | 'profile';

  let {
    activeSection,
    count = 0,
    unreadCount = 0,
    query = '',
    filter = 'all',
    loading = false,
    onQueryChange,
    onFilterChange,
    onRefresh,
    title
  }: {
    activeSection: AppSection;
    count?: number;
    unreadCount?: number;
    query?: string;
    filter?: MailFilter;
    loading?: boolean;
    onQueryChange?: (query: string) => void;
    onFilterChange?: (filter: MailFilter) => void;
    onRefresh?: () => void | Promise<void>;
    title?: string;
  } = $props();

  const sectionLabels: Record<AppSection, string> = {
    inbox: '收件箱',
    sent: '已发送',
    drafts: '草稿箱',
    archive: '归档',
    trash: '垃圾箱',
    profile: '个人资料'
  };

  const heading = $derived(title || sectionLabels[activeSection]);
  const countLabel = $derived(`${count} 封`);
</script>

<header class="border-b border-[var(--fm-border)] bg-[var(--fm-surface)] px-4 py-3 sm:px-5">
  <div class="flex min-h-8 items-center justify-between gap-3">
    <div class="flex min-w-0 items-baseline gap-2">
      <h1 class="truncate text-lg font-semibold tracking-tight text-[var(--fm-text)]">{heading}</h1>
      <span class="shrink-0 text-xs tabular-nums text-[var(--fm-text-muted)]">{countLabel}</span>
      {#if unreadCount > 0 && activeSection !== 'drafts'}
        <span class="shrink-0 text-xs text-[var(--fm-primary)]">{unreadCount} 未读</span>
      {/if}
    </div>
    <IconButton
      ariaLabel="刷新邮件列表"
      title="刷新邮件列表"
      variant="ghost"
      size="sm"
      loading={loading}
      onclick={() => onRefresh?.()}
    >
      <RefreshCw class="size-4" aria-hidden="true" />
    </IconButton>
  </div>

  {#if activeSection !== 'profile'}
    <div class="mt-3 grid gap-2">
      <MailSearchBar {query} disabled={loading} onQueryChange={onQueryChange} />
      <MailFilterBar {filter} disabled={loading} onFilterChange={onFilterChange} />
    </div>
  {/if}
</header>
