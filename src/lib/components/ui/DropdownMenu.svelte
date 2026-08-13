<script lang="ts">
  import type { Snippet } from 'svelte';
  import { ChevronDown } from '@lucide/svelte';
  import { cn, focusRing } from './styles';

  let {
    trigger,
    children,
    open = false,
    onOpenChange,
    align = 'start',
    class: className = ''
  }: {
    trigger: Snippet;
    children?: Snippet;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    align?: 'start' | 'end';
    class?: string;
  } = $props();

  let menuElement = $state<HTMLDivElement>();
  let triggerElement = $state<HTMLButtonElement>();
  const menuId = `menu-${Math.random().toString(36).slice(2, 8)}`;
  const items = () => [...menuElement?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []].filter((item) => !item.hasAttribute('disabled') && item.getAttribute('aria-disabled') !== 'true');

  function focusItem(index: number) { const current = items(); current[(index + current.length) % current.length]?.focus(); }
  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') { event.preventDefault(); onOpenChange?.(false); triggerElement?.focus(); }
    if (event.key === 'ArrowDown') { event.preventDefault(); const index = items().indexOf(document.activeElement as HTMLElement); focusItem(index + 1); }
    if (event.key === 'ArrowUp') { event.preventDefault(); const index = items().indexOf(document.activeElement as HTMLElement); focusItem(index - 1); }
    if (event.key === 'Home') { event.preventDefault(); focusItem(0); }
    if (event.key === 'End') { event.preventDefault(); focusItem(-1); }
  }

  $effect(() => {
    if (!open || typeof document === 'undefined') return;
    const frame = requestAnimationFrame(() => focusItem(0));
    document.addEventListener('keydown', handleKeydown);
    return () => { cancelAnimationFrame(frame); document.removeEventListener('keydown', handleKeydown); };
  });
</script>

<div class={cn('relative inline-block', className)}>
  <button bind:this={triggerElement} type="button" aria-haspopup="menu" aria-expanded={open} aria-controls={menuId} class={cn('inline-flex items-center gap-1', focusRing)} onclick={() => onOpenChange?.(!open)}>
    {@render trigger()}
    <ChevronDown class={cn('size-3.5 transition-transform', open && 'rotate-180')} aria-hidden="true" />
  </button>
  {#if open}
    <div bind:this={menuElement} id={menuId} class={cn('absolute top-[calc(100%+0.375rem)] z-40 min-w-44 rounded-[var(--radius-lg)] border border-[var(--fm-border)] bg-[var(--fm-surface)] p-1 shadow-[var(--fm-shadow-overlay)]', align === 'end' ? 'right-0' : 'left-0')} role="menu" tabindex="-1" onclick={(event) => { if ((event.target as HTMLElement).closest('[role="menuitem"]')) onOpenChange?.(false); }} onkeydown={() => undefined}>
      {#if children}{@render children()}{/if}
    </div>
  {/if}
</div>
