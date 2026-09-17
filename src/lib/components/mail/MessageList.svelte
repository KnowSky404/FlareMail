<script lang="ts">
  import { AlertCircle, RefreshCw } from '@lucide/svelte';
  import { Button, Skeleton } from '$lib/components/ui';
  import type { MailboxSection, MailMessage, MailThread } from '$lib/domain/mail';
  import { useLocale } from '$lib/i18n/runtime.svelte';
  import EmptyMailbox from './EmptyMailbox.svelte';
  import MessageListItem from './MessageListItem.svelte';
  import type { MailFilter } from './MailFilterBar.svelte';

  type AppSection = MailboxSection | 'trash' | 'profile';
  type ListItem = { kind: 'thread'; value: MailThread } | { kind: 'message'; value: MailMessage };

  let {
    activeSection,
    messages = [],
    threads = [],
    selectedMessageId = null,
    selectedThreadId = null,
    query = '',
    filter = 'all',
    loading = false,
    error = '',
    paginationEnd = false,
    hasMore = false,
    onSelect,
    onSelectThread,
    onToggleStar,
    onQueryChange,
    onFilterChange,
    onRefresh,
    onClearFilters,
    onLoadMore,
    selectable = false,
    selectedMessageIds = [],
    onToggleSelect
  }: {
    activeSection: AppSection;
    messages?: MailMessage[];
    threads?: MailThread[];
    selectedMessageId?: string | null;
    selectedThreadId?: string | null;
    query?: string;
    filter?: MailFilter;
    loading?: boolean;
    error?: string;
    paginationEnd?: boolean;
    hasMore?: boolean;
    onSelect?: (message: MailMessage) => void | Promise<void>;
    onSelectThread?: (thread: MailThread) => void | Promise<void>;
    onToggleStar?: (message: MailMessage, event?: MouseEvent) => void | Promise<void>;
    onQueryChange?: (query: string) => void;
    onFilterChange?: (filter: MailFilter) => void;
    onRefresh?: () => void | Promise<void>;
    onClearFilters?: () => void;
    onLoadMore?: () => void | Promise<void>;
    selectable?: boolean;
    selectedMessageIds?: string[];
    onToggleSelect?: (message: MailMessage) => void;
  } = $props();

  const { t } = useLocale();

  const sectionLabels = $derived<Record<AppSection, string>>({
    inbox: t('shell.inbox'),
    sent: t('shell.sent'),
    drafts: t('shell.drafts'),
    archive: t('shell.archive'),
    trash: t('shell.trash'),
    profile: t('mail.detail')
  });

  const sourceItems = $derived.by<ListItem[]>(() => {
    if (activeSection === 'drafts' || activeSection === 'trash' || threads.length === 0) {
      return messages.map((value) => ({ kind: 'message', value }));
    }
    return threads.map((value) => ({ kind: 'thread', value }));
  });

  const visibleItems = $derived.by(() => {
    return sourceItems.filter((item) => {
      const message = item.kind === 'thread' ? item.value.sectionLatestMessage : item.value;
      const thread = item.kind === 'thread' ? item.value : null;
      const matchesFilter =
        filter === 'all' ||
        (filter === 'unread' && (thread ? thread.unreadCount > 0 : !message.read)) ||
        (filter === 'starred' && (thread ? thread.messages.some((entry) => entry.starred) : message.starred));
      if (!matchesFilter) return false;
      return true;
    });
  });

  const selectedCount = $derived(visibleItems.length);
  const isFiltered = $derived(Boolean(query.trim()) || filter !== 'all');
  const emptyTitle = $derived(isFiltered ? t('mail.noMatch') : t('mail.empty', { section: sectionLabels[activeSection] }));
  const emptyDescription = $derived(
    isFiltered
      ? t('mail.tryDifferentSearch')
      : activeSection === 'drafts'
        ? t('mail.savedDraftHint')
        : activeSection === 'trash'
          ? t('mail.trashHint')
          : t('mail.newMailHint')
  );

  const itemKey = (item: ListItem) => (item.kind === 'thread' ? `thread:${item.value.id}` : `message:${item.value.id}`);
  const handleSelect = (item: ListItem) => {
    if (item.kind === 'thread') void onSelectThread?.(item.value);
    else void onSelect?.(item.value);
  };
</script>

<section class="fm-list-scroll min-h-0 flex-1 overflow-y-auto bg-[var(--fm-surface)]" aria-label={t('mail.listLabel', { section: sectionLabels[activeSection] })}>
  {#if loading}
    <div class="divide-y divide-[var(--fm-border)]" aria-label={t('mail.loadingList')} aria-busy="true">
      {#each Array(7) as _, index (index)}
        <div class="flex min-h-[72px] items-center gap-3 px-3 py-2" aria-hidden="true">
          <Skeleton class="size-2 shrink-0 rounded-full" />
          <Skeleton class="size-8 shrink-0 rounded-full" />
          <div class="min-w-0 flex-1 space-y-2">
            <Skeleton width={index % 2 ? '48%' : '35%'} height="0.75rem" />
            <Skeleton width={index % 3 ? '68%' : '52%'} height="0.8rem" />
            <Skeleton width={index % 2 ? '76%' : '60%'} height="0.625rem" />
          </div>
          <Skeleton width="2.5rem" height="0.625rem" />
        </div>
      {/each}
    </div>
  {:else if error}
    <div class="grid min-h-56 place-items-center px-6 py-10 text-center" role="alert">
      <div class="grid max-w-sm justify-items-center">
        <div class="mb-3 grid size-11 place-items-center rounded-full bg-[var(--fm-danger-soft)] text-[var(--fm-danger)]">
          <AlertCircle class="size-5" aria-hidden="true" />
        </div>
        <h2 class="text-sm font-semibold text-[var(--fm-text)]">{t('mail.listError')}</h2>
        <p class="mt-1 text-xs leading-5 text-[var(--fm-text-muted)]">{error}</p>
        {#if onRefresh}
          <Button variant="secondary" size="sm" class="mt-4" onclick={() => onRefresh?.()}>
            <RefreshCw class="size-3.5" aria-hidden="true" />
            {t('mail.retry')}
          </Button>
        {/if}
      </div>
    </div>
  {:else if visibleItems.length === 0}
    <EmptyMailbox
      title={emptyTitle}
      description={emptyDescription}
      searchActive={Boolean(query.trim())}
      filterActive={filter !== 'all'}
      onClear={onClearFilters || (() => { onQueryChange?.(''); onFilterChange?.('all'); })}
      onRefresh={isFiltered ? undefined : onRefresh}
    />
  {:else}
    <div role="list" aria-label={t('mail.listLabel', { section: sectionLabels[activeSection] })}>
      {#each visibleItems as item (itemKey(item))}
        {#if item.kind === 'thread'}
          <MessageListItem
            activeSection={activeSection}
            thread={item.value}
            selected={selectedThreadId === item.value.id}
            onSelect={(message) => handleSelect({ kind: 'thread', value: item.value })}
            onToggleStar={onToggleStar}
            {selectable}
            selectedForBulk={selectedMessageIds.includes(item.value.sectionLatestMessage.id)}
            onToggleSelect={onToggleSelect}
          />
        {:else}
          <MessageListItem
            {activeSection}
            message={item.value}
            selected={selectedMessageId === item.value.id}
            onSelect={(message) => handleSelect({ kind: 'message', value: message })}
            onToggleStar={onToggleStar}
            {selectable}
            selectedForBulk={selectedMessageIds.includes(item.value.id)}
            onToggleSelect={onToggleSelect}
          />
        {/if}
      {/each}
    </div>
    {#if hasMore && onLoadMore}
      <div class="border-t border-[var(--fm-border)] px-4 py-4 text-center">
        <Button variant="secondary" size="sm" onclick={() => onLoadMore?.()}>{t('mail.loadMore')}</Button>
      </div>
    {:else if paginationEnd || selectedCount > 0}
      <p class="border-t border-[var(--fm-border)] px-4 py-3 text-center text-[11px] text-[var(--fm-text-muted)]" aria-label={t('mail.allShown')}>{t('mail.allShown')}</p>
    {/if}
  {/if}
</section>
