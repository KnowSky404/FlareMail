<script lang="ts">
  import { controlBase, cn } from './styles';

  let {
    value = $bindable(''),
    label,
    hint,
    error,
    id,
    name,
    type = 'text',
    placeholder = '',
    maxlength,
    required = false,
    disabled = false,
    readonly = false,
    autocomplete = undefined,
    class: className = '',
    oninput
  }: {
    value?: string;
    label?: string;
    hint?: string;
    error?: string;
    id?: string;
    name?: string;
    type?: string;
    placeholder?: string;
    maxlength?: number;
    required?: boolean;
    disabled?: boolean;
    readonly?: boolean;
    autocomplete?: string;
    class?: string;
    oninput?: (event: Event & { currentTarget: HTMLInputElement }) => void;
  } = $props();

  const describedBy = $derived([hint ? `${id}-hint` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ') || undefined);

  function handleInput(event: Event & { currentTarget: HTMLInputElement }) {
    value = event.currentTarget.value;
    oninput?.(event);
  }
</script>

<label class="grid gap-1.5" for={id}>
  {#if label}<span class="text-xs font-medium text-[var(--fm-text)]">{label}{#if required}<span class="ml-1 text-[var(--fm-brand-orange)]" aria-hidden="true">*</span>{/if}</span>{/if}
  <input
    {id}
    {name}
    {type}
    {placeholder}
    {maxlength}
    {required}
    {disabled}
    {readonly}
    autocomplete={autocomplete as 'on' | 'off' | undefined}
    {value}
    aria-invalid={error ? 'true' : undefined}
    aria-describedby={describedBy}
    class={cn(controlBase, 'fm-touch-target w-full px-3 py-2', error && 'border-red-400 focus-visible:border-red-500 focus-visible:ring-red-500/25', className)}
    oninput={handleInput}
  />
  {#if error}<span id={`${id}-error`} class="text-xs text-[var(--fm-danger)]" role="alert">{error}</span>{:else if hint}<span id={`${id}-hint`} class="text-xs text-[var(--fm-text-muted)]">{hint}</span>{/if}
</label>
