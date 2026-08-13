<script lang="ts">
  import { focusRing } from './styles';

  let {
    checked = false,
    label,
    description,
    id,
    disabled = false,
    class: className = '',
    onchange
  }: {
    checked?: boolean;
    label?: string;
    description?: string;
    id?: string;
    disabled?: boolean;
    class?: string;
    onchange?: (checked: boolean, event: MouseEvent) => void;
  } = $props();
</script>

<button
  type="button"
  role="switch"
  aria-checked={checked}
  aria-labelledby={label && id ? `${id}-label` : undefined}
  aria-describedby={description && id ? `${id}-description` : undefined}
  {id}
  {disabled}
  class={`flex items-center gap-3 text-left ${disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'} ${className}`}
  onclick={(event) => onchange?.(!checked, event)}
>
  <span class={`relative inline-flex h-5 w-9 shrink-0 rounded-full p-0.5 transition-colors ${checked ? 'bg-[var(--fm-primary)]' : 'bg-[var(--fm-border-strong)]'} ${focusRing}`} aria-hidden="true">
    <span class={`size-4 rounded-full bg-white shadow-sm transition-transform ${checked ? 'translate-x-4' : 'translate-x-0'}`}></span>
  </span>
  {#if label || description}<span class="grid gap-0.5"><span id={`${id}-label`} class="text-sm font-medium text-[var(--fm-text)]">{label}</span>{#if description}<span id={`${id}-description`} class="text-xs text-[var(--fm-text-muted)]">{description}</span>{/if}</span>{/if}
</button>
