<script lang="ts">
  import { onMount } from 'svelte';
  import { Search, X } from '@lucide/svelte';
  import { IconButton } from '$lib/components/ui';

  let {
    query = '',
    placeholder = '搜索邮件，支持 from:、subject:、is:',
    disabled = false,
    onQueryChange,
    id = 'mail-search'
  }: {
    query?: string;
    placeholder?: string;
    disabled?: boolean;
    id?: string;
    onQueryChange?: (query: string) => void;
  } = $props();

  let searchInput = $state<HTMLInputElement>();

  onMount(() => {
    const focusSearch = () => searchInput?.focus();
    window.addEventListener('flaremail:focus-search', focusSearch);
    return () => window.removeEventListener('flaremail:focus-search', focusSearch);
  });
</script>

<div class="relative min-w-0 flex-1">
  <label class="sr-only" for={id}>搜索邮件</label>
  <Search class="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--fm-text-muted)]" aria-hidden="true" />
  <input
    bind:this={searchInput}
    {id}
    type="search"
    value={query}
    {placeholder}
    {disabled}
    autocomplete="off"
    enterkeyhint="search"
    class="fm-field h-9 w-full pl-9 pr-10 text-sm"
    aria-label="搜索邮件"
    aria-describedby={`${id}-hint`}
    oninput={(event) => onQueryChange?.(event.currentTarget.value)}
  />
  {#if query}
    <IconButton
      ariaLabel="清除搜索"
      title="清除搜索"
      size="sm"
      class="absolute right-1 top-1/2 size-11 -translate-y-1/2 sm:size-7"
      onclick={() => onQueryChange?.('')}
    >
      <X class="size-4" aria-hidden="true" />
    </IconButton>
  {/if}
  <span class="sr-only" id={`${id}-hint`}>支持发件人、收件人、抄送、主题、状态、附件、日期与标签高级搜索。</span>
</div>
