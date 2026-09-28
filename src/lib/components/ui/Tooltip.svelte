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
    disabled?: boolean;
    class?: string;
  } = $props();

  let visible = $state(false);
  let tooltipElement = $state<HTMLSpanElement>();
  let horizontalShift = $state(0);
  let showTimer: ReturnType<typeof setTimeout> | undefined;
  const runtimeId = $props.id();
  const stableId = $derived(id ?? `tooltip-${runtimeId}`);
  const positions = {
    top: 'bottom-full left-1/2 mb-2 -translate-x-1/2',
    right: 'left-full top-1/2 ml-2 -translate-y-1/2',
    bottom: 'left-1/2 top-full mt-2 -translate-x-1/2',
    left: 'right-full top-1/2 mr-2 -translate-y-1/2'
  };

  onMount(() => {
    window.addEventListener('resize', keepWithinViewport);
    return () => {
      if (showTimer !== undefined) clearTimeout(showTimer);
      releaseTooltip(hide);
      window.removeEventListener('resize', keepWithinViewport);
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
      void keepWithinViewport();
    }, 250);
  }

  function hide() {
    if (showTimer !== undefined) clearTimeout(showTimer);
    showTimer = undefined;
    visible = false;
    horizontalShift = 0;
    releaseTooltip(hide);
  }

  async function keepWithinViewport() {
    if (!visible || (side !== 'top' && side !== 'bottom')) return;
    horizontalShift = 0;
    await tick();
    if (!visible || !tooltipElement) return;
    const bounds = tooltipElement.getBoundingClientRect();
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
  <span bind:this={tooltipElement} id={stableId} role="tooltip" hidden={!visible} style:margin-left={horizontalShift ? `${horizontalShift}px` : undefined} class={cn('pointer-events-none absolute z-50 w-max max-w-[min(20rem,calc(100vw-1rem))] break-words rounded-[var(--radius-sm)] bg-[var(--fm-text)] px-2 py-1 text-[11px] leading-4 text-[var(--fm-text-inverse)] shadow-lg', positions[side])}>
    {content}
  </span>
</span>
