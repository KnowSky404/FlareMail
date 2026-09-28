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
    disabled = false,
    class: className = ''
  }: {
    content: string;
    /** Render the real focusable trigger and receive the stable described-by id. */
    trigger?: Snippet<[string]>;
    /** Legacy fallback for non-interactive content. Prefer `trigger` for controls. */
    children?: Snippet;
    id?: string;
    side?: 'top' | 'right' | 'bottom' | 'left';
    /** Escape an ancestor's scroll clipping without moving the trigger. */
    floating?: boolean;
    disabled?: boolean;
    class?: string;
  } = $props();

  let visible = $state(false);
  let triggerElement = $state<HTMLSpanElement>();
  let tooltipElement = $state<HTMLSpanElement>();
  let horizontalShift = $state(0);
  let floatingTop = $state(0);
  let floatingLeft = $state(0);
  let showTimer: ReturnType<typeof setTimeout> | undefined;
  let listening = false;
  const runtimeId = $props.id();
  const stableId = $derived(id ?? `tooltip-${runtimeId}`);
  const positions = {
    top: 'bottom-full left-1/2 mb-2 -translate-x-1/2',
    right: 'left-full top-1/2 ml-2 -translate-y-1/2',
    bottom: 'left-1/2 top-full mt-2 -translate-x-1/2',
    left: 'right-full top-1/2 mr-2 -translate-y-1/2'
  };

  onMount(() => {
    return () => {
      if (showTimer !== undefined) clearTimeout(showTimer);
      removeViewportListeners();
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
      addViewportListeners();
      void keepWithinViewport();
    }, 250);
  }

  function addViewportListeners() {
    if (listening) return;
    window.addEventListener('resize', keepWithinViewport);
    if (floating) window.addEventListener('scroll', handleScroll, true);
    listening = true;
  }

  function removeViewportListeners() {
    if (!listening) return;
    window.removeEventListener('resize', keepWithinViewport);
    if (floating) window.removeEventListener('scroll', handleScroll, true);
    listening = false;
  }

  function hide() {
    if (showTimer !== undefined) clearTimeout(showTimer);
    showTimer = undefined;
    visible = false;
    horizontalShift = 0;
    removeViewportListeners();
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
      const left = side === 'right' ? triggerBounds.right + 8
        : side === 'left' ? triggerBounds.left - bounds.width - 8
          : triggerBounds.left + (triggerBounds.width - bounds.width) / 2;
      const top = side === 'bottom' ? triggerBounds.bottom + 8
        : side === 'top' ? triggerBounds.top - bounds.height - 8
          : triggerBounds.top + (triggerBounds.height - bounds.height) / 2;
      floatingLeft = Math.max(8, Math.min(window.innerWidth - bounds.width - 8, left));
      floatingTop = Math.max(8, Math.min(window.innerHeight - bounds.height - 8, top));
      return;
    }
    if (side !== 'top' && side !== 'bottom') return;
    horizontalShift = Math.max(8 - bounds.left, Math.min(0, window.innerWidth - 8 - bounds.right));
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape' && visible) {
      event.preventDefault();
      hide();
    }
  }
</script>

<span
  bind:this={triggerElement}
  role="presentation"
  class={cn('relative inline-flex min-w-0', className)}
  onpointerenter={show}
  onpointerleave={hide}
  onfocusin={show}
  onfocusout={(event) => {
    if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null)) hide();
  }}
  onkeydown={handleKeydown}
>
  {#if trigger}
    {@render trigger(stableId)}
  {:else if children}
    <span>{@render children()}</span>
  {/if}
  <span bind:this={tooltipElement} id={stableId} role="tooltip" hidden={!visible} style:top={floating ? `${floatingTop}px` : undefined} style:left={floating ? `${floatingLeft}px` : undefined} style:margin-left={horizontalShift ? `${horizontalShift}px` : undefined} class={cn('pointer-events-none z-50 w-max max-w-[min(20rem,calc(100vw-1rem))] break-words rounded-[var(--radius-sm)] bg-[var(--fm-text)] px-2 py-1 text-[11px] leading-4 text-[var(--fm-text-inverse)] shadow-lg', floating ? 'fixed' : `absolute ${positions[side]}`)}>
    {content}
  </span>
</span>
