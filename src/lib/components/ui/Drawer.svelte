<script lang="ts">
  import type { Snippet } from 'svelte';
  import { X } from '@lucide/svelte';
  import { cn, focusRing } from './styles';

  let {
    open = false,
    title,
    description,
    children,
    footer,
    onClose,
    side = 'right',
    dismissible = true,
    closeOnBackdrop = true,
    width = 'md',
    class: className = ''
  }: {
    open?: boolean;
    title: string;
    description?: string;
    children?: Snippet;
    footer?: Snippet;
    onClose?: () => void;
    side?: 'left' | 'right';
    dismissible?: boolean;
    closeOnBackdrop?: boolean;
    width?: 'sm' | 'md' | 'lg';
    class?: string;
  } = $props();

  let drawerElement = $state<HTMLDivElement>();
  let restoreElement: HTMLElement | null = null;
  let drawerId = `drawer-${Math.random().toString(36).slice(2, 8)}`;
  const widths = { sm: 'w-full max-w-sm', md: 'w-full max-w-md', lg: 'w-full max-w-2xl' };
  const positions = { left: 'left-0', right: 'right-0' };

  function focusables() { return [...drawerElement?.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? []]; }
  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape' && dismissible) { event.preventDefault(); onClose?.(); return; }
    if (event.key !== 'Tab') return;
    const elements = focusables(); if (!elements.length) return;
    const first = elements[0]; const last = elements[elements.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  $effect(() => {
    if (!open || typeof document === 'undefined') return;
    restoreElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = requestAnimationFrame(() => focusables()[0]?.focus());
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', handleKeydown);
    return () => { cancelAnimationFrame(frame); document.body.style.overflow = ''; document.removeEventListener('keydown', handleKeydown); restoreElement?.focus(); restoreElement = null; };
  });
</script>

{#if open}
  <div class="fixed inset-0 z-50 bg-[var(--fm-overlay)]" role="presentation" onclick={(event) => { if (closeOnBackdrop && event.target === event.currentTarget) onClose?.(); }}>
    <div bind:this={drawerElement} class={cn('absolute inset-y-0 flex max-h-full flex-col border-[var(--fm-border)] bg-[var(--fm-surface)] shadow-[var(--fm-shadow-overlay)]', positions[side], widths[width], side === 'left' ? 'border-r' : 'border-l', className)} role="dialog" aria-modal="true" aria-labelledby={`${drawerId}-title`} aria-describedby={description ? `${drawerId}-description` : undefined}>
      <header class="flex items-start justify-between gap-4 border-b border-[var(--fm-border)] px-5 py-4"><div><h2 id={`${drawerId}-title`} class="text-base font-semibold">{title}</h2>{#if description}<p id={`${drawerId}-description`} class="mt-1 text-sm text-[var(--fm-text-muted)]">{description}</p>{/if}</div>{#if dismissible}<button class={cn('rounded p-1 text-[var(--fm-text-muted)] hover:bg-[var(--fm-surface-hover)]', focusRing)} type="button" aria-label="关闭" onclick={() => onClose?.()}><X class="size-4" aria-hidden="true" /></button>{/if}</header>
      {#if children}<div class="min-h-0 flex-1 overflow-y-auto p-5">{@render children()}</div>{/if}
      {#if footer}<footer class="flex items-center justify-end gap-2 border-t border-[var(--fm-border)] px-5 py-3">{@render footer()}</footer>{/if}
    </div>
  </div>
{/if}
