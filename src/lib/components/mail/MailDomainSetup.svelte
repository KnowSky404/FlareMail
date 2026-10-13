<script lang="ts">
  import { onMount } from 'svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import TextField from '$lib/components/ui/TextField.svelte';
  import { ClientApiError, requestJson } from '$lib/client/api';
  import { AUTH_EXPIRED_EVENT, isClientAuthExpired } from '$lib/client/auth-session';
  import type { MailDomain } from './mail-resource-types';
  import { useLocale } from '$lib/i18n/runtime.svelte';

  type DomainSummary = Omit<MailDomain, 'cloudflare_configured' | 'resend_configured'>;
  type DomainWriteResult = {
    domainId: string | null;
    domain?: DomainSummary;
    /** True when the POST response was unavailable and a safe GET found the row. */
    reconciled: boolean;
    unknown: boolean;
    refreshError?: unknown;
  };
  type FormState = { canSubmit: boolean; pending: boolean; unknownWrite: boolean };

  let {
    available,
    workerName,
    busy = false,
    error,
    onCreated,
    onRefresh,
    onError,
    onDirtyChange,
    onPendingChange,
    onFormStateChange,
    onWriteResult,
    idPrefix = 'new-mail',
    formId = 'mail-domain-setup-form',
    hideActions = false
  }: {
    available: boolean;
    workerName: string | null;
    /** Parent controlled busy state, for example while the surrounding dialog refreshes. */
    busy?: boolean;
    /** Parent supplied error, rendered without discarding the draft. */
    error?: string;
    onCreated: (domainId: string, domain?: DomainSummary) => void | Promise<void>;
    onRefresh: () => void | Promise<void>;
    onError?: (error: unknown) => void;
    onDirtyChange?: (dirty: boolean) => void;
    onPendingChange?: (pending: boolean) => void;
    onFormStateChange?: (state: FormState) => void;
    onWriteResult?: (result: DomainWriteResult) => void | Promise<void>;
    idPrefix?: string;
    formId?: string;
    hideActions?: boolean;
  } = $props();
  const { t } = useLocale();
  let domainName = $state('');
  let zoneId = $state('');
  let pending = $state(false);
  let refreshing = $state(false);
  let verifying = $state(false);
  let unknownWrite = $state(false);
  let errorMessage = $state('');
  let sessionEpoch = 0;
  const dirty = $derived(Boolean(domainName || zoneId));
  const internalBusy = $derived(pending || refreshing || verifying);
  const isBusy = $derived(internalBusy || busy);
  const canSubmit = $derived(available && !isBusy && !unknownWrite && Boolean(domainName.trim()) && Boolean(zoneId.trim()));
  const visibleError = $derived(error || errorMessage);

  $effect(() => {
    onDirtyChange?.(dirty);
  });

  $effect(() => {
    onPendingChange?.(internalBusy);
  });

  $effect(() => {
    onFormStateChange?.({ canSubmit, pending: internalBusy, unknownWrite });
  });

  onMount(() => {
    const expire = () => {
      sessionEpoch += 1;
      if (pending || verifying) {
        unknownWrite = true;
        errorMessage = t('settings.writeOutcomeUnknown');
      }
    };
    window.addEventListener(AUTH_EXPIRED_EVENT, expire);
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, expire);
  });

  function clearDraft() {
    domainName = '';
    zoneId = '';
    errorMessage = '';
  }

  async function refreshConfiguration() {
    if (isBusy) return;
    refreshing = true;
    try {
      await onRefresh();
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : t('settings.mailIdentityActionFailed');
      onError?.(error);
    } finally {
      refreshing = false;
    }
  }

  function normalizeDomain(value: string) {
    const source = value.trim().replace(/\.$/u, '');
    try {
      return new URL(`https://${source}`).hostname.toLowerCase().replace(/\.$/u, '');
    } catch {
      return source.toLowerCase();
    }
  }

  function matchesRequestedDomain(item: DomainSummary, domain: string, zone: string) {
    return normalizeDomain(item.domain_name) === normalizeDomain(domain) &&
      item.cloudflare_zone_id.trim().toLowerCase() === zone.trim().toLowerCase();
  }

  function isUncertain(error: unknown) {
    if (!(error instanceof ClientApiError)) return true;
    return error.code === 'AUTH_SESSION_EXPIRED' || error.code === 'INVALID_RESPONSE' || error.status === 0 || error.status >= 500;
  }

  function currentSession(epoch: number) {
    return epoch === sessionEpoch && !isClientAuthExpired();
  }

  async function notifyWriteResult(result: DomainWriteResult) {
    try {
      await onWriteResult?.(result);
    } catch (error) {
      onError?.(error);
    }
  }

  async function finishCreated(domainId: string, reconciled: boolean, domain?: DomainSummary) {
    clearDraft();
    unknownWrite = false;
    let refreshError: unknown;
    try {
      await onCreated(domainId, domain);
    } catch (error) {
      refreshError = error;
      onError?.(error);
    }
    await notifyWriteResult({ domainId, domain, reconciled, unknown: false, ...(refreshError ? { refreshError } : {}) });
  }

  async function verifyWriteOutcome() {
    if (isBusy || !unknownWrite) return;
    verifying = true;
    errorMessage = t('settings.verifyWriteOutcome');
    const epoch = sessionEpoch;
    try {
      const result = await requestJson<{ domains: DomainSummary[] }>('/api/workspace/mail-identities');
      if (!currentSession(epoch)) {
        errorMessage = t('settings.writeOutcomeUnknown');
        return;
      }
      const matched = result.domains.find((item) => matchesRequestedDomain(item, domainName, zoneId));
      if (matched) {
        await finishCreated(matched.id, true, matched);
        return;
      }
      unknownWrite = false;
      errorMessage = t('settings.writeVerifiedMissing');
      await notifyWriteResult({ domainId: null, reconciled: false, unknown: false });
    } catch (error) {
      errorMessage = t('settings.writeOutcomeUnknown');
      onError?.(error);
      await notifyWriteResult({ domainId: null, reconciled: false, unknown: true, refreshError: error });
    } finally {
      verifying = false;
    }
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (isBusy || unknownWrite || !available) return;
    const requestedDomain = domainName.trim();
    const requestedZone = zoneId.trim();
    pending = true;
    errorMessage = '';
    unknownWrite = false;
    const epoch = sessionEpoch;
    try {
      const result = await requestJson<{ domain: DomainSummary }>('/api/workspace/mail-identities/domains', {
        method: 'POST', body: JSON.stringify({ domainName: requestedDomain, zoneId: requestedZone })
      });
      if (!currentSession(epoch)) {
        unknownWrite = true;
        errorMessage = t('settings.writeOutcomeUnknown');
        await notifyWriteResult({ domainId: result.domain.id, domain: result.domain, reconciled: false, unknown: true });
        return;
      }
      await finishCreated(result.domain.id, false, result.domain);
    } catch (error) {
      if (!currentSession(epoch) || isUncertain(error)) {
        unknownWrite = true;
        errorMessage = t('settings.writeOutcomeUnknown');
        await notifyWriteResult({ domainId: null, reconciled: false, unknown: true, refreshError: error });
        onError?.(error);
        return;
      }
      errorMessage = error instanceof Error ? error.message : t('settings.mailIdentityActionFailed');
      onError?.(error);
    } finally { pending = false; }
  }
</script>

<form id={formId} class="domain-setup" class:in-dialog={hideActions} onsubmit={submit} aria-label={t('settings.addMailDomain')}>
  {#if !hideActions}<strong>{t('settings.addMailDomain')}</strong>{/if}
  <p>{t('settings.domainSetupDescription')}</p>
  {#if !available}
    <p class="configuration-notice" role="status">{t(workerName ? 'settings.domainReadPermissionMissing' : 'settings.domainWorkerMissing')}</p>
    {#if !hideActions}<Button variant="secondary" loading={refreshing} disabled={isBusy} onclick={() => void refreshConfiguration()}>{t('settings.refreshDomainConfiguration')}</Button>{/if}
  {/if}
  <div class="fields">
    <TextField id={`${idPrefix}-domain`} label={t('settings.domainName')} value={domainName} placeholder="example.com" required maxlength={253} disabled={isBusy || unknownWrite || !available} oninput={(event) => { domainName = event.currentTarget.value; errorMessage = ''; }} />
    <TextField id={`${idPrefix}-zone`} label={t('settings.domainZoneId')} value={zoneId} placeholder={t('settings.domainZonePlaceholder')} required maxlength={32} disabled={isBusy || unknownWrite || !available} oninput={(event) => { zoneId = event.currentTarget.value; errorMessage = ''; }} />
  </div>
  <p>{t('settings.domainZoneHelp')}</p>
  {#if visibleError}<p class="error" role="alert">{visibleError}</p>{/if}
  {#if unknownWrite}
    <Button type="button" variant="secondary" loading={verifying} disabled={isBusy} onclick={() => void verifyWriteOutcome()}>{t('settings.verifyWriteOutcome')}</Button>
  {:else if !hideActions}
    <Button type="submit" loading={pending} disabled={!canSubmit}>{t('settings.connectMailDomain')}</Button>
  {/if}
</form>

<style>
  .domain-setup { display: grid; gap: 0.75rem; padding: 1rem; border: 1px solid var(--fm-border); border-radius: 0.75rem; }
  .domain-setup.in-dialog { padding: 0; border: 0; border-radius: 0; }
  .fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem; }
  p { margin: 0; font-size: 0.8rem; line-height: 1.6; color: var(--fm-text-muted); overflow-wrap: anywhere; }
  .configuration-notice { color: var(--fm-text); }
  .error { color: var(--fm-danger); }
  @media (max-width: 640px) { .fields { grid-template-columns: minmax(0, 1fr); } }
</style>
