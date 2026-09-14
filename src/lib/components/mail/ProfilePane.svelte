<script lang="ts">
  import { onMount } from 'svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import Badge from '$lib/components/ui/Badge.svelte';
  import Panel from '$lib/components/ui/Panel.svelte';
  import Select from '$lib/components/ui/Select.svelte';
  import Switch from '$lib/components/ui/Switch.svelte';
  import TextArea from '$lib/components/ui/TextArea.svelte';
  import TextField from '$lib/components/ui/TextField.svelte';
  import TelegramNotificationPanel from '$lib/components/mail/TelegramNotificationPanel.svelte';
  import type { UserProfile, WorkspaceMetrics } from '$lib/domain/mail';
  import { applyTheme, readThemePreference, type ThemePreference } from '$lib/theme';
  import LanguageSwitcher from '$lib/components/shell/LanguageSwitcher.svelte';
  import { formatNumber } from '$lib/i18n';
  import { useLocale } from '$lib/i18n/runtime.svelte';

  const createProfileDraft = (profile: UserProfile): UserProfile => ({ ...profile });

  type RuntimeDiagnostics = {
    environment: string;
    d1Configured: boolean;
    r2Configured: boolean;
    outboundConfigured: boolean;
    outboundMode: string;
    webhookConfigured: boolean;
    senderConfigured: boolean;
    autoReplyEnabled: boolean;
    notificationEnabled: boolean;
    telegramEnabled: boolean;
    telegramConfigured: boolean;
  };

  let {
    profile,
    diagnostics = null,
    metrics,
    serviceDegraded,
    status = '',
    statusError = false,
    pending = false,
    onSave
  }: {
    profile: UserProfile;
    diagnostics?: RuntimeDiagnostics | null;
    metrics: WorkspaceMetrics;
    serviceDegraded: boolean;
    status?: string;
    statusError?: boolean;
    pending?: boolean;
    onSave: (next: UserProfile) => void | Promise<void>;
  } = $props();

  let nextProfile = $state<UserProfile>(
    createProfileDraft({
      name: '',
      role: '',
      email: '',
      company: '',
      location: '',
      timezone: '',
      forwardingEnabled: false,
      signature: ''
    })
  );
  let themePreference = $state<ThemePreference>('system');
  const i18n = useLocale();
  const { t } = i18n;

  onMount(() => {
    themePreference = readThemePreference();
  });

  $effect(() => {
    nextProfile = createProfileDraft(profile);
  });

  function submit(event: SubmitEvent) {
    event.preventDefault();
    void onSave(nextProfile);
  }
</script>

<div class="settings-layout">
  <header class="settings-header">
    <div><h1>{t('settings.title')}</h1>
    <p>{t('settings.description')}</p></div>
    <LanguageSwitcher />
  </header>

  <form onsubmit={submit}>
    <Panel title={t('settings.profile')} description={t('settings.profileDescription')}>
      <div class="field-grid">
        <TextField
          id="profile-name"
          label={t('settings.displayName')}
          value={nextProfile.name}
          required
          disabled={pending}
          oninput={(event) => (nextProfile.name = event.currentTarget.value)}
        />
        <TextField
          id="profile-role"
          label={t('settings.role')}
          value={nextProfile.role}
          disabled={pending}
          oninput={(event) => (nextProfile.role = event.currentTarget.value)}
        />
        <TextField
          id="profile-company"
          label={t('settings.company')}
          value={nextProfile.company}
          disabled={pending}
          oninput={(event) => (nextProfile.company = event.currentTarget.value)}
        />
        <TextField
          id="profile-timezone"
          label={t('settings.timezone')}
          value={nextProfile.timezone}
          disabled={pending}
          oninput={(event) => (nextProfile.timezone = event.currentTarget.value)}
        />
        <TextField
          id="profile-location"
          label={t('settings.location')}
          value={nextProfile.location}
          disabled={pending}
          oninput={(event) => (nextProfile.location = event.currentTarget.value)}
        />
      </div>
    </Panel>

    <Panel title={t('settings.workspaceIdentity')} description={t('settings.workspaceIdentityDescription')}>
      <div class="identity-grid">
        <TextField
          id="profile-email"
          label={t('settings.displayEmail')}
          type="email"
          value={nextProfile.email}
          required
          disabled={pending}
          oninput={(event) => (nextProfile.email = event.currentTarget.value)}
        />
        <TextArea
          id="profile-signature"
          label={t('settings.signature')}
          value={nextProfile.signature}
          rows={4}
          disabled={pending}
          placeholder={t('settings.signaturePlaceholder')}
          oninput={(event) => (nextProfile.signature = event.currentTarget.value)}
        />
      </div>
      {#if diagnostics}<p class="section-note">{t('settings.currentChannel')}：<Badge>{diagnostics.outboundMode}</Badge> · {t('settings.senderAddress')}{diagnostics.senderConfigured ? t('settings.configured') : t('settings.missing')}</p>{/if}
    </Panel>

    <Panel title={t('settings.autoReply')} description={t('settings.autoReplyDescription')}>
      <div class="configuration-row">
        <div><strong>{t('settings.inboundAutoReply')}</strong><p>{t('settings.autoReplyDetails')}</p></div>
        <Badge>{diagnostics?.autoReplyEnabled ? t('settings.enabled') : t('settings.disabled')}</Badge>
      </div>
    </Panel>

    <Panel title={t('settings.notifications')} description={t('settings.notificationsDescription')}>
      <Switch
        id="profile-forwarding"
        checked={nextProfile.forwardingEnabled}
        label={t('settings.inboundNotifications')}
        description={t('settings.inboundNotificationsDescription')}
        disabled={pending}
        onchange={(checked) => (nextProfile.forwardingEnabled = checked)}
      />
      <p class="section-note">{t('settings.systemNotifications')}：{diagnostics?.notificationEnabled ? t('settings.runtimeEnabled') : t('settings.runtimeDisabled')}。{t('settings.notificationAddressHidden')}</p>
    </Panel>

    <Panel title={t('settings.appearance')} description={t('settings.appearanceDescription')}>
      <div class="theme-field">
        <Select
          id="profile-theme"
          label={t('settings.theme')}
          value={themePreference}
          options={[
            { value: 'system', label: t('settings.themeSystem') },
            { value: 'light', label: t('settings.themeLight') },
            { value: 'dark', label: t('settings.themeDark') }
          ]}
          onchange={(value) => {
            themePreference = value as ThemePreference;
            applyTheme(themePreference);
          }}
        />
      </div>
    </Panel>

    <Panel title={t('settings.diagnostics')} description={t('settings.diagnosticsDescription')}>
      {#if diagnostics}
        <dl class="diagnostic-grid">
          <div><dt>{t('settings.runtime')}</dt><dd><Badge>{diagnostics.environment}</Badge></dd></div>
          <div><dt>D1</dt><dd>{diagnostics.d1Configured ? t('settings.configured') : t('settings.missing')}</dd></div>
          <div><dt>R2</dt><dd>{diagnostics.r2Configured ? t('settings.configured') : t('settings.missing')}</dd></div>
          <div><dt>{t('settings.outboundGateway')}</dt><dd>{diagnostics.outboundConfigured ? t('settings.configured') : t('settings.missing')}</dd></div>
          <div><dt>Webhook {t('settings.signatureVerification')}</dt><dd>{diagnostics.webhookConfigured ? t('settings.configured') : t('settings.missing')}</dd></div>
          <div><dt>{t('settings.globalDelivery')}</dt><dd><Badge class={serviceDegraded ? 'text-[var(--fm-danger)]' : 'text-[var(--fm-success)]'}>{serviceDegraded ? t('settings.needsAttention') : t('settings.normal')}</Badge></dd></div>
          <div><dt>Telegram {t('settings.notifications')}</dt><dd>{diagnostics.telegramEnabled ? (diagnostics.telegramConfigured ? t('settings.configured') : t('settings.needsConfiguration')) : t('settings.disabled')}</dd></div>
          <div><dt>{t('settings.queuedDelayed')}</dt><dd>{formatNumber(metrics.queuedCount, i18n.locale)} / {formatNumber(metrics.delayedCount, i18n.locale)}</dd></div>
          <div><dt>{t('settings.failedBouncedComplained')}</dt><dd>{formatNumber(metrics.failedCount, i18n.locale)} / {formatNumber(metrics.bouncedCount, i18n.locale)} / {formatNumber(metrics.complainedCount, i18n.locale)}</dd></div>
          <div><dt>{t('settings.staleSubmitting')}</dt><dd>{formatNumber(metrics.staleDeliveryCount, i18n.locale)}</dd></div>
        </dl>
      {:else}
        <p class="section-note">{t('settings.diagnosticsUnavailable')}</p>
      {/if}
    </Panel>

    <div class="save-row">
      <Button type="submit" loading={pending}>{pending ? t('settings.saving') : t('settings.save')}</Button>
      {#if status}
        <p role="status" aria-live="polite" class:error={statusError}>{status}</p>
      {/if}
    </div>
  </form>
  <TelegramNotificationPanel />
</div>

<style>
  .settings-layout {
    width: min(100%, 920px);
    margin: 0 auto;
  }

  header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-4);
    margin-bottom: var(--space-6);
  }

  h1 {
    margin: 0;
    font-size: 22px;
    font-weight: 650;
    letter-spacing: -0.025em;
  }

  header p {
    margin: var(--space-1) 0 0;
    color: var(--fm-text-muted);
  }

  form {
    display: grid;
    gap: var(--space-5);
  }

  .field-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--space-4);
  }

  .identity-grid {
    display: grid;
    gap: var(--space-4);
  }

  .configuration-row,
  .diagnostic-grid > div {
    display: flex;
    min-height: 44px;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
  }

  .configuration-row strong,
  .diagnostic-grid dt {
    color: var(--fm-text);
    font-size: 14px;
    font-weight: 600;
  }

  .configuration-row p,
  .section-note {
    margin: var(--space-1) 0 0;
    color: var(--fm-text-muted);
    font-size: 12px;
  }

  .diagnostic-grid {
    display: grid;
    margin: 0;
  }

  .diagnostic-grid > div + div {
    border-top: 1px solid var(--fm-border);
  }

  .diagnostic-grid dd {
    margin: 0;
    color: var(--fm-text-secondary);
    font-size: 13px;
  }

  .save-row {
    display: flex;
    min-height: 44px;
    align-items: center;
    gap: var(--space-4);
  }

  .theme-field {
    max-width: 320px;
  }

  .save-row p {
    margin: 0;
    color: var(--fm-success);
    font-size: 13px;
  }

  .save-row p.error {
    color: var(--fm-danger);
  }

  @media (max-width: 720px) {
    .field-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
