<script lang="ts">
  import { RefreshCw } from '@lucide/svelte';
  import { IconButton } from '$lib/components/ui';
  import MailFilterBar, { type MailFilter } from './MailFilterBar.svelte';
  import MailSearchBar from './MailSearchBar.svelte';
  import type { MailboxSection } from '$lib/domain/mail';
  import { translateCount } from '$lib/i18n';
  import { useLocale } from '$lib/i18n/runtime.svelte';

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

  const i18n = useLocale();
  const { t } = i18n;

  const sectionLabels = $derived<Record<AppSection, string>>({
    inbox: t('shell.inbox'),
    sent: t('shell.sent'),
    drafts: t('shell.drafts'),
    archive: t('shell.archive'),
    trash: t('shell.trash'),
    profile: t('common.settings')
  });

  const heading = $derived(title || sectionLabels[activeSection]);
  const countLabel = $derived(query.trim()
    ? translateCount(i18n.locale, 'mail.resultCount', count)
    : translateCount(i18n.locale, 'mail.folderCount', count));
</script>

<header class="border-b border-[var(--fm-border)] bg-[var(--fm-surface)] px-4 py-3 sm:px-5">
  <div class="flex min-h-8 items-center justify-between gap-3">
    <div class="flex min-w-0 items-baseline gap-2">
      <h1 class="truncate text-lg font-semibold tracking-tight text-[var(--fm-text)]">{heading}</h1>
      <span class="shrink-0 text-xs tabular-nums text-[var(--fm-text-muted)]">{countLabel}</span>
      {#if unreadCount > 0 && activeSection !== 'drafts'}
        <span class="shrink-0 text-xs text-[var(--fm-primary)]">{translateCount(i18n.locale, 'mail.unreadCount', unreadCount)}</span>
      {/if}
    </div>
    <IconButton
      ariaLabel={t('mail.refresh')}
      title={t('mail.refresh')}
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
