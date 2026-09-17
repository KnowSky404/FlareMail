<script lang="ts">
  import type { Snippet } from 'svelte';
  import { LoaderCircle } from '@lucide/svelte';
  import { buttonClass, type ButtonVariant, type ControlSize } from './styles';

  let {
    children,
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
    touchTarget = true,
    class: className = '',
    onclick
  }: {
    children?: Snippet;
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
    touchTarget?: boolean;
    class?: string;
    onclick?: (event: MouseEvent) => void;
  } = $props();
</script>

<button
  type="button"
  class={buttonClass(variant, size, `${touchTarget ? '' : '!min-h-0 !min-w-0'} aspect-square !px-0 ${className}`)}
  {title}
  aria-label={ariaLabel}
  aria-pressed={ariaPressed}
  aria-expanded={ariaExpanded}
  aria-controls={ariaControls}
  aria-describedby={ariaDescribedBy}
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
