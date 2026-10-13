<script lang="ts">
  import { AlertTriangle, RefreshCw, RotateCw, ShieldAlert } from '@lucide/svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import { formatDate } from '$lib/i18n';
  import { useLocale } from '$lib/i18n/runtime.svelte';
  import { mailHealthState, type MailHealthState } from '$lib/domain/mail/health';
  import type { DomainCheck, MailAddress, MailDomain } from './mail-resource-types';

  let {
    domain,
    address,
    check,
    busy = false,
    showActions = true,
    onCheck,
    onRetry
  }: {
    domain: MailDomain;
    address?: MailAddress;
    check?: Partial<DomainCheck>;
    busy?: boolean;
    showActions?: boolean;
    onCheck?: () => void;
    onRetry?: () => void;
  } = $props();

  const { t, locale } = useLocale();
  const providers = ['cloudflare', 'resend'] as const;

  function routeStatusLabel(status: string) {
    const labels: Record<string, string> = {
      managed: t('settings.routeManaged'),
      imported: t('settings.routeImported'),
      importable: t('settings.routeImportable'),
      missing: t('settings.routeMissing'),
      conflict: t('settings.routeConflict'),
      duplicate: t('settings.routeDuplicate'),
      deleted_route: t('settings.routeStillPresent'),
      reject_route_preserved: t('settings.deletedRejectRoutePreserved'),
      deleted_absent: t('settings.deletedRouteAbsent'),
      imported_preserved: t('settings.importedRuleRetained'),
      pending: t('settings.routePending'),
      provisioning: t('settings.routeProvisioning'),
      active: t('settings.routeActive'),
      deleting: t('settings.routeDeleting'),
      unknown: t('settings.routeUnknown'),
      error: t('settings.routeError'),
      deleted: t('settings.routeDeleted')
    };
    return labels[status] ?? t('settings.routeUnknown');
  }

  function catchAllLabel(target: MailDomain['catch_all_target']) {
    const labels: Record<MailDomain['catch_all_target'], string> = {
      unknown: t('settings.catchAllUnknown'),
      this_worker: t('settings.catchAllWorker'),
      external: t('settings.catchAllExternal'),
      drop: t('settings.catchAllDrop'),
      none: t('settings.catchAllDisabled')
    };
    return labels[target];
  }

  function providerHealth(provider: 'cloudflare' | 'resend'): MailHealthState {
    const cloudflare = provider === 'cloudflare';
    return mailHealthState({
      configured: cloudflare ? domain.cloudflare_configured : domain.resend_configured,
      checkedAt: cloudflare ? domain.cloudflare_checked_at : domain.resend_checked_at,
      leaseExpiresAt: cloudflare ? domain.cloudflare_check_expires_at : domain.resend_check_expires_at,
      errorCode: cloudflare ? domain.cloudflare_error_code : domain.resend_error_code
    });
  }

  function healthLabel(provider: 'cloudflare' | 'resend', state: MailHealthState) {
    if (state === 'fresh') return t('settings.mailHealthFresh');
    if (state === 'refreshing') return t('settings.mailHealthRefreshing');
    if (state === 'degraded') return t('settings.mailHealthDegraded');
    if (state === 'not_configured') return t('settings.mailHealthNotConfigured');
    return provider === 'cloudflare' && !domain.cloudflare_checked_at
      ? t('settings.statusNotChecked')
      : t('settings.mailHealthStale');
  }

  function providerErrorLabel(provider: 'cloudflare' | 'resend') {
    const cloudflare = provider === 'cloudflare';
    const configured = cloudflare ? domain.cloudflare_configured : domain.resend_configured;
    if (!configured) {
      return t(cloudflare ? 'settings.cloudflareCheckNotConfigured' : 'settings.resendCheckNotConfigured');
    }
    const code = cloudflare
      ? (check?.cloudflare ? check.cloudflare.errorCode : domain.cloudflare_error_code)
      : (check?.resend?.errorCode === undefined ? domain.resend_error_code : check.resend.errorCode);
    const checkFailed = cloudflare
      ? check?.cloudflare?.state === 'error'
      : check?.resend?.state === 'error';
    if (!code && !checkFailed) return '';
    if (!code && checkFailed) {
      return t(cloudflare ? 'settings.cloudflareCheckNeedsAttention' : 'settings.resendCheckNeedsAttention');
    }
    if (cloudflare) {
      return t(code === 'cloudflare_permission_denied'
        ? 'settings.cloudflareCheckAccessDenied'
        : 'settings.cloudflareCheckNeedsAttention');
    }
    return t(code === 'resend_permission_denied'
      ? 'settings.resendCheckAccessDenied'
      : 'settings.resendCheckNeedsAttention');
  }

  function formatTimestamp(value: string | null | undefined) {
    if (!value) return t('settings.statusNotChecked');
    return formatDate(value, locale, { dateStyle: 'medium', timeStyle: 'short' }) || t('settings.statusNotChecked');
  }

  function resendStatusLabel() {
    const state = check?.resend?.state;
    if (state === 'verified' || (!state && domain.resend_status === 'verified')) return t('settings.resendVerified');
    if (state === 'failed' || (!state && domain.resend_status === 'failed')) return t('settings.resendFailed');
    if (state === 'missing') return t('settings.resendMissing');
    if (state === 'not_configured') return t('settings.resendNotConfigured');
    if (state === 'error') return t('settings.resendCheckFailed');
    if (state === 'pending' || (!state && domain.resend_status === 'pending')) return t('settings.resendPending');
    return t('settings.resendUnknown');
  }

  function catchAllTarget() {
    return check?.cloudflare?.catchAllTarget ?? domain.catch_all_target;
  }

  function routeStatus() {
    if (!address) return null;
    return check?.cloudflare?.addresses.find((entry) => entry.addressId === address.id)?.status
      ?? address.routing_state;
  }

  function routeLabel() {
    const status = routeStatus();
    return status ? routeStatusLabel(status) : t('settings.routeUnknown');
  }

  function routingOwnerLabel() {
    if (address?.routing_owner === 'flaremail') return t('settings.routeManaged');
    if (address?.routing_owner === 'imported') return t('settings.routeImported');
    return t('settings.routeUnknown');
  }

  function deletePolicyLabel() {
    if (address?.delete_route_policy === 'remove_owned_route') return t('settings.deletePolicyRemoveLabel');
    if (address?.delete_route_policy === 'retain_reject_route') return t('settings.deletePolicyRetainLabel');
    if (address?.delete_route_policy === 'preserve_imported_route') return t('settings.importedRuleRetained');
    return t('settings.routeUnknown');
  }

  function hasRetryableRoute() {
    return Boolean(address && (
      address.routing_state === 'error' ||
      address.routing_state === 'unknown' ||
      address.routing_state === 'pending' ||
      address.routing_state === 'provisioning' ||
      address.routing_state === 'deleting' ||
      address.last_error_code
    ));
  }

  function hasCatchAllWarning() {
    const target = catchAllTarget();
    return target === 'external' || (domain.unknown_recipient_policy === 'collect' && target !== 'this_worker');
  }

  function lifecycleLabel() {
    if (!address) return '';
    if (address.lifecycle_status === 'active') return t('settings.enabled');
    if (address.lifecycle_status === 'disabled') return t('settings.disabled');
    return t('settings.routeDeleted');
  }

  function sendLabel() {
    if (!address) return '';
    return address.send_enabled === 1
      ? (address.is_default_sender ? t('settings.defaultSender') : t('settings.sendEnabled'))
      : t('settings.sendDisabled');
  }
</script>

<div class="space-y-5" data-mail-identity-diagnostics>
  <section aria-labelledby="mail-diagnostics-mapping" class="space-y-3">
    <h3 id="mail-diagnostics-mapping" class="text-sm font-semibold text-[var(--fm-text)]">{t('settings.domainMappingLocked')}</h3>
    <dl class="grid gap-3 text-sm sm:grid-cols-2">
      <div>
        <dt class="text-xs text-[var(--fm-text-muted)]">{t('settings.domainZoneId')}</dt>
        <dd class="mt-1 break-all font-mono text-[var(--fm-text)]">{domain.cloudflare_zone_id}</dd>
      </div>
      <div>
        <dt class="text-xs text-[var(--fm-text-muted)]">Worker</dt>
        <dd class="mt-1 break-all font-mono text-[var(--fm-text)]">{domain.worker_name}</dd>
      </div>
      <div>
        <dt class="text-xs text-[var(--fm-text-muted)]">{t('settings.domainEnabled')}</dt>
        <dd class="mt-1 text-[var(--fm-text)]">{domain.enabled ? t('settings.enabled') : t('settings.disabled')}</dd>
      </div>
      <div>
        <dt class="text-xs text-[var(--fm-text-muted)]">{t('settings.unknownRecipients')}</dt>
        <dd class="mt-1 text-[var(--fm-text)]">{domain.unknown_recipient_policy === 'collect' ? t('settings.unknownCollect') : t('settings.unknownReject')}</dd>
      </div>
    </dl>
  </section>

  <section aria-labelledby="mail-diagnostics-health" class="space-y-3">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <h3 id="mail-diagnostics-health" class="text-sm font-semibold text-[var(--fm-text)]">{t('settings.diagnostics')}</h3>
    </div>
    <div class="grid gap-4 lg:grid-cols-2">
      {#each providers as provider}
        {@const providerName = provider === 'cloudflare' ? 'Cloudflare' : 'Resend'}
        {@const health = providerHealth(provider)}
        {@const checkedAt = provider === 'cloudflare' ? (check?.cloudflare?.checkedAt ?? domain.cloudflare_checked_at) : domain.resend_checked_at}
        {@const expiresAt = provider === 'cloudflare' ? domain.cloudflare_check_expires_at : domain.resend_check_expires_at}
        {@const nextCheckAt = provider === 'cloudflare' ? domain.cloudflare_next_check_at : domain.resend_next_check_at}
        {@const error = providerErrorLabel(provider)}
        <div class="rounded border border-[var(--fm-border)] p-3">
          <div class="flex items-center justify-between gap-2">
            <h4 class="font-medium text-[var(--fm-text)]">{providerName}</h4>
            <span class="text-xs text-[var(--fm-text-muted)]">{healthLabel(provider, health)}</span>
          </div>
          <dl class="mt-3 space-y-2 text-sm">
            <div class="flex justify-between gap-3"><dt class="text-[var(--fm-text-muted)]">{t('settings.statusChecked')}</dt><dd class="text-right text-[var(--fm-text)]">{formatTimestamp(checkedAt)}</dd></div>
            <div class="flex justify-between gap-3"><dt class="text-[var(--fm-text-muted)]">Lease expires</dt><dd class="text-right text-[var(--fm-text)]">{expiresAt ? formatTimestamp(expiresAt) : t('settings.statusNotChecked')}</dd></div>
            <div class="flex justify-between gap-3"><dt class="text-[var(--fm-text-muted)]">{t('settings.mailHealthNextCheck')}</dt><dd class="text-right text-[var(--fm-text)]">{nextCheckAt ? formatTimestamp(nextCheckAt) : t('settings.statusNotChecked')}</dd></div>
            {#if provider === 'resend'}<div class="flex justify-between gap-3"><dt class="text-[var(--fm-text-muted)]">{t('settings.send')}</dt><dd class="text-right text-[var(--fm-text)]">{resendStatusLabel()}</dd></div>{/if}
          </dl>
          {#if error}<p class="mt-3 flex gap-2 text-sm text-[var(--fm-danger)]"><AlertTriangle size={15} class="mt-0.5 shrink-0" aria-hidden="true" /> <span>{error}</span></p>{/if}
        </div>
      {/each}
    </div>
  </section>

  <section aria-labelledby="mail-diagnostics-routing" class="space-y-3">
    <h3 id="mail-diagnostics-routing" class="text-sm font-semibold text-[var(--fm-text)]">{t('settings.catchAll')}</h3>
    <dl class="grid gap-3 text-sm sm:grid-cols-2">
      <div><dt class="text-xs text-[var(--fm-text-muted)]">{t('settings.catchAll')}</dt><dd class="mt-1 text-[var(--fm-text)]">{catchAllLabel(catchAllTarget())}</dd></div>
      <div><dt class="text-xs text-[var(--fm-text-muted)]">{t('settings.unknownRecipients')}</dt><dd class="mt-1 text-[var(--fm-text)]">{domain.unknown_recipient_policy === 'collect' ? t('settings.unknownCollect') : t('settings.unknownReject')}</dd></div>
    </dl>
    {#if hasCatchAllWarning()}
      <p class="flex gap-2 rounded border border-[var(--fm-warning)]/40 bg-[var(--fm-warning)]/10 p-3 text-sm text-[var(--fm-text)]">
        {#if catchAllTarget() === 'external'}<AlertTriangle size={15} class="mt-0.5 shrink-0 text-[var(--fm-warning)]" aria-hidden="true" />{:else}<ShieldAlert size={15} class="mt-0.5 shrink-0 text-[var(--fm-warning)]" aria-hidden="true" />{/if}
        <span>{catchAllTarget() === 'external' ? t('settings.externalCatchAllRisk') : t('settings.collectRequiresWorkerCatchAll')}</span>
      </p>
    {/if}
  </section>

  {#if address}
    <section aria-labelledby="mail-diagnostics-address" class="space-y-3">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <h3 id="mail-diagnostics-address" class="text-sm font-semibold text-[var(--fm-text)]">{address.email}</h3>
      </div>
      <dl class="grid gap-3 text-sm sm:grid-cols-2">
        <div><dt class="text-xs text-[var(--fm-text-muted)]">{t('settings.mailDomain')}</dt><dd class="mt-1 text-[var(--fm-text)]">{domain.domain_name}</dd></div>
        <div><dt class="text-xs text-[var(--fm-text-muted)]">{t('settings.resourceStatus')}</dt><dd class="mt-1 text-[var(--fm-text)]">{lifecycleLabel()}</dd></div>
        <div><dt class="text-xs text-[var(--fm-text-muted)]">{t('settings.receive')}</dt><dd class="mt-1 text-[var(--fm-text)]">{address.receive_enabled === 1 ? t('settings.receiveEnabled') : t('settings.receiveDisabled')}</dd></div>
        <div><dt class="text-xs text-[var(--fm-text-muted)]">{t('settings.send')}</dt><dd class="mt-1 text-[var(--fm-text)]">{sendLabel()}</dd></div>
        <div><dt class="text-xs text-[var(--fm-text-muted)]">{t('settings.routeManaged')}</dt><dd class="mt-1 text-[var(--fm-text)]">{routingOwnerLabel()}</dd></div>
        <div><dt class="text-xs text-[var(--fm-text-muted)]">{t('settings.deletePreviewPolicy')}</dt><dd class="mt-1 text-[var(--fm-text)]">{deletePolicyLabel()}</dd></div>
        <div class="sm:col-span-2"><dt class="text-xs text-[var(--fm-text-muted)]">{t('settings.deletePreviewRoute')}</dt><dd class="mt-1 text-[var(--fm-text)]">{routeLabel()}</dd></div>
      </dl>
      {#if address.last_error_code}<p class="flex gap-2 text-sm text-[var(--fm-danger)]"><AlertTriangle size={15} class="mt-0.5 shrink-0" aria-hidden="true" /> <span>{t('settings.lastSyncNeedsAttention')}</span></p>{/if}
    </section>
  {/if}

  {#if showActions && (onCheck || (onRetry && hasRetryableRoute()))}
    <footer class="sticky bottom-0 z-10 flex flex-wrap items-center justify-end gap-2 border-t border-[var(--fm-border)] bg-[var(--fm-surface)] pt-4">
      {#if onCheck}
        <Button size="sm" variant="secondary" loading={busy} onclick={() => onCheck?.()}>
          <RefreshCw size={14} aria-hidden="true" /> {t('settings.checkMailDomain')}
        </Button>
      {/if}
      {#if onRetry && hasRetryableRoute()}
        <Button size="sm" variant="secondary" loading={busy} onclick={() => onRetry?.()}>
          <RotateCw size={14} aria-hidden="true" /> {t('settings.retryRouting')}
        </Button>
      {/if}
    </footer>
  {/if}
</div>
