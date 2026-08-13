<script lang="ts">
  import type { Snippet } from 'svelte';
  import { cn, focusRing } from './styles';

  export type Tab = { id: string; label: string; disabled?: boolean };

  let {
    tabs,
    value,
    children,
    onChange,
    class: className = ''
  }: {
    tabs: Tab[];
    value?: string;
    children?: Snippet;
    onChange?: (value: string) => void;
    class?: string;
  } = $props();

  const activeValue = $derived(value ?? tabs.find((tab) => !tab.disabled)?.id ?? '');

  function move(index: number, direction: 1 | -1) {
    const next = tabs[(index + direction + tabs.length) % tabs.length];
    if (next && !next.disabled) onChange?.(next.id);
  }
</script>

<div class={cn('grid gap-4', className)}>
  <div class="flex items-center gap-1 border-b border-[var(--fm-border)]" role="tablist" aria-label="选项卡">
    {#each tabs as tab, index (tab.id)}
      <button
        id={`tab-${tab.id}`}
        type="button"
        role="tab"
        aria-selected={activeValue === tab.id}
        aria-controls={`tabpanel-${tab.id}`}
        tabindex={activeValue === tab.id ? 0 : -1}
        disabled={tab.disabled}
        class={cn('relative px-3 py-2.5 text-sm font-medium text-[var(--fm-text-muted)] transition-colors hover:text-[var(--fm-text)] disabled:cursor-not-allowed disabled:opacity-50', focusRing, activeValue === tab.id && 'text-[var(--fm-text)] after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:bg-[var(--fm-primary)]')}
        onclick={() => onChange?.(tab.id)}
        onkeydown={(event) => {
          if (event.key === 'ArrowRight' || event.key === 'ArrowDown') { event.preventDefault(); move(index, 1); }
          if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') { event.preventDefault(); move(index, -1); }
          if (event.key === 'Home') { event.preventDefault(); onChange?.(tabs.find((item) => !item.disabled)?.id ?? tab.id); }
          if (event.key === 'End') { event.preventDefault(); onChange?.([...tabs].reverse().find((item) => !item.disabled)?.id ?? tab.id); }
        }}
      >{tab.label}</button>
    {/each}
  </div>
  {#if children}<div role="tabpanel" id={`tabpanel-${activeValue}`} aria-labelledby={`tab-${activeValue}`}>{@render children()}</div>{/if}
</div>
