<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import { AlertTriangle, CheckCircle2, Mail, RefreshCw, RotateCw, ShieldAlert, Trash2 } from '@lucide/svelte';
  import Panel from '$lib/components/ui/Panel.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import TextField from '$lib/components/ui/TextField.svelte';
  import TextArea from '$lib/components/ui/TextArea.svelte';
  import Dialog from '$lib/components/ui/Dialog.svelte';
  import MailDomainSetup from './MailDomainSetup.svelte';
  import { requestJson } from '$lib/client/api';
  import { mailHealthState } from '$lib/domain/mail/health';
  import { mailSenderSendBlockReason } from '$lib/domain/mail/sender-readiness';
  import { summarizeDomainCapabilities, type DomainCapabilityState } from './domain-capabilities';
  import type { WorkspaceSnapshot } from '$lib/domain/mail';
  import { useLocale } from '$lib/i18n/runtime.svelte';

  type MailDomain = {
    id: string;
    domain_name: string;
    enabled: number;
    cloudflare_zone_id: string;
    worker_name: string;
    unknown_recipient_policy: 'reject' | 'collect';
    catch_all_target: 'unknown' | 'this_worker' | 'external' | 'drop' | 'none';
    resend_status: 'unknown' | 'pending' | 'verified' | 'failed';
    resend_sending_status: 'unknown' | 'enabled' | 'disabled';
    resend_checked_at: string | null;
    cloudflare_checked_at: string | null;
    cloudflare_check_expires_at: string | null;
    cloudflare_next_check_at: string | null;
    cloudflare_error_code: string | null;
    resend_check_expires_at: string | null;
    resend_next_check_at: string | null;
    resend_error_code: string | null;
    cloudflare_configured: boolean;
    resend_configured: boolean;
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
    delete_route_policy: 'remove_owned_route' | 'retain_reject_route' | 'preserve_imported_route' | null;
    last_error_code: string | null;
  };

  type RouteStatus = 'managed' | 'imported' | 'importable' | 'missing' | 'conflict' | 'duplicate' | 'deleted_route' | 'deleted_absent' | 'imported_preserved' | 'reject_route_preserved';
  type DeletePolicy = 'remove_owned_route' | 'retain_reject_route' | 'preserve_imported_route';
  type DeletePreview = {
    previewedAt: string;
    expiresAt: string;
    historyRetained: true;
    cloudflare: {
      state: 'verified' | 'unavailable';
      errorCode: string | null;
      route: { observation: 'managed_worker' | 'imported_worker' | 'absent' | 'external_rule' | 'conflict' | 'unknown'; source: 'api' | 'wrangler' | null; ruleId: string | null };
      catchAll: { target: MailDomain['catch_all_target']; checkedAt: string | null; fresh: boolean; live: boolean };
    };
    policies: Record<DeletePolicy, { available: boolean; action: string | null }>;
    recommendedPolicy: DeletePolicy | null;
    canConfirm: boolean;
  };
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
    view = 'addresses',
    initialDomainId = '',
    initialAddressLocalPart = '',
    onError,
    onOptionsChange,
    onCreateAddressForDomain,
    onSelectedDomainChange
  }: {
    view?: 'domains' | 'addresses';
    initialDomainId?: string;
    initialAddressLocalPart?: string;
    onError?: (error: unknown) => void;
    onOptionsChange?: (options: WorkspaceSnapshot['mailIdentityOptions']) => void;
    onCreateAddressForDomain?: (domainId: string, addressLocalPart: string) => void;
    onSelectedDomainChange?: (domainId: string) => void;
  } = $props();
  const { t } = useLocale();
  let domains = $state<MailDomain[]>([]);
  let addresses = $state<MailAddress[]>([]);
  let checks = $state<Record<string, DomainCheck>>({});
  let localPart = $state('');
  let selectedDomainId = $state('');
  let displayName = $state('');
  let signature = $state('');
  let quickCreateDomainId = $state('');
  let quickLocalPart = $state('');
  let quickCreateError = $state('');
  let quickCreateNoticeDomainId = $state('');
  let quickCreateNotice = $state('');
  let quickCreateNeedsAttention = $state(false);
  let loading = $state(true);
  let pendingAction = $state('');
  let errorMessage = $state('');
  let notice = $state('');
  let noticeNeedsAttention = $state(false);
  let onboarding = $state<{ available: boolean; workerName: string | null; canManageRouting: boolean }>({ available: false, workerName: null, canManageRouting: false });
  let domainSettingsTarget = $state<MailDomain | null>(null);
  let domainEnabled = $state(true);
  let unknownPolicy = $state<'reject' | 'collect'>('reject');
  let settingsError = $state('');
  let editAddressTarget = $state<MailAddress | null>(null);
  let editDisplayName = $state('');
  let editSignature = $state('');
  let deleteTarget = $state<MailAddress | null>(null);
  let deletePreview = $state<DeletePreview | null>(null);
  let deletePreviewLoading = $state(false);
  let deletePreviewError = $state('');
  let deletePolicy = $state<DeletePolicy>('remove_owned_route');

  const addressByDomain = $derived.by(() => {
    const grouped = new Map<string, MailAddress[]>();
    for (const address of addresses) {
      const current = grouped.get(address.domain_id) ?? [];
      current.push(address);
      grouped.set(address.domain_id, current);
    }
    return grouped;
  });

  $effect(() => {
    const requestedDomainId = initialDomainId;
    if (!requestedDomainId) return;
    untrack(() => {
      if (domains.some((domain) => domain.id === requestedDomainId && domain.enabled)) {
        selectedDomainId = requestedDomainId;
      }
    });
  });

  $effect(() => {
    const requestedLocalPart = initialAddressLocalPart;
    if (requestedLocalPart) untrack(() => { localPart = requestedLocalPart; });
  });

  async function load() {
    loading = true;
    errorMessage = '';
    try {
      const loaded = await requestJson<{
        domains: Omit<MailDomain, 'cloudflare_configured' | 'resend_configured'>[];
        addresses: MailAddress[];
        providerConfiguration: { cloudflare: boolean; resend: boolean };
        domainOnboarding?: typeof onboarding;
      }>('/api/workspace/mail-identities');
      onboarding = loaded.domainOnboarding ?? { available: false, workerName: null, canManageRouting: false };
      domains = loaded.domains.map((domain) => ({
        ...domain,
        cloudflare_configured: loaded.providerConfiguration.cloudflare,
        resend_configured: loaded.providerConfiguration.resend
      }));
      const loadedDomains = domains;
      addresses = loaded.addresses;
      onOptionsChange?.({
        domains: loadedDomains.map(({ id, domain_name }) => ({ id, domainName: domain_name })),
      addresses: loaded.addresses.map((address) => {
        const domain = loadedDomains.find((item) => item.id === address.domain_id);
          const readiness = {
            lifecycleStatus: address.lifecycle_status,
            sendEnabled: address.send_enabled === 1,
            domainEnabled: Boolean(domain?.enabled),
            resendStatus: domain?.resend_status ?? 'unknown',
            resendSendingStatus: domain?.resend_sending_status ?? 'unknown',
            resendCheckedAt: domain?.resend_checked_at ?? null,
            resendCheckFailed: Boolean(domain?.resend_error_code)
          } satisfies Omit<WorkspaceSnapshot['mailIdentityOptions']['addresses'][number],
            'id' | 'domainId' | 'email' | 'displayName' | 'isDefaultSender' | 'sendReady'>;
          return {
            id: address.id,
            domainId: address.domain_id,
            email: address.email,
            displayName: address.display_name,
            isDefaultSender: address.is_default_sender === 1,
            ...readiness,
            sendReady: mailSenderSendBlockReason(readiness) === null
          };
        })
      });
      if (!selectedDomainId || !domains.some((domain) => domain.id === selectedDomainId)) {
        selectedDomainId = domains.find((domain) => domain.id === initialDomainId && domain.enabled)?.id
          ?? domains.find((domain) => domain.enabled)?.id ?? domains[0]?.id ?? '';
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

  async function domainCreated(domainId: string) {
    selectedDomainId = domainId;
    notice = t('settings.mailDomainConnected');
    noticeNeedsAttention = false;
    await load();
  }

  function openDomainSettings(domain: MailDomain) {
    domainSettingsTarget = domain;
    domainEnabled = Boolean(domain.enabled);
    unknownPolicy = domain.unknown_recipient_policy;
    settingsError = '';
  }

  async function saveDomainSettings(event: SubmitEvent) {
    event.preventDefault();
    if (!domainSettingsTarget || pendingAction) return;
    pendingAction = 'domain-settings';
    settingsError = '';
    try {
      await requestJson(`/api/workspace/mail-identities/domains/${encodeURIComponent(domainSettingsTarget.id)}`, {
        method: 'PATCH', body: JSON.stringify({ enabled: domainEnabled, unknownRecipientPolicy: unknownPolicy })
      });
      domainSettingsTarget = null;
      notice = t('settings.domainSettingsSaved');
      noticeNeedsAttention = false;
      await load();
    } catch (error) { settingsError = error instanceof Error ? error.message : t('settings.mailIdentityActionFailed'); }
    finally { pendingAction = ''; }
  }

  function openAddressSettings(address: MailAddress) {
    editAddressTarget = address;
    editDisplayName = address.display_name;
    editSignature = address.signature;
    settingsError = '';
  }

  async function saveAddressSettings(event: SubmitEvent) {
    event.preventDefault();
    if (!editAddressTarget || pendingAction) return;
    pendingAction = 'address-settings';
    settingsError = '';
    try {
      await requestJson(`/api/workspace/mail-identities/${encodeURIComponent(editAddressTarget.id)}`, {
        method: 'PATCH', body: JSON.stringify({ displayName: editDisplayName, signature: editSignature })
      });
      editAddressTarget = null;
      notice = t('settings.addressSettingsSaved');
      noticeNeedsAttention = false;
      await load();
    } catch (error) { settingsError = error instanceof Error ? error.message : t('settings.mailIdentityActionFailed'); }
    finally { pendingAction = ''; }
  }

  function checkFor(domain: MailDomain, addressId: string): RouteStatus | undefined {
    return checks[domain.id]?.cloudflare.addresses.find((entry) => entry.addressId === addressId)?.status;
  }

  async function createAddress(event: SubmitEvent) {
    event.preventDefault();
    if (!selectedDomainId || !localPart.trim()) return;
    const requestedAddress = localPart.trim().toLowerCase();
    const domainName = domains.find((domain) => domain.id === selectedDomainId)?.domain_name.toLowerCase() ?? '';
    const expectedEmail = requestedAddress.includes('@') ? requestedAddress : `${requestedAddress}@${domainName}`;
    const existedBefore = addresses.some((address) => address.email.toLowerCase() === expectedEmail);
    pendingAction = 'create';
    errorMessage = '';
    notice = '';
    noticeNeedsAttention = false;
    try {
      const created = await requestJson<{ address: MailAddress }>('/api/workspace/mail-identities', {
        method: 'POST',
        body: JSON.stringify({ domainId: selectedDomainId, address: localPart, displayName, signature })
      });
      localPart = '';
      displayName = '';
      signature = '';
      noticeNeedsAttention = created.address.receive_enabled !== 1;
      notice = t(noticeNeedsAttention ? 'settings.mailAddressSavedNeedsAttention' : 'settings.mailAddressCreated');
      await load();
    } catch (error) {
      const message = error instanceof Error ? error.message : t('settings.mailIdentityActionFailed');
      onError?.(error);
      await load();
      if (!existedBefore && addresses.some((address) => address.email.toLowerCase() === expectedEmail)) {
        localPart = '';
        displayName = '';
        signature = '';
        notice = t('settings.mailAddressSavedNeedsAttention');
        noticeNeedsAttention = true;
      } else {
        errorMessage = message;
      }
    } finally {
      pendingAction = '';
    }
  }

  async function toggleQuickCreate(domainId: string) {
    const closing = quickCreateDomainId === domainId;
    quickCreateDomainId = closing ? '' : domainId;
    quickLocalPart = '';
    quickCreateError = '';
    quickCreateNoticeDomainId = '';
    quickCreateNotice = '';
    quickCreateNeedsAttention = false;
    await tick();
    document.getElementById(`${closing ? 'quick-create-trigger' : 'quick-address'}-${domainId}`)?.focus();
  }

  function handleQuickCreateKeydown(event: KeyboardEvent) {
    if (event.key !== 'Escape' || !quickCreateDomainId) return;
    const form = document.getElementById(`quick-create-form-${quickCreateDomainId}`);
    if (!form?.contains(event.target as Node)) return;
    event.preventDefault();
    void toggleQuickCreate(quickCreateDomainId);
  }

  function openFullAddressForm(domainId: string) {
    quickCreateDomainId = '';
    onCreateAddressForDomain?.(domainId, quickLocalPart.trim());
  }

  async function createQuickAddress(event: SubmitEvent, domain: MailDomain) {
    event.preventDefault();
    const requestedLocalPart = quickLocalPart.trim();
    if (!requestedLocalPart || pendingAction || !domain.enabled) return;
    if (requestedLocalPart.includes('@')) {
      quickCreateError = t('settings.quickAddressPrefixOnly');
      return;
    }
    const expectedEmail = `${requestedLocalPart.toLowerCase()}@${domain.domain_name.toLowerCase()}`;
    const existedBefore = addresses.some((address) => address.email.toLowerCase() === expectedEmail);
    if (existedBefore) {
      quickCreateError = t('settings.quickAddressAlreadyExists');
      return;
    }
    pendingAction = `quick-create:${domain.id}`;
    quickCreateError = '';
    quickCreateNoticeDomainId = '';
    quickCreateNotice = '';
    quickCreateNeedsAttention = false;
    let restoreTriggerFocus = false;
    try {
      const created = await requestJson<{ address: MailAddress }>('/api/workspace/mail-identities', {
        method: 'POST',
        body: JSON.stringify({ domainId: domain.id, address: requestedLocalPart })
      });
      await load();
      quickLocalPart = '';
      quickCreateDomainId = '';
      quickCreateNoticeDomainId = domain.id;
      quickCreateNeedsAttention = created.address.receive_enabled !== 1;
      quickCreateNotice = t(quickCreateNeedsAttention ? 'settings.mailAddressSavedNeedsAttention' : 'settings.mailAddressCreated');
      restoreTriggerFocus = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : t('settings.mailIdentityActionFailed');
      onError?.(error);
      await load();
      if (!existedBefore && addresses.some((address) => address.email.toLowerCase() === expectedEmail)) {
        quickLocalPart = '';
        quickCreateDomainId = '';
        quickCreateError = '';
        quickCreateNoticeDomainId = domain.id;
        quickCreateNotice = t('settings.mailAddressSavedNeedsAttention');
        quickCreateNeedsAttention = true;
        restoreTriggerFocus = true;
      } else {
        quickCreateError = message;
      }
    } finally {
      pendingAction = '';
      if (restoreTriggerFocus) {
        await tick();
        document.getElementById(`quick-create-trigger-${domain.id}`)?.focus();
      }
    }
  }

  async function checkDomain(domain: MailDomain) {
    pendingAction = 'check:' + domain.id;
    errorMessage = '';
    notice = '';
    noticeNeedsAttention = false;
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
    noticeNeedsAttention = false;
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
    if (!deletePreview || Date.parse(deletePreview.expiresAt) <= Date.now()) {
      await openDeletePreview(address);
      return;
    }
    if (!deletePreview.canConfirm || !deletePreview.policies[deletePolicy].available) return;
    pendingAction = `${address.id}:delete`;
    errorMessage = '';
    notice = '';
    noticeNeedsAttention = false;
    try {
      const result = await requestJson<{ remoteRuleStatus: string }>(`/api/workspace/mail-identities/${encodeURIComponent(address.id)}`, {
        method: 'DELETE',
        body: JSON.stringify({ confirm: 'delete', policy: deletePolicy })
      });
      deleteTarget = null;
      notice = result.remoteRuleStatus === 'retained_for_rejection'
        ? t('settings.deleteAddressRouteRetained')
        : result.remoteRuleStatus === 'preserved_unverified'
          ? t('settings.deleteAddressImportedPreserved')
          : result.remoteRuleStatus === 'removed'
            ? t('settings.deleteAddressRuleRemoved')
            : t('settings.mailAddressDeleted');
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

  async function openDeletePreview(address: MailAddress) {
    deleteTarget = address;
    deletePreview = null;
    deletePreviewError = '';
    deletePreviewLoading = true;
    try {
      const result = await requestJson<{ preview: DeletePreview }>(
        `/api/workspace/mail-identities/${encodeURIComponent(address.id)}/delete-preview`
      );
      deletePreview = result.preview;
      deletePolicy = result.preview.recommendedPolicy ?? (address.routing_owner === 'imported'
        ? 'preserve_imported_route' : 'remove_owned_route');
    } catch (error) {
      deletePreviewError = error instanceof Error ? error.message : t('settings.deletePreviewUnavailable');
      onError?.(error);
    } finally {
      deletePreviewLoading = false;
    }
  }

  function closeDeletePreview() {
    if (pendingAction.endsWith(':delete')) return;
    deleteTarget = null;
    deletePreview = null;
    deletePreviewError = '';
  }

  function deleteRouteLabel(preview: DeletePreview) {
    const labels: Record<DeletePreview['cloudflare']['route']['observation'], string> = {
      managed_worker: t('settings.deletePreviewManagedRoute'),
      imported_worker: t('settings.deletePreviewImportedRoute'),
      absent: t('settings.deletePreviewNoRoute'),
      external_rule: t('settings.deletePreviewExternalRoute'),
      conflict: t('settings.deletePreviewRouteConflict'),
      unknown: t('settings.deletePreviewRouteUnknown')
    };
    return labels[preview.cloudflare.route.observation];
  }

  function deleteCatchAllLabel(preview: DeletePreview) {
    const labels: Record<MailDomain['catch_all_target'], string> = {
      unknown: t('settings.catchAllUnknown'), this_worker: t('settings.catchAllWorker'),
      external: t('settings.catchAllExternal'), drop: t('settings.catchAllDrop'), none: t('settings.catchAllDisabled')
    };
    return labels[preview.cloudflare.catchAll.target];
  }

  function canConfirmDelete() {
    return Boolean(deletePreview?.canConfirm && deletePreview.policies[deletePolicy].available &&
      Date.parse(deletePreview.expiresAt) > Date.now() && !deletePreviewLoading && !pendingAction.endsWith(':delete'));
  }

  function statusLabel(status: RouteStatus | MailAddress['routing_state']) {
    const labels: Record<string, string> = {
      managed: t('settings.routeManaged'), imported: t('settings.routeImported'), importable: t('settings.routeImportable'),
      missing: t('settings.routeMissing'), conflict: t('settings.routeConflict'), duplicate: t('settings.routeDuplicate'),
      deleted_route: t('settings.routeStillPresent'), reject_route_preserved: t('settings.deletedRejectRoutePreserved'),
      deleted_absent: t('settings.deletedRouteAbsent'), imported_preserved: t('settings.importedRuleRetained'),
      pending: t('settings.routePending'), provisioning: t('settings.routeProvisioning'),
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

  function healthLabel(domain: MailDomain, provider: 'cloudflare' | 'resend') {
    const isCloudflare = provider === 'cloudflare';
    const state = mailHealthState({
      configured: isCloudflare ? domain.cloudflare_configured : domain.resend_configured,
      checkedAt: isCloudflare ? domain.cloudflare_checked_at : domain.resend_checked_at,
      leaseExpiresAt: isCloudflare ? domain.cloudflare_check_expires_at : domain.resend_check_expires_at,
      errorCode: isCloudflare ? domain.cloudflare_error_code : domain.resend_error_code
    });
    if (state === 'fresh') return t('settings.mailHealthFresh');
    if (state === 'refreshing') return t('settings.mailHealthRefreshing');
    if (state === 'degraded') return t('settings.mailHealthDegraded');
    if (state === 'not_configured') return t('settings.mailHealthNotConfigured');
    return isCloudflare && !domain.cloudflare_checked_at ? t('settings.statusNotChecked') : t('settings.mailHealthStale');
  }

  function nextHealthCheck(domain: MailDomain, provider: 'cloudflare' | 'resend') {
    return provider === 'cloudflare' ? domain.cloudflare_next_check_at : domain.resend_next_check_at;
  }

  function canSendFrom(address: MailAddress) {
    const domain = domains.find((item) => item.id === address.domain_id);
    return mailSenderSendBlockReason({
      lifecycleStatus: address.lifecycle_status,
      sendEnabled: address.send_enabled === 1,
      domainEnabled: Boolean(domain?.enabled),
      resendStatus: domain?.resend_status ?? 'unknown',
      resendSendingStatus: domain?.resend_sending_status ?? 'unknown',
      resendCheckedAt: domain?.resend_checked_at ?? null,
      resendCheckFailed: Boolean(domain?.resend_error_code)
    }) === null;
  }

  function capabilitiesFor(domain: MailDomain, domainAddresses: MailAddress[]) {
    return summarizeDomainCapabilities({
      enabled: Boolean(domain.enabled),
      cloudflareHealth: mailHealthState({
        configured: domain.cloudflare_configured,
        checkedAt: domain.cloudflare_checked_at,
        leaseExpiresAt: domain.cloudflare_check_expires_at,
        errorCode: domain.cloudflare_error_code
      }),
      catchAllCollects: domain.unknown_recipient_policy === 'collect' &&
        (checks[domain.id]?.cloudflare.catchAllTarget ?? domain.catch_all_target) === 'this_worker',
      resendStatus: domain.resend_status,
      resendSendingStatus: domain.resend_sending_status,
      resendCheckedAt: domain.resend_checked_at,
      resendCheckFailed: Boolean(domain.resend_error_code),
      addresses: domainAddresses.map((address) => ({
        lifecycleStatus: address.lifecycle_status,
        routingState: address.routing_state,
        receiveEnabled: address.receive_enabled === 1,
        sendEnabled: address.send_enabled === 1
      }))
    });
  }

  function capabilityLabel(state: DomainCapabilityState) {
    return state === 'ready' ? t('settings.ready') :
      state === 'needs_check' ? t('settings.statusNeedsCheck') : t('settings.notReady');
  }

</script>

<svelte:window onkeydown={handleQuickCreateKeydown} />

<Panel class="mx-auto max-w-[72rem]" title={view === 'domains' ? t('settings.domainDashboard') : t('settings.mailIdentities')} description={view === 'domains' ? t('settings.domainDashboardDescription') : t('settings.mailIdentitiesDescription')}>
  {#if errorMessage}<p class="message error" role="alert">{errorMessage}</p>{/if}
  {#if notice}<p class="message" class:success={!noticeNeedsAttention} class:attention={noticeNeedsAttention} role="status" aria-live="polite">{notice}</p>{/if}

  {#if loading}
    <p class="muted" role="status">{t('common.loading')}</p>
  {:else}
    {#if view === 'domains' || domains.length === 0}
      <MailDomainSetup available={onboarding.available} workerName={onboarding.workerName} onCreated={domainCreated} onRefresh={load} />
    {/if}
    {#if !onboarding.canManageRouting}
      <p class="setup-hint" role="status">{t('settings.routingManagementMissing')}</p>
    {/if}
    {#if domains.length === 0}
    <p class="muted">{t('settings.noMailDomains')}</p>
    {:else}
    {#if view === 'addresses'}
    <form class="create-form" onsubmit={createAddress}>
      <div class="form-title"><Mail size={16} aria-hidden="true" /><strong>{t('settings.addMailAddress')}</strong></div>
      <div class="create-grid">
        <label class="field-label" for="mail-identity-domain">{t('settings.mailDomain')}</label>
        <select id="mail-identity-domain" bind:value={selectedDomainId} disabled={pendingAction === 'create'} onchange={(event) => onSelectedDomainChange?.(event.currentTarget.value)}>
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
    {/if}

    <div class="domain-list">
      {#each domains as domain (domain.id)}
        {@const domainAddresses = addressByDomain.get(domain.id) ?? []}
        {@const check = checks[domain.id]}
        {@const capabilities = capabilitiesFor(domain, domainAddresses)}
        <section class="domain-card" aria-labelledby={`domain-title-${domain.id}`}>
          <header class="domain-header">
            <div class="domain-heading">
              <h3 id={`domain-title-${domain.id}`}>{domain.domain_name}</h3>
              <p>{domain.enabled ? t('settings.enabled') : t('settings.disabled')} · {t('settings.catchAll')}: {catchAllLabel(domain)}</p>
            </div>
            <div class="domain-header-actions">
              {#if view === 'domains'}
                <Button variant="secondary" size="sm" disabled={Boolean(pendingAction)} onclick={() => openDomainSettings(domain)}>{t('settings.domainSettings')}</Button>
                <Button id={`quick-create-trigger-${domain.id}`} variant="secondary" size="sm" disabled={!domain.enabled || Boolean(pendingAction)} ariaExpanded={quickCreateDomainId === domain.id} ariaControls={quickCreateDomainId === domain.id ? `quick-create-form-${domain.id}` : undefined} onclick={() => void toggleQuickCreate(domain.id)}>{t('settings.createAddressForDomain')}</Button>
                <Button variant="secondary" size="sm" loading={pendingAction === 'check:' + domain.id} onclick={() => void checkDomain(domain)}>
                  <RefreshCw size={14} aria-hidden="true" /> {t('settings.checkMailDomain')}
                </Button>
              {/if}
            </div>
          </header>
          {#if view === 'domains' && quickCreateDomainId === domain.id}
            <form id={`quick-create-form-${domain.id}`} class="quick-create-form" onsubmit={(event) => void createQuickAddress(event, domain)}>
              <div class="quick-address-field">
                <TextField id={`quick-address-${domain.id}`} label={`${t('settings.quickAddressLocalPart')} (@${domain.domain_name})`} value={quickLocalPart} error={quickCreateError} maxlength={64} required disabled={Boolean(pendingAction)} autocomplete="off" placeholder="hello" oninput={(event) => { quickLocalPart = event.currentTarget.value; quickCreateError = ''; }} />
                <span class="quick-address-domain" aria-hidden="true">@{domain.domain_name}</span>
              </div>
              <div class="quick-create-actions">
                <Button type="submit" size="sm" loading={pendingAction === `quick-create:${domain.id}`} disabled={!quickLocalPart.trim() || Boolean(pendingAction)}>{t('settings.createMailAddress')}</Button>
                <Button variant="ghost" size="sm" disabled={Boolean(pendingAction)} onclick={() => openFullAddressForm(domain.id)}>{t('settings.quickAddressDetails')}</Button>
                <Button variant="ghost" size="sm" disabled={Boolean(pendingAction)} onclick={() => void toggleQuickCreate(domain.id)}>{t('common.cancel')}</Button>
              </div>
            </form>
          {/if}
          {#if view === 'domains' && quickCreateNoticeDomainId === domain.id}
            <p class:attention={quickCreateNeedsAttention} class="quick-create-notice" role="status">{quickCreateNotice}</p>
          {/if}
          {#if view === 'domains'}
          <dl class="capability-summary" aria-label={t('settings.domainCapabilities')}>
            <div>
              <dt>{t('settings.receive')}</dt>
              <dd class:ready={capabilities.receiving === 'ready'} class:attention={capabilities.receiving === 'needs_check'}>
                {#if capabilities.receiving === 'ready'}<CheckCircle2 size={16} aria-hidden="true" />{:else}<AlertTriangle size={16} aria-hidden="true" />{/if}
                {capabilityLabel(capabilities.receiving)}
              </dd>
            </div>
            <div>
              <dt>{t('settings.send')}</dt>
              <dd class:ready={capabilities.sending === 'ready'} class:attention={capabilities.sending === 'needs_check'}>
                {#if capabilities.sending === 'ready'}<CheckCircle2 size={16} aria-hidden="true" />{:else}<AlertTriangle size={16} aria-hidden="true" />{/if}
                {capabilityLabel(capabilities.sending)}
              </dd>
            </div>
          </dl>
          <dl class="domain-status">
            <div>
              <dt>Cloudflare</dt>
              <dd>{healthLabel(domain, 'cloudflare')}{#if nextHealthCheck(domain, 'cloudflare')}<small>{t('settings.mailHealthNextCheck')}: {nextHealthCheck(domain, 'cloudflare')}</small>{/if}</dd>
            </div>
            <div>
              <dt>Resend</dt>
              <dd>{resendLabel(domain)} · {healthLabel(domain, 'resend')}{#if nextHealthCheck(domain, 'resend')}<small>{t('settings.mailHealthNextCheck')}: {nextHealthCheck(domain, 'resend')}</small>{/if}</dd>
            </div>
            <div><dt>{t('settings.unknownRecipients')}</dt><dd>{domain.unknown_recipient_policy === 'collect' ? t('settings.unknownCollect') : t('settings.unknownReject')}</dd></div>
          </dl>

          {#if check?.cloudflare.catchAllTarget === 'external' || domain.catch_all_target === 'external'}
            <p class="warning"><AlertTriangle size={15} aria-hidden="true" /> {t('settings.externalCatchAllRisk')}</p>
          {:else if domain.unknown_recipient_policy === 'collect' && (check?.cloudflare.catchAllTarget ?? domain.catch_all_target) !== 'this_worker'}
            <p class="warning"><ShieldAlert size={15} aria-hidden="true" /> {t('settings.collectRequiresWorkerCatchAll')}</p>
          {/if}
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
                  {#if view === 'addresses'}
                  <div class="address-actions" aria-label={t('settings.mailAddressActions')}>
                    {#if address.lifecycle_status !== 'deleted'}
                      <Button size="sm" variant="secondary" disabled={Boolean(pendingAction)} onclick={() => openAddressSettings(address)}>{t('settings.editAddressDetails')}</Button>
                    {/if}
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
                      <Button size="sm" variant="ghost" ariaLabel={t('settings.deleteAddress')} onclick={() => void openDeletePreview(address)}><Trash2 size={14} aria-hidden="true" /><span class="sr-only">{t('settings.deleteAddress')}</span></Button>
                    {/if}
                  </div>
                  {/if}
                </li>
              {/each}
            </ul>
          {/if}
          {#if domain.last_error_code}<p class="safe-error">{t('settings.lastSyncNeedsAttention')}</p>{/if}
        </section>
      {/each}
    </div>
    {/if}
  {/if}
</Panel>

{#if domainSettingsTarget}
  <Dialog open title={t('settings.domainSettings')} description={domainSettingsTarget.domain_name} dismissible={!pendingAction} onClose={() => domainSettingsTarget = null}>
    <form class="identity-settings-form" onsubmit={saveDomainSettings}>
      <p class="muted">{t('settings.domainMappingLocked')}</p>
      <label><input type="checkbox" bind:checked={domainEnabled} disabled={Boolean(pendingAction)} /> {t('settings.domainEnabled')}</label>
      <p class="muted">{t('settings.domainDisableHelp')}</p>
      <label for="domain-unknown-policy">{t('settings.unknownRecipients')}</label>
      <select id="domain-unknown-policy" bind:value={unknownPolicy} disabled={Boolean(pendingAction)}>
        <option value="reject">{t('settings.unknownReject')}</option>
        <option value="collect">{t('settings.unknownCollect')}</option>
      </select>
      <p class="muted">{t('settings.collectRequiresWorkerCatchAll')}</p>
      {#if settingsError}<p class="message error" role="alert">{settingsError}</p>{/if}
      <Button type="submit" loading={pendingAction === 'domain-settings'}>{t('settings.saveIdentitySettings')}</Button>
    </form>
  </Dialog>
{/if}

{#if editAddressTarget}
  <Dialog open title={t('settings.editAddressDetails')} description={editAddressTarget.email} dismissible={!pendingAction} onClose={() => editAddressTarget = null}>
    <form class="identity-settings-form" onsubmit={saveAddressSettings}>
      <TextField id="edit-address-name" label={t('settings.mailAddressDisplayName')} value={editDisplayName} maxlength={128} disabled={Boolean(pendingAction)} oninput={(event) => editDisplayName = event.currentTarget.value} />
      <TextArea id="edit-address-signature" label={t('settings.mailAddressSignature')} value={editSignature} rows={5} disabled={Boolean(pendingAction)} oninput={(event) => editSignature = event.currentTarget.value} />
      {#if settingsError}<p class="message error" role="alert">{settingsError}</p>{/if}
      <Button type="submit" loading={pendingAction === 'address-settings'}>{t('settings.saveIdentitySettings')}</Button>
    </form>
  </Dialog>
{/if}

{#if deleteTarget}
  <Dialog
    open
    id="delete-mail-address"
    title={t('settings.deleteAddressTitle')}
    description={t('settings.deletePreviewDescription', { email: deleteTarget.email })}
    size="lg"
    dismissible={!pendingAction.endsWith(':delete')}
    closeOnBackdrop={!pendingAction.endsWith(':delete')}
    onClose={closeDeletePreview}
  >
    {#snippet children()}
      {#if deletePreviewLoading}
        <p role="status" class="preview-note">{t('settings.deletePreviewLoading')}</p>
      {:else if deletePreviewError}
        <p role="alert" class="preview-warning">{deletePreviewError}</p>
      {:else if deletePreview}
        <div class="delete-preview">
          <p>{t('settings.mailAddressHistoryRetained')}</p>
          <dl>
            <div><dt>{t('settings.deletePreviewRoute')}</dt><dd>{deleteRouteLabel(deletePreview)}</dd></div>
            <div><dt>{t('settings.catchAll')}</dt><dd>{deleteCatchAllLabel(deletePreview)} · {deletePreview.cloudflare.catchAll.live ? t('settings.deletePreviewLive') : deletePreview.cloudflare.catchAll.fresh ? t('settings.deletePreviewCachedFresh') : t('settings.deletePreviewStale')}</dd></div>
            {#if deletePreview.cloudflare.catchAll.checkedAt}<div><dt>{t('settings.deletePreviewCheckedAt')}</dt><dd>{deletePreview.cloudflare.catchAll.checkedAt}</dd></div>{/if}
          </dl>
          {#if deletePreview.cloudflare.catchAll.target === 'external' || !deletePreview.cloudflare.catchAll.fresh || !deletePreview.cloudflare.catchAll.live}
            <p class="preview-warning">{t('settings.deletePreviewCatchAllWarning')}</p>
          {/if}
          {#if deletePreview.cloudflare.errorCode}<p class="preview-note">{t('settings.deletePreviewProviderIssue', { code: deletePreview.cloudflare.errorCode })}</p>{/if}
          {#if deletePreview.policies.retain_reject_route.available || deletePreview.policies.remove_owned_route.available}
            <fieldset>
              <legend>{t('settings.deletePreviewPolicy')}</legend>
              {#if deletePreview.policies.retain_reject_route.available}
                <label><input type="radio" name="mail-address-delete-policy" value="retain_reject_route" bind:group={deletePolicy} />
                  <span><strong>{t('settings.deletePolicyRetainLabel')}</strong><small>{t('settings.deletePolicyRetainDescription')}</small></span>
                </label>
              {/if}
              {#if deletePreview.policies.remove_owned_route.available}
                <label><input type="radio" name="mail-address-delete-policy" value="remove_owned_route" bind:group={deletePolicy} />
                  <span><strong>{t('settings.deletePolicyRemoveLabel')}</strong><small>{t('settings.deletePolicyRemoveDescription')}</small></span>
                </label>
              {/if}
            </fieldset>
          {:else if deletePreview.policies.preserve_imported_route.available}
            <p>{t('settings.deletePolicyImportedDescription')}</p>
          {:else}
            <p class="preview-warning">{t('settings.deletePreviewCannotConfirm')}</p>
          {/if}
          {#if deletePreview.cloudflare.catchAll.target === 'external'}
            <p class="preview-warning">{t('settings.externalCatchAllDeleteRisk')}</p>
          {/if}
        </div>
      {/if}
    {/snippet}
    {#snippet footer()}
      <Button variant="ghost" disabled={pendingAction.endsWith(':delete')} onclick={closeDeletePreview}>{t('common.cancel')}</Button>
      <Button variant="danger" loading={pendingAction.endsWith(':delete')} disabled={!canConfirmDelete()} onclick={deleteAddress}>{t('settings.deleteAddress')}</Button>
    {/snippet}
  </Dialog>
{/if}

<style>
  .identity-settings-form { display: grid; gap: 0.75rem; }
  .message { margin: 0 0 var(--space-3); font-size: 13px; }
  .error, .safe-error { color: var(--fm-danger); }
  .success { color: var(--fm-success); }
  .attention { color: var(--fm-warning); }
  .muted, .setup-hint { color: var(--fm-text-muted); font-size: 13px; }
  .create-form { display: grid; gap: var(--space-3); padding: var(--space-4); border: 1px solid var(--fm-border); border-radius: var(--radius-md); background: var(--fm-surface-subtle); }
  .form-title { display: flex; align-items: center; gap: var(--space-2); font-size: 13px; }
  .create-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: end; gap: var(--space-3); }
  .field-label { display: block; min-width: 0; font-size: 12px; color: var(--fm-text-secondary); }
  select { width: 100%; min-height: 40px; margin-top: 5px; padding: 0 10px; border: 1px solid var(--fm-border); border-radius: var(--radius-md); color: var(--fm-text); background: var(--fm-surface); }
  .signature-field { grid-column: 1 / -1; }
  .domain-list { display: grid; gap: var(--space-3); margin-top: var(--space-4); }
  .domain-card { min-width: 0; padding: var(--space-4); border: 1px solid var(--fm-border); border-radius: var(--radius-md); }
  .domain-header { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-3); }
  .domain-header-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--space-2); }
  .domain-heading { min-width: 0; }
  .domain-heading h3 { margin: 0; overflow-wrap: anywhere; font-size: 14px; font-weight: 650; }
  .domain-heading p { margin: 4px 0 0; color: var(--fm-text-muted); font-size: 12px; }
  .quick-create-form { display: grid; gap: var(--space-2); margin-top: var(--space-3); padding: var(--space-3); border: 1px solid var(--fm-border); border-radius: var(--radius-md); background: var(--fm-surface-subtle); }
  .quick-address-field { display: flex; min-width: 0; align-items: end; gap: var(--space-2); }
  .quick-address-field :global(label) { flex: 1; min-width: 0; }
  .quick-address-domain { flex: 0 1 auto; min-width: 0; max-width: 50%; min-height: 40px; display: inline-flex; align-items: center; color: var(--fm-text-secondary); font-size: 13px; overflow-wrap: anywhere; }
  .quick-create-actions { display: flex; flex-wrap: wrap; gap: var(--space-2); }
  .quick-create-notice { margin: var(--space-3) 0 0; color: var(--fm-success); font-size: 12px; }
  .quick-create-notice.attention { color: var(--fm-warning); }
  .capability-summary { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-3); margin: var(--space-3) 0 0; padding: var(--space-3) 0; border-block: 1px solid var(--fm-border); }
  .capability-summary > div { display: flex; min-width: 0; align-items: center; justify-content: space-between; gap: var(--space-3); }
  .capability-summary dt { color: var(--fm-text-secondary); font-size: 13px; font-weight: 600; }
  .capability-summary dd { display: inline-flex; align-items: center; gap: var(--space-1); margin: 0; color: var(--fm-danger); font-size: 13px; font-weight: 600; white-space: nowrap; }
  .capability-summary dd.ready { color: var(--fm-success); }
  .capability-summary dd.attention { color: var(--fm-warning); }
  .domain-status { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px 16px; margin: 0 0 var(--space-3); padding: var(--space-3) 0; border-bottom: 1px solid var(--fm-border); font-size: 12px; }
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
  .delete-preview { display: grid; gap: var(--space-3); color: var(--fm-text-secondary); font-size: 13px; }
  .delete-preview dl { display: grid; gap: var(--space-2); }
  .delete-preview dl > div { display: grid; grid-template-columns: minmax(7rem, 1fr) 2fr; gap: var(--space-2); }
  .delete-preview dt { color: var(--fm-text-muted); }
  .delete-preview dd { min-width: 0; overflow-wrap: anywhere; color: var(--fm-text); }
  .delete-preview fieldset { display: grid; gap: var(--space-2); border: 1px solid var(--fm-border); border-radius: var(--radius-md); padding: var(--space-3); }
  .delete-preview legend { padding: 0 var(--space-1); font-weight: 600; color: var(--fm-text); }
  .delete-preview label { display: flex; align-items: flex-start; gap: var(--space-2); cursor: pointer; }
  .delete-preview label span { display: grid; gap: 2px; }
  .delete-preview label small, .preview-note { color: var(--fm-text-muted); }
  .preview-warning { color: var(--fm-danger); }
  @media (max-width: 720px) {
    .create-grid { grid-template-columns: minmax(0, 1fr); }
    .signature-field { grid-column: auto; }
    .domain-header { flex-direction: column; align-items: stretch; }
    .domain-header-actions { justify-content: flex-start; }
    .quick-address-field { flex-direction: column; align-items: stretch; }
    .quick-address-domain { max-width: 100%; min-height: 0; }
    .quick-create-actions :global(button:first-child) { flex: 1 0 100%; }
    .quick-create-actions :global(button:not(:first-child)) { flex: 1; }
    .capability-summary { grid-template-columns: minmax(0, 1fr); }
    .domain-status { grid-template-columns: minmax(0, 1fr); }
    .address-list li { grid-template-columns: minmax(0, 1fr) auto; }
    .address-state { grid-column: 1; justify-content: flex-start; }
    .address-actions { grid-column: 1 / -1; justify-content: flex-start; }
  }
</style>
