<script lang="ts">
  import { ChevronDown } from '@lucide/svelte';
  import { controlBase, cn } from './styles';

  export type SelectOption = { value: string; label: string; disabled?: boolean };

  let {
    options = [],
    value = '',
    label,
    hint,
    error,
    id,
    name,
    required = false,
    disabled = false,
    class: className = '',
    onchange
  }: {
    options?: SelectOption[];
    value?: string;
    label?: string;
    hint?: string;
    error?: string;
    id?: string;
    name?: string;
    required?: boolean;
    disabled?: boolean;
    class?: string;
    onchange?: (value: string, event: Event) => void;
  } = $props();
</script>

<label class="grid gap-1.5" for={id}>
  {#if label}<span class="text-xs font-medium">{label}{#if required}<span class="ml-1 text-[var(--fm-brand-orange)]" aria-hidden="true">*</span>{/if}</span>{/if}
  <span class="relative">
    <select
      {id}
      {name}
      {required}
      {disabled}
      {value}
      aria-invalid={error ? 'true' : undefined}
      class={cn(controlBase, 'w-full appearance-none px-3 py-2 pr-9', error && 'border-red-400 focus-visible:border-red-500 focus-visible:ring-red-500/25', className)}
      onchange={(event) => onchange?.(event.currentTarget.value, event)}
    >
      {#each options as option (option.value)}
        <option value={option.value} disabled={option.disabled}>{option.label}</option>
      {/each}
    </select>
    <ChevronDown class="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-[var(--fm-text-muted)]" aria-hidden="true" />
  </span>
  {#if error}<span class="text-xs text-[var(--fm-danger)]" role="alert">{error}</span>{:else if hint}<span class="text-xs text-[var(--fm-text-muted)]">{hint}</span>{/if}
</label>
