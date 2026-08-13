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
    class?: string;
    ariaLabel?: string;
    onclick?: (event: MouseEvent) => void;
  } = $props();
</script>

<button
  {type}
  class={buttonClass(variant, size, className)}
  disabled={disabled || loading}
  aria-label={ariaLabel}
  aria-busy={loading}
  {onclick}
>
  {#if loading}
    <LoaderCircle class="size-4 animate-spin" aria-hidden="true" />
  {/if}
  {#if children}{@render children()}{/if}
</button>
