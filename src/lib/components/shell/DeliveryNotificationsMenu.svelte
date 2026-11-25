<script lang="ts">
  import { tick } from 'svelte';
  import { Bell, CircleAlert, RefreshCw, X } from '@lucide/svelte';
  import { Button, DropdownMenu, IconButton } from '$lib/components/ui';
  import type { DeliveryNotifications } from '$lib/client/delivery-notifications.svelte';
  import { attentionKindLabel, attentionStateLabel, systemHealthLabel } from '$lib/client/delivery-attention-labels';
  import { formatNavigationCount } from '$lib/client/navigation-counts';
  import { deliveryAttentionKinds, type DeliveryAttentionAction, type DeliveryAttentionKind, type DeliveryAttentionSummary } from '$lib/domain/mail';
  import { formatNumber, translateCount } from '$lib/i18n';
  import { useLocale } from '$lib/i18n/runtime.svelte';

  let { notifications, onAct, onViewMessage, onOpenDiagnostics, onOpenChange, onRefresh }: {
    notifications: DeliveryNotifications;
    onAct: (action: DeliveryAttentionAction, messageId?: string) => Promise<boolean>;
    onViewMessage: (id: string) => void;
    onOpenDiagnostics: () => void;
    onOpenChange: (open: boolean) => void;
    onRefresh: () => void;
  } = $props();

  const i18n = useLocale();
  const { t } = i18n;
  let root = $state<HTMLDivElement>();
  let pendingTab = $state<HTMLButtonElement>();
  let historyTab = $state<HTMLButtonElement>();
  let confirmation = $state<DeliveryAttentionSummary | null>(null);
  const count = $derived(notifications.summary?.pendingCount ?? 0);
  const badge = $derived(count > 0 ? formatNavigationCount(i18n.locale, count) : '');
  const countDescription = $derived(translateCount(i18n.locale, 'attention.pendingCount', count));
  const label = $derived([t('attention.title'), count > 0 ? countDescription : '', count > 99 ? badge : '',
    notifications.health === 'degraded' ? t('attention.systemDegraded') : ''].filter(Boolean).join(' · '));
  const formatter = $derived(new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium', timeStyle: 'short' }));

  $effect(() => {
    if (!notifications.open) confirmation = null;
  });

  function close(restoreFocus = false) {
    onOpenChange(false);
    if (restoreFocus) root?.querySelector<HTMLButtonElement>('.fm-menu-trigger')?.focus({ preventScroll: true });
  }

  async function act(action: DeliveryAttentionAction, messageId?: string) {
    const changed = await onAct(action, messageId);
    if (changed) confirmation = null;
    await tick();
    if (notifications.open && document.activeElement === document.body) {
      (notifications.view === 'pending' ? pendingTab : historyTab)?.focus({ preventScroll: true });
    }
  }

  async function loadMore(event: MouseEvent) {
    const button = event.currentTarget as HTMLButtonElement;
    const restoreFocus = document.activeElement === button;
    const firstNewNotice = notifications.notices.length;
    await notifications.refresh(true, true);
    await tick();
    if (!restoreFocus || !notifications.open || document.activeElement !== document.body) return;
    const appended = root?.querySelectorAll<HTMLButtonElement>('.notices .notification-link')[firstNewNotice];
    const tab = notifications.view === 'pending' ? pendingTab : historyTab;
    (appended ?? (button.isConnected ? button : tab))?.focus();
  }

  async function confirmAll() {
    confirmation = notifications.summary;
    await tick();
    root?.querySelector<HTMLButtonElement>('#cancel-notification-confirmation')?.focus();
  }

  function changeScope(view: 'pending' | 'history', kind: DeliveryAttentionKind | null = notifications.kind) {
    confirmation = null;
    notifications.setScope(view, kind);
  }
</script>

<div class="contents" bind:this={root}>
  <DropdownMenu
    id="delivery-notifications"
    open={notifications.open}
    {onOpenChange}
    align="end"
    contentRole="dialog"
    viewportAware
    showChevron={false}
    triggerAriaLabel={label}
    triggerTitle={label}
    triggerClass="topbar-icon-trigger notification-trigger"
    initialFocusSelector='#notification-close'
  >
    {#snippet trigger()}
      <Bell size={19} aria-hidden="true" />
      {#if notifications.health === 'degraded'}
        <CircleAlert class="system-alert" size={13} aria-hidden="true" />
      {/if}
      {#if badge}<span class="notification-count" aria-hidden="true">{badge}</span>{/if}
    {/snippet}
    {#snippet children()}
      <div class="notification-panel">
        <header>
          <h2>{t('attention.title')}</h2>
          <div class="flex gap-1">
            <IconButton ariaLabel={t('attention.refresh')} title={t('attention.refresh')} onclick={() => {
              notifications.invalidate();
              void notifications.checkHealth(true);
              onRefresh();
            }} disabled={notifications.loading || Boolean(notifications.mutation)}><RefreshCw size={16} aria-hidden="true" /></IconButton>
            <IconButton id="notification-close" tooltipSide="left" ariaLabel={t('common.close')} title={t('common.close')} onclick={() => close(true)}><X size={17} aria-hidden="true" /></IconButton>
          </div>
        </header>
        <div class="health-row">
          <span class:degraded={notifications.health === 'degraded'} role="status">{t(systemHealthLabel[notifications.health])}</span>
          <button class="notification-link" type="button" onclick={() => { close(); onOpenDiagnostics(); }}>{t('settings.diagnostics')}</button>
        </div>

        <nav aria-label={t('attention.delivery')}>
          <button bind:this={pendingTab} type="button" disabled={Boolean(notifications.mutation)} aria-pressed={notifications.view === 'pending'} onclick={() => changeScope('pending')}>
            {t('attention.pending')}{count > 0 ? ` (${formatNumber(count, i18n.locale)})` : ''}
          </button>
          <button bind:this={historyTab} type="button" disabled={Boolean(notifications.mutation)} aria-pressed={notifications.view === 'history'} onclick={() => changeScope('history')}>{t('attention.history')}</button>
        </nav>
        <label class="kind-filter">
          <span class="sr-only">{t('attention.kind')}</span>
          <select disabled={Boolean(notifications.mutation)} value={notifications.kind ?? ''} onchange={(event) => changeScope(notifications.view, (event.currentTarget.value || null) as DeliveryAttentionKind | null)}>
            <option value="">{t('attention.allKinds')}</option>
            {#each deliveryAttentionKinds as kind}
              <option value={kind}>{t(attentionKindLabel[kind])}</option>
            {/each}
          </select>
        </label>

        {#if notifications.loadError}<p class="notice-error" role="alert">{t('attention.loadFailed')}</p>{/if}
        {#if notifications.actionError}<p class="notice-error" role="alert">{t(notifications.actionError === 'changed' ? 'attention.changed' : 'attention.actionFailed')}</p>{/if}
        {#if notifications.loading}<p class="notice-empty" role="status">{t('common.loading')}</p>{/if}
        {#if !notifications.loading && !notifications.loadError && notifications.notices.length === 0}
          <p class="notice-empty" role="status">{t(notifications.view === 'pending' ? 'attention.emptyPending' : 'attention.emptyHistory')}</p>
        {/if}
        {#if notifications.notices.length}
          <ul class="notices">
            {#each notifications.notices as notice (notice.id)}
              <li>
                <div class="notice-type">
                  <strong>{t(attentionKindLabel[notice.kind])}</strong>
                  {#if notice.state !== 'open'}<span>{t(attentionStateLabel[notice.state])}</span>{/if}
                </div>
                <p class="notice-subject">{notice.subject || t('mail.noSubject')}</p>
                <p class="notice-meta">{notice.sender} · <time datetime={notice.occurredAt}>{formatter.format(new Date(notice.occurredAt))}</time></p>
                <div class="notice-actions">
                  <button class="notification-link" type="button" onclick={() => { close(); onViewMessage(notice.messageId); }}>{t('attention.openMessage')}</button>
                  {#if notice.state === 'open' || notice.state === 'acknowledged'}
                    <Button variant="ghost" size="sm" disabled={Boolean(notifications.mutation)} onclick={() => act({
                      action: notice.state === 'open' ? 'acknowledge' : 'reopen', incident: { id: notice.id, version: notice.version }
                    }, notice.messageId)}>{t(notice.state === 'open' ? 'attention.acknowledge' : 'attention.reopen')}</Button>
                  {/if}
                </div>
              </li>
            {/each}
          </ul>
        {/if}
        {#if notifications.cursor}
          <Button variant="ghost" size="sm" disabled={notifications.loading || Boolean(notifications.mutation)} onclick={loadMore}>{t('attention.loadMore')}</Button>
        {/if}
        {#if confirmation}
          <div class="confirm">
            <p>{t('attention.confirmAll', { count: formatNumber(confirmation.pendingCount, i18n.locale) })}</p>
            <div class="notice-actions">
              <Button id="cancel-notification-confirmation" variant="ghost" size="sm" disabled={Boolean(notifications.mutation)} onclick={() => { confirmation = null; void tick().then(() => pendingTab?.focus()); }}>{t('common.cancel')}</Button>
              <Button variant="primary" size="sm" loading={Boolean(notifications.mutation)} onclick={() => {
                if (confirmation) void act({ action: 'acknowledge_all', snapshot: confirmation.snapshot });
              }}>{t('attention.acknowledgeAll')}</Button>
            </div>
          </div>
        {:else if notifications.view === 'pending' && count > 0}
          <footer><Button variant="secondary" size="sm" disabled={notifications.loading || notifications.loadError || Boolean(notifications.mutation)} onclick={confirmAll}>{t('attention.acknowledgeAll')}</Button></footer>
        {/if}
      </div>
    {/snippet}
  </DropdownMenu>
  <span class="sr-only" role="status">{notifications.summary ? countDescription : ''}</span>
</div>

<style>
  :global(.notification-trigger) { position: relative; }
  :global(.system-alert), .notification-count {
    position: absolute;
    border-radius: var(--radius-pill);
    background: var(--fm-surface);
  }
  :global(.system-alert) { top: 1px; left: 1px; color: var(--fm-danger); }
  .notification-count {
    top: 0;
    right: 0;
    min-width: 1rem;
    padding: 0 3px;
    color: var(--fm-danger);
    font-size: 0.625rem;
    font-weight: 700;
  }
  .notification-panel { width: min(23rem, calc(100vw - 1.75rem)); padding: 0 var(--space-3); overflow-wrap: anywhere; }
  header, .health-row, nav, .notice-actions, .notice-type, footer { display: flex; align-items: center; gap: var(--space-2); }
  header, .health-row, .notice-type { justify-content: space-between; }
  header h2 { font-size: 0.9375rem; font-weight: 650; }
  .health-row { border-bottom: 1px solid var(--fm-border); font-size: 0.75rem; color: var(--fm-text-secondary); }
  .degraded, .notice-error { color: var(--fm-danger); }
  nav { margin: var(--space-2) 0; }
  nav button { min-height: 44px; padding: 0 var(--space-3); border-radius: var(--radius-md); font-weight: 550; }
  nav button[aria-pressed='true'] { background: var(--fm-primary-soft); color: var(--fm-primary); }
  .kind-filter select { min-height: 44px; max-width: 100%; padding: 0 var(--space-2); border: 1px solid var(--fm-border); border-radius: var(--radius-md); font-size: 0.75rem; background: var(--fm-surface); }
  .notice-empty, .notice-error { padding: var(--space-3) 0; font-size: 0.8125rem; }
  .notice-empty, .notice-meta, .notice-type span { color: var(--fm-text-secondary); }
  .notices li { border-bottom: 1px solid var(--fm-border); padding: var(--space-3) 0 0; }
  .notice-type { flex-wrap: wrap; }
  .notice-type, .notice-meta { font-size: 0.75rem; }
  .notice-subject { margin: var(--space-1) 0; font-size: 0.875rem; }
  .notice-actions { flex-wrap: wrap; }
  .notification-link { min-height: 44px; color: var(--fm-primary); text-align: start; font-size: 0.75rem; font-weight: 550; }
  .notification-link:hover { text-decoration: underline; }
  footer, .confirm { padding: var(--space-2) 0; }
  footer { justify-content: end; }
  .confirm { font-size: 0.8125rem; }
  @media (max-width: 900px) {
    .notice-actions :global(button) { min-height: 44px; }
  }
</style>
