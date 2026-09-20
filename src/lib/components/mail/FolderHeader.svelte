<script lang="ts">
  import { onMount } from 'svelte';
  import { RefreshCw } from '@lucide/svelte';
  import { IconButton } from '$lib/components/ui';
  import MailFilterBar, { type MailFilter } from './MailFilterBar.svelte';
  import MailSearchBar from './MailSearchBar.svelte';
  import type { MailboxIdentityFilter, MailboxSection, WorkspaceSnapshot } from '$lib/domain/mail';
  import { translateCount } from '$lib/i18n';
  import { useLocale } from '$lib/i18n/runtime.svelte';

  type AppSection = MailboxSection | 'trash' | 'profile';

  let {
    activeSection,
    count = 0,
    unreadCount = 0,
    query = '',
    filter = 'all',
    identityFilter = null,
    identityOptions = { domains: [], addresses: [] },
    loading = false,
    onQueryChange,
    onFilterChange,
    onIdentityFilterChange,
    onRefresh,
    title
  }: {
    activeSection: AppSection;
    count?: number;
    unreadCount?: number;
    query?: string;
    filter?: MailFilter;
    identityFilter?: MailboxIdentityFilter | null;
    identityOptions?: WorkspaceSnapshot['mailIdentityOptions'];
    loading?: boolean;
    onQueryChange?: (query: string) => void;
    onFilterChange?: (filter: MailFilter) => void;
    onIdentityFilterChange?: (filter: MailboxIdentityFilter | null) => void;
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
  const identityValue = $derived(identityFilter ? `${identityFilter.kind}:${identityFilter.id}` : '');

  function changeIdentity(value: string) {
    if (!value) {
      onIdentityFilterChange?.(null);
      return;
    }
    const separator = value.indexOf(':');
    const kind = value.slice(0, separator);
    const id = value.slice(separator + 1);
    if (kind === 'domain' && identityOptions.domains.some((item) => item.id === id)) {
      onIdentityFilterChange?.({ kind, id });
    } else if (kind === 'address' && identityOptions.addresses.some((item) => item.id === id)) {
      onIdentityFilterChange?.({ kind, id });
    }
  }

  let showMobileSearch = $state(false);

  onMount(() => {
    const media = matchMedia('(max-width: 900px)');
    const syncMobileSearch = () => {
      showMobileSearch = media.matches;
    };
    syncMobileSearch();
    media.addEventListener('change', syncMobileSearch);
    return () => media.removeEventListener('change', syncMobileSearch);
  });
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
    <div class="folder-search mt-3 grid gap-2">
      {#if showMobileSearch}
        <div class="folder-search-field">
          <MailSearchBar {query} disabled={loading} onQueryChange={onQueryChange} />
        </div>
      {/if}
      {#if activeSection !== 'trash' && identityOptions.domains.length > 0}
        <label class="sr-only" for="mail-identity-filter">{t('mail.identityFilter')}</label>
        <select
          id="mail-identity-filter"
          class="min-h-11 w-full rounded-[var(--radius-md)] border border-[var(--fm-border)] bg-[var(--fm-surface)] px-3 text-sm text-[var(--fm-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--fm-focus)]/40"
          value={identityValue}
          disabled={loading}
          onchange={(event) => changeIdentity(event.currentTarget.value)}
        >
          <option value="">{t('mail.allIdentities')}</option>
          {#each identityOptions.domains as domain (domain.id)}
            <option value={`domain:${domain.id}`}>{t('mail.domainIdentityOption', { domain: domain.domainName })}</option>
          {/each}
          {#each identityOptions.addresses as address (address.id)}
            <option value={`address:${address.id}`}>{t('mail.addressIdentityOption', { email: address.email })}</option>
          {/each}
        </select>
      {/if}
      <MailFilterBar {filter} disabled={loading} onFilterChange={onFilterChange} />
    </div>
  {/if}
</header>
