<script lang="ts">
  import type { Snippet } from 'svelte';
  import { X } from '@lucide/svelte';
  import { cn, focusRing } from './styles';
  import { isTopOverlay, registerOverlay } from './overlay';

  let {
    open = false,
    title,
    description,
    children,
    footer,
    onClose,
    dismissible = true,
    closeOnBackdrop = true,
    size = 'md',
    class: className = ''
  }: {
    open?: boolean;
    title: string;
    description?: string;
    children?: Snippet;
    footer?: Snippet;
    onClose?: () => void;
    dismissible?: boolean;
    closeOnBackdrop?: boolean;
    size?: 'sm' | 'md' | 'lg' | 'xl';
    class?: string;
  } = $props();

  let dialogElement = $state<HTMLDivElement>();
  let restoreElement: HTMLElement | null = null;
  const overlayToken = {};
  let dialogId = `dialog-${Math.random().toString(36).slice(2, 8)}`;
  const sizeClasses = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl' };

  function focusables() {
    return [...dialogElement?.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? []];
  }

  function handleKeydown(event: KeyboardEvent) {
    if (!isTopOverlay(overlayToken)) return;
    if (event.key === 'Escape' && dismissible) {
      event.preventDefault();
      onClose?.();
      return;
    }
    if (event.key !== 'Tab') return;
    const elements = focusables();
    if (!elements.length) return;
    const first = elements[0];
    const last = elements[elements.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  $effect(() => {
    if (!open || typeof document === 'undefined') return;
    restoreElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = requestAnimationFrame(() => focusables()[0]?.focus());
    const releaseOverlay = registerOverlay(overlayToken);
    document.addEventListener('keydown', handleKeydown);
    return () => {
      cancelAnimationFrame(frame);
      releaseOverlay();
      document.removeEventListener('keydown', handleKeydown);
      restoreElement?.focus();
      restoreElement = null;
    };
  });
</script>

{#if open}
  <div class="fixed inset-0 z-50 grid place-items-center bg-[var(--fm-overlay)] p-4" role="presentation" onclick={(event) => { if (closeOnBackdrop && event.target === event.currentTarget) onClose?.(); }}>
    <div bind:this={dialogElement} class={cn('flex max-h-[min(90dvh,48rem)] w-full flex-col overflow-hidden rounded-[var(--radius-lg)] border border-[var(--fm-border)] bg-[var(--fm-surface)] shadow-[var(--fm-shadow-overlay)]', sizeClasses[size], className)} role="dialog" aria-modal="true" aria-labelledby={`${dialogId}-title`} aria-describedby={description ? `${dialogId}-description` : undefined}>
      <div class="flex items-start justify-between gap-4 border-b border-[var(--fm-border)] px-5 py-4">
        <div><h2 id={`${dialogId}-title`} class="text-base font-semibold text-[var(--fm-text)]">{title}</h2>{#if description}<p id={`${dialogId}-description`} class="mt-1 text-sm text-[var(--fm-text-muted)]">{description}</p>{/if}</div>
        {#if dismissible}<button class={cn('rounded p-1 text-[var(--fm-text-muted)] hover:bg-[var(--fm-surface-hover)] hover:text-[var(--fm-text)]', focusRing)} type="button" aria-label="关闭" onclick={() => onClose?.()}><X class="size-4" aria-hidden="true" /></button>{/if}
      </div>
      {#if children}<div class="min-h-0 flex-1 overflow-y-auto p-5">{@render children()}</div>{/if}
      {#if footer}<footer class="flex items-center justify-end gap-2 border-t border-[var(--fm-border)] px-5 py-3">{@render footer()}</footer>{/if}
    </div>
  </div>
{/if}
