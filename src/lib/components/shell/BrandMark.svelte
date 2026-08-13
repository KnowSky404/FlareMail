<script lang="ts">
  import Flame from '@lucide/svelte/icons/flame';

  let { compact = false }: { compact?: boolean } = $props();
</script>

<span class="brand" role="img" aria-label="FlareMail">
  <span class="mark" aria-hidden="true"><Flame size={compact ? 18 : 20} strokeWidth={2.2} /></span>
  {#if !compact}<span class="wordmark">FlareMail</span>{/if}
</span>

<style>
  .brand {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
    color: var(--fm-text);
    font-size: 17px;
    font-weight: 700;
    line-height: 1;
    letter-spacing: -0.025em;
  }

  .mark {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 30px;
    flex: none;
    border: 1px solid color-mix(in srgb, var(--fm-brand-orange) 42%, var(--fm-border));
    border-radius: var(--radius-md);
    color: var(--fm-brand-orange-strong);
    background: var(--fm-brand-orange-soft);
  }

  .wordmark {
    white-space: nowrap;
  }
</style>
