<script lang="ts">
  import type { Snippet } from 'svelte';
  import { untrack } from 'svelte';
  import { X } from '@lucide/svelte';
  import { cn, focusRing } from './styles';
  import { isTopOverlay, registerOverlay, renderedFocusables } from './overlay';
  import { useLocale } from '$lib/i18n/runtime.svelte';

  type FocusTarget = HTMLElement | string | (() => HTMLElement | null | undefined) | null | undefined;
  type FocusQueryRoot = Pick<ParentNode, 'querySelector'>;

  let {
    open = false,
    title,
    description,
    id,
    children,
    footer,
    onClose,
    dismissible = true,
    closeOnBackdrop = true,
    initialFocus,
    restoreFocusElement,
    fallbackFocus,
    size = 'md',
    class: className = ''
  }: {
    open?: boolean;
    title: string;
    description?: string;
    id?: string;
    children?: Snippet;
    footer?: Snippet;
    onClose?: () => void;
    dismissible?: boolean;
    closeOnBackdrop?: boolean;
    /** Focus a specific control when the dialog opens, by element or selector. */
    initialFocus?: FocusTarget;
    /** Restore focus to the control that opened the dialog when it closes. */
    restoreFocusElement?: HTMLElement | null;
    /** Focus this control when the restore target is gone or no longer usable. */
    fallbackFocus?: FocusTarget;
    size?: 'sm' | 'md' | 'lg' | 'xl';
    class?: string;
  } = $props();
  const { t } = useLocale();

  let dialogElement = $state<HTMLDivElement>();
  let restoreElement: HTMLElement | null = null;
  const overlayToken = {};
  const stableId = (value: string) => {
    let hash = 0;
    for (const character of value) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
    return hash.toString(36);
  };
  const dialogId = $derived(id ?? `dialog-${stableId(title)}`);
  const sizeClasses = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl' };

  function focusables() {
    return renderedFocusables(dialogElement);
  }

  function resolveFocusTarget(target: FocusTarget, root?: FocusQueryRoot): HTMLElement | null {
    if (!target) return null;
    if (typeof target === 'function') return target() ?? null;
    if (typeof target !== 'string') return target;
    try {
      return (root ?? document).querySelector<HTMLElement>(target);
    } catch {
      return null;
    }
  }

  function focusTarget(target: FocusTarget, root?: FocusQueryRoot) {
    const element = resolveFocusTarget(target, root);
    if (!element?.isConnected || element.hidden || element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true' || element.closest('[inert]')) return false;
    if (typeof getComputedStyle === 'function') {
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
    }
    if (typeof element.getClientRects === 'function' && element.getClientRects().length === 0) return false;
    element.focus({ preventScroll: true });
    return document.activeElement === element;
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
    if (!elements.length) {
      event.preventDefault();
      dialogElement?.focus({ preventScroll: true });
      return;
    }
    const first = elements[0];
    const last = elements[elements.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    else if (document.activeElement === dialogElement || !dialogElement?.contains(document.activeElement)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus({ preventScroll: true });
    }
  }

  $effect(() => {
    if (!open || typeof document === 'undefined') return;
    return untrack(() => {
      restoreElement = restoreFocusElement?.isConnected
        ? restoreFocusElement
        : document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const frame = requestAnimationFrame(() => {
        if (focusTarget(initialFocus, dialogElement)) return;
        const first = focusables()[0];
        if (first) first.focus({ preventScroll: true });
        else dialogElement?.focus({ preventScroll: true });
      });
      const releaseOverlay = registerOverlay(overlayToken);
      document.addEventListener('keydown', handleKeydown);
      return () => {
        cancelAnimationFrame(frame);
        releaseOverlay();
        document.removeEventListener('keydown', handleKeydown);
        focusTarget(restoreElement) || focusTarget(fallbackFocus);
        restoreElement = null;
      };
    });
  });
</script>

{#if open}
  <div class="fixed inset-0 z-50 grid place-items-center bg-[var(--fm-overlay)] p-2 sm:p-4" role="presentation" onclick={(event) => { if (closeOnBackdrop && event.target === event.currentTarget) onClose?.(); }}>
    <div id={dialogId} bind:this={dialogElement} tabindex="-1" class={cn('flex max-h-[min(94dvh,48rem)] w-full flex-col overflow-hidden rounded-[var(--radius-lg)] border border-[var(--fm-border)] bg-[var(--fm-surface)] shadow-[var(--fm-shadow-overlay)]', sizeClasses[size], className)} role="dialog" aria-modal="true" aria-labelledby={`${dialogId}-title`} aria-describedby={description ? `${dialogId}-description` : undefined}>
      <div class="flex min-w-0 flex-none items-start justify-between gap-3 border-b border-[var(--fm-border)] px-4 py-3 sm:gap-4 sm:px-5 sm:py-4">
        <div class="min-w-0 [overflow-wrap:anywhere]"><h2 id={`${dialogId}-title`} class="break-words text-base font-semibold text-[var(--fm-text)]">{title}</h2>{#if description}<p id={`${dialogId}-description`} class="mt-1 break-words text-sm text-[var(--fm-text-muted)]">{description}</p>{/if}</div>
        {#if dismissible}<button class={cn('fm-touch-target grid size-8 shrink-0 place-items-center rounded text-[var(--fm-text-muted)] hover:bg-[var(--fm-surface-hover)] hover:text-[var(--fm-text)]', focusRing)} type="button" aria-label={t('common.close')} onclick={() => onClose?.()}><X class="size-4" aria-hidden="true" /></button>{/if}
      </div>
      {#if children}<div class="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 sm:p-5">{@render children()}</div>{/if}
      {#if footer}<footer class="flex flex-none flex-wrap items-center justify-end gap-2 border-t border-[var(--fm-border)] px-4 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] sm:px-5 sm:py-3 sm:pb-3">{@render footer()}</footer>{/if}
    </div>
  </div>
{/if}
