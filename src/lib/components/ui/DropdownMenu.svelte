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
    contentRole = 'menu',
    id = 'menu',
    triggerAriaLabel,
    triggerTitle,
    triggerClass = '',
    showChevron = true,
    class: className = ''
  }: {
    trigger: Snippet;
    children?: Snippet;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    align?: 'start' | 'end';
    contentRole?: 'menu' | 'dialog';
    id?: string;
    triggerAriaLabel?: string;
    triggerTitle?: string;
    triggerClass?: string;
    showChevron?: boolean;
    class?: string;
  } = $props();

  let rootElement = $state<HTMLDivElement>();
  let menuElement = $state<HTMLDivElement>();
  let triggerElement = $state<HTMLButtonElement>();
  let internalOpen = $state(false);
  const isOpen = $derived(onOpenChange ? open : internalOpen);
  const contentId = $derived(`${id}-content`);

  const items = () =>
    [...menuElement?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []].filter(
      (item) => !item.hasAttribute('disabled') && item.getAttribute('aria-disabled') !== 'true'
    );

  function focusItem(index: number) {
    const current = items();
    if (!current.length) return;
    current[(index + current.length) % current.length]?.focus({ preventScroll: true });
  }

  function closeMenu() {
    setOpen(false);
    requestAnimationFrame(() => triggerElement?.focus({ preventScroll: true }));
  }

  function setOpen(next: boolean) {
    if (onOpenChange) onOpenChange(next);
    else internalOpen = next;
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeMenu();
      return;
    }

    if (contentRole !== 'menu') return;
    const current = items();
    const index = current.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusItem(index + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      focusItem(index - 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      focusItem(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      focusItem(-1);
    }
  }

  function handleTriggerKeydown(event: KeyboardEvent) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    setOpen(true);
  }

  function handleContentClick(event: MouseEvent) {
    if (contentRole !== 'menu') return;
    if ((event.target as HTMLElement).closest('[role="menuitem"]')) closeMenu();
  }

  $effect(() => {
    if (!isOpen || typeof document === 'undefined' || !menuElement) return;

    const frame = requestAnimationFrame(() => {
      if (contentRole === 'menu') focusItem(0);
      else {
        menuElement?.querySelector<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled])')?.focus({ preventScroll: true });
      }
    });
    const handleOutsidePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && !rootElement?.contains(target)) closeMenu();
    };
    document.addEventListener('pointerdown', handleOutsidePointerDown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('pointerdown', handleOutsidePointerDown);
    };
  });
</script>

<div bind:this={rootElement} class={cn('relative inline-block', className)}>
  <button
    bind:this={triggerElement}
    type="button"
    aria-haspopup={contentRole}
    aria-expanded={isOpen}
    aria-controls={contentId}
    aria-label={triggerAriaLabel}
    title={triggerTitle}
    class={cn('fm-menu-trigger fm-touch-target inline-flex items-center justify-center gap-1', focusRing, triggerClass)}
    onclick={() => setOpen(!isOpen)}
    onkeydown={handleTriggerKeydown}
  >
    {@render trigger()}
    {#if showChevron}
      <ChevronDown class={cn('size-3.5 transition-transform', isOpen && 'rotate-180')} aria-hidden="true" />
    {/if}
  </button>
  {#if isOpen}
    <div
      bind:this={menuElement}
      id={contentId}
      class={cn('absolute top-[calc(100%+0.375rem)] z-40 max-h-[min(70dvh,28rem)] min-w-44 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-[var(--radius-lg)] border border-[var(--fm-border)] bg-[var(--fm-surface)] p-1 shadow-[var(--fm-shadow-overlay)]', align === 'end' ? 'right-0' : 'left-0')}
      role={contentRole}
      aria-label={contentRole === 'dialog' ? triggerAriaLabel : undefined}
      tabindex="-1"
      onclick={handleContentClick}
      onkeydown={handleKeydown}
    >
      {#if children}{@render children()}{/if}
    </div>
  {/if}
</div>
