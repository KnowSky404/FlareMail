<script lang="ts">
  import { onMount } from 'svelte';
  import { AlertTriangle, CheckCircle2, Mail, RefreshCw, RotateCw, ShieldAlert, Trash2 } from '@lucide/svelte';
  import Panel from '$lib/components/ui/Panel.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import TextField from '$lib/components/ui/TextField.svelte';
  import TextArea from '$lib/components/ui/TextArea.svelte';
  import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte';
  import { requestJson } from '$lib/client/api';
  import { useLocale } from '$lib/i18n/runtime.svelte';

  type MailDomain = {
    id: string;
    domain_name: string;
    enabled: number;
    unknown_recipient_policy: 'reject' | 'collect';
    catch_all_target: 'unknown' | 'this_worker' | 'external' | 'drop' | 'none';
    resend_status: 'unknown' | 'pending' | 'verified' | 'failed';
    resend_sending_status: 'unknown' | 'enabled' | 'disabled';
    resend_checked_at: string | null;
    cloudflare_checked_at: string | null;
    last_error_code: string | null;
  };

  type MailAddress = {
    id: string;
    domain_id: string;
    email: string;
    display_name: string;
    signature: string;
    receive_enabled: number;
    send_enabled: number;
    is_default_sender: number;
    lifecycle_status: 'active' | 'disabled' | 'deleted';
    routing_state: 'pending' | 'provisioning' | 'active' | 'deleting' | 'imported' | 'unknown' | 'error' | 'deleted';
    routing_owner: 'flaremail' | 'imported' | null;
    last_error_code: string | null;
  };

  type RouteStatus = 'managed' | 'imported' | 'importable' | 'missing' | 'conflict' | 'duplicate' | 'deleted_route';
  type DomainCheck = {
    cloudflare: {
      state: 'ready' | 'error';
      errorCode: string | null;
      catchAllEnabled: boolean | null;
      catchAllTarget: MailDomain['catch_all_target'];
      checkedAt: string | null;
      addresses: Array<{ addressId: string; status: RouteStatus }>;
    };
    resend: { state: 'verified' | 'pending' | 'failed' | 'missing' | 'not_configured' | 'error' };
  };

  let {
    onError,
    onOptionsChange
  }: {
    onError?: (error: unknown) => void;
    onOptionsChange?: (options: {
      domains: Array<{ id: string; domainName: string }>;
      addresses: Array<{
        id: string; domainId: string; email: string; displayName: string; lifecycleStatus: 'active' | 'disabled' | 'deleted';
        sendEnabled: boolean; isDefaultSender: boolean; sendReady: boolean;
      }>;
    }) => void;
  } = $props();
  const { t } = useLocale();
  let domains = $state<MailDomain[]>([]);
  let addresses = $state<MailAddress[]>([]);
  let checks = $state<Record<string, DomainCheck>>({});
  let localPart = $state('');
  let selectedDomainId = $state('');
  let displayName = $state('');
  let signature = $state('');
  let loading = $state(true);
  let pendingAction = $state('');
  let errorMessage = $state('');
  let notice = $state('');
  let deleteTarget = $state<MailAddress | null>(null);

  const addressByDomain = $derived.by(() => {
    const grouped = new Map<string, MailAddress[]>();
    for (const address of addresses) {
      const current = grouped.get(address.domain_id) ?? [];
      current.push(address);
      grouped.set(address.domain_id, current);
    }
    return grouped;
  });

  async function load() {
    loading = true;
    errorMessage = '';
    try {
      const result = await requestJson<{ domains: MailDomain[]; addresses: MailAddress[] }>('/api/workspace/mail-identities');
      domains = result.domains;
      addresses = result.addresses;
      onOptionsChange?.({
        domains: result.domains.map(({ id, domain_name }) => ({ id, domainName: domain_name })),
        addresses: result.addresses.map((address) => {
          const domain = result.domains.find((item) => item.id === address.domain_id);
          const checkedAt = domain?.resend_checked_at ? Date.parse(domain.resend_checked_at) : Number.NaN;
          const recentCheck = Number.isFinite(checkedAt) && checkedAt <= Date.now() && Date.now() - checkedAt <= 24 * 60 * 60 * 1000;
          return {
            id: address.id,
            domainId: address.domain_id,
            email: address.email,
            displayName: address.display_name,
            lifecycleStatus: address.lifecycle_status,
            sendEnabled: address.send_enabled === 1,
            isDefaultSender: address.is_default_sender === 1,
            sendReady: Boolean(domain?.enabled && address.send_enabled && address.lifecycle_status === 'active' &&
              domain.resend_status === 'verified' && domain.resend_sending_status === 'enabled' && recentCheck)
          };
        })
      });
      if (!selectedDomainId || !domains.some((domain) => domain.id === selectedDomainId)) {
        selectedDomainId = domains.find((domain) => domain.enabled)?.id ?? domains[0]?.id ?? '';
      }
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : t('settings.mailIdentityLoadFailed');
      onError?.(error);
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void load();
  });

  function checkFor(domain: MailDomain, addressId: string): RouteStatus | undefined {
    return checks[domain.id]?.cloudflare.addresses.find((entry) => entry.addressId === addressId)?.status;
  }

  async function createAddress(event: SubmitEvent) {
    event.preventDefault();
    if (!selectedDomainId || !localPart.trim()) return;
    pendingAction = 'create';
    errorMessage = '';
    notice = '';
    try {
      await requestJson('/api/workspace/mail-identities', {
        method: 'POST',
        body: JSON.stringify({ domainId: selectedDomainId, address: localPart, displayName, signature })
      });
      localPart = '';
      displayName = '';
      signature = '';
      notice = t('settings.mailAddressCreated');
      await load();
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : t('settings.mailIdentityActionFailed');
      onError?.(error);
      const message = errorMessage;
      await load();
      errorMessage = message;
    } finally {
      pendingAction = '';
    }
  }

  async function checkDomain(domain: MailDomain) {
    pendingAction = 'check:' + domain.id;
    errorMessage = '';
    notice = '';
    try {
      const result = await requestJson<{ check: DomainCheck }>(
        `/api/workspace/mail-identities/domains/${encodeURIComponent(domain.id)}/check`,
        { method: 'POST', body: '{}' }
      );
      checks = { ...checks, [domain.id]: result.check };
      notice = result.check.cloudflare.state === 'ready'
        ? t('settings.mailIdentityCheckComplete')
        : t('settings.mailIdentityCheckIncomplete');
      await load();
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : t('settings.mailIdentityActionFailed');
      onError?.(error);
    } finally {
      pendingAction = '';
    }
  }

  async function runAction(address: MailAddress, action: 'disable' | 'enable' | 'import' | 'restore' | 'retry' | 'enable_send' | 'disable_send' | 'make_default') {
    pendingAction = `${address.id}:${action}`;
    errorMessage = '';
    notice = '';
    try {
      await requestJson(`/api/workspace/mail-identities/${encodeURIComponent(address.id)}`, {
        method: 'POST',
        body: JSON.stringify({ action })
      });
      notice = t('settings.mailIdentityActionComplete');
      await load();
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : t('settings.mailIdentityActionFailed');
      onError?.(error);
      const message = errorMessage;
      await load();
      errorMessage = message;
    } finally {
      pendingAction = '';
    }
  }

  async function deleteAddress() {
    const address = deleteTarget;
    if (!address) return;
    pendingAction = `${address.id}:delete`;
    errorMessage = '';
    notice = '';
    try {
      await requestJson(`/api/workspace/mail-identities/${encodeURIComponent(address.id)}`, {
        method: 'DELETE',
        body: JSON.stringify({ confirm: 'delete' })
      });
      deleteTarget = null;
      notice = t('settings.mailAddressDeleted');
      await load();
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : t('settings.mailIdentityActionFailed');
      onError?.(error);
      const message = errorMessage;
      await load();
      errorMessage = message;
    } finally {
      pendingAction = '';
    }
  }

  function statusLabel(status: RouteStatus | MailAddress['routing_state']) {
    const labels: Record<string, string> = {
      managed: t('settings.routeManaged'), imported: t('settings.routeImported'), importable: t('settings.routeImportable'),
      missing: t('settings.routeMissing'), conflict: t('settings.routeConflict'), duplicate: t('settings.routeDuplicate'),
      deleted_route: t('settings.routeStillPresent'), pending: t('settings.routePending'), provisioning: t('settings.routeProvisioning'),
      active: t('settings.routeActive'), deleting: t('settings.routeDeleting'), unknown: t('settings.routeUnknown'), error: t('settings.routeError'), deleted: t('settings.routeDeleted')
    };
    return labels[status] ?? status;
  }

  function catchAllLabel(domain: MailDomain) {
    const target = checks[domain.id]?.cloudflare.catchAllTarget ?? domain.catch_all_target;
    const labels = {
      unknown: t('settings.catchAllUnknown'), this_worker: t('settings.catchAllWorker'),
      external: t('settings.catchAllExternal'), drop: t('settings.catchAllDrop'), none: t('settings.catchAllDisabled')
    };
    return labels[target];
  }

  function resendLabel(domain: MailDomain) {
    const state = checks[domain.id]?.resend.state;
    if (state === 'verified' || (!state && domain.resend_status === 'verified')) return t('settings.resendVerified');
    if (state === 'failed' || (!state && domain.resend_status === 'failed')) return t('settings.resendFailed');
    if (state === 'missing') return t('settings.resendMissing');
    if (state === 'not_configured') return t('settings.resendNotConfigured');
    if (state === 'error') return t('settings.resendCheckFailed');
    if (state === 'pending' || (!state && domain.resend_status === 'pending')) return t('settings.resendPending');
    return t('settings.resendUnknown');
  }

  function canSendFrom(address: MailAddress) {
    const domain = domains.find((item) => item.id === address.domain_id);
    const checkedAt = domain?.resend_checked_at ? Date.parse(domain.resend_checked_at) : Number.NaN;
    const now = Date.now();
    const recentCheck = Number.isFinite(checkedAt) && checkedAt <= now && now - checkedAt <= 24 * 60 * 60 * 1000;
    return Boolean(address.lifecycle_status === 'active' && address.send_enabled && domain?.enabled &&
      domain.resend_status === 'verified' && domain.resend_sending_status === 'enabled' && recentCheck);
  }

  function deleteDescription(address: MailAddress) {
    const domain = domains.find((item) => item.id === address.domain_id);
    const externalRisk = domain && (checks[domain.id]?.cloudflare.catchAllTarget ?? domain.catch_all_target) === 'external';
    const importedRoute = address.routing_owner === 'imported';
    return [
      t('settings.mailAddressHistoryRetained'),
      importedRoute ? t('settings.importedRuleRetained') : '',
      externalRisk ? t('settings.externalCatchAllDeleteRisk') : ''
    ].filter(Boolean).join(' ');
  }
</script>

<Panel title={t('settings.mailIdentities')} description={t('settings.mailIdentitiesDescription')}>
  {#if errorMessage}<p class="message error" role="alert">{errorMessage}</p>{/if}
  {#if notice}<p class="message success" role="status" aria-live="polite">{notice}</p>{/if}

  {#if loading}
    <p class="muted" role="status">{t('common.loading')}</p>
  {:else if domains.length === 0}
    <p class="muted">{t('settings.noMailDomains')}</p>
    <p class="setup-hint">{t('settings.mailDomainSetupHint')} <code>bun run mail:domain:configure</code></p>
  {:else}
    <form class="create-form" onsubmit={createAddress}>
      <div class="form-title"><Mail size={16} aria-hidden="true" /><strong>{t('settings.addMailAddress')}</strong></div>
      <div class="create-grid">
        <label class="field-label" for="mail-identity-domain">{t('settings.mailDomain')}</label>
        <select id="mail-identity-domain" bind:value={selectedDomainId} disabled={pendingAction === 'create'}>
          {#each domains as domain (domain.id)}
            <option value={domain.id} disabled={!domain.enabled}>{domain.domain_name}</option>
          {/each}
        </select>
        <TextField id="mail-identity-address" label={t('settings.mailAddress')} value={localPart} required disabled={pendingAction === 'create'} placeholder="hello or hello@example.com" oninput={(event) => (localPart = event.currentTarget.value)} />
        <TextField id="mail-identity-name" label={t('settings.mailAddressDisplayName')} value={displayName} disabled={pendingAction === 'create'} oninput={(event) => (displayName = event.currentTarget.value)} />
        <div class="signature-field"><TextArea id="mail-identity-signature" label={t('settings.mailAddressSignature')} value={signature} rows={2} disabled={pendingAction === 'create'} oninput={(event) => (signature = event.currentTarget.value)} /></div>
        <Button type="submit" loading={pendingAction === 'create'} disabled={!selectedDomainId || !localPart.trim()}>{t('settings.createMailAddress')}</Button>
      </div>
    </form>

    <div class="domain-list">
      {#each domains as domain (domain.id)}
        {@const domainAddresses = addressByDomain.get(domain.id) ?? []}
        {@const check = checks[domain.id]}
        <section class="domain-card" aria-labelledby={`domain-title-${domain.id}`}>
          <header class="domain-header">
            <div class="domain-heading">
              <h3 id={`domain-title-${domain.id}`}>{domain.domain_name}</h3>
              <p>{domain.enabled ? t('settings.enabled') : t('settings.disabled')} · {t('settings.catchAll')}: {catchAllLabel(domain)}</p>
            </div>
            <Button variant="secondary" size="sm" loading={pendingAction === 'check:' + domain.id} onclick={() => void checkDomain(domain)}>
              <RefreshCw size={14} aria-hidden="true" /> {t('settings.checkMailDomain')}
            </Button>
          </header>
          <dl class="domain-status">
            <div><dt>Cloudflare</dt><dd>{check?.cloudflare.state === 'ready' ? t('settings.statusChecked') : domain.cloudflare_checked_at ? t('settings.statusNeedsCheck') : t('settings.statusNotChecked')}</dd></div>
            <div><dt>Resend</dt><dd>{resendLabel(domain)}</dd></div>
            <div><dt>{t('settings.send')}</dt><dd>{domain.resend_sending_status === 'enabled' ? t('settings.ready') : t('settings.notReady')}</dd></div>
            <div><dt>{t('settings.unknownRecipients')}</dt><dd>{domain.unknown_recipient_policy === 'collect' ? t('settings.unknownCollect') : t('settings.unknownReject')}</dd></div>
          </dl>

          {#if check?.cloudflare.catchAllTarget === 'external' || domain.catch_all_target === 'external'}
            <p class="warning"><AlertTriangle size={15} aria-hidden="true" /> {t('settings.externalCatchAllRisk')}</p>
          {:else if domain.unknown_recipient_policy === 'collect' && (check?.cloudflare.catchAllTarget ?? domain.catch_all_target) !== 'this_worker'}
            <p class="warning"><ShieldAlert size={15} aria-hidden="true" /> {t('settings.collectRequiresWorkerCatchAll')}</p>
          {/if}

          {#if domainAddresses.length === 0}
            <p class="muted empty-addresses">{t('settings.noMailAddresses')}</p>
          {:else}
            <ul class="address-list" aria-label={t('settings.managedMailAddresses')}>
              {#each domainAddresses as address (address.id)}
                {@const route = checkFor(domain, address.id)}
                <li class:deleted={address.lifecycle_status === 'deleted'}>
                  <div class="address-info">
                    <strong>{address.email}</strong>
                    {#if address.display_name}<span>{address.display_name}</span>{/if}
                  </div>
                  <div class="address-state">
                    <span class="pill" class:success={address.receive_enabled === 1} class:danger={address.routing_state === 'error' || route === 'conflict' || route === 'duplicate'}>
                      {address.lifecycle_status === 'deleted' ? t('settings.routeDeleted') : address.receive_enabled ? t('settings.receiveEnabled') : t('settings.receiveDisabled')}
                    </span>
                    <span class="pill" class:success={canSendFrom(address)}>{address.is_default_sender ? t('settings.defaultSender') : address.send_enabled ? t('settings.sendEnabled') : t('settings.sendDisabled')}</span>
                    <span class="route-state">{statusLabel(route ?? address.routing_state)}</span>
                    {#if address.last_error_code}<span class="safe-error">{t('settings.lastSyncNeedsAttention')}</span>{/if}
                  </div>
                  <div class="address-actions" aria-label={t('settings.mailAddressActions')}>
                    {#if route === 'importable' && address.lifecycle_status !== 'deleted'}
                      <Button size="sm" variant="secondary" loading={pendingAction === `${address.id}:import`} onclick={() => void runAction(address, 'import')}><CheckCircle2 size={14} aria-hidden="true" /> {t('settings.importRule')}</Button>
                    {/if}
                    {#if address.lifecycle_status === 'active'}
                      <Button size="sm" variant="ghost" loading={pendingAction === `${address.id}:disable`} onclick={() => void runAction(address, 'disable')}>{t('settings.disableAddress')}</Button>
                    {:else if address.lifecycle_status === 'disabled'}
                      <Button size="sm" variant="secondary" loading={pendingAction === `${address.id}:enable`} onclick={() => void runAction(address, 'enable')}>{t('settings.enableAddress')}</Button>
                    {:else}
                      <Button size="sm" variant="secondary" loading={pendingAction === `${address.id}:restore`} onclick={() => void runAction(address, 'restore')}>{t('settings.restoreAddress')}</Button>
                    {/if}
                    {#if address.lifecycle_status === 'active'}
                      {#if address.send_enabled}
                        <Button size="sm" variant="ghost" loading={pendingAction === `${address.id}:disable_send`} onclick={() => void runAction(address, 'disable_send')}>{t('settings.disableSending')}</Button>
                        {#if !address.is_default_sender}
                          <Button size="sm" variant="secondary" disabled={!canSendFrom(address)} loading={pendingAction === `${address.id}:make_default`} onclick={() => void runAction(address, 'make_default')}>{t('settings.setDefaultSender')}</Button>
                        {/if}
                      {:else}
                        <Button size="sm" variant="secondary" disabled={!canSendFrom({ ...address, send_enabled: 1 })} loading={pendingAction === `${address.id}:enable_send`} onclick={() => void runAction(address, 'enable_send')}>{t('settings.enableSending')}</Button>
                      {/if}
                    {/if}
                    {#if address.routing_state === 'error' || address.routing_state === 'unknown' || address.routing_state === 'pending' || address.routing_state === 'deleting'}
                      <Button size="sm" variant="ghost" loading={pendingAction === `${address.id}:retry`} onclick={() => void runAction(address, 'retry')}><RotateCw size={14} aria-hidden="true" /> {t('settings.retryRouting')}</Button>
                    {/if}
                    {#if address.lifecycle_status !== 'deleted'}
                      <Button size="sm" variant="ghost" ariaLabel={t('settings.deleteAddress')} onclick={() => (deleteTarget = address)}><Trash2 size={14} aria-hidden="true" /><span class="sr-only">{t('settings.deleteAddress')}</span></Button>
                    {/if}
                  </div>
                </li>
              {/each}
            </ul>
          {/if}
          {#if domain.last_error_code}<p class="safe-error">{t('settings.lastSyncNeedsAttention')}</p>{/if}
        </section>
      {/each}
    </div>
  {/if}
</Panel>

{#if deleteTarget}
  <ConfirmDialog
    open
    id="delete-mail-address"
    title={t('settings.deleteAddressTitle')}
    description={deleteDescription(deleteTarget)}
    confirmLabel={t('settings.deleteAddress')}
    cancelLabel={t('common.cancel')}
    pending={pendingAction === `${deleteTarget.id}:delete`}
    onConfirm={deleteAddress}
    onCancel={() => (deleteTarget = null)}
  />
{/if}

<style>
  .message { margin: 0 0 var(--space-3); font-size: 13px; }
  .error, .safe-error { color: var(--fm-danger); }
  .success { color: var(--fm-success); }
  .muted, .setup-hint { color: var(--fm-text-muted); font-size: 13px; }
  .setup-hint code { overflow-wrap: anywhere; }
  .create-form { display: grid; gap: var(--space-3); padding: var(--space-4); border: 1px solid var(--fm-border); border-radius: var(--radius-md); background: var(--fm-surface-subtle); }
  .form-title { display: flex; align-items: center; gap: var(--space-2); font-size: 13px; }
  .create-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: end; gap: var(--space-3); }
  .field-label { display: block; min-width: 0; font-size: 12px; color: var(--fm-text-secondary); }
  select { width: 100%; min-height: 40px; margin-top: 5px; padding: 0 10px; border: 1px solid var(--fm-border); border-radius: var(--radius-md); color: var(--fm-text); background: var(--fm-surface); }
  .signature-field { grid-column: 1 / -1; }
  .domain-list { display: grid; gap: var(--space-3); margin-top: var(--space-4); }
  .domain-card { min-width: 0; padding: var(--space-4); border: 1px solid var(--fm-border); border-radius: var(--radius-md); }
  .domain-header { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-3); }
  .domain-heading { min-width: 0; }
  .domain-heading h3 { margin: 0; overflow-wrap: anywhere; font-size: 14px; font-weight: 650; }
  .domain-heading p { margin: 4px 0 0; color: var(--fm-text-muted); font-size: 12px; }
  .domain-status { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px 16px; margin: var(--space-3) 0; padding: var(--space-3) 0; border-block: 1px solid var(--fm-border); font-size: 12px; }
  .domain-status div { display: flex; justify-content: space-between; gap: 8px; }
  .domain-status dt { color: var(--fm-text-muted); }
  .domain-status dd { margin: 0; color: var(--fm-text); text-align: right; }
  .warning { display: flex; align-items: flex-start; gap: 7px; margin: 0 0 var(--space-3); color: var(--fm-warning); font-size: 12px; }
  .warning :global(svg) { flex: none; margin-top: 1px; }
  .empty-addresses { margin: 0; }
  .address-list { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
  .address-list li { display: grid; grid-template-columns: minmax(0, 1fr) minmax(120px, auto) auto; align-items: center; gap: 10px; min-width: 0; padding-top: 8px; }
  .address-list li + li { border-top: 1px solid var(--fm-border); }
  .address-list li.deleted { opacity: .76; }
  .address-info { display: grid; min-width: 0; gap: 2px; }
  .address-info strong { overflow-wrap: anywhere; font-size: 13px; font-weight: 600; }
  .address-info span, .route-state { color: var(--fm-text-muted); font-size: 11px; }
  .address-state { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 5px; }
  .pill { border-radius: var(--radius-pill); padding: 2px 7px; color: var(--fm-text-secondary); background: var(--fm-surface-subtle); font-size: 10px; white-space: nowrap; }
  .pill.success { color: var(--fm-success); }
  .pill.danger { color: var(--fm-danger); }
  .address-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 4px; }
  .safe-error { margin: 4px 0 0; font-size: 11px; }
  @media (max-width: 720px) {
    .create-grid { grid-template-columns: minmax(0, 1fr); }
    .signature-field { grid-column: auto; }
    .domain-header { align-items: flex-start; }
    .domain-header :global(button) { flex: none; }
    .address-list li { grid-template-columns: minmax(0, 1fr) auto; }
    .address-state { grid-column: 1; justify-content: flex-start; }
    .address-actions { grid-column: 1 / -1; justify-content: flex-start; }
  }
</style>
