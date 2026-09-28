<script lang="ts">
  import type { Snippet } from 'svelte';
  import { LoaderCircle } from '@lucide/svelte';
  import { buttonClass, cn, type ButtonVariant, type ControlSize } from './styles';
  import Tooltip from './Tooltip.svelte';

  let {
    children,
    id,
    ariaLabel,
    title,
    variant = 'ghost',
    size = 'md',
    disabled = false,
    loading = false,
    ariaPressed,
    ariaExpanded,
    ariaControls,
    ariaDescribedBy,
    tooltipSide = 'bottom',
    containerClass = '',
    touchTarget = true,
    class: className = '',
    onclick
  }: {
    children?: Snippet;
    id?: string;
    ariaLabel: string;
    title?: string;
    variant?: ButtonVariant;
    size?: ControlSize;
    disabled?: boolean;
    loading?: boolean;
    ariaPressed?: boolean;
    ariaExpanded?: boolean;
    ariaControls?: string;
    ariaDescribedBy?: string;
    tooltipSide?: 'top' | 'right' | 'bottom' | 'left';
    containerClass?: string;
    touchTarget?: boolean;
    class?: string;
    onclick?: (event: MouseEvent) => void;
  } = $props();
</script>

<Tooltip content={title ?? ariaLabel} side={tooltipSide} class={cn('shrink-0', containerClass)}>
  {#snippet trigger(tooltipId)}
    <button
      {id}
      type="button"
      class={buttonClass(variant, size, `${touchTarget ? '' : '!min-h-0 !min-w-0'} aspect-square !px-0 ${className}`)}
      aria-label={ariaLabel}
      aria-pressed={ariaPressed}
      aria-expanded={ariaExpanded}
      aria-controls={ariaControls}
      aria-describedby={[ariaDescribedBy, tooltipId].filter(Boolean).join(' ') || undefined}
      aria-busy={loading}
      disabled={disabled || loading}
      {onclick}
    >
      {#if loading}
        <LoaderCircle class="size-4 animate-spin" aria-hidden="true" />
      {:else if children}
        {@render children()}
      {/if}
    </button>
  {/snippet}
</Tooltip>
