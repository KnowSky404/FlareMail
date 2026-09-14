<script lang="ts">
  import type { Snippet } from 'svelte';
  import { X } from '@lucide/svelte';
  import { cn, focusRing } from './styles';
  import { isTopOverlay, registerOverlay } from './overlay';
  import { useLocale } from '$lib/i18n/runtime.svelte';

  let {
    open = false,
    title,
    children,
    onClose,
    class: className = ''
  }: {
    open?: boolean;
    title: string;
    children?: Snippet;
    onClose?: () => void;
    class?: string;
  } = $props();
  const { t } = useLocale();

  let readerElement = $state<HTMLElement>();
  let restoreElement: HTMLElement | null = null;
  const overlayToken = {};
  const inertTargets: Array<{ element: HTMLElement; hadAttribute: boolean }> = [];
  let readerId = `reader-${Math.random().toString(36).slice(2, 8)}`;

  function focusables() {
    return [...readerElement?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    ) ?? []];
  }

  function handleKeydown(event: KeyboardEvent) {
    if (!isTopOverlay(overlayToken)) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose?.();
      return;
    }
    if (event.key !== 'Tab') return;
    const elements = focusables();
    if (!elements.length) return;
    const first = elements[0];
    const last = elements[elements.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function makeBackgroundInert() {
    if (typeof document === 'undefined') return;
    const candidates = document.querySelectorAll<HTMLElement>('.fm-workspace-shell, .topbar, .mobile-bar');
    for (const element of candidates) {
      if (element === readerElement || (readerElement && element.contains(readerElement))) continue;
      inertTargets.push({ element, hadAttribute: element.hasAttribute('inert') });
      element.setAttribute('inert', '');
    }
  }

  function restoreBackground() {
    for (const { element, hadAttribute } of inertTargets.splice(0)) {
      if (!hadAttribute) element.removeAttribute('inert');
    }
  }

  $effect(() => {
    if (!open || typeof document === 'undefined') return;
    restoreElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    makeBackgroundInert();
    const frame = requestAnimationFrame(() => focusables()[0]?.focus());
    const releaseOverlay = registerOverlay(overlayToken);
    document.addEventListener('keydown', handleKeydown);
    return () => {
      cancelAnimationFrame(frame);
      releaseOverlay();
      document.removeEventListener('keydown', handleKeydown);
      restoreBackground();
      restoreElement?.focus();
      restoreElement = null;
    };
  });
</script>

{#if open}
  <div class="fixed inset-0 z-[80] bg-[var(--fm-overlay)] p-0 sm:p-3" role="presentation" onclick={(event) => { if (event.target === event.currentTarget) onClose?.(); }}>
    <div
      bind:this={readerElement}
      class={cn('flex h-full max-h-full w-full flex-col overflow-hidden bg-[var(--fm-surface)] shadow-[var(--fm-shadow-overlay)] sm:rounded-[var(--radius-lg)] sm:border sm:border-[var(--fm-border)]', className)}
      role="dialog"
      aria-modal="true"
      aria-labelledby={`${readerId}-title`}
    >
      <header class="flex min-h-12 shrink-0 items-center gap-3 border-b border-[var(--fm-border)] px-3 sm:px-5">
        <h2 id={`${readerId}-title`} class="min-w-0 flex-1 truncate text-sm font-semibold text-[var(--fm-text)]">{title}</h2>
        <button class={cn('grid size-11 shrink-0 place-items-center rounded-[var(--radius-md)] text-[var(--fm-text-secondary)] hover:bg-[var(--fm-surface-hover)] hover:text-[var(--fm-text)]', focusRing)} type="button" aria-label={t('reader.close')} title={t('reader.close')} onclick={() => onClose?.()}>
          <X class="size-5" aria-hidden="true" />
        </button>
      </header>
      {#if children}<div class="min-h-0 flex-1">{@render children()}</div>{/if}
    </div>
  </div>
{/if}
