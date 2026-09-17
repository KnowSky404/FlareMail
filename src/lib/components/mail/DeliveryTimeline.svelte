<script lang="ts">
  import { Check, CircleAlert, CircleCheck, Clock3, Eye, ExternalLink, MousePointerClick, RefreshCw, Send, TriangleAlert } from '@lucide/svelte';
  import { getDeliveryRetryEligibility } from '$lib/domain/mail';
  import type { DeliveryDetail, DeliveryEvent, DeliveryEventType, DeliveryStatus, MailMessage } from '$lib/domain/mail';
  import { StatusBadge } from '$lib/components/ui';
  import { translateCount } from '$lib/i18n';
  import { useLocale } from '$lib/i18n/runtime.svelte';

  let {
    message = null,
    deliveryDetail = null,
    loading = false,
    error = '',
    pending = false,
    onReload,
    onRetry
  }: {
    message?: MailMessage | null;
    deliveryDetail?: DeliveryDetail | null;
    loading?: boolean;
    error?: string;
    pending?: boolean;
    onReload?: (message: MailMessage) => void | Promise<void>;
    onRetry?: (message: MailMessage) => void | Promise<void>;
  } = $props();

  const i18n = useLocale();
  const { t } = i18n;

  const statusLabels = $derived<Record<string, string>>({
    queued: t('mail.statusQueued'),
    submitting: t('mail.statusSubmitting'),
    submitted: t('mail.statusSubmitted'),
    sent: t('mail.statusSent'),
    delivered: t('mail.statusDelivered'),
    delayed: t('mail.statusDelayed'),
    bounced: t('mail.statusBounced'),
    failed: t('mail.statusFailed'),
    complained: t('mail.statusComplained'),
    suppressed: t('mail.statusSuppressed'),
    draft: t('mail.statusDraft')
  });

  const eventLabels = $derived<Record<string, string>>({
    submission: t('mail.eventSubmitted'),
    'email.sent': t('mail.eventSent'),
    'email.delivered': t('mail.eventDelivered'),
    'email.delivery_delayed': t('mail.eventDelayed'),
    'email.bounced': t('mail.eventBounced'),
    'email.failed': t('mail.eventFailed'),
    'email.complained': t('mail.eventComplained'),
    'email.suppressed': t('mail.eventSuppressed'),
    'email.opened': t('mail.eventOpened'),
    'email.clicked': t('mail.eventClicked')
  });

  const formatDate = (value: string) =>
    new Intl.DateTimeFormat(i18n.locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value));

  const statusFromEvent = (event: DeliveryEvent): DeliveryStatus | null => {
    const map: Record<string, DeliveryStatus> = {
      submission: 'submitted',
      'email.sent': 'sent',
      'email.delivered': 'delivered',
      'email.delivery_delayed': 'delayed',
      'email.bounced': 'bounced',
      'email.failed': 'failed',
      'email.complained': 'complained',
      'email.suppressed': 'suppressed'
    };
    return map[event.type] ?? null;
  };

  const iconForEvent = (event: DeliveryEvent) => {
    if (event.type === 'email.opened') return Eye;
    if (event.type === 'email.clicked') return MousePointerClick;
    if (event.type === 'email.delivered') return CircleCheck;
    if (event.type === 'email.bounced' || event.type === 'email.failed' || event.type === 'email.suppressed' || event.type === 'email.complained') return CircleAlert;
    if (event.type === 'email.delivery_delayed') return Clock3;
    if (event.type === 'email.sent' || event.type === 'submission') return Send;
    return Check;
  };

  const eventTone = (event: DeliveryEvent) => {
    if (event.type === 'email.delivered') return 'success';
    if (event.type === 'submission' || event.type === 'email.sent' || event.type === 'email.delivery_delayed' || event.type === 'email.opened' || event.type === 'email.clicked') return 'warning';
    if (event.type === 'email.bounced' || event.type === 'email.failed' || event.type === 'email.suppressed' || event.type === 'email.complained') return 'danger';
    return 'neutral';
  };

  const currentStatus = $derived<DeliveryStatus | null>(
    message?.folder === 'sent' ? (message.deliveryStatus ?? (deliveryDetail?.resultKind === 'accepted' ? 'submitted' : null)) : null
  );
  const sortedEvents = $derived(
    [...(deliveryDetail?.events ?? [])].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
  );
  const retryEligibility = $derived(
    message?.folder === 'sent' && message.deliveryStatus
      ? getDeliveryRetryEligibility({
        status: message.deliveryStatus,
        resultKind: message.deliveryResultKind,
        idempotencyKey: message.deliveryIdempotencyKey,
        attemptStartedAt: message.deliveryAttemptStartedAt
      })
      : null
  );
  const retryable = $derived(Boolean(retryEligibility?.eligible));

  const statusTone = (status: string | null): 'success' | 'warning' | 'danger' | 'neutral' => {
    if (status === 'delivered' || status === 'sent') return 'success';
    if (status === 'queued' || status === 'submitting' || status === 'submitted' || status === 'delayed') return 'warning';
    if (status === 'bounced' || status === 'failed' || status === 'complained' || status === 'suppressed') return 'danger';
    return 'neutral';
  };

  const statusLabel = (status: string | null) => (status ? statusLabels[status] ?? status : t('mail.noStatus'));
</script>

{#if message?.folder === 'sent'}
  <section class="border-t border-[var(--fm-border)] pt-5" aria-labelledby="delivery-title">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 id="delivery-title" class="text-sm font-semibold text-[var(--fm-text)]">{t('mail.deliveryTimeline')}</h2>
        <p class="mt-1 text-xs text-[var(--fm-text-muted)]">{t('mail.deliveryDisclaimer')}</p>
      </div>
      <div class="flex items-center gap-2">
        {#if currentStatus}<StatusBadge status={currentStatus} tone={statusTone(currentStatus)}>{statusLabel(currentStatus)}</StatusBadge>{/if}
        {#if onReload}<button class="grid size-11 place-items-center rounded-[var(--radius-md)] text-[var(--fm-text-secondary)] hover:bg-[var(--fm-surface-hover)]" type="button" aria-label={t('mail.reloadReceipt')} title={t('mail.reloadReceipt')} onclick={() => onReload?.(message)} disabled={pending || loading}><RefreshCw class={loading ? 'size-4 animate-spin' : 'size-4'} aria-hidden="true" /></button>{/if}
        {#if retryable && onRetry}<button class="inline-flex min-h-11 items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--fm-border)] px-3 text-xs font-semibold text-[var(--fm-text-secondary)] hover:bg-[var(--fm-surface-hover)]" type="button" onclick={() => onRetry?.(message)} disabled={pending}>{t('mail.retryDelivery')}</button>{/if}
      </div>
    </div>
    {#if error}
      <p class="mt-3 flex items-start gap-2 rounded-[var(--radius-md)] border border-[var(--fm-danger)]/35 bg-[var(--fm-danger-soft)] px-3 py-2 text-xs text-[var(--fm-danger)]" role="alert"><TriangleAlert class="mt-0.5 size-4 shrink-0" aria-hidden="true" />{error}</p>
    {:else if loading && sortedEvents.length === 0}
      <p class="mt-4 flex items-center gap-2 text-xs text-[var(--fm-text-muted)]" role="status"><RefreshCw class="size-3.5 animate-spin" aria-hidden="true" />{t('mail.loadingReceipt')}</p>
    {:else if sortedEvents.length === 0}
      <p class="mt-4 text-xs text-[var(--fm-text-muted)]">{t('mail.noDeliveryEvents')}</p>
    {:else}
      <details class="mt-4 group" open>
        <summary class="fm-touch-target flex cursor-pointer list-none items-center gap-2 text-xs font-medium text-[var(--fm-text-secondary)]">
          <span class="transition-transform group-open:rotate-90" aria-hidden="true">›</span>
          {translateCount(i18n.locale, 'mail.viewDeliveryEvents', sortedEvents.length)}
        </summary>
        <ol class="relative ml-2 mt-3 space-y-0 pl-7" aria-label={t('mail.deliveryEventList')}>
          {#each sortedEvents as event (event.id)}
            {@const EventIcon = iconForEvent(event)}
            {@const eventStatus = statusFromEvent(event)}
            <li class="relative pb-4 last:pb-0">
              <span class="absolute -left-7 top-0 grid size-5 place-items-center rounded-full border border-[var(--fm-border)] bg-[var(--fm-surface)] text-[var(--fm-text-muted)]" class:text-[var(--fm-success)]={eventTone(event) === 'success'} class:text-[var(--fm-danger)]={eventTone(event) === 'danger'} class:text-[var(--fm-warning)]={eventTone(event) === 'warning'}><EventIcon class="size-3" aria-hidden="true" /></span>
              {#if event.id !== sortedEvents.at(-1)?.id}<span class="absolute -left-[18px] top-5 h-[calc(100%-10px)] w-px bg-[var(--fm-border)]" aria-hidden="true"></span>{/if}
              <div class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <div class="flex flex-wrap items-center gap-2">
                  <span class="text-sm font-medium text-[var(--fm-text)]">{eventLabels[event.type] ?? event.type}</span>
                  {#if eventStatus}<span class="text-[11px] text-[var(--fm-text-muted)]">{statusLabel(eventStatus)}</span>{/if}
                </div>
                <time class="text-xs text-[var(--fm-text-muted)]" datetime={event.createdAt} title={new Date(event.createdAt).toISOString()}>{formatDate(event.createdAt)}</time>
              </div>
              {#if event.summary}<p class="mt-1 text-xs leading-5 text-[var(--fm-text-secondary)]">{event.summary}</p>{/if}
              {#if event.providerMessageId}<p class="mt-1 flex items-center gap-1 text-[11px] text-[var(--fm-text-muted)]"><ExternalLink class="size-3" aria-hidden="true" />{t('mail.providerId')} <span class="font-mono">{event.providerMessageId}</span></p>{/if}
            </li>
          {/each}
        </ol>
      </details>
    {/if}
  </section>
{/if}
