<script lang="ts">
  let { compact = false }: { compact?: boolean } = $props();
</script>

<span class="brand" role="img" aria-label="FlareMail">
  <svg class:compact class="mark" viewBox="0 0 64 64" aria-hidden="true">
    <path d="M8 36 32 52l24-16v14c0 5.5-4.5 10-10 10H18C12.5 60 8 55.5 8 50V36Z" />
    <path d="M33 4c2 8-2 14-10 20-8 6-11 12-6 18l11 7c-2-7 0-12 6-17 9-7 11-18-1-28Z" />
    <path d="M40 19c5 6 7 13 4 19-2 5-7 9-12 12-1-6 1-11 6-15 5-5 5-10 2-16Z" />
  </svg>
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
    display: block;
    width: 32px;
    height: 32px;
    flex: none;
    fill: var(--fm-brand-orange);
  }

  .mark.compact {
    width: 28px;
    height: 28px;
  }

  .wordmark {
    white-space: nowrap;
  }
</style>
