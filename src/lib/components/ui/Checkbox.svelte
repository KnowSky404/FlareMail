<script lang="ts">
  import { Check } from '@lucide/svelte';
  import { focusRing } from './styles';

  let {
    checked = false,
    label,
    description,
    id,
    name,
    value,
    disabled = false,
    required = false,
    class: className = '',
    onchange
  }: {
    checked?: boolean;
    label?: string;
    description?: string;
    id?: string;
    name?: string;
    value?: string;
    disabled?: boolean;
    required?: boolean;
    class?: string;
    onchange?: (checked: boolean, event: Event) => void;
  } = $props();
</script>

<label class={`flex items-start gap-2.5 text-sm ${disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'} ${className}`} for={id}>
  <span class="relative mt-0.5 grid size-4 shrink-0 place-items-center">
    <input
      class="peer absolute inset-0 z-10 cursor-pointer opacity-0 disabled:cursor-not-allowed"
      type="checkbox"
      {id}
      {name}
      {value}
      {required}
      {disabled}
      {checked}
      aria-describedby={description ? `${id}-description` : undefined}
      onchange={(event) => onchange?.(event.currentTarget.checked, event)}
    />
    <span class="pointer-events-none absolute inset-0 rounded-[3px] border border-[var(--fm-border)] bg-[var(--fm-surface)] transition-colors peer-checked:border-[var(--fm-primary)] peer-checked:bg-[var(--fm-primary)] peer-focus-visible:outline-none peer-focus-visible:ring-2 peer-focus-visible:ring-[var(--fm-focus)]/35">
      {#if checked}<Check class="size-3 text-white" strokeWidth={3} aria-hidden="true" />{/if}
    </span>
  </span>
  {#if label || description}<span class="grid gap-0.5"><span class="font-medium text-[var(--fm-text)]">{label}</span>{#if description}<span id={`${id}-description`} class="text-xs text-[var(--fm-text-muted)]">{description}</span>{/if}</span>{/if}
</label>
