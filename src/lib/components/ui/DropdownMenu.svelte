<script lang="ts">
  import type { Snippet } from 'svelte';
  import { ChevronDown } from '@lucide/svelte';
  import { cn, focusRing } from './styles';
  import Tooltip from './Tooltip.svelte';

  let {
    trigger: triggerContent,
    children,
    open = false,
    onOpenChange,
    align = 'start',
    contentRole = 'menu',
    id = 'menu',
    triggerAriaLabel,
    triggerTitle,
    triggerClass = '',
    initialFocusSelector,
    viewportAware = false,
    restoreFocusOnClose = true,
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
    initialFocusSelector?: string;
    /** Keep this popover inside the viewport, including in clipped readers. */
    viewportAware?: boolean;
    /** Set false when selecting an item immediately opens another overlay. */
    restoreFocusOnClose?: boolean;
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
    const modalSelector = '[role="dialog"][aria-modal="true"]';
    // Keep the overlays that were already present separate from one opened by
    // the menu item in this event turn. Existing parent/stacked dialogs must
    // not prevent returning focus to a trigger inside the current dialog.
    const existingModals = new Set([...document.querySelectorAll<HTMLElement>(modalSelector)]);
    const triggerModal = triggerElement?.closest<HTMLElement>(modalSelector) ?? null;
    setOpen(false);
    if (!restoreFocusOnClose) return;
    requestAnimationFrame(() => {
      const activeModal = document.activeElement instanceof HTMLElement
        ? document.activeElement.closest<HTMLElement>(modalSelector)
        : null;
      const openedModal = [...document.querySelectorAll<HTMLElement>(modalSelector)]
        .some((modal) => !existingModals.has(modal));
      // A newly opened or currently focused different modal owns focus. An
      // existing dialog containing this menu is the valid restoration target.
      if (openedModal || (activeModal && activeModal !== triggerModal)) return;
      triggerElement?.focus({ preventScroll: true });
    });
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

  function positionInViewport() {
    if (!menuElement || !triggerElement) return;
    const viewport = window.visualViewport;
    const margin = 8;
    const gap = 6;
    const viewportTop = (viewport?.offsetTop ?? 0) + margin;
    const viewportLeft = (viewport?.offsetLeft ?? 0) + margin;
    const viewportWidth = viewport?.width ?? window.innerWidth;
    const viewportHeight = viewport?.height ?? window.innerHeight;
    const viewportRight = viewportLeft + viewportWidth - margin * 2;
    const viewportBottom = viewportTop + viewportHeight - margin * 2;
    const trigger = triggerElement.getBoundingClientRect();
    const below = Math.max(0, viewportBottom - Math.max(viewportTop, trigger.bottom + gap));
    const above = Math.max(0, Math.min(viewportBottom, trigger.top - gap) - viewportTop);
    const naturalHeight = menuElement.scrollHeight + menuElement.offsetHeight - menuElement.clientHeight;
    const preferredHeight = Math.min(naturalHeight, viewportHeight * 0.7, 28 * parseFloat(getComputedStyle(document.documentElement).fontSize));
    const openAbove = below < preferredHeight && above > below;
    const availableHeight = openAbove ? above : below;

    menuElement.style.right = 'auto';
    menuElement.style.maxWidth = `${Math.max(0, viewportWidth - margin * 2)}px`;
    menuElement.style.maxHeight = `min(70dvh, 28rem, ${availableHeight}px)`;
    const menu = menuElement.getBoundingClientRect();
    const preferredLeft = align === 'end' ? trigger.right - menu.width : trigger.left;
    const preferredTop = openAbove ? trigger.top - gap - menu.height : trigger.bottom + gap;
    menuElement.style.left = `${Math.max(viewportLeft, Math.min(viewportRight - menu.width, preferredLeft))}px`;
    menuElement.style.top = `${Math.max(viewportTop, Math.min(viewportBottom - menu.height, preferredTop))}px`;
    // Visibility transitions can leave WebKit descendants temporarily unfocusable.
    menuElement.style.opacity = '1';
    menuElement.style.pointerEvents = 'auto';
  }

  $effect(() => {
    if (!isOpen || typeof document === 'undefined' || !menuElement) return;

    const frame = requestAnimationFrame(() => {
      if (viewportAware) positionInViewport();
      if (contentRole === 'menu') focusItem(0);
      else {
        const preferred = initialFocusSelector ? menuElement?.querySelector<HTMLElement>(initialFocusSelector) : null;
        const fallback = menuElement?.querySelector<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled])');
        (preferred ?? fallback)?.focus({ preventScroll: true });
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

  $effect(() => {
    if (!isOpen || !viewportAware || !menuElement || !triggerElement) return;
    const menu = menuElement;
    const viewport = window.visualViewport;
    let frame = 0;
    const reposition = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(positionInViewport);
    };
    const observer = new ResizeObserver(reposition);
    observer.observe(menu);
    observer.observe(triggerElement);
    menu.addEventListener('toggle', reposition, true);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    viewport?.addEventListener('resize', reposition);
    viewport?.addEventListener('scroll', reposition);
    reposition();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      menu.removeEventListener('toggle', reposition, true);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
      viewport?.removeEventListener('resize', reposition);
      viewport?.removeEventListener('scroll', reposition);
    };
  });
</script>

<div bind:this={rootElement} class={cn('relative inline-block', className)}>
  <Tooltip content={triggerTitle ?? triggerAriaLabel ?? ''} side="bottom" disabled={isOpen}>
    {#snippet trigger(tooltipId)}
      <button
        bind:this={triggerElement}
        type="button"
        aria-haspopup={contentRole}
        aria-expanded={isOpen}
        aria-controls={contentId}
        aria-label={triggerAriaLabel}
        aria-describedby={tooltipId}
        class={cn('fm-menu-trigger fm-touch-target inline-flex items-center justify-center gap-1', focusRing, triggerClass)}
        onclick={() => setOpen(!isOpen)}
        onkeydown={handleTriggerKeydown}
      >
        {@render triggerContent()}
        {#if showChevron}
          <ChevronDown class={cn('size-3.5 transition-transform', isOpen && 'rotate-180')} aria-hidden="true" />
        {/if}
      </button>
    {/snippet}
  </Tooltip>
  {#if isOpen}
    <div
      bind:this={menuElement}
      id={contentId}
      class={cn('absolute top-[calc(100%+0.375rem)] z-40 max-h-[min(70dvh,28rem)] min-w-44 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-[var(--radius-lg)] border border-[var(--fm-border)] bg-[var(--fm-surface)] p-1 shadow-[var(--fm-shadow-overlay)]', align === 'end' ? 'right-0' : 'left-0')}
      style:position={viewportAware ? 'fixed' : undefined}
      style:opacity={viewportAware ? 0 : undefined}
      style:pointer-events={viewportAware ? 'none' : undefined}
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
