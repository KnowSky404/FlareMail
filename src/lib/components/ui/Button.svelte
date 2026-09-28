<script lang="ts">
  import type { Snippet } from 'svelte';
  import { LoaderCircle } from '@lucide/svelte';
  import { buttonClass, type ButtonVariant, type ControlSize, cn } from './styles';

  let {
    children,
    type = 'button',
    variant = 'primary',
    size = 'md',
    disabled = false,
    loading = false,
    id,
    ariaExpanded,
    ariaControls,
    class: className = '',
    ariaLabel,
    onclick
  }: {
    children?: Snippet;
    type?: 'button' | 'submit' | 'reset';
    variant?: ButtonVariant;
    size?: ControlSize;
    disabled?: boolean;
    loading?: boolean;
    id?: string;
    ariaExpanded?: boolean;
    ariaControls?: string;
    class?: string;
    ariaLabel?: string;
    onclick?: (event: MouseEvent) => void;
  } = $props();
</script>

<button
  {id}
  {type}
  class={buttonClass(variant, size, className)}
  disabled={disabled || loading}
  aria-label={ariaLabel}
  aria-expanded={ariaExpanded}
  aria-controls={ariaControls}
  aria-busy={loading}
  {onclick}
>
  {#if loading}
    <LoaderCircle class="size-4 animate-spin" aria-hidden="true" />
  {/if}
  {#if children}{@render children()}{/if}
</button>
