<script lang="ts">
  import Button from './Button.svelte';
  import { useLocale } from '$lib/i18n/runtime.svelte';
  import { formatNumber } from '$lib/i18n';

  let { page = 1, hasPrevious = false, hasNext = false, pending = false, totalPages,
    empty = false, onPrevious, onNext }: {
    page?: number; hasPrevious?: boolean; hasNext?: boolean; pending?: boolean; totalPages?: number;
    empty?: boolean; onPrevious?: () => void | Promise<unknown>; onNext?: () => void | Promise<unknown>;
  } = $props();
  const i18n = useLocale();
  const { t } = i18n;
</script>

<nav class="pagination" aria-label={t('pagination.label')} aria-busy={pending}>
  <Button variant="secondary" size="sm" disabled={!hasPrevious || pending} onclick={() => void onPrevious?.()}>{t('settings.previousPage')}</Button>
  <span role="status" aria-live="polite">{empty && !hasPrevious && !hasNext ? t('pagination.empty') : totalPages
    ? t('settings.resourcePage', { page: formatNumber(page, i18n.locale), pages: formatNumber(totalPages, i18n.locale) })
    : t('pagination.current', { page: formatNumber(page, i18n.locale) })}</span>
  <Button variant="secondary" size="sm" disabled={!hasNext || pending} onclick={() => void onNext?.()}>{t('settings.nextPage')}</Button>
</nav>

<style>
  .pagination { display: flex; flex-wrap: wrap; justify-content: center; align-items: center; gap: 8px; padding: 12px 4px; }
  span { color: var(--fm-text-muted); font-size: 12px; }
  .pagination :global(button) { min-height: 44px; }
</style>
