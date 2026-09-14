<script lang="ts">
  import { onMount, tick } from 'svelte';
  import Badge from '$lib/components/ui/Badge.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import Panel from '$lib/components/ui/Panel.svelte';
  import Switch from '$lib/components/ui/Switch.svelte';
  import {
    confirmTelegramBinding,
    createTelegramBinding,
    fetchTelegramSettings,
    retryTelegramDelivery,
    sendTelegramTest,
    setupTelegram,
    unbindTelegram,
    updateTelegramSettings,
    type TelegramSettingsStatus
  } from '$lib/client/telegram-api';
  import { ClientApiError } from '$lib/client/api';
  import { useLocale } from '$lib/i18n/runtime.svelte';

  let telegramState = $state<TelegramSettingsStatus | null>(null);
  let bindingLink = $state<string | null>(null);
  let bindingExpiresAt = $state<string | null>(null);
  let bindingCommandElement = $state<HTMLTextAreaElement>();
  const bindingCommand = $derived(bindingLink ? `/start ${new URL(bindingLink).searchParams.get('start') ?? ''}` : '');
  let generatedLinkElement = $state<HTMLDivElement>();
  let candidateElement = $state<HTMLDivElement>();
  let loading = $state(true);
  let action = $state('');
  let error = $state('');
  let message = $state('');
  let bindingExpired = $state(false);
  let disposed = false;
  let refreshRevision = 0;
  let refreshController: AbortController | undefined;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  const i18n = useLocale();
  const { t } = i18n;

  const deliveryStatusLabels = $derived<Record<TelegramSettingsStatus['recentDeliveries'][number]['status'], string>>({
    pending: t('telegram.statusPending'),
    processing: t('telegram.statusProcessing'),
    retryable: t('telegram.statusRetryable'),
    sent: t('telegram.statusSent'),
    failed: t('telegram.statusFailed'),
    unknown_delivery: t('telegram.statusUnknown'),
    cancelled: t('telegram.statusCancelled')
  });

  function formatDate(value: string | null, timezone = telegramState?.timezone ?? 'UTC') {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.valueOf())) return '—';
    try {
      return new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: timezone || 'UTC' }).format(date);
    } catch {
      return new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(date);
    }
  }

  function errorMessage(value: unknown) {
    return value instanceof ClientApiError && i18n.locale === 'en'
      ? t('telegram.updateError')
      : value instanceof Error
        ? value.message
        : t('telegram.updateError');
  }

  function cancelRefresh() {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = undefined;
    // Aborting alone cannot prevent a response already being parsed from
    // overwriting a newer confirmation/settings mutation.
    refreshRevision += 1;
    refreshController?.abort();
    refreshController = undefined;
  }

  function scheduleRefresh() {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = undefined;
    if (disposed) return;
    // Use the challenge lifetime, not a fixed attempt count: Telegram may
    // stay in the foreground for several minutes before the user returns.
    const expiresAt = bindingExpiresAt ? Date.parse(bindingExpiresAt) : NaN;
    bindingExpired = Boolean(bindingLink) && (!Number.isFinite(expiresAt) || expiresAt <= Date.now());
    if (action || !bindingLink || bindingExpired || document.visibilityState === 'hidden' ||
      telegramState?.binding?.state === 'active' || telegramState?.binding?.state === 'candidate') return;
    pollTimer = setTimeout(() => void refresh(), Math.min(5_000, expiresAt - Date.now()));
  }

  async function refresh() {
    cancelRefresh();
    if (disposed) return;
    const revision = refreshRevision;
    const controller = new AbortController();
    refreshController = controller;
    try {
      const result = await fetchTelegramSettings(controller.signal);
      if (disposed || revision !== refreshRevision) return;
      const revealCandidate = result.binding?.state === 'candidate' && telegramState?.binding?.state !== 'candidate';
      telegramState = result;
      error = '';
      if (result.binding?.state === 'active') {
        bindingLink = null;
        bindingExpiresAt = null;
      }
      if (revealCandidate) {
        await tick();
        if (disposed || revision !== refreshRevision) return;
        candidateElement?.focus({ preventScroll: true });
        candidateElement?.scrollIntoView({ block: 'center' });
      }
    } catch (value) {
      if (disposed || revision !== refreshRevision) return;
      error = errorMessage(value);
    } finally {
      if (!disposed && revision === refreshRevision) {
        refreshController = undefined;
        loading = false;
        scheduleRefresh();
      }
    }
  }

  onMount(() => {
    const resume = () => {
      if (document.visibilityState === 'hidden') cancelRefresh();
      else if (!action) void refresh();
    };
    window.addEventListener('focus', resume);
    document.addEventListener('visibilitychange', resume);
    void refresh();
    return () => {
      disposed = true;
      cancelRefresh();
      window.removeEventListener('focus', resume);
      document.removeEventListener('visibilitychange', resume);
    };
  });

  async function beginBinding() {
    cancelRefresh();
    action = 'bind';
    error = '';
    message = '';
    try {
      const result = await createTelegramBinding();
      bindingLink = result.deepLink;
      bindingExpiresAt = result.expiresAt;
      bindingExpired = false;
      message = t('telegram.bindingInstructions');
      await refresh();
      await tick();
      generatedLinkElement?.focus();
      generatedLinkElement?.scrollIntoView({ block: 'center' });
    } catch (value) {
      error = errorMessage(value);
    } finally {
      action = '';
      scheduleRefresh();
    }
  }

  async function connectTelegram() {
    cancelRefresh();
    action = 'setup';
    error = '';
    message = '';
    try {
      const result = await setupTelegram();
      message = t('telegram.connected', { username: result.botUsername });
    } catch (value) {
      error = errorMessage(value);
    } finally {
      action = '';
      scheduleRefresh();
    }
  }

  async function copyBindingCommand() {
    try {
      await navigator.clipboard.writeText(bindingCommand);
      message = t('telegram.commandCopied');
    } catch {
      bindingCommandElement?.focus();
      bindingCommandElement?.select();
      message = t('telegram.commandCopyFailed');
    }
  }

  async function confirmBinding() {
    cancelRefresh();
    action = 'confirm';
    error = '';
    try {
      telegramState = await confirmTelegramBinding();
      bindingLink = null;
      message = t('telegram.bindingConfirmed');
    } catch (value) {
      error = errorMessage(value);
    } finally {
      action = '';
      scheduleRefresh();
    }
  }

  async function changeSettings(input: { enabled?: boolean; privacyMode?: boolean; summaryEnabled?: boolean }) {
    if (!telegramState?.binding || telegramState.binding.state !== 'active') return;
    cancelRefresh();
    action = 'settings';
    error = '';
    try {
      const result = await updateTelegramSettings(input);
      if (result.settings && telegramState?.binding) telegramState = { ...telegramState, userEnabled: result.settings.enabled, binding: { ...telegramState.binding, ...result.settings } };
      message = t('telegram.settingsSaved');
    } catch (value) {
      error = errorMessage(value);
    } finally {
      action = '';
      scheduleRefresh();
    }
  }

  async function testNotification() {
    cancelRefresh();
    action = 'test';
    error = '';
    try {
      await sendTelegramTest();
      message = t('telegram.testSent');
    } catch (value) {
      error = errorMessage(value);
    } finally {
      action = '';
      scheduleRefresh();
    }
  }

  async function removeBinding() {
    if (!window.confirm(t('telegram.unbindConfirm'))) return;
    cancelRefresh();
    action = 'unbind';
    error = '';
    try {
      telegramState = await unbindTelegram();
      bindingLink = null;
      message = t('telegram.unbound');
    } catch (value) {
      error = errorMessage(value);
    } finally {
      action = '';
      scheduleRefresh();
    }
  }

  async function retry(id: string) {
    if (!window.confirm(t('telegram.retryConfirm'))) return;
    cancelRefresh();
    action = `retry:${id}`;
    error = '';
    try {
      await retryTelegramDelivery(id);
      message = t('telegram.retryQueued');
      await refresh();
    } catch (value) {
      error = errorMessage(value);
    } finally {
      action = '';
      scheduleRefresh();
    }
  }
</script>

<Panel title={t('telegram.title')} description={t('telegram.description')}>
  {#if loading}
    <p class="muted">{t('telegram.loading')}</p>
  {:else if !telegramState?.globalEnabled}
    <div class="notice"><Badge>{t('settings.disabled')}</Badge><span>{t('telegram.globalDisabled')}</span></div>
  {:else if !telegramState.configReady}
    <div class="notice warning"><Badge>{t('settings.needsConfiguration')}</Badge><span>{t('telegram.configMissing')}</span></div>
  {:else if !telegramState.schemaReady}
    <div class="notice warning"><Badge>{t('telegram.migrationRequired')}</Badge><span>{t('telegram.migrationDescription')}</span></div>
  {:else}
    <div class="stack">
      <div class="setup-strip">
        <div class="setup-copy">
          <strong>{t('telegram.connection')}</strong>
          <p class="muted">{t('telegram.connectionDescription')}</p>
        </div>
        <Button variant="secondary" loading={action === 'setup'} disabled={action !== ''} onclick={() => void connectTelegram()}>{t('telegram.connect')}</Button>
      </div>

      {#if telegramState.binding?.state === 'candidate'}
        <div class="stack" bind:this={candidateElement} tabindex="-1" role="group" aria-label={t('telegram.confirmBinding')}>
          <div class="notice"><Badge class="shrink-0 whitespace-nowrap">{t('telegram.pendingConfirmation')}</Badge><span>{t('telegram.candidateDetected')}</span></div>
          <p class="muted">{t('telegram.linkExpires', { date: formatDate(telegramState.binding.candidateExpiresAt ?? bindingExpiresAt) })} {t('telegram.notificationsRemainOff')}</p>
          <div class="actions"><Button loading={action === 'confirm'} disabled={action !== ''} onclick={() => void confirmBinding()}>{t('telegram.confirm')}</Button><Button variant="secondary" loading={action === 'bind'} disabled={action !== ''} onclick={() => void beginBinding()}>{t('telegram.regenerate')}</Button><Button variant="secondary" disabled={action !== ''} onclick={() => void refresh()}>{t('telegram.refreshStatus')}</Button></div>
        </div>
      {:else if telegramState.binding?.state === 'active'}
        <div class="stack">
          <div class="notice"><Badge class={telegramState.binding.enabled ? 'success' : ''}>{telegramState.binding.enabled ? t('telegram.enabled') : t('telegram.bound')}</Badge><span>{telegramState.binding.enabled ? t('telegram.enabledDescription') : t('telegram.boundDescription')}</span></div>
          <div class="identity-summary" role="group" aria-label={t('telegram.boundIdentityGroup')}>
            <span class="muted">{t('telegram.boundIdentity')}</span>
            <strong>{telegramState.binding.telegramDisplayName || t('telegram.user')}</strong>
            {#if telegramState.binding.telegramUsername}<span class="muted">@{telegramState.binding.telegramUsername}</span>{/if}
          </div>
          <Switch
            id="telegram-enabled"
            checked={telegramState.binding.enabled}
            label={t('telegram.enableNotifications')}
            description={t('telegram.enableNotificationsDescription')}
            disabled={action !== ''}
            onchange={(checked) => void changeSettings({ enabled: checked })}
          />
          <Switch
            id="telegram-privacy"
            checked={telegramState.binding.privacyMode}
            label={t('telegram.privacyMode')}
            description={t('telegram.privacyModeDescription')}
            disabled={action !== ''}
            onchange={(checked) => void changeSettings({ privacyMode: checked })}
          />
          <Switch
            id="telegram-summary"
            checked={telegramState.binding.summaryEnabled}
            label={t('telegram.includeSummary')}
            description={t('telegram.includeSummaryDescription')}
            disabled={action !== '' || telegramState.binding.privacyMode}
            onchange={(checked) => void changeSettings({ summaryEnabled: checked })}
          />
          <div class="actions"><Button variant="secondary" loading={action === 'test'} disabled={!telegramState.binding.enabled || action !== ''} onclick={() => void testNotification()}>{t('telegram.sendTest')}</Button><Button variant="danger" loading={action === 'unbind'} disabled={action !== ''} onclick={() => void removeBinding()}>{t('telegram.unbind')}</Button></div>
          {#if telegramState.binding.lastErrorCode}<p class="muted">{t('telegram.lastError')}：{telegramState.binding.lastErrorCode} · {formatDate(telegramState.binding.lastErrorAt)}</p>{/if}
        </div>
      {:else}
        <div class="stack">
          <div class="notice"><Badge class="shrink-0 whitespace-nowrap">{t('telegram.unbound')}</Badge><span>{t('telegram.unboundDescription')}</span></div>
          <Button loading={action === 'bind'} disabled={action !== ''} onclick={() => void beginBinding()}>{t('telegram.generateLink')}</Button>
          {#if !bindingLink}<Button variant="secondary" disabled={action !== ''} onclick={() => void refresh()}>{t('telegram.refreshBinding')}</Button>{/if}
        </div>
      {/if}
    </div>
  {/if}

  {#if bindingLink && bindingExpired}
    <p class="feedback error" role="status">{t('telegram.linkExpired')}</p>
    <Button variant="secondary" disabled={action !== ''} onclick={() => void refresh()}>{t('telegram.refreshBinding')}</Button>
  {:else if bindingLink}
    <div class="generated-link" bind:this={generatedLinkElement} tabindex="-1" role="group" aria-label={t('telegram.generatedLink')}>
      <strong>{t('telegram.generatedLink')}</strong>
      <a class="bind-link" href={bindingLink} target="_blank" rel="noreferrer">{t('telegram.openToBind')}</a>
      <label class="muted" for="telegram-binding-link">{t('telegram.copyFullLink')}</label>
      <textarea id="telegram-binding-link" class="link-value" readonly value={bindingLink} rows="3" onclick={(event) => event.currentTarget.select()}></textarea>
      <p class="muted">{t('telegram.commandInstruction')}</p>
      <label class="muted" for="telegram-binding-command">{t('telegram.fullCommand')}</label>
      <textarea id="telegram-binding-command" class="link-value" bind:this={bindingCommandElement} readonly value={bindingCommand} rows="2" onclick={(event) => event.currentTarget.select()}></textarea>
      <div class="actions"><Button variant="secondary" onclick={() => void copyBindingCommand()}>{t('telegram.copyCommand')}</Button><Button variant="secondary" disabled={action !== ''} onclick={() => void refresh()}>{t('telegram.refreshBinding')}</Button></div>
      <p class="muted">{t('telegram.linkExpires', { date: formatDate(bindingExpiresAt) })} {t('telegram.notStored')}</p>
    </div>
  {/if}

  {#if message}<p class="feedback" role="status" aria-live="polite">{message}</p>{/if}
  {#if error}<p class="feedback error" role="alert">{error}</p>{/if}

  {#if telegramState?.recentDeliveries?.length}
    <div class="history">
      <h3>{t('telegram.recentDeliveries')}</h3>
      {#each telegramState.recentDeliveries as delivery (delivery.id)}
        <div class="delivery-row">
          <div><strong>{delivery.subject || t('mail.noSubject')}</strong><span>{formatDate(delivery.receivedAt)} · {deliveryStatusLabels[delivery.status]}</span></div>
          {#if ['failed', 'retryable', 'unknown_delivery'].includes(delivery.status)}<Button variant="secondary" disabled={action !== ''} onclick={() => void retry(delivery.id)}>{delivery.status === 'unknown_delivery' ? t('telegram.manualRetry') : t('mail.retry')}</Button>{/if}
        </div>
      {/each}
    </div>
  {/if}
</Panel>

<style>
  .stack { display: grid; gap: var(--space-3); }
  .notice { display: flex; align-items: center; gap: var(--space-3); color: var(--fm-text-secondary); font-size: 13px; }
  .notice.warning { color: var(--fm-warning); }
  .identity-summary { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--space-2); }
  .identity-summary strong { color: var(--fm-text); font-size: 13px; }
  .setup-strip { display: flex; align-items: center; justify-content: space-between; gap: var(--space-4); padding: var(--space-3); border: 1px solid var(--fm-border); border-radius: var(--radius-md); background: var(--fm-surface-subtle); }
  .setup-copy { display: grid; gap: var(--space-1); min-width: 0; }
  .setup-copy strong { color: var(--fm-text); font-size: 13px; }
  .muted { margin: 0; color: var(--fm-text-muted); font-size: 12px; line-height: 1.6; }
  .bind-link { color: var(--fm-accent); font-size: 13px; overflow-wrap: anywhere; }
  .link-value { width: 100%; min-width: 0; box-sizing: border-box; padding: var(--space-2); border: 1px solid var(--fm-border); border-radius: var(--radius-md); background: var(--fm-surface); color: var(--fm-text); font: inherit; font-size: 13px; overflow-wrap: anywhere; resize: vertical; }
  .actions { display: flex; flex-wrap: wrap; gap: var(--space-3); align-items: center; }
  .generated-link { display: grid; gap: var(--space-2); margin-top: var(--space-4); padding-top: var(--space-4); border-top: 1px solid var(--fm-border); }
  .feedback { margin: var(--space-3) 0 0; color: var(--fm-success); font-size: 13px; }
  .feedback.error { color: var(--fm-danger); }
  .history { display: grid; gap: var(--space-2); margin-top: var(--space-5); padding-top: var(--space-4); border-top: 1px solid var(--fm-border); }
  .history h3 { margin: 0; font-size: 14px; }
  .delivery-row { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); padding: var(--space-2) 0; border-top: 1px solid var(--fm-border); }
  .delivery-row > div { min-width: 0; display: grid; gap: 2px; }
  .delivery-row strong, .delivery-row span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .delivery-row span { color: var(--fm-text-muted); font-size: 12px; }
  @media (max-width: 620px) { .setup-strip { align-items: flex-start; flex-direction: column; } }
  @media (max-width: 520px) { .delivery-row { align-items: flex-start; flex-direction: column; } }
</style>
