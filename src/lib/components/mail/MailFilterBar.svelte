<script lang="ts">
  import { ListFilter } from '@lucide/svelte';

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

  const options: Array<{ value: MailFilter; label: string }> = [
    { value: 'all', label: '全部' },
    { value: 'unread', label: '未读' },
    { value: 'starred', label: '已加星标' }
  ];
</script>

<div class="flex min-w-0 items-center gap-1" role="group" aria-label="邮件筛选">
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
