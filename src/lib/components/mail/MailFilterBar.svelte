<script lang="ts">
  import { ListFilter } from '@lucide/svelte';
  import { useLocale } from '$lib/i18n/runtime.svelte';

  export type MailFilter = 'all' | 'unread' | 'starred';

  let {
    filter = 'all',
    disabled = false,
    onFilterChange
  }: {
    filter?: MailFilter;
    disabled?: boolean;
    onFilterChange?: (filter: MailFilter) => void;
  } = $props();

  const { t } = useLocale();

  const options: Array<{ value: MailFilter; label: string }> = [
    { value: 'all', label: t('mail.all') },
    { value: 'unread', label: t('mail.unread') },
    { value: 'starred', label: t('mail.starred') }
  ];
</script>

<div class="flex min-w-0 items-center gap-1" role="group" aria-label={t('mail.filter')}>
  <span class="mr-1 hidden text-[var(--fm-text-muted)] sm:inline-flex" aria-hidden="true">
    <ListFilter class="size-4" />
  </span>
  {#each options as option (option.value)}
    <button
      type="button"
      class={`min-h-11 rounded-[var(--radius-md)] border px-3 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-[var(--fm-focus)]/40 focus-visible:ring-offset-1 sm:min-h-8 ${
        filter === option.value
          ? 'border-[var(--fm-primary)] bg-[var(--fm-primary-soft)] text-[var(--fm-primary)]'
          : 'border-[var(--fm-border)] bg-[var(--fm-surface)] text-[var(--fm-text-secondary)] hover:bg-[var(--fm-surface-hover)] hover:text-[var(--fm-text)]'
      }`}
      aria-pressed={filter === option.value}
      {disabled}
      onclick={() => onFilterChange?.(option.value)}
    >
      {option.label}
    </button>
  {/each}
</div>
