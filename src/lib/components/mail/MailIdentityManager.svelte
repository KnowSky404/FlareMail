<script lang="ts">
  import { onMount } from 'svelte';
  import { AlertTriangle, ChevronLeft, ChevronRight, MoreHorizontal, Pencil, Plus, RefreshCw } from '@lucide/svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import IconButton from '$lib/components/ui/IconButton.svelte';
  import TextField from '$lib/components/ui/TextField.svelte';
  import TextArea from '$lib/components/ui/TextArea.svelte';
  import Dialog from '$lib/components/ui/Dialog.svelte';
  import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte';
  import DropdownMenu from '$lib/components/ui/DropdownMenu.svelte';
  import Skeleton from '$lib/components/ui/Skeleton.svelte';
  import MailDomainSetup from './MailDomainSetup.svelte';
  import MailIdentityDiagnostics from './MailIdentityDiagnostics.svelte';
  import { ClientApiError, requestJson } from '$lib/client/api';
  import { AUTH_EXPIRED_EVENT, isClientAuthExpired } from '$lib/client/auth-session';
  import { LatestRequest } from '$lib/client/latest-request';
  import { filterMailDomains, filterMailAddresses, paginateMailResources, type MailDomainStatusFilter, type MailAddressLifecycleFilter } from '$lib/client/mail-resource-list';
  import { mailHealthState } from '$lib/domain/mail/health';
  import { mailSenderSendBlockReason } from '$lib/domain/mail/sender-readiness';
  import { summarizeDomainCapabilities, type DomainCapabilityState } from './domain-capabilities';
  import type { MailDomain, MailAddress, DomainCheck, DeletePreview, DeletePolicy, RouteStatus } from './mail-resource-types';
  import type { WorkspaceSnapshot } from '$lib/domain/mail';
  import { useLocale } from '$lib/i18n/runtime.svelte';

  let { view = 'addresses', initialDomainId = '', onError, onOptionsChange, onViewAddressesForDomain,
    onSelectedDomainChange, onNavigationGuardChange }: {
    view?: 'domains' | 'addresses'; initialDomainId?: string;
    onError?: (error: unknown) => void;
    onOptionsChange?: (options: WorkspaceSnapshot['mailIdentityOptions']) => void;
    onViewAddressesForDomain?: (domainId: string) => void;
    onSelectedDomainChange?: (domainId: string) => void;
    onNavigationGuardChange?: (guard: ((proceed: () => void) => boolean) | null) => void;
  } = $props();
  const { t } = useLocale();
  let domains = $state<MailDomain[]>([]);
  let addresses = $state<MailAddress[]>([]);
  let checks = $state<Record<string, Partial<DomainCheck>>>({});
  let loading = $state(true);
  let loadedOnce = $state(false);
  let pendingAction = $state('');
  let errorMessage = $state('');
  let notice = $state('');
  let noticeNeedsAttention = $state(false);
  let syncNotice = $state('');
  let syncError = $state('');
  let providerConfiguration = $state({ cloudflare: false, resend: false });
  let onboarding = $state({ available: false, workerName: null as string | null, canManageRouting: false });
  let domainSearch = $state('');
  let addressSearch = $state('');
  let domainStatus = $state<MailDomainStatusFilter>('all');
  let addressStatus = $state<MailAddressLifecycleFilter>('current');
  let domainFilter = $state('');
  let pageNumber = $state(1);
  let sortDescending = $state(false);
  let createAddressOpen = $state(false);
  let addDomainOpen = $state(false);
  let domainSetupDirty = $state(false);
  let domainSetupBusy = $state(false);
  let domainFormCanSubmit = $state(false);
  let selectedDomainId = $state('');
  let localPart = $state('');
  let displayName = $state('');
  let signature = $state('');
  let createSeedDomainId = $state('');
  let createError = $state('');
  let createFoundAddressId = $state('');
  let createAttempt = $state<{ domainId: string; email: string; displayName: string; signature: string } | null>(null);
  let createExistingConflict = $state(false);
  let unresolvedAddressActions = $state<Record<string, boolean>>({});
  let unresolvedDomainChecks = $state<Record<string, boolean>>({});
  let unknownWrite = $state(false);
  let domainSettingsTarget = $state<MailDomain | null>(null);
  let domainEnabled = $state(true);
  let unknownPolicy = $state<'reject' | 'collect'>('reject');
  let editAddressTarget = $state<MailAddress | null>(null);
  let editDisplayName = $state('');
  let editSignature = $state('');
  let settingsError = $state('');
  let diagnosticsDomainId = $state('');
  let diagnosticsAddressId = $state('');
  let syncOpen = $state(false);
  let discardOpen = $state(false);
  let discardAction: (() => void) | null = null;
  let restoreFocusElement = $state<HTMLElement | null>(null);
  let deleteTarget = $state<MailAddress | null>(null);
  let deletePreview = $state<DeletePreview | null>(null);
  let deletePreviewLoading = $state(false);
  let deletePreviewError = $state('');
  let deletePolicy = $state<DeletePolicy>('remove_owned_route');
  let now = $state(Date.now());
  let deleteExpiryTimer: ReturnType<typeof setTimeout> | undefined;
  let sessionEpoch = 0;
  const loadRequests = new LatestRequest();
  const deleteRequests = new LatestRequest();
  const busy = $derived(Boolean(pendingAction) || domainSetupBusy);
  const dirty = $derived(domainSetupDirty || (createAddressOpen && (selectedDomainId !== createSeedDomainId || Boolean(localPart || displayName || signature))) ||
    (domainSettingsTarget !== null && (domainEnabled !== Boolean(domainSettingsTarget.enabled) || unknownPolicy !== domainSettingsTarget.unknown_recipient_policy)) ||
    (editAddressTarget !== null && (editDisplayName !== editAddressTarget.display_name || editSignature !== editAddressTarget.signature)));
  const hasDialog = $derived(createAddressOpen || addDomainOpen || Boolean(domainSettingsTarget || editAddressTarget || deleteTarget || diagnosticsDomainId) || syncOpen);
  const availableDomains = $derived(domains.filter((domain) => domain.enabled));
  const invalidDomainFilter = $derived(Boolean(domainFilter) && loadedOnce && !domains.some((domain) => domain.id === domainFilter));
  const visibleDomains = $derived(filterMailDomains(domains, domainSearch, domainStatus).sort((a, b) => (sortDescending ? -1 : 1) * a.domain_name.localeCompare(b.domain_name)));
  const visibleAddresses = $derived(filterMailAddresses(addresses, { search: addressSearch, domainId: domainFilter, lifecycle: addressStatus }).sort((a, b) => (sortDescending ? -1 : 1) * a.email.localeCompare(b.email)));
  const domainPage = $derived(paginateMailResources(visibleDomains, pageNumber, 25));
  const addressPage = $derived(paginateMailResources(visibleAddresses, pageNumber, 25));
  const currentPage = $derived(view === 'domains' ? domainPage : addressPage);
  const totalResources = $derived(view === 'domains' ? domains.length : addresses.filter((address) => addressStatus === 'deleted' ? address.lifecycle_status === 'deleted' : addressStatus === 'all' || address.lifecycle_status !== 'deleted').length);
  const diagnosticsDomain = $derived(domains.find((domain) => domain.id === diagnosticsDomainId));
  const diagnosticsAddress = $derived(addresses.find((address) => address.id === diagnosticsAddressId));
  const title = $derived(view === 'domains' ? t('shell.domains') : t('shell.addresses'));
  const expectedEmail = $derived(`${localPart.trim().toLowerCase()}@${domains.find((domain) => domain.id === selectedDomainId)?.domain_name ?? '…'}`);

  $effect(() => { domainFilter = initialDomainId; pageNumber = 1; });
  $effect(() => { view; pageNumber = 1; });
  $effect(() => { if (loadedOnce && pageNumber !== currentPage.page) pageNumber = currentPage.page; });
  $effect(() => {
    onNavigationGuardChange?.((proceed) => {
      if (!hasDialog) return true;
      if (busy) return false;
      if (!dirty) {
        closeAll();
        return true;
      }
      requestClose(() => { closeAll(); proceed(); });
      return false;
    });
    return () => onNavigationGuardChange?.(null);
  });

  type Identities = { domains: Omit<MailDomain, 'cloudflare_configured' | 'resend_configured'>[]; addresses: MailAddress[];
    providerConfiguration: { cloudflare: boolean; resend: boolean }; domainOnboarding?: typeof onboarding };

  type FreshCheck = DomainCheck & { resend: DomainCheck['resend'] & { checkedAt: string | null } };
  type LoadOptions = { preserveCheck?: { domainId: string; check: FreshCheck } };

  async function load(options: LoadOptions = {}): Promise<boolean> {
    const request = loadRequests.begin();
    loading = true;
    errorMessage = '';
    try {
      const loaded = await requestJson<Identities>('/api/workspace/mail-identities', { signal: request.signal });
      if (!request.isCurrent()) return false;
      providerConfiguration = loaded.providerConfiguration;
      onboarding = loaded.domainOnboarding ?? { available: false, workerName: null, canManageRouting: false };
      domains = loaded.domains.map((domain) => ({ ...domain, cloudflare_configured: loaded.providerConfiguration.cloudflare, resend_configured: loaded.providerConfiguration.resend }));
      addresses = loaded.addresses;
      loadedOnce = true;
      checks = {};
      const preserved = options.preserveCheck;
      if (preserved) {
        const domain = domains.find((item) => item.id === preserved.domainId);
        if (domain) {
          const current: Partial<DomainCheck> = {};
          if (preserved.check.cloudflare.checkedAt === domain.cloudflare_checked_at) current.cloudflare = preserved.check.cloudflare;
          if (preserved.check.resend.checkedAt === domain.resend_checked_at) current.resend = preserved.check.resend;
          if (current.cloudflare || current.resend) checks = { [preserved.domainId]: current };
        }
      }
      unresolvedAddressActions = {};
      unresolvedDomainChecks = {};
      publishOptions();
      return true;
    } catch (error) {
      if (!request.isCurrent()) return false;
      errorMessage = t(loadedOnce ? 'settings.refreshFailedKept' : 'settings.loadFailedRetry');
      onError?.(error);
      return false;
    } finally { if (request.isCurrent()) loading = false; }
  }

  function publishOptions() {
    onOptionsChange?.({
        domains: domains.map(({ id, domain_name }) => ({ id, domainName: domain_name })),
        addresses: addresses.map((address) => {
          const domain = domains.find((item) => item.id === address.domain_id);
          const readiness = { lifecycleStatus: address.lifecycle_status, sendEnabled: address.send_enabled === 1,
            domainEnabled: Boolean(domain?.enabled), resendStatus: domain?.resend_status ?? 'unknown',
            resendSendingStatus: domain?.resend_sending_status ?? 'unknown', resendCheckedAt: domain?.resend_checked_at ?? null,
            resendCheckFailed: Boolean(domain?.resend_error_code) };
          return { id: address.id, domainId: address.domain_id, email: address.email, displayName: address.display_name,
            isDefaultSender: address.is_default_sender === 1, ...readiness, sendReady: mailSenderSendBlockReason(readiness, now) === null };
        })
      });
  }

  onMount(() => {
    void load();
    const interval = setInterval(() => { now = Date.now(); if (loadedOnce) publishOptions(); }, 30_000);
    const expire = () => { sessionEpoch++; loadRequests.cancel(); loading = false; };
    window.addEventListener(AUTH_EXPIRED_EVENT, expire);
    return () => { clearInterval(interval); clearTimeout(deleteExpiryTimer); loadRequests.cancel(); deleteRequests.cancel(); window.removeEventListener(AUTH_EXPIRED_EVENT, expire); };
  });

  function beforeUnload(event: BeforeUnloadEvent) {
    if (!dirty && !busy) return;
    event.preventDefault(); event.returnValue = '';
  }
  function captureTrigger(event?: MouseEvent) {
    const target = event?.currentTarget;
    restoreFocusElement = target instanceof HTMLElement
      ? (target.getAttribute('role') === 'menuitem' ? target.closest('[data-resource-actions]')?.querySelector<HTMLElement>('button[aria-haspopup="menu"]') ?? document.getElementById('mail-resources-menu')?.querySelector<HTMLElement>('button[aria-haspopup="menu"]') ?? target : target)
      : document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }
  function closeAll() {
    createAddressOpen = false; addDomainOpen = false; domainSetupDirty = false;
    domainSettingsTarget = null; editAddressTarget = null; deleteTarget = null;
    diagnosticsDomainId = ''; diagnosticsAddressId = ''; syncOpen = false; unknownWrite = false; deleteRequests.cancel(); clearTimeout(deleteExpiryTimer);
  }
  function requestClose(action: () => void = closeAll) {
    if (busy) return;
    if (dirty) { discardAction = action; discardOpen = true; }
    else action();
  }
  function discardChanges() {
    const action = discardAction; discardOpen = false; discardAction = null; action?.();
  }
  function filterDomain(domainId: string) { domainFilter = domainId; pageNumber = 1; onSelectedDomainChange?.(domainId); }
  function clearFilters() { domainSearch = ''; addressSearch = ''; domainStatus = 'all'; addressStatus = 'current'; filterDomain(''); }
  function domainAddresses(domainId: string) { return addresses.filter((address) => address.domain_id === domainId); }
  function openCreateAddress(domainId = domainFilter, event?: MouseEvent) {
    captureTrigger(event);
    selectedDomainId = availableDomains.some((domain) => domain.id === domainId) ? domainId : availableDomains[0]?.id ?? '';
    createSeedDomainId = selectedDomainId; localPart = ''; displayName = ''; signature = ''; createError = ''; createFoundAddressId = ''; createAttempt = null; createExistingConflict = false; unknownWrite = false;
    createAddressOpen = true;
  }
  function openAddDomain(event?: MouseEvent) { captureTrigger(event); domainSetupDirty = false; addDomainOpen = true; }
  async function domainCreated(_domainId: string, domain?: Omit<MailDomain, 'cloudflare_configured' | 'resend_configured'>) {
    if (domain) {
      domains = [...domains.filter((item) => item.id !== domain.id), { ...domain, cloudflare_configured: providerConfiguration.cloudflare, resend_configured: providerConfiguration.resend }];
      publishOptions();
    }
    notice = t('settings.mailDomainConnected'); noticeNeedsAttention = false;
    if (!await load()) notice = t('settings.savedRefreshFailed');
    addDomainOpen = false; domainSetupDirty = false; domainSetupBusy = false;
  }
  function openDomainSettings(domain: MailDomain, event?: MouseEvent) {
    captureTrigger(event); domainSettingsTarget = domain; domainEnabled = Boolean(domain.enabled);
    unknownPolicy = domain.unknown_recipient_policy; settingsError = ''; unknownWrite = false;
  }
  function openAddressSettings(address: MailAddress, event?: MouseEvent) {
    captureTrigger(event); editAddressTarget = address; editDisplayName = address.display_name;
    editSignature = address.signature; settingsError = ''; unknownWrite = false;
  }
  function openDiagnostics(domain: MailDomain, address?: MailAddress, event?: MouseEvent) {
    captureTrigger(event); errorMessage = ''; notice = ''; diagnosticsDomainId = domain.id; diagnosticsAddressId = address?.id ?? '';
  }
  function uncertain(error: unknown) {
    return !(error instanceof ClientApiError) || error.status === 0 || error.status >= 500 || error.code === 'INVALID_RESPONSE';
  }
  function currentSession(epoch: number) { return epoch === sessionEpoch && !isClientAuthExpired(); }
  async function saved(message: string, attention = false, options: LoadOptions = {}) {
    notice = message; noticeNeedsAttention = attention;
    if (!await load(options)) notice = `${message} ${t('settings.savedRefreshFailed')}`;
  }
  function resourceNotice(message: string, resource: MailAddress | MailDomain) {
    const matches = 'email' in resource
      ? view !== 'addresses' || filterMailAddresses([resource], { search: addressSearch, domainId: domainFilter, lifecycle: addressStatus }).length > 0
      : view !== 'domains' || filterMailDomains([resource], domainSearch, domainStatus).length > 0;
    return matches ? message : `${message} ${t('settings.resourceOutsideFilter')}`;
  }
  function formError(error: unknown) { onError?.(error); return error instanceof Error ? error.message : t('settings.mailIdentityActionFailed'); }

  async function verifyWriteOutcome() {
    if (busy) return;
    pendingAction = 'verify';
    try {
      if (!await load()) return;
      if (createAddressOpen) {
        const existing = addresses.find((address) => address.email.toLowerCase() === (createAttempt?.email ?? expectedEmail).toLowerCase());
        if (existing) { createFoundAddressId = existing.id; createError = t(createExistingConflict ? 'settings.addressAlreadyExistsReadback' : 'settings.addressFoundAfterUnknown'); unknownWrite = true; return; }
      } else if (editAddressTarget) {
        const existing = addresses.find((address) => address.id === editAddressTarget?.id);
        if (existing?.display_name === editDisplayName.trim() && existing?.signature === editSignature.replace(/\r\n?/gu, '\n')) {
          editAddressTarget = null; notice = t('settings.addressSettingsSaved'); unknownWrite = false; return;
        }
      } else if (domainSettingsTarget) {
        const existing = domains.find((domain) => domain.id === domainSettingsTarget?.id);
        if (Boolean(existing?.enabled) === domainEnabled && existing?.unknown_recipient_policy === unknownPolicy) {
          domainSettingsTarget = null; notice = t('settings.domainSettingsSaved'); unknownWrite = false; return;
        }
      }
      unknownWrite = false;
      createExistingConflict = false;
      if (createAddressOpen) createError = t('settings.writeVerifiedMissing'); else settingsError = t('settings.writeVerifiedMissing');
    } finally { pendingAction = ''; }
  }
  async function createAddress(event: SubmitEvent) {
    event.preventDefault();
    if (busy || unknownWrite || !selectedDomainId) return;
    const prefix = localPart.trim().toLowerCase();
    if (!availableDomains.some((domain) => domain.id === selectedDomainId) || !prefix || prefix.length > 64 ||
      prefix.startsWith('.') || prefix.endsWith('.') || prefix.includes('..') || !/^[a-z0-9.!#$%&'*+/=?^_{|}~-]+$/u.test(prefix) || new TextEncoder().encode(expectedEmail).byteLength > 90) {
      createError = t('settings.addressPrefixInvalid'); return;
    }
    if (addresses.some((address) => address.email.toLowerCase() === expectedEmail.toLowerCase())) { createError = t('settings.quickAddressAlreadyExists'); return; }
    const attempt = { domainId: selectedDomainId, email: expectedEmail, displayName, signature };
    createAttempt = attempt;
    const payload = { domainId: attempt.domainId, address: localPart, displayName: attempt.displayName, signature: attempt.signature };
    pendingAction = 'create'; createError = ''; const epoch = sessionEpoch;
    try {
      const result = await requestJson<{ address: MailAddress }>('/api/workspace/mail-identities', {
        method: 'POST', body: JSON.stringify(payload)
      });
      if (!currentSession(epoch)) { unknownWrite = true; createError = t('settings.writeOutcomeUnknown'); return; }
      addresses = [...addresses.filter((address) => address.id !== result.address.id), result.address]; publishOptions();
      const attention = result.address.receive_enabled !== 1;
      await saved(resourceNotice(t(attention ? 'settings.mailAddressSavedNeedsAttention' : 'settings.mailAddressCreated'), result.address), attention);
      createAddressOpen = false;
    } catch (error) {
      createError = formError(error);
      // A conflict may occur after insertion, such as a lost lease or a domain
      // being disabled during routing. Read back before allowing another POST.
      const conflict = error instanceof ClientApiError && error.status === 409;
      const persistedConflict = conflict && ['CLOUDFLARE_ROUTING_CONFLICT', 'MAIL_ADDRESS_OPERATION_CONFLICT', 'MAIL_DOMAIN_DISABLED'].includes(error.code);
      const existingConflict = conflict && ['MAIL_ADDRESS_ALREADY_EXISTS', 'MAIL_ADDRESS_RESTORE_REQUIRED'].includes(error.code);
      const outcomeUnknown = !currentSession(epoch) || uncertain(error);
      if (outcomeUnknown || conflict) {
        unknownWrite = true;
        if (currentSession(epoch) && await load()) {
          const created = addresses.find((address) => address.email.toLowerCase() === attempt.email.toLowerCase());
          if (created) {
            if (persistedConflict && created.domain_id === attempt.domainId && created.lifecycle_status !== 'deleted' &&
              created.receive_enabled !== 1 && created.display_name === attempt.displayName.trim() && created.signature === attempt.signature.replace(/\r\n?/gu, '\n')) {
              notice = resourceNotice(t('settings.mailAddressSavedNeedsAttention'), created);
              noticeNeedsAttention = true; createAddressOpen = false; unknownWrite = false;
              return;
            }
            createFoundAddressId = created.id;
            createExistingConflict = existingConflict;
            createError = t(existingConflict ? 'settings.addressAlreadyExistsReadback' : 'settings.addressFoundAfterUnknown');
          }
          else if (outcomeUnknown) createError = t('settings.writeOutcomeUnknown');
          else unknownWrite = false;
        }
      }
    } finally { pendingAction = ''; }
  }
  async function saveDomainSettings(event: SubmitEvent) {
    event.preventDefault(); if (!domainSettingsTarget || busy || unknownWrite) return;
    pendingAction = 'domain-settings'; settingsError = ''; const epoch = sessionEpoch;
    try {
      const result = await requestJson<{ domain: MailDomain }>(`/api/workspace/mail-identities/domains/${encodeURIComponent(domainSettingsTarget.id)}`, {
        method: 'PATCH', body: JSON.stringify({ enabled: domainEnabled, unknownRecipientPolicy: unknownPolicy })
      });
      if (!currentSession(epoch)) { unknownWrite = true; settingsError = t('settings.writeOutcomeUnknown'); return; }
      const targetId = domainSettingsTarget.id;
      domains = domains.map((domain) => domain.id === targetId ? { ...domain, ...result.domain } : domain); publishOptions();
      await saved(resourceNotice(t('settings.domainSettingsSaved'), result.domain)); domainSettingsTarget = null;
    } catch (error) { settingsError = formError(error); unknownWrite = uncertain(error) || !currentSession(epoch); }
    finally { pendingAction = ''; }
  }
  async function saveAddressSettings(event: SubmitEvent) {
    event.preventDefault(); if (!editAddressTarget || busy || unknownWrite) return;
    pendingAction = 'address-settings'; settingsError = ''; const epoch = sessionEpoch;
    try {
      const result = await requestJson<{ address: MailAddress }>(`/api/workspace/mail-identities/${encodeURIComponent(editAddressTarget.id)}`, {
        method: 'PATCH', body: JSON.stringify({ displayName: editDisplayName, signature: editSignature })
      });
      if (!currentSession(epoch)) { unknownWrite = true; settingsError = t('settings.writeOutcomeUnknown'); return; }
      const targetId = editAddressTarget.id;
      addresses = addresses.map((address) => address.id === targetId ? result.address : address); publishOptions();
      await saved(resourceNotice(t('settings.addressSettingsSaved'), result.address)); editAddressTarget = null;
    } catch (error) { settingsError = formError(error); unknownWrite = uncertain(error) || !currentSession(epoch); }
    finally { pendingAction = ''; }
  }
  async function syncResources() {
    if (busy || !onboarding.available) return;
    pendingAction = 'sync'; syncError = ''; syncNotice = ''; const epoch = sessionEpoch;
    try {
      const result = await requestJson<{ sync: { domainsCreated: number; addressesCreated: number; warnings: Array<{ domainName: string; code: string }> } }>('/api/workspace/mail-identities/sync', { method: 'POST' });
      if (!currentSession(epoch)) { syncError = t('settings.writeOutcomeUnknown'); return; }
      syncNotice = t('settings.providerSyncComplete', { domains: result.sync.domainsCreated, addresses: result.sync.addressesCreated });
      if (result.sync.warnings.length) syncError = t('settings.providerSyncPartial', { domains: result.sync.warnings.map((warning) => warning.domainName).join(', ') });
      if (!await load()) syncNotice += ` ${t('settings.savedRefreshFailed')}`;
    } catch (error) {
      syncError = formError(error);
      if (!currentSession(epoch) || uncertain(error)) syncError = `${t('settings.writeOutcomeUnknown')} ${syncError}`;
      if (currentSession(epoch)) await load();
    }
    finally { pendingAction = ''; }
  }
  async function checkDomain(domain: MailDomain) {
    if (busy || unresolvedDomainChecks[domain.id]) return;
    pendingAction = `check:${domain.id}`; errorMessage = ''; const epoch = sessionEpoch;
    try {
      const result = await requestJson<{ check: FreshCheck }>(`/api/workspace/mail-identities/domains/${encodeURIComponent(domain.id)}/check`, { method: 'POST', body: '{}' });
      if (!currentSession(epoch)) { unresolvedDomainChecks = { ...unresolvedDomainChecks, [domain.id]: true }; errorMessage = t('settings.writeOutcomeUnknown'); return; }
      checks = { ...checks, [domain.id]: result.check };
      await saved(t(result.check.cloudflare.state === 'ready' ? 'settings.mailIdentityCheckComplete' : 'settings.mailIdentityCheckIncomplete'), result.check.cloudflare.state !== 'ready', {
        preserveCheck: { domainId: domain.id, check: result.check }
      });
    } catch (error) {
      const unknown = !currentSession(epoch) || uncertain(error);
      const message = formError(error);
      if (unknown) {
        unresolvedDomainChecks = { ...unresolvedDomainChecks, [domain.id]: true };
        const remainingChecks = { ...checks };
        delete remainingChecks[domain.id];
        checks = remainingChecks;
      }
      if (currentSession(epoch)) await load();
      errorMessage = unknown ? `${t('settings.writeOutcomeUnknown')} ${message}` : message;
    }
    finally { pendingAction = ''; }
  }
  async function runAction(address: MailAddress, action: 'disable' | 'enable' | 'import' | 'restore' | 'retry' | 'enable_send' | 'disable_send' | 'make_default') {
    if (busy || unresolvedAddressActions[address.id] || (action === 'make_default' && !canSendFrom(address)) || (action === 'enable_send' && !canSendFrom({ ...address, send_enabled: 1 }))) return;
    pendingAction = `${address.id}:${action}`; errorMessage = ''; const epoch = sessionEpoch;
    try {
      const result = await requestJson<{ address: MailAddress }>(`/api/workspace/mail-identities/${encodeURIComponent(address.id)}`, { method: 'POST', body: JSON.stringify({ action }) });
      if (!currentSession(epoch)) { unresolvedAddressActions = { ...unresolvedAddressActions, [address.id]: true }; errorMessage = t('settings.writeOutcomeUnknown'); return; }
      addresses = addresses.map((item) => item.id === result.address.id ? result.address : action === 'make_default' ? { ...item, is_default_sender: 0 } : item); publishOptions();
      await saved(resourceNotice(t('settings.mailIdentityActionComplete'), result.address));
    } catch (error) {
      const unknown = !currentSession(epoch) || uncertain(error);
      const message = formError(error);
      if (unknown) unresolvedAddressActions = { ...unresolvedAddressActions, [address.id]: true };
      if (currentSession(epoch)) await load();
      errorMessage = unknown ? `${t('settings.writeOutcomeUnknown')} ${message}` : message;
    }
    finally { pendingAction = ''; }
  }
  async function openDeletePreview(address: MailAddress, event?: MouseEvent) {
    if (busy) return;
    if (!deleteTarget) captureTrigger(event);
    const request = deleteRequests.begin();
    deleteTarget = address; deletePreview = null; deletePreviewError = ''; deletePreviewLoading = true;
    try {
      const result = await requestJson<{ preview: DeletePreview }>(`/api/workspace/mail-identities/${encodeURIComponent(address.id)}/delete-preview`, { signal: request.signal });
      if (!request.isCurrent() || deleteTarget?.id !== address.id) return;
      deletePreview = result.preview; now = Date.now();
      clearTimeout(deleteExpiryTimer);
      deleteExpiryTimer = setTimeout(() => { now = Date.now(); }, Math.max(0, Date.parse(result.preview.expiresAt) - now) + 1);
      deletePolicy = result.preview.recommendedPolicy ?? (address.routing_owner === 'imported' ? 'preserve_imported_route' : 'remove_owned_route');
    } catch (error) { if (request.isCurrent()) deletePreviewError = formError(error); }
    finally { if (request.isCurrent()) deletePreviewLoading = false; }
  }
  function closeDeletePreview() { if (busy) return; deleteRequests.cancel(); clearTimeout(deleteExpiryTimer); deleteTarget = null; deletePreview = null; deletePreviewError = ''; }
  async function deleteAddress() {
    if (busy || !deleteTarget) return;
    const address = deleteTarget;
    if (!deletePreview || Date.parse(deletePreview.expiresAt) <= Date.now()) { await openDeletePreview(address); return; }
    if (!canConfirmDelete()) return;
    pendingAction = `${address.id}:delete`; deletePreviewError = ''; const epoch = sessionEpoch;
    try {
      const result = await requestJson<{ remoteRuleStatus: string; address: MailAddress }>(`/api/workspace/mail-identities/${encodeURIComponent(address.id)}`, { method: 'DELETE', body: JSON.stringify({ confirm: 'delete', policy: deletePolicy }) });
      if (!currentSession(epoch)) { unresolvedAddressActions = { ...unresolvedAddressActions, [address.id]: true }; deletePreviewError = t('settings.writeOutcomeUnknown'); deletePreview = null; return; }
      addresses = addresses.map((item) => item.id === address.id ? result.address : item); publishOptions();
      await saved(t(result.remoteRuleStatus === 'retained_for_rejection' ? 'settings.deleteAddressRouteRetained' : result.remoteRuleStatus === 'preserved_unverified' ? 'settings.deleteAddressImportedPreserved' : result.remoteRuleStatus === 'removed' ? 'settings.deleteAddressRuleRemoved' : 'settings.mailAddressDeleted'));
      deleteTarget = null;
    } catch (error) {
      const unknown = !currentSession(epoch) || uncertain(error);
      const message = formError(error);
      deletePreview = null;
      if (unknown) unresolvedAddressActions = { ...unresolvedAddressActions, [address.id]: true };
      if (currentSession(epoch)) await load();
      deletePreviewError = unknown ? `${t('settings.writeOutcomeUnknown')} ${message}` : message;
    }
    finally { pendingAction = ''; }
  }
  function canConfirmDelete() {
    return Boolean(deletePreview?.canConfirm && deletePreview.policies[deletePolicy].available && Date.parse(deletePreview.expiresAt) > now && !deletePreviewLoading && !busy);
  }
  function checkFor(domain: MailDomain, addressId: string): RouteStatus | undefined {
    return checks[domain.id]?.cloudflare?.addresses.find((entry) => entry.addressId === addressId)?.status;
  }
  function receivingState(address: MailAddress, domain?: MailDomain): DomainCapabilityState {
    if (!domain || !domain.enabled || address.lifecycle_status !== 'active' || !address.receive_enabled) return 'not_ready';
    const route = checkFor(domain, address.id);
    if ((route !== undefined && route !== 'managed' && route !== 'imported') || address.last_error_code || !['active', 'imported'].includes(address.routing_state)) return 'needs_check';
    return mailHealthState({ configured: domain.cloudflare_configured, checkedAt: domain.cloudflare_checked_at, errorCode: domain.cloudflare_error_code, leaseExpiresAt: domain.cloudflare_check_expires_at, nowMs: now }) === 'fresh' ? 'ready' : 'needs_check';
  }
  function sendingState(address: MailAddress): DomainCapabilityState {
    if (canSendFrom(address)) return 'ready';
    const domain = domains.find((item) => item.id === address.domain_id);
    if (address.lifecycle_status !== 'active' || !address.send_enabled || !domain?.enabled) return 'not_ready';
    return 'needs_check';
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
    }, now) === null;
  }

  function capabilitiesFor(domain: MailDomain, domainAddresses: MailAddress[]) {
    return summarizeDomainCapabilities({
      enabled: Boolean(domain.enabled),
      cloudflareHealth: mailHealthState({
        configured: domain.cloudflare_configured,
        checkedAt: domain.cloudflare_checked_at,
        leaseExpiresAt: domain.cloudflare_check_expires_at,
        errorCode: domain.cloudflare_error_code, nowMs: now
      }),
      catchAllCollects: domain.unknown_recipient_policy === 'collect' &&
        (checks[domain.id]?.cloudflare?.catchAllTarget ?? domain.catch_all_target) === 'this_worker',
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
    }, now);
  }

  function capabilityLabel(state: DomainCapabilityState) {
    return state === 'ready' ? t('settings.ready') :
      state === 'needs_check' ? t('settings.statusNeedsCheck') : t('settings.notReady');
  }

</script>

<svelte:window onbeforeunload={beforeUnload} />

{#snippet stateBadge(state: DomainCapabilityState)}
  <span class="state-badge" class:ready={state === 'ready'} class:attention={state === 'needs_check'}>{capabilityLabel(state)}</span>
{/snippet}

<section class="resource-manager" aria-labelledby="resource-manager-title" data-mail-resource-manager>
  <header class="resource-header">
    <h1 id="resource-manager-title">{title}<span class="resource-count">{loadedOnce ? totalResources : '…'}</span></h1>
    {#if view === 'domains'}
      <Button id="add-mail-domain" disabled={!loadedOnce || busy} onclick={openAddDomain}><Plus size={16} aria-hidden="true" />{t('settings.addMailDomain')}</Button>
    {:else}
      <Button id="add-mail-address" disabled={!loadedOnce || busy || availableDomains.length === 0} onclick={(event) => openCreateAddress(domainFilter, event)}><Plus size={16} aria-hidden="true" />{t('settings.addMailAddress')}</Button>
    {/if}
  </header>
  <div class="resource-toolbar">
    <div class="resource-search">
      <TextField id="mail-resource-search" label={view === 'domains' ? t('settings.domainSearch') : t('settings.addressSearch')} value={view === 'domains' ? domainSearch : addressSearch} type="search" oninput={(event) => { if (view === 'domains') domainSearch = event.currentTarget.value; else addressSearch = event.currentTarget.value; pageNumber = 1; }} />
    </div>
    {#if view === 'addresses'}
      <label class="toolbar-field" for="mail-domain-filter">{t('settings.domainFilter')}
        <select id="mail-domain-filter" value={domainFilter} onchange={(event) => filterDomain(event.currentTarget.value)}>
          <option value="">{t('settings.allDomains')}</option>
          {#if invalidDomainFilter}<option value={domainFilter}>{t('settings.invalidDomainContext')}</option>{/if}
          {#each domains as domain (domain.id)}<option value={domain.id}>{domain.domain_name}</option>{/each}
        </select>
      </label>
    {/if}
    <label class="toolbar-field" for="mail-state-filter">{t('settings.stateFilter')}
      {#if view === 'domains'}
        <select id="mail-state-filter" bind:value={domainStatus} onchange={() => pageNumber = 1}>
          <option value="all">{t('settings.allStates')}</option><option value="enabled">{t('settings.enabled')}</option><option value="disabled">{t('settings.disabled')}</option>
        </select>
      {:else}
        <select id="mail-state-filter" bind:value={addressStatus} onchange={() => pageNumber = 1}>
          <option value="current">{t('settings.configuredAddresses')}</option><option value="active">{t('settings.activeAddresses')}</option><option value="disabled">{t('settings.disabledAddresses')}</option><option value="deleted">{t('settings.deletedAddresses')}</option><option value="all">{t('settings.allStates')}</option>
        </select>
      {/if}
    </label>
    <div class="toolbar-actions">
      <IconButton id="refresh-mail-resources" ariaLabel={t('settings.refreshList')} loading={loading && loadedOnce} disabled={busy || loading} onclick={() => void load()}><RefreshCw size={17} aria-hidden="true" /></IconButton>
      <DropdownMenu id="mail-resources-menu" triggerAriaLabel={t('settings.moreActions')} align="end" showChevron={false}>
        {#snippet trigger()}<MoreHorizontal size={18} aria-hidden="true" />{/snippet}
        <button role="menuitem" type="button" disabled={busy || !loadedOnce} onclick={(event) => { captureTrigger(event); syncNotice = ''; syncError = ''; syncOpen = true; }}>{t('settings.syncCloudflare')}</button>
        {#if view === 'addresses'}<button role="menuitem" type="button" disabled={busy || !loadedOnce} onclick={openAddDomain}>{t('settings.addMailDomain')}</button>{/if}
        <button role="menuitem" type="button" onclick={() => { sortDescending = !sortDescending; pageNumber = 1; }}>{t(sortDescending ? 'settings.sortAscending' : 'settings.sortDescending')}</button>
        <button role="menuitem" type="button" onclick={clearFilters}>{t('settings.clearFilters')}</button>
      </DropdownMenu>
    </div>
  </div>
  {#if errorMessage}<p class="message error" role="alert">{errorMessage}<button type="button" class="text-action" disabled={loading || busy} onclick={() => void load()}>{t('settings.refreshList')}</button></p>{/if}
  {#if notice}<p class="message" class:success={!noticeNeedsAttention} class:attention={noticeNeedsAttention} role="status">{notice}</p>{/if}
  {#if invalidDomainFilter}<p class="message attention" role="status">{t('settings.invalidDomainContext')} <button type="button" class="text-action" onclick={() => filterDomain('')}>{t('settings.clearFilters')}</button></p>{/if}
  {#if !loadedOnce && loading}
    <div class="table-loading" role="status"><span class="sr-only">{t('common.loading')}</span>{#each Array(5) as _, index (index)}<Skeleton height="2.75rem" />{/each}</div>
  {:else if loadedOnce}
    {#if view === 'addresses' && availableDomains.length === 0}
      <p class="message" role="status">{t('settings.noAvailableDomains')} <button class="text-action" type="button" onclick={openAddDomain}>{t('settings.addMailDomain')}</button></p>
    {/if}
    <div class="table-wrap" aria-busy={loading}>
      {#if view === 'domains'}
        <table aria-label={title}>
          <thead><tr><th scope="col">{t('settings.mailDomain')}</th><th scope="col" class="secondary-column">{t('shell.addresses')}</th><th scope="col" class="secondary-column">{t('settings.resourceStatus')}</th><th scope="col" class="capability-column">{t('settings.receive')}</th><th scope="col" class="capability-column">{t('settings.send')}</th><th scope="col" class="actions-column"><span class="sr-only">{t('settings.resourceActions')}</span></th></tr></thead>
          <tbody>
            {#each domainPage.items as domain (domain.id)}
              {@const associated = domainAddresses(domain.id)}
              {@const capabilities = capabilitiesFor(domain, associated)}
              {@const count = associated.filter((address) => address.lifecycle_status !== 'deleted').length}
              <tr data-domain-id={domain.id} data-resource-row data-resource-kind="domain">
                <td class="identity-cell"><button type="button" class="identity-link" onclick={(event) => openDiagnostics(domain, undefined, event)}>{domain.domain_name}</button>
                  <div class="mobile-summary"><span>{domain.enabled ? t('settings.enabled') : t('settings.disabled')}</span><button type="button" class="text-action" title={t('settings.addressCountHelp')} aria-label={`${t('settings.viewAddresses')}: ${domain.domain_name} (${count})`} onclick={() => onViewAddressesForDomain?.(domain.id)}>{t('shell.addresses')} {count}</button></div>
                  <div class="mobile-capabilities"><span>{t('settings.receive')}: {capabilityLabel(capabilities.receiving)}</span><span>{t('settings.send')}: {capabilityLabel(capabilities.sending)}</span></div>
                  {#if capabilities.receiving === 'needs_check' || capabilities.sending === 'needs_check' || domain.cloudflare_error_code || domain.resend_error_code}<button type="button" class="attention detail-link" onclick={(event) => openDiagnostics(domain, undefined, event)}><AlertTriangle size={13} aria-hidden="true" />{t('settings.needsCheckDetails')}</button>{/if}
                </td>
                <td class="secondary-column"><button type="button" class="text-action" title={t('settings.addressCountHelp')} aria-label={`${t('settings.viewAddresses')}: ${domain.domain_name} (${count})`} onclick={() => onViewAddressesForDomain?.(domain.id)}>{count}</button></td>
                <td class="secondary-column"><span class="state-badge">{domain.enabled ? t('settings.enabled') : t('settings.disabled')}</span></td>
                <td class="capability-column">{@render stateBadge(capabilities.receiving)}</td><td class="capability-column">{@render stateBadge(capabilities.sending)}</td>
                <td class="actions-column"><div class="row-actions" data-resource-actions>
                  <IconButton ariaLabel={`${t('settings.domainSettings')}: ${domain.domain_name}`} disabled={busy} onclick={(event) => openDomainSettings(domain, event)}><Pencil size={16} aria-hidden="true" /></IconButton>
                  <DropdownMenu id={`domain-menu-${domain.id}`} triggerAriaLabel={`${t('settings.moreActions')}: ${domain.domain_name}`} align="end" showChevron={false}>
                    {#snippet trigger()}<MoreHorizontal size={17} aria-hidden="true" />{/snippet}
                    <button role="menuitem" type="button" onclick={() => onViewAddressesForDomain?.(domain.id)}>{t('settings.viewAddresses')}</button>
                    <button role="menuitem" type="button" disabled={!domain.enabled || busy} onclick={(event) => openCreateAddress(domain.id, event)}>{t('settings.createAddressForDomain')}</button>
                    <button role="menuitem" type="button" disabled={busy} onclick={(event) => openDiagnostics(domain, undefined, event)}>{t('settings.diagnostics')}</button>
                    <button role="menuitem" type="button" disabled={busy || unresolvedDomainChecks[domain.id]} onclick={() => void checkDomain(domain)}>{t('settings.checkMailDomain')}</button>
                  </DropdownMenu>
                </div></td>
              </tr>
            {/each}
            {#if !domainPage.total}<tr><td colspan="6" class="empty-cell">{domains.length ? t('settings.noMatches') : t('settings.noMailDomains')}</td></tr>{/if}
          </tbody>
        </table>
      {:else}
        <table aria-label={title}>
          <thead><tr><th scope="col">{t('shell.addresses')}</th><th scope="col" class="secondary-column">{t('settings.mailDomain')}</th><th scope="col" class="secondary-column">{t('settings.resourceStatus')}</th><th scope="col" class="capability-column">{t('settings.receive')}</th><th scope="col" class="capability-column">{t('settings.send')}</th><th scope="col" class="actions-column"><span class="sr-only">{t('settings.resourceActions')}</span></th></tr></thead>
          <tbody>
            {#each addressPage.items as address (address.id)}
              {@const domain = domains.find((item) => item.id === address.domain_id)}
              {@const route = domain ? checkFor(domain, address.id) : undefined}
              {@const receive = receivingState(address, domain)}
              {@const send = sendingState(address)}
              <tr data-address-id={address.id} data-resource-row data-resource-kind="address">
                <td class="identity-cell"><button type="button" class="identity-link" onclick={(event) => { if (domain) openDiagnostics(domain, address, event); }}>{address.email}</button>
                  {#if address.display_name && address.display_name !== address.email}<span class="display-name">{address.display_name}</span>{/if}
                  {#if address.is_default_sender}<span class="default-badge">{t('settings.defaultSender')}</span>{/if}
                  <div class="mobile-summary">{address.lifecycle_status === 'deleted' ? t('settings.routeDeleted') : address.lifecycle_status === 'active' ? t('settings.enabled') : t('settings.disabled')}</div>
                  <div class="mobile-capabilities"><span>{t('settings.receive')}: {capabilityLabel(receive)}</span><span>{t('settings.send')}: {capabilityLabel(send)}</span></div>
                  {#if address.lifecycle_status !== 'deleted' && (address.last_error_code || receive === 'needs_check' || send === 'needs_check' || route === 'conflict' || route === 'duplicate')}
                    <button type="button" class="attention detail-link" onclick={(event) => { if (domain) openDiagnostics(domain, address, event); }}><AlertTriangle size={13} aria-hidden="true" />{t('settings.needsCheckDetails')}</button>
                  {/if}
                </td>
                <td class="secondary-column">{domain?.domain_name ?? '—'}</td><td class="secondary-column"><span class="state-badge">{address.lifecycle_status === 'deleted' ? t('settings.routeDeleted') : address.lifecycle_status === 'active' ? t('settings.enabled') : t('settings.disabled')}</span></td>
                <td class="capability-column">{@render stateBadge(receive)}</td><td class="capability-column">{@render stateBadge(send)}</td>
                <td class="actions-column"><div class="row-actions" data-resource-actions>
                  {#if address.lifecycle_status !== 'deleted'}<IconButton ariaLabel={`${t('settings.editAddressDetails')}: ${address.email}`} disabled={busy} onclick={(event) => openAddressSettings(address, event)}><Pencil size={16} aria-hidden="true" /></IconButton>{/if}
                  <DropdownMenu id={`address-menu-${address.id}`} triggerAriaLabel={`${t('settings.moreActions')}: ${address.email}`} align="end" showChevron={false}>
                    {#snippet trigger()}<MoreHorizontal size={17} aria-hidden="true" />{/snippet}
                    <button role="menuitem" type="button" disabled={!domain || busy} onclick={(event) => { if (domain) openDiagnostics(domain, address, event); }}>{t('settings.diagnostics')}</button>
                    {#if address.lifecycle_status === 'deleted'}
                      <button role="menuitem" type="button" disabled={busy || unresolvedAddressActions[address.id]} onclick={() => void runAction(address, 'restore')}>{t('settings.restoreAddress')}</button>
                    {:else}
                      {#if route === 'importable'}<button role="menuitem" type="button" disabled={busy || unresolvedAddressActions[address.id]} onclick={() => void runAction(address, 'import')}>{t('settings.importRule')}</button>{/if}
                      <button role="menuitem" type="button" disabled={busy || unresolvedAddressActions[address.id]} onclick={() => void runAction(address, address.lifecycle_status === 'active' ? 'disable' : 'enable')}>{t(address.lifecycle_status === 'active' ? 'settings.disableAddress' : 'settings.enableAddress')}</button>
                      {#if address.lifecycle_status === 'active'}
                        {#if address.send_enabled}
                          <button role="menuitem" type="button" disabled={busy || unresolvedAddressActions[address.id]} onclick={() => void runAction(address, 'disable_send')}>{t('settings.disableSending')}</button>
                          {#if !address.is_default_sender}<button role="menuitem" type="button" disabled={busy || unresolvedAddressActions[address.id] || !canSendFrom(address)} onclick={() => void runAction(address, 'make_default')}>{t('settings.setDefaultSender')}</button>{/if}
                        {:else}<button role="menuitem" type="button" disabled={busy || unresolvedAddressActions[address.id] || !canSendFrom({ ...address, send_enabled: 1 })} onclick={() => void runAction(address, 'enable_send')}>{t('settings.enableSending')}</button>{/if}
                      {/if}
                      {#if ['error', 'unknown', 'pending', 'deleting'].includes(address.routing_state)}<button role="menuitem" type="button" disabled={busy || unresolvedAddressActions[address.id]} onclick={() => void runAction(address, 'retry')}>{t('settings.retryRouting')}</button>{/if}
                      <button role="menuitem" class="danger" type="button" disabled={busy || unresolvedAddressActions[address.id]} onclick={(event) => void openDeletePreview(address, event)}>{t('settings.deleteAddress')}</button>
                    {/if}
                  </DropdownMenu>
                </div></td>
              </tr>
            {/each}
            {#if !addressPage.total}<tr><td colspan="6" class="empty-cell">{addresses.length || invalidDomainFilter ? t('settings.noMatches') : t('settings.noMailAddresses')}</td></tr>{/if}
          </tbody>
        </table>
      {/if}
    </div>
    <footer class="resource-pagination">
      <p role="status">{t('settings.filteredCount', { visible: currentPage.total, total: totalResources })}</p>
      {#if view === 'domains'}<span class="count-help">{t('settings.addressCountHelp')}</span>{/if}
      {#if currentPage.pageCount > 1}<div><IconButton ariaLabel={t('settings.previousPage')} disabled={currentPage.page <= 1} onclick={() => pageNumber = currentPage.page - 1}><ChevronLeft size={17} aria-hidden="true" /></IconButton><span>{t('settings.resourcePage', { page: currentPage.page, pages: currentPage.pageCount })}</span><IconButton ariaLabel={t('settings.nextPage')} disabled={currentPage.page >= currentPage.pageCount} onclick={() => pageNumber = currentPage.page + 1}><ChevronRight size={17} aria-hidden="true" /></IconButton></div>{/if}
    </footer>
  {/if}
</section>

{#if createAddressOpen}
  <Dialog open id="add-mail-address-dialog" title={t('settings.addMailAddress')} dismissible={!busy} closeOnBackdrop={!busy} {restoreFocusElement} fallbackFocus="#add-mail-address" initialFocus="#mail-identity-address" onClose={() => requestClose()}>
    <form id="create-mail-address-form" class="identity-form" onsubmit={createAddress}>
      <label for="mail-identity-domain">{t('settings.mailDomain')}</label>
      <select id="mail-identity-domain" bind:value={selectedDomainId} disabled={busy || unknownWrite}>
        {#each availableDomains as domain (domain.id)}<option value={domain.id}>{domain.domain_name}</option>{/each}
      </select>
      <TextField id="mail-identity-address" label={t('settings.quickAddressLocalPart')} value={localPart} required maxlength={64} disabled={busy || unknownWrite} placeholder="hello" autocomplete="off" oninput={(event) => { localPart = event.currentTarget.value; createError = ''; }} />
      <p class="address-preview"><span>{t('settings.addressPreview')}</span><strong>{unknownWrite && createAttempt ? createAttempt.email : expectedEmail}</strong></p>
      <details><summary>{t('settings.optionalAddressSettings')}</summary><div class="identity-form optional-fields">
        <TextField id="mail-identity-name" label={t('settings.mailAddressDisplayName')} value={displayName} maxlength={128} disabled={busy || unknownWrite} oninput={(event) => displayName = event.currentTarget.value} />
        <TextArea id="mail-identity-signature" label={t('settings.mailAddressSignature')} value={signature} rows={4} disabled={busy || unknownWrite} oninput={(event) => signature = event.currentTarget.value} />
      </div></details>
      {#if !onboarding.canManageRouting}<p class="attention">{t('settings.routingManagementMissing')}</p>{/if}
      {#if createError}<p class="message error" role="alert">{createError}</p>{/if}
      {#if unknownWrite}{#if !createExistingConflict}<p class="attention" role="status">{t('settings.writeOutcomeUnknown')}</p>{/if}<Button variant="secondary" loading={pendingAction === 'verify'} disabled={busy} onclick={() => void verifyWriteOutcome()}>{t('settings.verifyWriteOutcome')}</Button>{#if createFoundAddressId}<Button variant="secondary" disabled={busy} onclick={() => requestClose(() => { const address = addresses.find((item) => item.id === createFoundAddressId); const domain = domains.find((item) => item.id === address?.domain_id); createAddressOpen = false; if (domain && address) openDiagnostics(domain, address); })}>{t('settings.diagnostics')}</Button>{/if}{/if}
    </form>
    {#snippet footer()}<Button variant="ghost" disabled={busy} onclick={() => requestClose()}>{t('common.cancel')}</Button><button class="submit-button" type="submit" form="create-mail-address-form" disabled={busy || unknownWrite || !selectedDomainId || !localPart.trim()} aria-busy={pendingAction === 'create'}>{t('settings.createMailAddress')}</button>{/snippet}
  </Dialog>
{/if}

{#if addDomainOpen}
  <Dialog open id="add-mail-domain-dialog" title={t('settings.addMailDomain')} dismissible={!busy} closeOnBackdrop={!busy} {restoreFocusElement} fallbackFocus="#add-mail-domain" initialFocus="#new-mail-domain" onClose={() => requestClose()}>
    <MailDomainSetup available={onboarding.available} workerName={onboarding.workerName} busy={Boolean(pendingAction)} onCreated={domainCreated} onRefresh={async () => { await load(); }} onDirtyChange={(value) => domainSetupDirty = value} onPendingChange={(value) => domainSetupBusy = value} onFormStateChange={(state) => domainFormCanSubmit = state.canSubmit} hideActions onError={onError} />
    {#snippet footer()}<Button variant="ghost" disabled={busy} onclick={() => requestClose()}>{t('common.cancel')}</Button><button class="submit-button" type="submit" form="mail-domain-setup-form" disabled={!domainFormCanSubmit || busy} aria-busy={domainSetupBusy}>{t('settings.connectMailDomain')}</button>{/snippet}
  </Dialog>
{/if}

{#if domainSettingsTarget}
  <Dialog open id="domain-settings" title={t('settings.domainSettings')} description={domainSettingsTarget.domain_name} dismissible={!busy} closeOnBackdrop={!busy} {restoreFocusElement} fallbackFocus="#add-mail-domain" initialFocus="#domain-enabled" onClose={() => requestClose()}>
    <form id="domain-settings-form" class="identity-form" onsubmit={saveDomainSettings}>
      <p>{t('settings.domainMappingLocked')}</p>
      <dl class="readonly-mapping"><div><dt>{t('settings.domainName')}</dt><dd>{domainSettingsTarget.domain_name}</dd></div><div><dt>{t('settings.domainZoneId')}</dt><dd>{domainSettingsTarget.cloudflare_zone_id}</dd></div><div><dt>Worker</dt><dd>{domainSettingsTarget.worker_name}</dd></div></dl>
      <label><input id="domain-enabled" type="checkbox" bind:checked={domainEnabled} disabled={busy || unknownWrite} /> {t('settings.domainEnabled')}</label>
      <p class="attention">{t('settings.domainDisableHelp')}</p>
      <label for="domain-unknown-policy">{t('settings.unknownRecipients')}</label>
      <select id="domain-unknown-policy" bind:value={unknownPolicy} disabled={busy || unknownWrite}><option value="reject">{t('settings.unknownReject')}</option><option value="collect">{t('settings.unknownCollect')}</option></select>
      <p class="attention">{t('settings.collectRequiresWorkerCatchAll')}</p>
      {#if domainSettingsTarget.catch_all_target === 'external'}<p class="attention">{t('settings.externalCatchAllRisk')}</p>{/if}
      {#if settingsError}<p class="message error" role="alert">{settingsError}</p>{/if}
      {#if unknownWrite}<p class="attention">{t('settings.writeOutcomeUnknown')}</p><Button variant="secondary" disabled={busy} onclick={() => void verifyWriteOutcome()}>{t('settings.verifyWriteOutcome')}</Button>{/if}
    </form>
    {#snippet footer()}<Button variant="ghost" disabled={busy} onclick={() => requestClose()}>{t('common.cancel')}</Button><button class="submit-button" type="submit" form="domain-settings-form" disabled={busy || unknownWrite} aria-busy={pendingAction === 'domain-settings'}>{t('settings.saveIdentitySettings')}</button>{/snippet}
  </Dialog>
{/if}

{#if editAddressTarget}
  <Dialog open id="edit-mail-address" title={t('settings.editAddressDetails')} description={editAddressTarget.email} dismissible={!busy} closeOnBackdrop={!busy} {restoreFocusElement} fallbackFocus="#add-mail-address" initialFocus="#edit-address-name" onClose={() => requestClose()}>
    <form id="address-settings-form" class="identity-form" onsubmit={saveAddressSettings}>
      <dl class="readonly-mapping"><div><dt>{t('settings.mailAddress')}</dt><dd>{editAddressTarget.email}</dd></div><div><dt>{t('settings.mailDomain')}</dt><dd>{domains.find((domain) => domain.id === editAddressTarget?.domain_id)?.domain_name}</dd></div></dl>
      <TextField id="edit-address-name" label={t('settings.mailAddressDisplayName')} value={editDisplayName} maxlength={128} disabled={busy || unknownWrite} oninput={(event) => editDisplayName = event.currentTarget.value} />
      <TextArea id="edit-address-signature" label={t('settings.mailAddressSignature')} value={editSignature} rows={5} disabled={busy || unknownWrite} oninput={(event) => editSignature = event.currentTarget.value} />
      {#if settingsError}<p class="message error" role="alert">{settingsError}</p>{/if}
      {#if unknownWrite}<p class="attention">{t('settings.writeOutcomeUnknown')}</p><Button variant="secondary" disabled={busy} onclick={() => void verifyWriteOutcome()}>{t('settings.verifyWriteOutcome')}</Button>{/if}
    </form>
    {#snippet footer()}<Button variant="ghost" disabled={busy} onclick={() => requestClose()}>{t('common.cancel')}</Button><button class="submit-button" type="submit" form="address-settings-form" disabled={busy || unknownWrite} aria-busy={pendingAction === 'address-settings'}>{t('settings.saveIdentitySettings')}</button>{/snippet}
  </Dialog>
{/if}

{#if diagnosticsDomain}
  <Dialog open id="mail-diagnostics" title={t('settings.diagnostics')} description={diagnosticsAddress?.email ?? diagnosticsDomain.domain_name} size="lg" dismissible={!busy} closeOnBackdrop={!busy} {restoreFocusElement} fallbackFocus="#refresh-mail-resources" onClose={() => requestClose()}>
    <MailIdentityDiagnostics domain={diagnosticsDomain} address={diagnosticsAddress} check={checks[diagnosticsDomain.id]} {busy} showActions={false} />
    {#if errorMessage}<p class="error" role="alert">{errorMessage}</p>{/if}
    {#if notice}<p class="message" role="status">{notice}</p>{/if}
    {#snippet footer()}<Button variant="ghost" disabled={busy} onclick={() => requestClose()}>{t('common.close')}</Button>{#if diagnosticsAddress && diagnosticsAddress.lifecycle_status !== 'deleted' && ['error','unknown','pending','deleting'].includes(diagnosticsAddress.routing_state)}<Button variant="secondary" disabled={busy || unresolvedAddressActions[diagnosticsAddress.id]} onclick={() => void runAction(diagnosticsAddress!, 'retry')}>{t('settings.retryRouting')}</Button>{/if}<Button loading={pendingAction === `check:${diagnosticsDomain.id}`} disabled={busy || unresolvedDomainChecks[diagnosticsDomain.id]} onclick={() => void checkDomain(diagnosticsDomain!)}>{t('settings.checkMailDomain')}</Button>{/snippet}
  </Dialog>
{/if}

{#if syncOpen}
  <Dialog open id="sync-mail-resources" title={t('settings.syncCloudflare')} dismissible={!busy} closeOnBackdrop={!busy} {restoreFocusElement} fallbackFocus="#refresh-mail-resources" onClose={() => requestClose()}>
    <p>{t('settings.syncImportExplanation')}</p>
    {#if !onboarding.available}<p class="attention" role="status">{t(onboarding.workerName ? 'settings.domainReadPermissionMissing' : 'settings.domainWorkerMissing')}</p>{/if}
    {#if syncNotice}<p class="message success" role="status">{syncNotice}</p>{/if}
    {#if syncError}<p class="message attention" role="alert">{syncError}</p>{/if}
    {#snippet footer()}<Button variant="ghost" disabled={busy} onclick={() => requestClose()}>{t('common.close')}</Button><Button disabled={busy || !onboarding.available} loading={pendingAction === 'sync'} onclick={() => void syncResources()}>{t('settings.syncImportConfirm')}</Button>{/snippet}
  </Dialog>
{/if}

<ConfirmDialog open={discardOpen} id="discard-mail-resource-changes" title={t('settings.discardChangesTitle')} description={t('settings.discardChangesDescription')} confirmLabel={t('settings.discardChanges')} cancelLabel={t('settings.keepEditing')} onConfirm={discardChanges} onCancel={() => { discardOpen = false; discardAction = null; }} />

{#if deleteTarget}
  <Dialog
    open
    id="delete-mail-address"
    title={t('settings.deleteAddressTitle')}
    description={t('settings.deletePreviewDescription', { email: deleteTarget.email })}
    size="lg"
    dismissible={!pendingAction.endsWith(':delete')}
    closeOnBackdrop={!pendingAction.endsWith(':delete')}
    {restoreFocusElement}
    fallbackFocus="#refresh-mail-resources"
    onClose={closeDeletePreview}
  >
    {#snippet children()}
      {#if deletePreviewLoading}
        <p role="status" class="preview-note">{t('settings.deletePreviewLoading')}</p>
      {:else if deletePreviewError}
        <p role="alert" class="preview-warning">{deletePreviewError}</p>
        <Button variant="secondary" onclick={() => void openDeletePreview(deleteTarget!)}>{t('settings.refreshList')}</Button>
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
                <label><input type="radio" name="mail-address-delete-policy" value="retain_reject_route" disabled={busy} bind:group={deletePolicy} />
                  <span><strong>{t('settings.deletePolicyRetainLabel')}</strong><small>{t('settings.deletePolicyRetainDescription')}</small></span>
                </label>
              {/if}
              {#if deletePreview.policies.remove_owned_route.available}
                <label><input type="radio" name="mail-address-delete-policy" value="remove_owned_route" disabled={busy} bind:group={deletePolicy} />
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
  .resource-manager { max-width: 80rem; margin-inline: auto; min-width: 0; color: var(--fm-text); font-size: 14px; }
  .resource-header { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: space-between; margin-bottom: 18px; }
  h1 { display: flex; align-items: center; gap: 10px; font-size: 20px; font-weight: 650; line-height: 1.3; }
  .resource-count { color: var(--fm-text-muted); font-size: 14px; font-weight: 500; }
  .resource-toolbar { display: flex; align-items: end; gap: 12px; flex-wrap: wrap; margin-bottom: 14px; }
  .resource-search { flex: 1; min-width: 12rem; }
  .toolbar-field { display: grid; gap: 5px; min-width: 8rem; max-width: 16rem; font-size: 13px; color: var(--fm-text-secondary); }
  .toolbar-actions, .row-actions, .resource-pagination > div { display: flex; align-items: center; gap: 4px; }
  select { width: 100%; min-height: 40px; padding: 8px 10px; border: 1px solid var(--fm-border); border-radius: var(--radius-md); background: var(--fm-surface); color: var(--fm-text); }
  .table-wrap { border: 1px solid var(--fm-border); border-radius: var(--radius-md); }
  table { width: 100%; table-layout: fixed; border-collapse: collapse; }
  th { text-align: left; font-weight: 600; font-size: 13px; color: var(--fm-text-secondary); background: var(--fm-surface-subtle); }
  th, td { padding: 12px; border-bottom: 1px solid var(--fm-border); vertical-align: middle; overflow-wrap: anywhere; }
  th:first-child { width: 34%; }
  th.secondary-column { width: 15%; }
  th.capability-column { width: 11%; }
  th.actions-column { width: 108px; }
  tbody tr:last-child td { border-bottom: 0; }
  tbody tr:hover { background: var(--fm-surface-hover); }
  .identity-link { text-align: left; font-weight: 600; overflow-wrap: anywhere; }
  .identity-link:hover, .text-action:hover { text-decoration: underline; }
  .text-action { color: var(--fm-primary); padding: 4px; min-height: 32px; }
  .display-name { display: block; margin-top: 3px; color: var(--fm-text-secondary); }
  .default-badge { display: inline-block; margin-top: 4px; padding: 2px 6px; border: 1px solid var(--fm-border); border-radius: 4px; color: var(--fm-text-secondary); font-size: 12px; }
  .state-badge { display: inline-block; color: var(--fm-text-secondary); font-size: 13px; }
  .ready, .success { color: var(--fm-success); }
  .attention { color: var(--fm-warning); }
  .error, .danger { color: var(--fm-danger); }
  .detail-link { display: flex; gap: 4px; align-items: center; text-align: left; min-height: 32px; margin-top: 4px; font-size: 12px; }
  .detail-link :global(svg) { flex: none; }
  .mobile-summary, .mobile-capabilities { display: none; }
  .empty-cell { text-align: center; padding: 32px 16px; color: var(--fm-text-muted); }
  .message { margin-block: 12px; overflow-wrap: anywhere; line-height: 1.6; }
  .table-loading { display: grid; gap: 1px; border: 1px solid var(--fm-border); border-radius: var(--radius-md); }
  .resource-pagination { display: flex; flex-wrap: wrap; gap: 8px; justify-content: space-between; align-items: center; padding-top: 10px; color: var(--fm-text-muted); font-size: 13px; }
  .resource-manager :global([role="menuitem"]) { display: block; width: 100%; min-height: 40px; padding: 8px 10px; text-align: left; border-radius: 4px; font-size: 13px; overflow-wrap: anywhere; }
  .resource-manager :global([role="menuitem"]:hover:not(:disabled)) { background: var(--fm-surface-hover); }
  .resource-manager :global([role="menuitem"]:disabled) { opacity: .5; }
  .identity-form { display: grid; gap: 12px; font-size: 14px; }
  .identity-form p { margin: 0; line-height: 1.6; overflow-wrap: anywhere; }
  .identity-form label { color: var(--fm-text-secondary); }
  .optional-fields { margin-top: 12px; }
  .address-preview { display: grid; gap: 4px; padding: 10px; background: var(--fm-surface-subtle); border-radius: var(--radius-md); overflow-wrap: anywhere; }
  .address-preview span { color: var(--fm-text-muted); font-size: 13px; }
  .readonly-mapping { display: grid; gap: 8px; }
  .readonly-mapping div { display: grid; gap: 4px; }
  .readonly-mapping dt { color: var(--fm-text-muted); font-size: 13px; }
  .readonly-mapping dd { margin: 0; overflow-wrap: anywhere; }
  .submit-button { display: inline-flex; justify-content: center; align-items: center; min-height: 40px; border-radius: var(--radius-md); padding: 8px 14px; background: var(--fm-primary); color: var(--fm-text-inverse); font-size: 14px; font-weight: 600; }
  .submit-button:disabled { opacity: .5; cursor: not-allowed; }
  button:focus-visible, select:focus-visible, summary:focus-visible { outline: 2px solid var(--fm-primary); outline-offset: 2px; }
  .delete-preview { display: grid; gap: 12px; color: var(--fm-text-secondary); font-size: 14px; }
  .delete-preview dl { display: grid; gap: 8px; }
  .delete-preview dl > div { display: grid; grid-template-columns: minmax(7rem, 1fr) 2fr; gap: 8px; }
  .delete-preview dt { color: var(--fm-text-muted); }
  .delete-preview dd { min-width: 0; margin: 0; overflow-wrap: anywhere; }
  .delete-preview fieldset { display: grid; gap: 8px; border: 1px solid var(--fm-border); border-radius: var(--radius-md); padding: 12px; }
  .delete-preview label { display: flex; align-items: start; gap: 8px; }
  .delete-preview label span { display: grid; gap: 4px; }
  .delete-preview label small, .preview-note { color: var(--fm-text-muted); }
  .preview-warning { color: var(--fm-danger); }
  @media (max-width: 760px) {
    .secondary-column { display: none; }
    th:first-child { width: auto; }
    th.capability-column { width: 16%; }
    .mobile-summary { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; color: var(--fm-text-muted); font-size: 13px; }
    .toolbar-field { flex: 1; min-width: 7rem; max-width: 100%; }
  }
  @media (max-width: 540px) {
    .capability-column { display: none; }
    .mobile-capabilities { display: flex; gap: 8px; flex-wrap: wrap; color: var(--fm-text-secondary); font-size: 13px; margin-top: 5px; }
    .resource-search { flex-basis: 100%; }
    th, td { padding: 10px 8px; }
    th.actions-column { width: 104px; }
    .row-actions { gap: 0; }
    .resource-header :global(button), .submit-button, .text-action, .identity-link, .detail-link { min-height: 44px; }
    .resource-manager :global([role="menuitem"]) { min-height: 44px; }
    .delete-preview dl > div { grid-template-columns: 1fr; }
  }
</style>
