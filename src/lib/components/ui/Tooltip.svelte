<script lang="ts">
  import type { Snippet } from 'svelte';
  import { cn } from './styles';

  let {
    content,
    trigger,
    children,
    id,
    side = 'top',
    class: className = ''
  }: {
    content: string;
    /** Render the real focusable trigger and receive the stable described-by id. */
    trigger?: Snippet<[string]>;
    /** Legacy fallback for non-interactive content. Prefer `trigger` for controls. */
    children?: Snippet;
    id?: string;
    side?: 'top' | 'right' | 'bottom' | 'left';
    class?: string;
  } = $props();

  let visible = $state(false);
  let showTimer: ReturnType<typeof setTimeout> | undefined;
  const stableId = $derived(id ?? `tooltip-${stableHash(content)}`);
  const positions = {
    top: 'bottom-full left-1/2 mb-2 -translate-x-1/2',
    right: 'left-full top-1/2 ml-2 -translate-y-1/2',
    bottom: 'left-1/2 top-full mt-2 -translate-x-1/2',
    left: 'right-full top-1/2 mr-2 -translate-y-1/2'
  };

  function stableHash(value: string) {
    let hash = 0;
    for (let index = 0; index < value.length; index += 1) hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
    return hash.toString(36);
  }

  function show() {
    if (showTimer !== undefined) clearTimeout(showTimer);
    showTimer = setTimeout(() => (visible = true), 250);
  }

  function hide() {
    if (showTimer !== undefined) clearTimeout(showTimer);
    showTimer = undefined;
    visible = false;
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
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
  {#if visible}
    <span id={stableId} role="tooltip" class={cn('pointer-events-none absolute z-50 max-w-[min(20rem,calc(100vw-1rem))] rounded-[var(--radius-sm)] bg-[var(--fm-text)] px-2 py-1 text-[11px] leading-4 text-[var(--fm-text-inverse)] shadow-lg', positions[side])}>
      {content}
    </span>
  {/if}
</span>
