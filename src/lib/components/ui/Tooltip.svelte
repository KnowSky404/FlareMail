<script lang="ts">
  import { onMount, tick, type Snippet } from 'svelte';
  import { cn } from './styles';
  import { claimTooltip, releaseTooltip } from './tooltip-coordinator';

  let {
    content,
    trigger,
    children,
    id,
    side = 'top',
    floating = false,
    hoverable = false,
    disabled = false,
    containEscape = false,
    class: className = ''
  }: {
    content: string;
    /** Receive the described-by id and a callback for explicit activation. */
    trigger?: Snippet<[string, () => void]>;
    /** Legacy fallback for non-interactive content. Prefer `trigger` for controls. */
    children?: Snippet;
    id?: string;
    side?: 'top' | 'right' | 'bottom' | 'left';
    /** Escape an ancestor's scroll clipping without moving the trigger. */
    floating?: boolean;
    hoverable?: boolean;
    disabled?: boolean;
    /** Keep Escape within an explanatory control instead of closing its reader. */
    containEscape?: boolean;
    class?: string;
  } = $props();

  let visible = $state(false);
  let triggerElement = $state<HTMLSpanElement>();
  let tooltipElement = $state<HTMLSpanElement>();
  let horizontalShift = $state(0);
  let floatingTop = $state(0);
  let floatingLeft = $state(0);
  let floatingSide = $state<'top' | 'bottom' | null>(null);
  let floatingMaxHeight = $state<number | undefined>();
  let showTimer: ReturnType<typeof setTimeout> | undefined;
  let listening = false;
  let hovered = false;
  let focused = false;
  const runtimeId = $props.id();
  const stableId = $derived(id ?? `tooltip-${runtimeId}`);
  const positions = {
    top: 'bottom-full left-1/2 -translate-x-1/2',
    right: 'left-full top-1/2 -translate-y-1/2',
    bottom: 'left-1/2 top-full -translate-x-1/2',
    left: 'right-full top-1/2 -translate-y-1/2'
  };
  const margins = { top: 'mb-2', right: 'ml-2', bottom: 'mt-2', left: 'mr-2' };
  // A transparent border keeps the space before the text inside the hover target.
  const hoverBorders = { top: 'border-b-8', right: 'border-l-8', bottom: 'border-t-8', left: 'border-r-8' };

  onMount(() => {
    return () => {
      if (showTimer !== undefined) clearTimeout(showTimer);
      removeTooltipListeners();
      releaseTooltip(hide);
    };
  });

  $effect(() => {
    if (disabled) hide();
  });

  function show() {
    if (disabled) return;
    claimTooltip(hide);
    if (showTimer !== undefined) clearTimeout(showTimer);
    showTimer = setTimeout(() => {
      showTimer = undefined;
      visible = true;
      addTooltipListeners();
      void keepWithinViewport();
    }, 250);
  }

  function addTooltipListeners() {
    if (listening) return;
    window.addEventListener('resize', keepWithinViewport);
    if (floating) window.addEventListener('scroll', handleScroll, true);
    if (hoverable) window.addEventListener('keydown', handleKeydown, true);
    listening = true;
  }

  function removeTooltipListeners() {
    if (!listening) return;
    window.removeEventListener('resize', keepWithinViewport);
    if (floating) window.removeEventListener('scroll', handleScroll, true);
    if (hoverable) window.removeEventListener('keydown', handleKeydown, true);
    listening = false;
  }

  function hide() {
    if (showTimer !== undefined) clearTimeout(showTimer);
    showTimer = undefined;
    visible = false;
    horizontalShift = 0;
    removeTooltipListeners();
    releaseTooltip(hide);
  }

  function triggerInScrollport() {
    if (!triggerElement) return false;
    const bounds = triggerElement.getBoundingClientRect();
    for (let ancestor = triggerElement.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      if (!/(auto|scroll|hidden|clip)/u.test(`${style.overflowX} ${style.overflowY}`)) continue;
      const clip = ancestor.getBoundingClientRect();
      if (bounds.bottom <= clip.top || bounds.top >= clip.bottom || bounds.right <= clip.left || bounds.left >= clip.right) return false;
    }
    return bounds.bottom > 0 && bounds.top < window.innerHeight && bounds.right > 0 && bounds.left < window.innerWidth;
  }

  function handleScroll() {
    if (!visible) return;
    if (!triggerInScrollport()) hide();
    else void keepWithinViewport();
  }

  async function keepWithinViewport() {
    if (!visible) return;
    horizontalShift = 0;
    await tick();
    if (!visible || !tooltipElement) return;
    if (floating && !triggerInScrollport()) {
      hide();
      return;
    }
    const bounds = tooltipElement.getBoundingClientRect();
    if (floating && triggerElement) {
      const triggerBounds = triggerElement.getBoundingClientRect();
      const gap = hoverable ? 0 : 8;
      const left = side === 'right' ? triggerBounds.right + gap
        : side === 'left' ? triggerBounds.left - bounds.width - gap
          : triggerBounds.left + (triggerBounds.width - bounds.width) / 2;
      let top = triggerBounds.top + (triggerBounds.height - bounds.height) / 2;
      floatingSide = null;
      floatingMaxHeight = undefined;
      if (side === 'top' || side === 'bottom') {
        const above = triggerBounds.top - gap - 8;
        const below = window.innerHeight - triggerBounds.bottom - gap - 8;
        const height = bounds.height + Math.max(0, tooltipElement.scrollHeight - tooltipElement.clientHeight);
        const placeAbove = side === 'top' ? height <= above || above >= below : height > below && above > below;
        floatingSide = placeAbove ? 'top' : 'bottom';
        if (hoverable) floatingMaxHeight = Math.max(0, placeAbove ? above : below);
        top = placeAbove ? triggerBounds.top - gap - Math.min(height, floatingMaxHeight ?? height) : triggerBounds.bottom + gap;
      }
      floatingLeft = Math.max(8, Math.min(window.innerWidth - bounds.width - 8, left));
      floatingTop = Math.max(8, Math.min(window.innerHeight - bounds.height - 8, top));
      return;
    }
    if (side !== 'top' && side !== 'bottom') return;
    horizontalShift = Math.max(8 - bounds.left, Math.min(0, window.innerWidth - 8 - bounds.right));
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key !== 'Escape' || !visible) return;
    const target = event.target instanceof Element ? event.target : null;
    const dialog = target?.closest('[role="dialog"][aria-modal="true"]');
    hide();
    if (target?.closest('[role="menu"]') || (dialog && !dialog.contains(triggerElement ?? null))) return;
    event.preventDefault();
    if (containEscape) event.stopPropagation();
  }
</script>

<span
  bind:this={triggerElement}
  role="presentation"
  class={cn('relative inline-flex min-w-0', className)}
  onpointerenter={() => { hovered = true; show(); }}
  onpointerleave={() => { hovered = false; if (!hoverable || !focused) hide(); }}
  onfocusin={() => { focused = true; show(); }}
  onfocusout={(event) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    focused = false;
    if (!hoverable || !hovered) hide();
  }}
  onkeydown={handleKeydown}
>
  {#if trigger}
    {@render trigger(stableId, show)}
  {:else if children}
    <span>{@render children()}</span>
  {/if}
  <span bind:this={tooltipElement} id={stableId} role="tooltip" hidden={!visible} style:top={floating ? `${floatingTop}px` : undefined} style:left={floating ? `${floatingLeft}px` : undefined} style:max-height={floating && floatingMaxHeight !== undefined ? `${floatingMaxHeight}px` : undefined} style:margin-left={horizontalShift ? `${horizontalShift}px` : undefined} class={cn('z-50 w-max max-w-[min(20rem,calc(100vw-1rem))] break-words rounded-[var(--radius-sm)] bg-[var(--fm-text)] px-2 py-1 text-[11px] leading-4 text-[var(--fm-text-inverse)] shadow-lg', hoverable ? 'pointer-events-auto overflow-y-auto border-transparent bg-clip-padding' : 'pointer-events-none', hoverable && hoverBorders[floating && floatingSide ? floatingSide : side], floating ? 'fixed' : `absolute ${positions[side]}`, !floating && !hoverable && margins[side])}>
    {content}
  </span>
</span>
