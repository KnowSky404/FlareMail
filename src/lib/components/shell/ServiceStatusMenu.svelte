<script lang="ts">
  import CheckCircle2 from '@lucide/svelte/icons/circle-check-big';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import CircleAlert from '@lucide/svelte/icons/circle-alert';
  import { formatNumber } from '$lib/i18n';
  import { useLocale } from '$lib/i18n/runtime.svelte';

  let {
    runtimeLabel,
    unreadCount,
    draftCount,
    queuedCount,
    delayedCount,
    failedCount,
    bouncedCount,
    complainedCount,
    staleDeliveryCount,
    serviceDegraded
  }: {
    runtimeLabel: string;
    unreadCount: number;
    draftCount: number;
    queuedCount: number;
    delayedCount: number;
    failedCount: number;
    bouncedCount: number;
    complainedCount: number;
    staleDeliveryCount: number;
    serviceDegraded: boolean;
  } = $props();
  const i18n = useLocale();
  const { t } = i18n;

  const healthy = $derived(!serviceDegraded);
  const attentionCount = $derived(delayedCount + failedCount + bouncedCount + complainedCount + staleDeliveryCount);
  let statusElement = $state<HTMLDetailsElement>();
  let summaryElement = $state<HTMLElement>();
  let open = $state(false);

  $effect(() => {
    if (!open || typeof document === 'undefined') return;
    const closeOutside = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && !statusElement?.contains(target)) open = false;
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      open = false;
      summaryElement?.focus({ preventScroll: true });
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  });
</script>

<details bind:this={statusElement} bind:open class="status-menu">
  <summary bind:this={summaryElement} class:degraded={!healthy} aria-label={t('status.view')} aria-controls="service-status-content" title={healthy ? t('status.healthy') : t('status.degraded')}>
    {#if healthy}
      <CheckCircle2 size={16} strokeWidth={2} aria-hidden="true" />
      <span class="sr-only">{t('status.healthy')}</span>
    {:else}
      <CircleAlert size={16} strokeWidth={2} aria-hidden="true" />
      <span class="sr-only">{t('status.degraded')}</span>
      <span class="attention-count" aria-hidden="true">{formatNumber(attentionCount, i18n.locale)}</span>
    {/if}
    <ChevronDown class="chevron" size={14} aria-hidden="true" />
  </summary>

  <div id="service-status-content" class="status-popover" role="region" aria-label={t('status.view')} tabindex="-1">
    <div class="status-heading">
      <strong>{t('status.workspace')}</strong>
      <span class:healthy>{runtimeLabel}</span>
    </div>
    <dl>
      <div><dt>{t('status.unread')}</dt><dd>{formatNumber(unreadCount, i18n.locale)}</dd></div>
      <div><dt>{t('status.drafts')}</dt><dd>{formatNumber(draftCount, i18n.locale)}</dd></div>
      <div><dt>{t('status.queued')}</dt><dd>{formatNumber(queuedCount, i18n.locale)}</dd></div>
      <div><dt>{t('status.delayed')}</dt><dd class:danger={delayedCount > 0}>{formatNumber(delayedCount, i18n.locale)}</dd></div>
      <div><dt>{t('status.failed')}</dt><dd class:danger={failedCount > 0}>{formatNumber(failedCount, i18n.locale)}</dd></div>
      <div><dt>{t('status.bounced')}</dt><dd class:danger={bouncedCount > 0}>{formatNumber(bouncedCount, i18n.locale)}</dd></div>
      <div><dt>{t('status.complained')}</dt><dd class:danger={complainedCount > 0}>{formatNumber(complainedCount, i18n.locale)}</dd></div>
      <div><dt>{t('status.stale')}</dt><dd class:danger={staleDeliveryCount > 0}>{formatNumber(staleDeliveryCount, i18n.locale)}</dd></div>
    </dl>
    <p>{t('status.description')}</p>
  </div>
</details>

<style>
  .status-menu {
    position: relative;
  }

  summary {
    display: inline-flex;
    min-height: 32px;
    min-width: 32px;
    align-items: center;
    justify-content: center;
    gap: 7px;
    padding: 0 8px;
    border: 1px solid var(--fm-border);
    border-radius: var(--radius-md);
    color: var(--fm-text-secondary);
    background: var(--fm-surface);
    cursor: pointer;
    font-size: 13px;
    font-weight: 550;
    list-style: none;
  }

  summary::-webkit-details-marker {
    display: none;
  }

  summary > :global(svg:first-child) {
    color: var(--fm-success);
  }

  summary.degraded > :global(svg:first-child) {
    color: var(--fm-danger);
  }

  .attention-count {
    min-width: 1.1rem;
    color: var(--fm-danger);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    font-weight: 700;
  }

  .status-menu[open] :global(.chevron) {
    transform: rotate(180deg);
  }

  :global(.chevron) {
    transition: transform var(--motion-fast);
  }

  .status-popover {
    position: absolute;
    z-index: 60;
    top: calc(100% + var(--space-2));
    right: 0;
    width: 288px;
    max-height: min(70dvh, 28rem);
    overflow-y: auto;
    padding: var(--space-4);
    border: 1px solid var(--fm-border);
    border-radius: var(--radius-lg);
    background: var(--fm-surface);
    box-shadow: var(--fm-shadow-overlay);
  }

  .status-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    padding-bottom: var(--space-3);
    border-bottom: 1px solid var(--fm-border);
  }

  .status-heading strong {
    font-size: 14px;
  }

  .status-heading span {
    color: var(--fm-text-muted);
    font-size: 12px;
  }

  .status-heading .healthy {
    color: var(--fm-success);
  }

  dl {
    margin: var(--space-3) 0;
  }

  dl div {
    display: flex;
    justify-content: space-between;
    padding: 6px 0;
  }

  dt {
    color: var(--fm-text-secondary);
  }

  dd {
    margin: 0;
    font-variant-numeric: tabular-nums;
    font-weight: 600;
  }

  .danger {
    color: var(--fm-danger);
  }

  p {
    margin: 0;
    color: var(--fm-text-muted);
    font-size: 12px;
    line-height: 1.5;
  }
</style>
