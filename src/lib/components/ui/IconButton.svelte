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
    class?: string;
    onclick?: (event: MouseEvent) => void;
  } = $props();
</script>

<button
  type="button"
  class={buttonClass(variant, size, `aspect-square !px-0 ${className}`)}
  {title}
  aria-label={ariaLabel}
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
