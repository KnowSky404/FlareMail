<script lang="ts">
  import { afterNavigate, goto, pushState, replaceState } from '$app/navigation';
  import { page } from '$app/state';
  import { onMount, tick, untrack } from 'svelte';
  import { Archive, Inbox, Mail, MailOpen, MoreHorizontal, Pencil, Star, Trash2, Tag } from '@lucide/svelte';
  import type { PageData } from './$types';
  import InboxCategoryTabs from '$lib/components/mail/InboxCategoryTabs.svelte';
  import FolderHeader from '$lib/components/mail/FolderHeader.svelte';
  import LoginView from '$lib/components/mail/LoginView.svelte';
  import MessageDetail from '$lib/components/mail/MessageDetail.svelte';
  import RuntimeUnavailableView from '$lib/components/mail/RuntimeUnavailableView.svelte';
  import MessageList from '$lib/components/mail/MessageList.svelte';
  import AppSidebar from '$lib/components/shell/AppSidebar.svelte';
  import AppTopbar from '$lib/components/shell/AppTopbar.svelte';
  import MobileNavigation from '$lib/components/shell/MobileNavigation.svelte';
  import Dialog from '$lib/components/ui/Dialog.svelte';
  import ReaderDialog from '$lib/components/ui/ReaderDialog.svelte';
  import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte';
  import ToastRegion from '$lib/components/ui/ToastRegion.svelte';
  import AuthExpiredNotice from '$lib/components/mail/AuthExpiredNotice.svelte';
  import { Banner, Button, Checkbox, DropdownMenu, IconButton, Select, Skeleton, TextField } from '$lib/components/ui';
  import { ClientApiError } from '$lib/client/api';
  import {
    AUTH_EXPIRED_EVENT,
    clearClientAuthExpired,
    createAuthSessionChannel,
    isClientAuthExpired,
    markClientAuthExpired,
    openReauthenticationTab,
    type AuthExpirySource
  } from '$lib/client/auth-session';
  import {
    ComposeAutosaveController,
    composeInputFromSavedDraft,
    createEmptyComposeInput,
    formatComposeSavedAt,
    hasComposeContent,
    mergeSavedDraftMetadata,
    serializeComposeInput,
    withComposePersistence
  } from '$lib/client/compose-controller';
  import { DetailCacheController } from '$lib/client/detail-cache-controller';
  import { deriveRecipientSuggestions } from '$lib/client/recipient-suggestions';
  import {
    MailboxController,
    createEmptyWorkspaceViewState,
    mergeMailboxPage,
    patchMailboxFlags,
    mergeMessageDelta,
    moveSelection,
    reconcileBulkSelection,
    removeMessage,
    selectNextMessage,
    selectionCandidates,
    workspaceViewStateFromSnapshot,
    type MailFilter,
    type MessageDelta,
    type WorkspaceSection
  } from '$lib/client/mailbox-controller';
  import { LatestRequest } from '$lib/client/latest-request';
  import { MessageFlagsController, ReadActivationController } from '$lib/client/message-flags-controller';
  import { selectedVisibleMessages } from '$lib/client/mailbox-selection';
  import {
    createSession,
    deleteMessage,
    deleteSession,
    emptyTrash,
    fetchDeliveryDetail,
    fetchDraftDetail,
    fetchInboundDetail,
    fetchMailboxPage,
    fetchMailboxMetrics,
    fetchWorkspaceMessage,
    fetchMessageBody,
    fetchTrash,
    fetchWorkspaceSession,
    permanentlyDeleteTrashItem,
    persistDraft,
    restoreTrashItem,
    retryDelivery,
    submitMessage,
    updateMessageFlags,
    updateProfile,
    mutateMailbox,
    setInboxCategory,
    fetchMailLabels,
    createMailLabel,
    renameMailLabel,
    deleteMailLabel,
    setMailMessageLabel,
    setManyMailMessageLabels
  } from '$lib/client/workspace-api';
  import { WorkspaceShortcutController, type WorkspaceShortcutAction } from '$lib/client/workspace-shortcuts';
  import { ToastController, type ToastMessage, type ToastTone } from '$lib/client/toast-controller';
  import { TrashController } from '$lib/client/trash-controller';
  import { readWorkspaceUrl, updateWorkspaceUrl as buildWorkspaceUrl, type WorkspaceUrlState } from '$lib/client/workspace-url-controller';
  import { WorkspaceSnapshotController } from '$lib/client/workspace-snapshot-controller';
  import { createWorkspaceSync, type WorkspaceSyncController } from '$lib/client/workspace-sync';
  import { LOCALE_CHANGE_EVENT } from '$lib/client/locale-preferences';
  import { useLocale } from '$lib/i18n/runtime.svelte';
  import { formatNumber, translateCount } from '$lib/i18n';
  import {
    DEFAULT_LAYOUT_PREFERENCES,
    clampListWidth,
    layoutPreferenceRange,
    listWidthFromKeyboard,
    readLayoutPreferences,
    writeLayoutPreferences,
    type ReadingLayout,
    type DisplayDensity
  } from '$lib/client/layout-preferences';
  import {
    buildMailThreads,
    cloneMailbox,
    cloneProfile,
    createForwardComposeInput,
    createReplyAllComposeInput,
    createReplyComposeInput,
    hasDistinctReplyAllRecipients,
    isInboundMessageId,
    selectInitialComposeSenderAddressId,
    serializeAddressList,
    type DeliveryDetail,
    type ComposeInput,
    type ComposeMode,
    type InboundMessageDetail,
    type LoginInput,
    type MailboxSection,
    type InboxCategoryFilter,
    type MailInboxCategory,
    type MailboxIdentityFilter,
    type MailboxMutationScope,
    type MailMessage,
    type MailUserLabel,
    type MailLabelMessageKind,
    type MailboxState,
    type MailboxPage,
    type MailThread,
    type MessagePatch,
    type TrashItem,
    type UserProfile,
    type WorkspaceMetrics,
    type WorkspaceSnapshot
  } from '$lib/domain/mail';

  type AppSection = WorkspaceSection;

  type ComposeAutosaveStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';
  type DraftConflictInfo = Pick<MailMessage, 'id' | 'sentAt'>;
  type WorkspaceBodyDetail = { body: string; attachments: NonNullable<ComposeInput['attachments']> };

  let { data }: { data: PageData } = $props();
  const i18n = useLocale();
  const { t } = i18n;
  const displayError = (error: unknown, fallback: string) =>
    error instanceof ClientApiError && i18n.locale === 'en'
      ? fallback
      : error instanceof Error
        ? error.message
        : fallback;
  const sameIdentityScope = (left: MailboxIdentityFilter | null | undefined, right: MailboxIdentityFilter | null | undefined) =>
    (left?.kind ?? null) === (right?.kind ?? null) && (left?.id ?? null) === (right?.id ?? null);
  const serverWorkspace = $derived(data.workspace);

  const runtimeLabel = $derived(
    data.runtimeState.state === 'ready'
      ? data.dbBound && data.bucketBound
        ? t('runtime.ready')
        : t('runtime.development')
      : data.runtimeState.state === 'unauthenticated'
        ? t('runtime.loginRequired')
        : t('runtime.unavailable')
  );

  let authenticated = $state(false);
  let authExpired = $state(false);
  let authRecoveryPending = $state(false);
  let authRecoveryError = $state('');
  let authRecoverySaveRequired = $state(false);
  let profile = $state<UserProfile>(cloneProfile());
  let mailbox = $state<MailboxState>(cloneMailbox());
  let metrics = $state<WorkspaceMetrics>({ inboxCount: 0, archiveCount: 0, sentCount: 0, draftsCount: 0, trashCount: 0, unreadCount: 0, starredCount: 0,
    queuedCount: 0, delayedCount: 0, failedCount: 0, bouncedCount: 0, complainedCount: 0, staleDeliveryCount: 0 });
  let metricsIdentity = $state<MailboxIdentityFilter | null>(null);
  let mailboxRefreshing = $state(false);
  const metricsCache = new Map<string, { value: WorkspaceMetrics; updatedAt: number }>();
  const metricsRequest = new LatestRequest();
  const readActivation = new ReadActivationController();
  let mailboxPages = $state<Partial<Record<MailboxSection, MailboxPage>> | null>(null);
  let trashItems = $state<TrashItem[]>([]);
  let trashHasMore = $state(false);
  let trashLoading = $state(false);
  let trashLoaded = $state(false);
  let trashError = $state('');
  let emptyTrashConfirmOpen = $state(false);
  let activeSection = $state<AppSection>('inbox');
  let userLabels = $state<MailUserLabel[]>([]);
  let activeLabelId = $state<string | null>(null);
  const activeSectionTitle = $derived(({
    inbox: t('shell.inbox'),
    starred: t('shell.starred'),
    label: userLabels.find((label) => label.id === activeLabelId)?.name ?? t('shell.labels'),
    sent: t('shell.sent'),
    drafts: t('shell.drafts'),
    archive: t('shell.archive'),
    trash: t('shell.trash'),
    profile: t('common.settings')
  } satisfies Record<AppSection, string>)[activeSection]);
  let labelEditorMode = $state<'create' | 'rename' | null>(null);
  let labelEditorName = $state('');
  let labelCreateTarget = $state<MailMessage | null>(null);
  let labelActionPending = $state(false);
  let labelEditorInterrupted = $state(false);
  let labelTargetMessage = $state<MailMessage | null>(null);
  let bulkLabelDialogOpen = $state(false);
  let bulkLabelId = $state('');
  let bulkLabelPending = $state(false);
  let deleteLabelConfirmOpen = $state(false);
  let managementView = $state<WorkspaceUrlState['managementView']>('settings');
  type ProfilePaneComponent = (typeof import('$lib/components/mail/ProfilePane.svelte'))['default'];
  type MailIdentityManagerComponent = (typeof import('$lib/components/mail/MailIdentityManager.svelte'))['default'];
  let ProfilePane = $state<ProfilePaneComponent | null>(null);
  let MailIdentityManager = $state<MailIdentityManagerComponent | null>(null);
  let profilePaneLoading = $state(false);
  let mailIdentityManagerLoading = $state(false);
  let profilePaneLoadFailed = $state(false);
  let mailIdentityManagerLoadFailed = $state(false);
  const managementTitle = $derived(managementView === 'settings'
    ? t('common.settings')
    : managementView === 'domains' ? t('shell.domains') : t('shell.addresses'));
  let createAddressDomainId = $state('');
  let createAddressLocalPart = $state('');
  let selectedMessageId = $state<string | null>(null);
  let deepLinkedMessage = $state<MailMessage | null>(null);
  let selectedMessageIds = $state<string[]>([]);
  let bulkThreadScope = $state<'selected' | 'filtered' | 'owner'>('selected');
  let bulkSelectInput = $state<HTMLInputElement>();
  let searchQuery = $state('');
  let mailFilter = $state<MailFilter>('all');
  let inboxCategory = $state<InboxCategoryFilter>('all');
  let categoryPending = $state(false);
  const inboxCategories = ['primary', 'promotions', 'social', 'updates', 'forums'] as const;
  let mailIdentityFilter = $state<MailboxIdentityFilter | null>(null);
  let mailIdentityOptions = $state<WorkspaceSnapshot['mailIdentityOptions']>({ domains: [], addresses: [] });
  let mobileDetailOpen = $state(false);
  let listReturnFocus: HTMLElement | null = null;
  let readerOpen = $state(false);
  let sidebarCollapsed = $state(false);
  let listWidth = $state(DEFAULT_LAYOUT_PREFERENCES.listWidth);
  let workspaceElement = $state<HTMLElement>();
  let workspaceWidth = $state(Number.POSITIVE_INFINITY);
  let density = $state<DisplayDensity>('comfortable');
  let readingLayout = $state<ReadingLayout>('list');
  let bodyViewByMessage = $state<Record<string, 'text' | 'html'>>({});
  let remoteImagesMessageId = $state<string | null>(null);
  let shortcutHelpOpen = $state(false);
  let composeOpen = $state(false);
  type ComposeModalComponent = (typeof import('$lib/components/mail/ComposeModal.svelte'))['default'];
  let ComposeModal = $state<ComposeModalComponent | null>(null);
  let composeModuleLoading = $state(false);
  let handledComposeAction = $state<string | null>(null);
  let composeMode = $state<ComposeMode>('new');
  let composeInitialInput = $state<ComposeInput | null>(null);
  let composeDraftId = $state<string | undefined>(undefined);
  let composeSubmissionId = $state<string | undefined>(undefined);
  let composeLiveInput = $state<ComposeInput | null>(null);
  let composeTouched = $state(false);
  let composeAutosavePending = $state(false);
  let composeClosePending = $state(false);
  let composeAutosaveStatus = $state<ComposeAutosaveStatus>('idle');
  let composeAutosaveMessage = $state(t('compose.autosaveIdle'));
  let composeLastSavedSignature = $state('');
  let draftConflict = $state<DraftConflictInfo | null>(null);
  let draftConflictLocalEditedAt = $state<string | null>(null);
  let inboundDetails = $state<Record<string, InboundMessageDetail>>({});
  let deliveryDetails = $state<Record<string, DeliveryDetail>>({});
  let inboundDetailErrors = $state<Record<string, string>>({});
  let deliveryDetailErrors = $state<Record<string, string>>({});
  let inboundDetailPendingId = $state<string | null>(null);
  let deliveryDetailPendingId = $state<string | null>(null);
  let workspaceBodies = $state<Record<string, WorkspaceBodyDetail>>({});
  let workspaceBodyErrors = $state<Record<string, string>>({});
  let workspaceBodyPendingId = $state<string | null>(null);
  let toastMessages = $state<ToastMessage[]>([]);
  let sendAnnouncement = $state('');
  let runtimeOperationError = $state(false);
  let loginError = $state('');
  let profileStatus = $state('');
  let profileStatusError = $state(false);
  let pending = $state(false);
  let mailboxLoading = $state(false);
  let mailboxError = $state('');
  let mailboxLoadingMore = $state(false);
  let mailboxRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  let workspaceSync: WorkspaceSyncController | null = null;
  let authSessionSync: ReturnType<typeof createAuthSessionChannel> | null = null;
  let authRecoveryPromise: Promise<boolean> | null = null;
  let composeSavePromise: Promise<void> | null = null;
  const composeAutosave = new ComposeAutosaveController();
  const listWidthRange = layoutPreferenceRange();
  const effectiveListWidth = $derived(clampListWidth(listWidth, workspaceWidth));
  const effectiveListWidthRange = $derived({
    min: clampListWidth(listWidthRange.min, workspaceWidth),
    max: clampListWidth(listWidthRange.max, workspaceWidth)
  });
  let stopListResize: (() => void) | null = null;
  const inboundDetailCache = new DetailCacheController<InboundMessageDetail>(t('mail.inboundDetailFailed'), (snapshot) => {
    inboundDetails = snapshot.values;
    inboundDetailErrors = snapshot.errors;
    inboundDetailPendingId = snapshot.pendingId;
  }, { formatError: displayError });
  const deliveryDetailCache = new DetailCacheController<DeliveryDetail>(t('mail.deliveryDetailFailed'), (snapshot) => {
    deliveryDetails = snapshot.values;
    deliveryDetailErrors = snapshot.errors;
    deliveryDetailPendingId = snapshot.pendingId;
  }, { formatError: displayError });
  const workspaceBodyCache = new DetailCacheController<WorkspaceBodyDetail>(t('mail.bodyLoadFailed'), (snapshot) => {
    workspaceBodies = snapshot.values;
    workspaceBodyErrors = snapshot.errors;
    workspaceBodyPendingId = snapshot.pendingId;
  }, { formatError: displayError });
  const shortcuts = new WorkspaceShortcutController();
  const labelRequest = new LatestRequest();
  const labelActionRequest = new LatestRequest();
  const bulkLabelRequest = new LatestRequest();

  // Cancel local requests and continuations; server writes may already be committed.
  function cancelLabelActions() {
    labelActionRequest.cancel();
    bulkLabelRequest.cancel();
    labelActionPending = false;
    bulkLabelPending = false;
  }

  function replySource(message: MailMessage): MailMessage {
    if (!isInboundMessageId(message.id)) return message;
    const detail = inboundDetails[message.id];
    if (!detail) return message;
    return {
      ...message,
      recipientAddressId: detail.recipientAddressId ?? message.recipientAddressId,
      toAddresses: detail.toAddresses.length ? detail.toAddresses : message.toAddresses,
      ccAddresses: detail.ccAddresses.length ? detail.ccAddresses : message.ccAddresses
    };
  }
  const toastController = new ToastController((messages) => (toastMessages = messages));
  const workspaceSnapshotController = new WorkspaceSnapshotController();
  const targetMessageRequest = new LatestRequest();
  const draftOpenRequest = new LatestRequest();
  const trashController = new TrashController(fetchTrash, {
    onResult: (result) => {
      trashItems = result.items;
      trashHasMore = result.hasMore;
      trashLoaded = true;
      trashError = '';
      acceptMetrics(result.metrics, null);
      if (activeSection === 'trash' && (!selectedMessageId || !result.items.some((item) => item.id === selectedMessageId))) {
        selectedMessageId = result.items[0]?.id ?? null;
      }
    },
    onLoading: (loading) => (trashLoading = loading),
    onError: () => {
      trashLoaded = true;
      trashError = t('mail.listError');
    }
  });

  const notify = (message: string, tone: ToastTone = 'info', options: {
    requestId?: string;
    persistent?: boolean;
    timeoutMs?: number;
    action?: { label: string; run: () => void | Promise<void> };
  } = {}) => toastController.push({ tone, message, ...options });

  const notifyError = (error: unknown, fallback: string) => {
    if (authExpired || isClientAuthExpired()) return;
    if (!(error instanceof ClientApiError) || error.status >= 500) runtimeOperationError = true;
    notify(
      displayError(error, fallback),
      'error',
      { requestId: error instanceof ClientApiError ? error.requestId : undefined }
    );
  };

  function enterAuthExpired(source: AuthExpirySource) {
    if (authExpired) return;
    authExpired = true;
    if (labelEditorMode && labelActionPending) labelEditorInterrupted = true;
    authRecoveryError = '';
    const composeInput = composeLiveInput ? withCurrentComposePersistence(composeLiveInput) : null;
    const hasUnsavedCompose = Boolean(
      composeOpen && composeTouched && composeInput && hasComposeContent(composeInput) &&
      serializeComposeInput(composeInput) !== composeLastSavedSignature
    );
    if (hasUnsavedCompose) {
      authRecoverySaveRequired = true;
      composeAutosaveStatus = 'error';
      composeAutosaveMessage = t('compose.authExpiredDraftPreserved');
    }
    clearComposeAutosaveTimer();
    composeAutosave.reset();
    composeAutosavePending = false;
    composeClosePending = false;
    clearMailboxRefreshTimer();
    mailboxController.reset();
    flagController.reset();
    readActivation.reset();
    metricsRequest.cancel();
    metricsCache.clear();
    labelRequest.cancel();
    cancelLabelActions();
    // Reopen server-backed choices after recovery; keep typed editor text intact.
    labelTargetMessage = null;
    bulkLabelDialogOpen = false;
    deleteLabelConfirmOpen = false;
    trashController.cancel();
    targetMessageRequest.cancel();
    draftOpenRequest.cancel();
    inboundDetailCache.cancel();
    deliveryDetailCache.cancel();
    workspaceBodyCache.cancel();
    if (source !== 'other-tab') authSessionSync?.publish({ type: 'expired' });
  }

  // SvelteKit shallow pushState changes history/page.state, not page.url.
  // Track the visible browser URL so list filters and Back/Forward share one source.
  let browserWorkspaceUrl = $state<string | null>(null);
  const currentWorkspaceUrl = $derived(browserWorkspaceUrl ? new URL(browserWorkspaceUrl) : page.url);
  const urlState = $derived(readWorkspaceUrl(currentWorkspaceUrl));
  afterNavigate(() => { browserWorkspaceUrl = window.location.href; });
  const urlSection = $derived(urlState.section);
  const urlManagementView = $derived(urlState.managementView);
  const urlManagementDomainId = $derived(urlState.managementDomainId);
  const urlQuery = $derived(urlState.query);
  const urlFilter = $derived(urlState.filter);
  const urlCategory = $derived(urlState.category);
  const urlIdentityFilter = $derived(urlState.identityFilter);
  const urlMessageId = $derived(urlState.messageId);
  const urlLabelId = $derived(urlState.labelId);

  $effect(() => {
    activeSection = urlSection;
    activeLabelId = urlLabelId;
    managementView = urlManagementView;
    createAddressDomainId = urlManagementDomainId ?? '';
    if (urlManagementView !== 'addresses') createAddressLocalPart = '';
    searchQuery = urlQuery;
    mailFilter = urlFilter;
    inboxCategory = urlCategory;
    mailIdentityFilter = urlIdentityFilter;
    selectedMessageId = urlMessageId;
    selectedMessageIds = [];
    mobileDetailOpen = Boolean(urlMessageId);
  });

  $effect(() => {
    const section = urlSection;
    const query = urlQuery;
    const filter = urlFilter;
    const identity = urlIdentityFilter;
    const label = urlLabelId;
    const category = urlCategory;
    if (!authenticated || authExpired) return;
    untrack(() => {
      clearMailboxRefreshTimer();
      if (section === 'profile' || section === 'trash') { mailboxController.cancel(); return; }
      const navigate = () => { void mailboxController.navigate(section, query, filter, identity, label, category); };
      if (mailboxPages?.[section]?.query !== query && query.trim()) mailboxRefreshTimer = setTimeout(navigate, 250);
      else navigate();
    });
  });

  $effect(() => {
    const identity = mailIdentityFilter;
    if (authenticated && !authExpired) untrack(() => { void refreshMetrics(identity); });
  });

  $effect(() => {
    if (!authenticated || activeSection !== 'profile') return;
    if (managementView === 'settings') void loadProfilePane();
    else void loadMailIdentityManager();
  });

  async function loadProfilePane() {
    if (ProfilePane || profilePaneLoading || profilePaneLoadFailed) return;
    profilePaneLoading = true;
    try {
      ProfilePane = (await import('$lib/components/mail/ProfilePane.svelte')).default;
    } catch {
      profilePaneLoadFailed = true;
    } finally {
      profilePaneLoading = false;
    }
  }

  async function loadMailIdentityManager() {
    if (MailIdentityManager || mailIdentityManagerLoading || mailIdentityManagerLoadFailed) return;
    mailIdentityManagerLoading = true;
    try {
      MailIdentityManager = (await import('$lib/components/mail/MailIdentityManager.svelte')).default;
    } catch {
      mailIdentityManagerLoadFailed = true;
    } finally {
      mailIdentityManagerLoading = false;
    }
  }

  $effect(() => {
    const workspace = serverWorkspace;
    if (workspace) {
      const decision = workspaceSnapshotController.accept(data.snapshotIdentity, workspace.profile.email);
      if (!decision.apply) return;
      untrack(() => {
        applyWorkspaceSnapshot(workspace, {
          section: urlSection,
          preferredMessageId: urlMessageId,
          resetUserScoped: decision.resetUserScoped
        });
        if (decision.announceRestore) {
          notify(t('notify.workspaceRestored'), 'success');
        }
      });
    }
  });

  $effect(() => {
    const targetId = urlMessageId;
    const section = activeSection;
    if (
      !authenticated ||
      authExpired ||
      !targetId ||
      section === 'profile' ||
      section === 'trash' ||
      (section !== 'inbox' && section !== 'archive' && section !== 'sent' && section !== 'starred' && section !== 'label')
    ) return;
    const currentMessages = section === 'archive'
      ? mailboxPages?.archive?.messages ?? []
      : section === 'inbox' ? mailbox.inbox
        : section === 'sent' ? mailbox.sent
        : mailboxPages?.[section]?.messages ?? [];
    if (currentMessages.some((message) => message.id === targetId) || deepLinkedMessage?.id === targetId) return;

    const request = targetMessageRequest.begin();
    void (async () => {
      try {
        const result = await fetchWorkspaceMessage(targetId, request.signal);
        if (!request.isCurrent() || urlMessageId !== targetId || activeSection !== section) return;
        // An explicit older-message link is independent of the current page cursor.
        // Keep the category, search and identity scope rather than injecting a row.
        deepLinkedMessage = result.message;
        selectedMessageId = targetId;
        mobileDetailOpen = true;
      } catch (error) {
        if (request.signal.aborted || !request.isCurrent()) return;
        if (error instanceof ClientApiError && (error.status === 401 || error.status === 403 || error.status === 404)) {
          selectedMessageId = null;
          mobileDetailOpen = false;
          updateWorkspaceUrl({ messageId: null }, true);
          notify(t('notify.messageUnavailable'), 'error');
          return;
        }
        notifyError(error, t('notify.targetMessageFailed'));
      }
    })();

    return () => targetMessageRequest.cancel();
  });

  const unreadCount = $derived(sameIdentityScope(metricsIdentity, mailIdentityFilter) ? metrics.unreadCount : 0);
  const recipientSuggestions = $derived(deriveRecipientSuggestions(
    [...mailbox.inbox, ...mailbox.sent],
    mailIdentityOptions.addresses.map((address) => address.email)
  ));
  const serviceDegraded = $derived(
    runtimeOperationError || metrics.delayedCount + metrics.failedCount + metrics.bouncedCount + metrics.complainedCount + metrics.staleDeliveryCount > 0
  );
  const activeMessages = $derived(
    activeSection === 'trash'
      ? trashItems.map((item) => item.message)
      : activeSection === 'drafts'
      ? mailbox.drafts
      : activeSection === 'archive' || activeSection === 'starred' || activeSection === 'label'
        ? mailboxPages?.[activeSection]?.messages ?? []
        : []
  );
  const activeThreads = $derived(
    activeSection === 'inbox' || activeSection === 'sent'
      ? searchQuery.trim()
        ? buildMailThreads(activeSection === 'inbox' ? { ...mailbox, sent: [] } : { ...mailbox, inbox: [] }, activeSection)
        : buildMailThreads(mailbox, activeSection)
      : activeSection === 'archive'
        ? buildMailThreads({ ...mailbox, inbox: activeMessages }, 'inbox')
        : []
  );
  const visibleMessages = $derived.by(() =>
    activeMessages.filter((message) => {
      const matchesFilter =
        mailFilter === 'all' ||
        (mailFilter === 'unread' && !message.read) ||
        (mailFilter === 'starred' && message.starred);
      return matchesFilter;
    })
  );
  const visibleThreads = $derived.by(() =>
    (activeSection === 'inbox' && (mailboxPages?.inbox?.category ?? 'all') !== inboxCategory ? [] : activeThreads).filter((thread) => {
      const matchesFilter =
        mailFilter === 'all' ||
        (mailFilter === 'unread' && thread.unreadCount > 0) ||
        (mailFilter === 'starred' && thread.messages.some((message) => message.starred));
      return matchesFilter;
    })
  );
  const bulkSelectableIds = $derived.by(() => activeSection === 'drafts' || activeSection === 'trash' || activeSection === 'profile'
    ? []
    : visibleThreads.length
      ? visibleThreads.map((thread) => thread.sectionLatestMessage.id)
      : visibleMessages.map((message) => message.id));
  const selectedMessageIdSet = $derived(new Set(selectedMessageIds));
  const bulkSelectedMessages = $derived(selectedVisibleMessages(visibleThreads, visibleMessages, selectedMessageIdSet));
  const bulkHasDraftSelection = $derived(bulkSelectedMessages.some((message) => message.folder === 'drafts'));
  const bulkCanMutateMessages = $derived(bulkSelectedMessages.length > 0 && !bulkHasDraftSelection);
  const bulkInboxOnly = $derived(bulkCanMutateMessages && bulkSelectedMessages.every((message) => message.folder === 'inbox'));
  const bulkHasUnarchivedInbox = $derived(bulkInboxOnly && bulkSelectedMessages.some((message) => !message.archivedAt));
  const bulkHasArchivedInbox = $derived(bulkInboxOnly && bulkSelectedMessages.some((message) => Boolean(message.archivedAt)));
  const bulkSelectedVisibleCount = $derived(bulkSelectableIds.filter((id) => selectedMessageIdSet.has(id)).length);
  const bulkSelectedThreadCount = $derived(visibleThreads.filter((thread) =>
    Boolean(thread.sectionLatestMessage.threadKey) && selectedMessageIdSet.has(thread.sectionLatestMessage.id)
  ).length);
  const bulkAllSelected = $derived(bulkSelectableIds.length > 0 && bulkSelectedVisibleCount === bulkSelectableIds.length);
  const bulkSomeSelected = $derived(bulkSelectedVisibleCount > 0 && !bulkAllSelected);

  $effect(() => {
    if (bulkSelectInput) bulkSelectInput.indeterminate = bulkSomeSelected;
  });
  const selectedThread = $derived.by(() => {
    if (activeSection === 'drafts' || activeSection === 'trash' || activeSection === 'profile' || activeSection === 'starred' || activeSection === 'label') {
      return null;
    }

    const threads = visibleThreads;

    if (!threads.length) {
      return null;
    }

    return threads.find((thread) => thread.messages.some((message) => message.id === selectedMessageId))
      ?? (selectedMessageId || readingLayout === 'list' ? null : threads[0]);
  });
  const selectedThreadId = $derived(selectedThread?.id ?? null);
  const selectedMessage = $derived.by(() => {
    if (deepLinkedMessage && deepLinkedMessage.id === selectedMessageId && (urlMessageId === selectedMessageId || readingLayout === 'split')) return deepLinkedMessage;
    if (activeSection === 'drafts' || activeSection === 'trash' || activeSection === 'starred' || activeSection === 'label') {
      const list = visibleMessages;

      if (!list.length) {
        return null;
      }

      return list.find((message) => message.id === selectedMessageId) ?? (selectedMessageId || readingLayout === 'list' ? null : list[0]);
    }

    const thread = selectedThread;

    if (!thread) {
      return null;
    }

    return (
      thread.messages.find((message) => message.id === selectedMessageId) ??
      thread.sectionLatestMessage ??
      thread.latestMessage
    );
  });
  const selectedThreadMessages = $derived(selectedThread?.messages ?? (selectedMessage ? [selectedMessage] : []));
  const selectedReplyAllAvailable = $derived(Boolean(
    selectedMessage &&
      activeSection !== 'trash' &&
      selectedMessage.folder !== 'drafts' &&
      hasDistinctReplyAllRecipients(replySource(selectedMessage), {
        selfEmail: profile.email,
        selfEmails: mailIdentityOptions.addresses.map((address) => address.email),
        replyTo: isInboundMessageId(selectedMessage.id) ? inboundDetails[selectedMessage.id]?.replyTo : undefined
      })
  ));
  const selectedInboundDetail = $derived(
    selectedMessage && isInboundMessageId(selectedMessage.id)
      ? inboundDetails[selectedMessage.id] ?? null
      : null
  );
  const selectedInboundDetailError = $derived(
    selectedMessage && isInboundMessageId(selectedMessage.id)
      ? inboundDetailErrors[selectedMessage.id] ?? ''
      : ''
  );
  const selectedInboundDownloadHref = $derived(
    selectedMessage && isInboundMessageId(selectedMessage.id)
      ? `/api/workspace/messages/${encodeURIComponent(selectedMessage.id)}/raw`
      : null
  );
  const selectedDeliveryDetail = $derived(
    selectedMessage && selectedMessage.folder === 'sent' && selectedMessage.source === 'workspace'
      ? deliveryDetails[selectedMessage.id] ?? null
      : null
  );
  const selectedDeliveryDetailError = $derived(
    selectedMessage && selectedMessage.folder === 'sent' && selectedMessage.source === 'workspace'
      ? deliveryDetailErrors[selectedMessage.id] ?? ''
      : ''
  );
  const selectedWorkspaceBody = $derived(
    selectedMessage && !isInboundMessageId(selectedMessage.id)
      ? workspaceBodies[selectedMessage.id]?.body ?? null
      : null
  );
  const selectedWorkspaceBodyError = $derived(
    selectedMessage && !isInboundMessageId(selectedMessage.id)
      ? workspaceBodyErrors[selectedMessage.id] ?? ''
      : ''
  );
  const selectedBodyView = $derived(selectedMessage ? bodyViewByMessage[selectedMessage.id] ?? 'text' : 'text');
  const selectedRemoteImagesAllowed = $derived(Boolean(selectedMessage && remoteImagesMessageId === selectedMessage.id));

  $effect(() => {
    const action = currentWorkspaceUrl.searchParams.get('compose');
    const requestedMessageId = currentWorkspaceUrl.searchParams.get('message');
    if (action !== 'reply' && action !== 'forward') {
      handledComposeAction = null;
      return;
    }
    if (!authenticated || !selectedMessage || requestedMessageId !== selectedMessage.id) return;
    const actionKey = `${action}:${requestedMessageId}`;
    if (handledComposeAction === actionKey) return;
    handledComposeAction = actionKey;
    const nextUrl = new URL(currentWorkspaceUrl);
    nextUrl.searchParams.delete('compose');
    replaceState(nextUrl, page.state);
    browserWorkspaceUrl = nextUrl.href;
    if (action === 'reply') void handleReplyMessage(selectedMessage);
    else void handleForwardMessage(selectedMessage);
  });

  $effect(() => {
    if (!selectedMessage) readerOpen = false;
  });
  const composeBusy = $derived(pending || composeAutosavePending || composeClosePending);

  $effect(() => {
    if (authenticated && activeSection === 'trash' && !trashLoaded && !trashLoading) {
      if (authExpired) return;
      void trashController.load();
    }
  });

  const clearComposeAutosaveTimer = () => {
    composeAutosave.clear();
  };

  const withCurrentComposePersistence = (input: ComposeInput) =>
    withComposePersistence(input, {
      draftId: input.draftId ?? composeDraftId,
      expectedUpdatedAt: input.expectedUpdatedAt ?? composeLiveInput?.expectedUpdatedAt
    });

  const resetComposeState = () => {
    clearComposeAutosaveTimer();
    composeAutosave.reset();
    composeOpen = false;
    composeMode = 'new';
    composeInitialInput = null;
    composeDraftId = undefined;
    composeSubmissionId = undefined;
    composeLiveInput = null;
    composeTouched = false;
    composeAutosavePending = false;
    composeClosePending = false;
    composeSavePromise = null;
    authRecoverySaveRequired = false;
    composeAutosaveStatus = 'idle';
    composeAutosaveMessage = t('compose.autosaveIdle');
    composeLastSavedSignature = '';
    draftConflict = null;
    draftConflictLocalEditedAt = null;
  };

  const syncComposeDraftState = (
    message: MailMessage,
    statusMessage: string,
    bodyRevision?: string | null,
    attachments: ComposeInput['attachments'] = [],
    attachmentRevision = 0
  ) => {
    const nextInput = composeInputFromSavedDraft(message, bodyRevision, attachments, attachmentRevision);

    composeDraftId = message.id;
    composeLiveInput = nextInput;
    composeTouched = false;
    composeAutosaveStatus = 'saved';
    composeAutosaveMessage = statusMessage;
    composeLastSavedSignature = serializeComposeInput(nextInput);
  };

  function applyMessageDelta(result: MessageDelta, options?: { section?: AppSection; preferredMessageId?: string | null; clearMailView?: boolean; removeDraftId?: string }) {
    mailboxController.invalidate();
    metricsCache.clear();
    metricsRequest.cancel();
    if (deepLinkedMessage?.id === result.message.id) deepLinkedMessage = result.message;
    if (result.message.userLabels === undefined || result.message.hasAttachments === undefined) {
      const previous = [...mailbox.inbox, ...mailbox.sent, ...mailbox.drafts, ...Object.values(mailboxPages ?? {}).flatMap((page) => page?.messages ?? [])]
        .find((message) => message.id === result.message.id);
      if (previous) result = { ...result, message: {
        ...result.message,
        ...(result.message.userLabels === undefined && previous.userLabels ? { userLabels: previous.userLabels } : {}),
        ...(result.message.hasAttachments === undefined && previous.hasAttachments !== undefined ? { hasAttachments: previous.hasAttachments } : {})
      } };
    }
    const merged = mergeMessageDelta(
      { mailbox, mailboxPages, metrics },
      result,
      {
        currentSection: activeSection,
        currentSelectedMessageId: selectedMessageId,
        identityFilter: mailIdentityFilter,
        identityAddresses: mailIdentityOptions.addresses.map(({ id, domainId }) => ({ id, domainId })),
        query: searchQuery,
        filter: mailFilter,
        section: options?.section,
        preferredMessageId: options?.preferredMessageId,
        removeDraftId: options?.removeDraftId
      }
    );
    mailbox = merged.snapshot.mailbox;
    mailboxPages = merged.snapshot.mailboxPages;
    metrics = merged.snapshot.metrics;
    if (merged.metricsApplied) metricsIdentity = mailIdentityFilter;
    runtimeOperationError = false;
    authenticated = true;
    if (options?.section) activeSection = options.section;
    if (options?.clearMailView) {
      searchQuery = '';
      mailFilter = 'all';
      mailIdentityFilter = null;
      mobileDetailOpen = false;
    }
    selectedMessageId = merged.selectedMessageId;
    if (options?.section) {
      mobileDetailOpen = options.section !== 'profile' && Boolean(selectedMessageId);
      updateWorkspaceUrl({ section: options.section, query: options.clearMailView ? '' : undefined, filter: options.clearMailView ? 'all' : undefined,
        identityFilter: options.clearMailView ? null : undefined, messageId: options.section === 'profile' ? null : selectedMessageId }, true);
    }
    if (options?.clearMailView || !merged.messageApplied || !merged.metricsApplied) {
      scheduleMailboxRefresh(activeSection, searchQuery, mailFilter, 0, mailIdentityFilter);
    }
  }

  const describeDeliveryState = (message: MailMessage) =>
    message.deliveryResultKind === 'accepted'
      ? t('notify.sentAccepted', { provider: message.deliveryProvider ?? t('notify.deliveryService') })
      : message.deliveryResultKind === 'queued'
        ? t('notify.sentQueued', { email: message.toEmail })
        : message.deliveryResultKind === 'temporary_failure'
          ? t('notify.sentRetryable', { error: message.deliveryError ?? t('notify.tryLater') })
          : message.deliveryResultKind === 'rate_limited'
            ? t('notify.sentRateLimited', { error: message.deliveryError ?? t('notify.tryLater') })
            : t('notify.sentFailed', { error: message.deliveryError ?? t('notify.tryLater') });

  $effect(() => {
    if (
      !authExpired &&
      selectedMessage &&
      isInboundMessageId(selectedMessage.id) &&
      !inboundDetails[selectedMessage.id] &&
      inboundDetailPendingId !== selectedMessage.id &&
      !inboundDetailErrors[selectedMessage.id]
    ) {
      void loadInboundDetail(selectedMessage);
    }
  });

  $effect(() => {
    if (
      !authExpired &&
      selectedMessage &&
      !isInboundMessageId(selectedMessage.id) &&
      !workspaceBodies[selectedMessage.id] &&
      workspaceBodyPendingId !== selectedMessage.id &&
      !workspaceBodyErrors[selectedMessage.id]
    ) {
      void loadWorkspaceBody(selectedMessage);
    }
  });

  $effect(() => {
    clearComposeAutosaveTimer();

    const input = composeLiveInput;
    const signature = serializeComposeInput(input ? withCurrentComposePersistence(input) : null);

    if (
      !composeOpen ||
      !composeTouched ||
      !input ||
      pending ||
      composeAutosavePending ||
      composeClosePending ||
      authExpired ||
      authRecoverySaveRequired ||
      !hasComposeContent(input) ||
      signature === composeLastSavedSignature
    ) {
      return;
    }

    composeAutosave.schedule(() => {
      void autosaveDraft();
    });

    return () => {
      clearComposeAutosaveTimer();
    };
  });

  $effect(() => {
    if (
      !authExpired &&
      selectedMessage &&
      selectedMessage.folder === 'sent' &&
      selectedMessage.source === 'workspace' &&
      !deliveryDetails[selectedMessage.id] &&
      deliveryDetailPendingId !== selectedMessage.id &&
      !deliveryDetailErrors[selectedMessage.id]
    ) {
      void loadDeliveryDetail(selectedMessage);
    }
  });

  function applyWorkspaceSnapshot(
    workspace: import('$lib/domain/mail').WorkspaceSnapshot,
    options?: {
      section?: AppSection;
      preferredMessageId?: string | null;
      clearMailView?: boolean;
      resetUserScoped?: boolean;
      syncUrl?: boolean;
    }
  ) {
    mailboxController.reset();
    flagController.reset();
    readActivation.reset();
    metricsRequest.cancel();
    metricsCache.clear();
    if (options?.resetUserScoped) {
      deepLinkedMessage = null;
      cancelLabelActions();
      labelEditorInterrupted = false;
      resetComposeState();
      inboundDetailCache.reset();
      deliveryDetailCache.reset();
      workspaceBodyCache.reset();
      trashController.cancel();
      trashItems = [];
      trashHasMore = false;
      trashLoaded = false;
      trashError = '';
    }
    const next = workspaceViewStateFromSnapshot(workspace, options);
    profile = next.profile;
    mailbox = next.mailbox;
    metrics = next.metrics;
    metricsIdentity = next.identityFilter;
    metricsCache.set(identityKey(next.identityFilter), { value: next.metrics, updatedAt: Date.now() });
    mailboxPages = next.mailboxPages;
    for (const cached of Object.values(next.mailboxPages ?? {})) if (cached) mailboxController.seed(cached);
    activeSection = next.activeSection;
    activeLabelId = next.activeSection === 'label' ? urlLabelId : null;
    selectedMessageId = readingLayout === 'list' && !options?.preferredMessageId ? null : next.selectedMessageId;
    selectedMessageIds = next.selectedMessageIds;
    searchQuery = next.searchQuery;
    mailFilter = next.mailFilter;
    inboxCategory = next.activeSection === 'inbox' && !options?.clearMailView ? urlCategory : 'all';
    mailIdentityFilter = next.identityFilter;
    mailIdentityOptions = workspace.mailIdentityOptions;
    mobileDetailOpen = next.activeSection !== 'profile' &&
      Boolean(options?.preferredMessageId);
    authenticated = true;
    void reloadMailLabels();
    workspaceSnapshotController.noteUser(workspace.profile.email);

    if (options?.syncUrl) {
      updateWorkspaceUrl(
        {
          section: next.activeSection,
          query: next.searchQuery,
          filter: next.mailFilter,
          identityFilter: next.identityFilter,
          category: inboxCategory,
          messageId: next.activeSection === 'profile' ? null : selectedMessageId
        },
        true
      );
    }
  }

  function resetWorkspace() {
    draftOpenRequest.cancel();
    const initial = createEmptyWorkspaceViewState();
    mailboxController.reset();
    flagController.reset();
    readActivation.reset();
    metricsRequest.cancel();
    metricsCache.clear();
    labelRequest.cancel();
    cancelLabelActions();
    trashController.cancel();
    authenticated = false;
    deepLinkedMessage = null;
    profile = initial.profile;
    mailbox = initial.mailbox;
    activeSection = initial.activeSection;
    activeLabelId = null;
    userLabels = [];
    labelEditorMode = null;
    labelEditorInterrupted = false;
    labelCreateTarget = null;
    labelTargetMessage = null;
    bulkLabelDialogOpen = false;
    bulkLabelId = '';
    bulkLabelPending = false;
    deleteLabelConfirmOpen = false;
    selectedMessageId = initial.selectedMessageId;
    selectedMessageIds = initial.selectedMessageIds;
    mailboxPages = initial.mailboxPages;
    metrics = initial.metrics;
    searchQuery = initial.searchQuery;
    mailFilter = initial.mailFilter;
    mailIdentityFilter = initial.identityFilter;
    mailIdentityOptions = { domains: [], addresses: [] };
    mobileDetailOpen = false;
    shortcutHelpOpen = false;
    mailboxLoading = false;
    mailboxLoadingMore = false;
    trashItems = [];
    trashHasMore = false;
    trashLoading = false;
    trashLoaded = false;
    trashError = '';
    authExpired = false;
    authRecoveryPending = false;
    authRecoveryError = '';
    authRecoverySaveRequired = false;
    clearClientAuthExpired();
    emptyTrashConfirmOpen = false;
    resetComposeState();
    inboundDetailCache.reset();
    deliveryDetailCache.reset();
    workspaceBodyCache.reset();
    profileStatus = '';
    profileStatusError = false;
    loginError = '';
    runtimeOperationError = false;
    sendAnnouncement = '';
    workspaceSnapshotController.reset();
  }

  async function loadInboundDetail(message: MailMessage, force = false) {
    if (authExpired || !isInboundMessageId(message.id)) {
      return false;
    }
    return inboundDetailCache.load(
      message.id,
      async (signal) => (await fetchInboundDetail(message.id, signal)).detail,
      force
    );
  }

  async function loadDeliveryDetail(message: MailMessage, force = false) {
    if (authExpired || message.folder !== 'sent' || message.source !== 'workspace') {
      return false;
    }
    return deliveryDetailCache.load(
      message.id,
      async (signal) => (await fetchDeliveryDetail(message.id, signal)).detail,
      force
    );
  }

  async function loadWorkspaceBody(message: MailMessage, force = false) {
    if (authExpired || isInboundMessageId(message.id)) return false;
    return workspaceBodyCache.load(
      message.id,
      async (signal) => await fetchMessageBody(message.id, signal),
      force
    );
  }

  function draftConflictFromError(error: unknown): DraftConflictInfo | null {
    if (!(error instanceof ClientApiError) || error.code !== 'DRAFT_CONFLICT') return null;
    const draftId = error.details?.draftId;
    const updatedAt = error.details?.updatedAt;
    return typeof draftId === 'string' && draftId.length > 0 && typeof updatedAt === 'string' && updatedAt.length > 0
      ? { id: draftId, sentAt: updatedAt }
      : null;
  }

  function updateWorkspaceUrl(
    updates: {
      section?: AppSection;
      managementView?: WorkspaceUrlState['managementView'];
      managementDomainId?: string | null;
      query?: string;
      filter?: MailFilter;
      category?: InboxCategoryFilter;
      identityFilter?: MailboxIdentityFilter | null;
      messageId?: string | null;
      labelId?: string | null;
    },
    replaceHistory = false
  ) {
    const next = buildWorkspaceUrl(currentWorkspaceUrl, updates);
    browserWorkspaceUrl = next.href;
    if (replaceHistory) {
      replaceState(next, page.state);
    } else {
      pushState(next, page.state);
    }
  }

  function setSection(section: AppSection, syncUrl = true) {
    if (section === 'label') {
      if (activeLabelId) selectLabel(activeLabelId);
      return;
    }
    clearMailboxRefreshTimer();
    selectedMessageIds = [];
    bulkThreadScope = 'selected';
    activeSection = section;
    activeLabelId = null;
    managementView = 'settings';
    searchQuery = '';
    mailFilter = 'all';
    inboxCategory = 'all';
    mobileDetailOpen = false;

    if (section === 'inbox' || section === 'sent' || section === 'archive') {
      const threads = section === 'archive'
        ? buildMailThreads({ ...mailbox, inbox: mailboxPages?.archive?.messages ?? [] }, 'inbox')
        : buildMailThreads(mailbox, section);
      const currentThread = selectedMessageId
        ? threads.find((thread) => thread.messages.some((message) => message.id === selectedMessageId))
        : null;

      selectedMessageId = section === 'archive'
        ? currentThread?.sectionLatestMessage.id ?? threads[0]?.sectionLatestMessage.id ?? null
        : selectNextMessage(
            mailbox,
            section,
            currentThread?.sectionLatestMessage.id ?? selectedMessageId
          );

      if (syncUrl) {
        updateWorkspaceUrl({ section, query: '', filter: 'all', messageId: null });
      }
      return;
    }

    if (section === 'trash') {
      mailIdentityFilter = null;
      selectedMessageId = trashItems.some((item) => item.id === selectedMessageId)
        ? selectedMessageId
        : trashItems[0]?.id ?? null;
      if (syncUrl) updateWorkspaceUrl({ section, query: '', filter: 'all', identityFilter: null, messageId: null });
      if (authenticated && !authExpired) void trashController.load();
      return;
    }

    selectedMessageId = section === 'starred'
      ? mailboxPages?.starred?.messages.find((message) => message.id === selectedMessageId)?.id ?? mailboxPages?.starred?.messages[0]?.id ?? null
      : selectNextMessage(mailbox, section, selectedMessageId);
    if (syncUrl) {
      updateWorkspaceUrl({ section, query: '', filter: 'all', messageId: null });
    }
  }

  async function reloadMailLabels() {
    if (!authenticated || authExpired) return;
    const request = labelRequest.begin();
    try {
      const result = await fetchMailLabels(request.signal);
      if (!request.isCurrent() || !authenticated || authExpired) return;
      userLabels = result.labels;
      if (activeSection === 'label' && activeLabelId && !userLabels.some((label) => label.id === activeLabelId)) {
        setSection('inbox');
      }
    } catch (error) {
      if (request.signal.aborted) return;
      notifyError(error, t('label.loadFailed'));
    }
  }

  function selectLabel(id: string) {
    if (!userLabels.some((label) => label.id === id)) return;
    clearMailboxRefreshTimer();
    activeLabelId = id;
    activeSection = 'label';
    selectedMessageId = null;
    selectedMessageIds = [];
    searchQuery = '';
    mailFilter = 'all';
    inboxCategory = 'all';
    mobileDetailOpen = false;
    updateWorkspaceUrl({ section: 'label', labelId: id, query: '', filter: 'all', messageId: null });
  }

  function editLabel(mode: 'create' | 'rename', target: MailMessage | null = null) {
    labelEditorInterrupted = false;
    labelEditorMode = mode;
    labelEditorName = mode === 'rename' ? userLabels.find((label) => label.id === activeLabelId)?.name ?? '' : '';
    labelCreateTarget = mode === 'create' ? target : null;
  }

  function closeLabelEditor() {
    if (labelActionPending) return;
    labelEditorMode = null;
    labelEditorInterrupted = false;
    labelCreateTarget = null;
  }

  async function applyMessageLabel(message: MailMessage, labelId: string, enabled: boolean, request: ReturnType<LatestRequest['begin']>) {
    const kind: MailLabelMessageKind = message.source === 'inbound' ? 'inbound' : message.folder === 'drafts' ? 'draft' : 'workspace';
    const id = message.source === 'inbound' ? message.id.slice('email:'.length) : message.id;
    const result = await setMailMessageLabel(labelId, kind, id, enabled, request.signal);
    if (!request.isCurrent()) return;
    const update = (items: MailMessage[]) => items.map((item) => item.id === message.id ? { ...item, userLabels: result.labels } : item);
    mailbox = { inbox: update(mailbox.inbox), sent: update(mailbox.sent), drafts: update(mailbox.drafts) };
    if (mailboxPages) mailboxPages = Object.fromEntries(Object.entries(mailboxPages).map(([section, page]) => [section, page ? { ...page, messages: update(page.messages) } : page])) as typeof mailboxPages;
    if (labelTargetMessage?.id === message.id) labelTargetMessage = { ...message, userLabels: result.labels };
    if (activeSection === 'label') void refreshWorkspace(false);
  }

  async function saveLabel() {
    if (labelActionPending || !authenticated || authExpired) return;
    const request = labelActionRequest.begin();
    labelActionPending = true;
    try {
      const target = labelCreateTarget;
      const result = labelEditorMode === 'rename' && activeLabelId
        ? await renameMailLabel(activeLabelId, labelEditorName, request.signal)
        : await createMailLabel(labelEditorName, request.signal);
      if (!request.isCurrent()) return;
      labelEditorMode = null;
      labelCreateTarget = null;
      await reloadMailLabels();
      if (!request.isCurrent()) return;
      if (target) {
        try {
          await applyMessageLabel(target, result.label.id, true, request);
        } catch (error) {
          if (request.isCurrent()) notifyError(error, t('label.applyFailed'));
        }
      }
      if (!request.isCurrent()) return;
      if (activeSection === 'label' && activeLabelId === result.label.id) void refreshWorkspace(false);
    } catch (error) {
      if (request.isCurrent()) notifyError(error, t('label.saveFailed'));
    } finally {
      if (request.isCurrent()) labelActionPending = false;
    }
  }

  async function removeActiveLabel() {
    if (!activeLabelId || labelActionPending || !authenticated || authExpired) return;
    const request = labelActionRequest.begin();
    const removedLabelId = activeLabelId;
    labelActionPending = true;
    try {
      await deleteMailLabel(removedLabelId, request.signal);
      if (!request.isCurrent()) return;
      deleteLabelConfirmOpen = false;
      if (activeSection === 'label' && activeLabelId === removedLabelId) setSection('inbox');
      await reloadMailLabels();
    } catch (error) {
      if (request.isCurrent()) notifyError(error, t('label.deleteFailed'));
    } finally {
      if (request.isCurrent()) labelActionPending = false;
    }
  }

  async function toggleMessageLabel(message: MailMessage, labelId: string) {
    if (labelActionPending || !authenticated || authExpired) return;
    const request = labelActionRequest.begin();
    const enabled = !(message.userLabels ?? []).some((label) => label.id === labelId);
    labelActionPending = true;
    try {
      await applyMessageLabel(message, labelId, enabled, request);
    } catch (error) {
      if (request.isCurrent()) notifyError(error, t('label.applyFailed'));
    } finally {
      if (request.isCurrent()) labelActionPending = false;
    }
  }

  function openBulkLabelDialog() {
    if (!bulkSelectedMessages.length) return;
    bulkLabelId = activeLabelId && userLabels.some((label) => label.id === activeLabelId)
      ? activeLabelId : userLabels[0]?.id ?? '';
    bulkLabelDialogOpen = true;
  }

  async function changeBulkLabel(enabled: boolean) {
    if (bulkLabelPending || !bulkLabelId || !bulkSelectedMessages.length || !authenticated || authExpired) return;
    const request = bulkLabelRequest.begin();
    bulkLabelPending = true;
    try {
      const targets = bulkSelectedMessages.map((message) => ({
        kind: (message.source === 'inbound' ? 'inbound' : message.folder === 'drafts' ? 'draft' : 'workspace') as MailLabelMessageKind,
        id: message.source === 'inbound' ? message.id.slice('email:'.length) : message.id
      }));
      await setManyMailMessageLabels(bulkLabelId, targets, enabled, request.signal);
      if (!request.isCurrent()) return;
      bulkLabelDialogOpen = false;
      selectedMessageIds = [];
      await refreshWorkspace(false);
      if (!request.isCurrent()) return;
      workspaceSync?.publish({ type: 'mailbox-refresh' });
      notify(enabled ? t('label.bulkAdded') : t('label.bulkRemoved'), 'success');
    } catch (error) {
      if (request.isCurrent()) notifyError(error, t('label.applyFailed'));
    } finally {
      if (request.isCurrent()) bulkLabelPending = false;
    }
  }

  function setManagementView(view: 'domains' | 'addresses', domainId = '', addressLocalPart = '') {
    setSection('profile', false);
    managementView = view;
    createAddressDomainId = domainId;
    createAddressLocalPart = addressLocalPart;
    mailIdentityFilter = null;
    selectedMessageId = null;
    updateWorkspaceUrl({ section: 'profile', managementView: view, managementDomainId: domainId || null, query: '', filter: 'all', identityFilter: null, messageId: null });
  }

  function clearMailboxRefreshTimer() {
    if (mailboxRefreshTimer !== undefined) {
      clearTimeout(mailboxRefreshTimer);
      mailboxRefreshTimer = undefined;
    }
  }

  function scheduleMailboxRefresh(
    folder: AppSection,
    query: string,
    filter: MailFilter,
    delayMs = 250,
    identityFilter: MailboxIdentityFilter | null = mailIdentityFilter
  ) {
    clearMailboxRefreshTimer();
    if (!authenticated || authExpired || folder === 'profile' || folder === 'trash') return;
    mailboxRefreshTimer = setTimeout(() => {
      mailboxRefreshTimer = undefined;
      if (authenticated && !authExpired && activeSection === folder) {
        void mailboxController.refresh(folder, query, filter, identityFilter, folder === 'label' ? activeLabelId : null, folder === 'inbox' ? inboxCategory : 'all');
      }
    }, delayMs);
  }

  function handleSearchQueryChange(query: string) {
    searchQuery = query;
    selectedMessageId = null;
    selectedMessageIds = [];
    bulkThreadScope = 'selected';
    mobileDetailOpen = false;
    updateWorkspaceUrl({ query, messageId: null }, true);
  }

  function handleCategoryChange(category: InboxCategoryFilter) {
    if (category === inboxCategory) return;
    inboxCategory = category;
    selectedMessageId = null;
    selectedMessageIds = [];
    bulkThreadScope = 'selected';
    mobileDetailOpen = false;
    updateWorkspaceUrl({ category, messageId: null });
  }

  async function changeSelectedCategory(category: MailInboxCategory | null) {
    if (categoryPending || pending || activeSection !== 'inbox' || !bulkSelectedMessages.length) return;
    categoryPending = true;
    const ids = bulkSelectedMessages.map((message) => message.id);
    try {
      const changed = await setInboxCategory(ids, category, { section: 'inbox', identityFilter: mailIdentityFilter, category: inboxCategory });
      selectedMessageIds = selectedMessageIds.filter((id) => !ids.includes(id));
      await refreshWorkspace(false);
      workspaceSync?.publish({ type: 'mailbox-refresh' });
      const complete = ids.every((id) => changed.summaries.some((summary) => summary.id === id && summary.inboxCategoryOverride === category));
      notify(complete ? t('mail.category.updated') : t('mail.category.changedElsewhere'), complete ? 'success' : 'warning');
    } catch (error) { notifyError(error, t('notify.bulkFailed')); }
    finally { categoryPending = false; }
  }

  async function handleRowArchive(message: MailMessage) {
    if (pending || message.folder !== 'inbox') return;
    pending = true;
    try {
      await mutateMailbox(message.archivedAt ? 'unarchive' : 'archive', [message.id], [], {
        section: activeSection as MailboxMutationScope['section'], identityFilter: mailIdentityFilter,
        threadScope: 'selected', ...(activeSection === 'inbox' ? { category: inboxCategory } : {}),
        ...(activeSection === 'label' && activeLabelId ? { labelId: activeLabelId } : {})
      });
      if (selectedMessageId === message.id && readingLayout === 'list') closeMobileDetail();
      await refreshWorkspace(false);
      workspaceSync?.publish({ type: 'mailbox-refresh', id: message.id });
      notify(message.archivedAt ? t('notify.bulkUnarchived') : t('notify.bulkArchived'), 'success');
    } catch (error) { notifyError(error, t('notify.bulkFailed')); }
    finally { pending = false; }
  }

  function handleFilterChange(filter: MailFilter) {
    mailFilter = filter;
    selectedMessageId = null;
    selectedMessageIds = [];
    bulkThreadScope = 'selected';
    mobileDetailOpen = false;
    updateWorkspaceUrl({ filter, messageId: null });
  }

  function handleIdentityFilterChange(identityFilter: MailboxIdentityFilter | null) {
    mailIdentityFilter = identityFilter;
    selectedMessageId = null;
    selectedMessageIds = [];
    bulkThreadScope = 'selected';
    mobileDetailOpen = false;
    updateWorkspaceUrl({ identityFilter, messageId: null });
  }

  function clearMailFilters() {
    searchQuery = '';
    mailFilter = 'all';
    mailIdentityFilter = null;
    selectedMessageId = null;
    selectedMessageIds = [];
    bulkThreadScope = 'selected';
    mobileDetailOpen = false;
    inboxCategory = 'all';
    updateWorkspaceUrl({ query: '', filter: 'all', category: 'all', identityFilter: null, messageId: null }, true);
  }

  async function refreshWorkspace(announce = true) {
    mailboxController.invalidate();
    metricsCache.clear();
    metricsRequest.cancel();
    if (!authenticated || authExpired) return;
    if (activeSection === 'trash') {
      const refreshed = await trashController.load();
      if (refreshed) {
        runtimeOperationError = false;
        if (announce) notify(t('notify.trashRefreshed'), 'success');
      }
      return;
    }
    const refreshed = await mailboxController.refresh(
      activeSection === 'profile' ? 'inbox' : activeSection,
      searchQuery,
      mailFilter,
      mailIdentityFilter,
      activeSection === 'label' ? activeLabelId : null,
      activeSection === 'inbox' ? inboxCategory : 'all'
    );
    if (refreshed) {
      runtimeOperationError = false;
      if (announce) notify(t('notify.mailboxRefreshed'), 'success');
    }
  }

  async function recoverExpiredSession(): Promise<boolean> {
    if (!authExpired) return true;
    if (authRecoveryPromise) return authRecoveryPromise;

    authRecoveryPending = true;
    authRecoveryError = '';
    const operation = (async () => {
      try {
        const result = await fetchWorkspaceSession({ allowAfterAuthExpiry: true });
        if (!result.authenticated || !result.workspace) {
          authRecoveryError = t('auth.sessionNotRestored');
          return false;
        }

        authRecoverySaveRequired = authRecoverySaveRequired || Boolean(
          composeOpen && composeLiveInput && composeTouched && hasComposeContent(composeLiveInput) &&
          serializeComposeInput(withCurrentComposePersistence(composeLiveInput)) !== composeLastSavedSignature
        );
        profile = cloneProfile(result.workspace.profile);
        mailIdentityOptions = result.workspace.mailIdentityOptions;
        authenticated = true;
        clearClientAuthExpired();
        authExpired = false;
        if (composeOpen && authRecoverySaveRequired) {
          composeAutosaveStatus = 'dirty';
          composeAutosaveMessage = t('compose.authRecoveredDraftPaused');
        }
        authRecoveryError = '';
        authSessionSync?.publish({ type: 'authenticated' });

        void refreshWorkspace(false);
        void reloadMailLabels();
        const current = selectedMessage;
        if (current) {
          if (isInboundMessageId(current.id)) void loadInboundDetail(current, true);
          else void loadWorkspaceBody(current, true);
          if (current.folder === 'sent' && current.source === 'workspace') void loadDeliveryDetail(current, true);
        }
        return true;
      } catch (error) {
        authRecoveryError = displayError(error, t('auth.recoveryFailed'));
        return false;
      } finally {
        authRecoveryPending = false;
      }
    })();
    authRecoveryPromise = operation;
    try {
      return await operation;
    } finally {
      if (authRecoveryPromise === operation) authRecoveryPromise = null;
    }
  }

  function invalidateMessageCaches(messageId: string) {
    inboundDetailCache.invalidate(messageId);
    deliveryDetailCache.invalidate(messageId);
    workspaceBodyCache.invalidate(messageId);
  }

  function handleWorkspaceSync(event: import('$lib/client/workspace-sync').WorkspaceSyncEvent) {
    if (event.type === 'session-ended') {
      if (!authenticated) return;
      resetWorkspace();
      void goto(buildWorkspaceUrl(currentWorkspaceUrl, {
        section: 'inbox', query: '', filter: 'all', messageId: null
      }), { replaceState: true, noScroll: true, keepFocus: false });
      return;
    }

    if (event.type === 'mail-identity-options-changed') {
      if (!authenticated || authExpired) return;
      void fetchWorkspaceSession().then((result) => {
        if (!result.authenticated || !result.workspace) {
          markClientAuthExpired('worker-session');
          return;
        }
        profile = cloneProfile(result.workspace.profile);
        mailIdentityOptions = result.workspace.mailIdentityOptions;
      }).catch((error) => notifyError(error, t('settings.mailIdentityLoadFailed')));
      return;
    }

    if (!authenticated || authExpired) return;

    mailboxController.invalidate();
    metricsCache.clear();
    if (event.id) invalidateMessageCaches(event.id);
    const current = event.id && selectedMessage?.id === event.id ? selectedMessage : null;
    if (current) {
      if (isInboundMessageId(current.id)) void loadInboundDetail(current, true);
      else void loadWorkspaceBody(current, true);
      if (current.folder === 'sent' && current.source === 'workspace') void loadDeliveryDetail(current, true);
    }
    if (authenticated) void refreshWorkspace(false);
  }

  function applyMailboxPage(page: MailboxPage, append: boolean) {
    page = { ...page, messages: page.messages.map((message) => flagController.overlay(message)), ...(flagController.busy ? { metrics: undefined } : {}) };
    const merged = mergeMailboxPage({ mailbox, mailboxPages, metrics }, page, append);
    mailbox = merged.mailbox;
    mailboxPages = merged.mailboxPages;
    if (page.metrics) acceptMetrics(page.metrics, page.identityFilter ?? null);
    runtimeOperationError = false;
    mailboxError = '';
    const currentMessages = merged.mailboxPages?.[page.folder]?.messages ?? [];
    if (activeSection === page.folder) {
      selectedMessageIds = reconcileBulkSelection(selectedMessageIds, currentMessages);
      if (selectedMessageIds.length === 0) bulkThreadScope = 'selected';
    }
    if (
      activeSection === page.folder &&
      (!selectedMessageId || !currentMessages.some((message) => message.id === selectedMessageId)) &&
      !(selectedMessageId && deepLinkedMessage?.id === selectedMessageId && (readerOpen || mobileDetailOpen || readingLayout === 'split'))
    ) {
      if (readingLayout === 'split') selectedMessageId = currentMessages[0]?.id ?? null;
      else if (selectedMessageId && !urlMessageId) selectedMessageId = null;
    }
  }

  function toggleBulkSelection(message: MailMessage) {
    selectedMessageIds = selectedMessageIds.includes(message.id)
      ? selectedMessageIds.filter((id) => id !== message.id)
      : [...selectedMessageIds, message.id];
    bulkThreadScope = 'selected';
  }

  function selectAllVisible() {
    const ids = bulkSelectableIds;
    selectedMessageIds = bulkAllSelected
      ? selectedMessageIds.filter((id) => !ids.includes(id))
      : [...new Set([...selectedMessageIds, ...ids])];
    bulkThreadScope = 'selected';
  }

  async function handleBulkMutation(action: import('$lib/domain/mail').MailboxMutationAction) {
    if (!selectedMessageIds.length || !['inbox', 'sent', 'archive', 'starred', 'label'].includes(activeSection)) return;
    if (bulkHasDraftSelection) {
      notify(t('mail.bulkDraftRestriction'), 'info');
      return;
    }
    if (activeSection === 'label' && !activeLabelId) return;
    pending = true;
    try {
      const selected = bulkSelectedMessages;
      const validSelectedIds = selected.map((message) => message.id);
      if (!validSelectedIds.length) {
        selectedMessageIds = [];
        bulkThreadScope = 'selected';
        return;
      }
      const selectedThreadKeys = selected.map((message) => message.threadKey).filter((key): key is string => Boolean(key));
      const mixedView = activeSection === 'starred' || activeSection === 'label';
      const threadScope = !mixedView && bulkThreadScope !== 'selected' && selectedThreadKeys.length ? bulkThreadScope : 'selected';
      const threadKeys = threadScope === 'selected' ? [] : selectedThreadKeys;
      const scope: MailboxMutationScope = {
        section: activeSection as MailboxMutationScope['section'],
        identityFilter: mailIdentityFilter,
        threadScope,
        ...(activeSection === 'inbox' ? { category: inboxCategory } : {}),
        ...(activeSection === 'label' ? { labelId: activeLabelId! } : {}),
        ...(threadScope === 'filtered' ? { query: searchQuery, filter: mailFilter } : {})
      };
      if (action === 'read' || action === 'unread') await flagController.flush();
      const result = await mutateMailbox(action, validSelectedIds, threadKeys, scope);
      const metricsScope = result.result.metricsScope.identityFilter;
      if (sameIdentityScope(metricsScope, mailIdentityFilter)) {
        metrics = result.result.metrics;
      }
      if (action === 'trash') trashLoaded = false;
      selectedMessageIds = [];
      bulkThreadScope = 'selected';
      await refreshWorkspace(false);
      workspaceSync?.publish({ type: 'mailbox-refresh' });
      toastController.dismissPassive();
      notify(
        action === 'archive'
          ? t('notify.bulkArchived')
          : action === 'unarchive'
            ? t('notify.bulkUnarchived')
            : action === 'trash'
              ? t('notify.bulkTrashed')
            : t('notify.bulkUpdated'),
        'success'
      );
    } catch (error) {
      notifyError(error, t('notify.bulkFailed'));
    } finally {
      pending = false;
    }
  }

  const mailboxController = new MailboxController(fetchMailboxPage, {
    onPage: (page, append) => applyMailboxPage(page, append),
    onLoading: (loading, append) => {
      if (loading && !append) mailboxError = '';
      mailboxLoading = loading && !append;
      mailboxLoadingMore = loading && append;
    },
    onError: () => { mailboxError = t('mail.listError'); },
    onRefreshing: (refreshing) => { mailboxRefreshing = refreshing; if (refreshing) mailboxError = ''; }
  });

  async function loadMoreMailbox() {
    if (!authenticated || authExpired || mailboxLoading || mailboxLoadingMore || activeSection === 'profile' || activeSection === 'trash') return;
    await mailboxController.loadMore(activeSection, searchQuery, mailFilter, mailboxPages?.[activeSection], mailIdentityFilter, activeSection === 'label' ? activeLabelId : null, activeSection === 'inbox' ? inboxCategory : 'all');
  }

  function openCompose(mode: ComposeMode = 'new', initialInput: ComposeInput | null = null) {
    draftOpenRequest.cancel();
    if (composeOpen) {
      window.dispatchEvent(new Event('flaremail:restore-compose'));
      return;
    }
    toastController.dismissPassive();
    const senderAddressId = selectInitialComposeSenderAddressId(
      mailIdentityOptions.addresses,
      mode,
      mailIdentityFilter,
      initialInput?.senderAddressId
    );
    const nextInitialInput = { ...(initialInput ?? createEmptyComposeInput()), senderAddressId };
    clearComposeAutosaveTimer();
    composeAutosave.reset();
    composeMode = mode;
    composeInitialInput = nextInitialInput;
    composeDraftId = nextInitialInput.draftId;
    composeSubmissionId = crypto.randomUUID();
    composeLiveInput = { ...nextInitialInput };
    composeTouched = false;
    authRecoverySaveRequired = authExpired;
    composeAutosavePending = false;
    draftConflict = null;
    draftConflictLocalEditedAt = null;
    composeAutosaveStatus = nextInitialInput.draftId ? 'saved' : 'idle';
    composeAutosaveMessage = nextInitialInput.draftId
      ? t('compose.draftLoaded')
      : t('compose.autosaveIdle');
    composeLastSavedSignature = nextInitialInput.draftId ? serializeComposeInput(nextInitialInput) : '';
    composeOpen = true;
    void loadComposeModule();
  }

  async function loadComposeModule() {
    if (ComposeModal || composeModuleLoading) return;
    composeModuleLoading = true;
    try {
      ComposeModal = (await import('$lib/components/mail/ComposeModal.svelte')).default;
    } catch {
      if (composeOpen) {
        resetComposeState();
        notify(t('compose.loadEditorFailed'), 'error');
      }
    } finally {
      composeModuleLoading = false;
    }
  }

  async function closeCompose(latestInput?: ComposeInput) {
    clearComposeAutosaveTimer();
    if (latestInput) {
      composeLiveInput = withComposePersistence(latestInput, {
        draftId: composeLiveInput?.draftId ?? composeDraftId,
        expectedUpdatedAt: composeLiveInput?.expectedUpdatedAt,
        bodyRevision: composeLiveInput?.bodyRevision
      });
    }
    if (authExpired) {
      const input = composeLiveInput ? withCurrentComposePersistence(composeLiveInput) : null;
      const hasUnsavedContent = Boolean(
        input && hasComposeContent(input) && serializeComposeInput(input) !== composeLastSavedSignature
      );
      if (!hasUnsavedContent) {
        resetComposeState();
        notify(t('notify.composeClosed'), 'info');
        return;
      }
      composeClosePending = false;
      composeAutosaveStatus = 'error';
      composeAutosaveMessage = t('compose.authExpiredDraftPreserved');
      return;
    }
    composeClosePending = true;
    let savedBeforeClose = false;

    if (composeSavePromise) await composeSavePromise;
    if (!composeOpen) return;
    if (draftConflict) {
      composeClosePending = false;
      return;
    }

    while (composeOpen) {
      const input = composeLiveInput ? withCurrentComposePersistence(composeLiveInput) : null;
      const signature = serializeComposeInput(input);
      if (!input || !hasComposeContent(input) || signature === composeLastSavedSignature) break;

      composeAutosavePending = true;
      composeAutosaveStatus = 'saving';
      composeAutosaveMessage = t('compose.savingBeforeClose');
      const save = composeAutosave.sequence.begin();
      try {
        const result = await persistDraft(input);
        if (!save.isActive()) return;
        applyMessageDelta(result);
        savedBeforeClose = true;
        if (save.isCurrent()) {
          syncComposeDraftState(
            result.message,
            t('compose.savedBeforeClose', { date: formatComposeSavedAt(result.message.sentAt, i18n.locale) }),
            result.bodyRevision,
            result.attachments,
            result.attachmentRevision
          );
        } else if (composeLiveInput) {
          composeDraftId = result.message.id;
          composeLiveInput = mergeSavedDraftMetadata(
            composeLiveInput,
            result.message,
            result.bodyRevision,
            result.attachments,
            result.attachmentRevision
          );
          composeLastSavedSignature = serializeComposeInput({ ...input, draftId: result.message.id, bodyRevision: result.bodyRevision ?? undefined });
        }
      } catch (error) {
        const conflict = draftConflictFromError(error);
        if (conflict) {
          draftConflict = conflict;
          draftConflictLocalEditedAt = new Date().toISOString();
        }
        composeAutosaveStatus = 'error';
        composeAutosaveMessage = authExpired
          ? t('compose.authExpiredDraftPreserved')
          : displayError(error, t('compose.saveBeforeCloseFailed'));
        if (!authExpired) notify(composeAutosaveMessage, 'error');
        composeClosePending = false;
        return;
      } finally {
        if (save.isActive()) composeAutosavePending = false;
      }
    }

    resetComposeState();
    notify(savedBeforeClose ? t('notify.composeSavedBeforeClose') : t('notify.composeClosed'), savedBeforeClose ? 'success' : 'info');
  }

  function discardCompose() {
    resetComposeState();
    notify(t('notify.composeDiscarded'), 'warning');
  }

  async function handleLogin(payload: LoginInput) {
    pending = true;
    loginError = '';

    try {
      const result = await createSession(payload);

      if (!result.workspace) {
        throw new Error(t('notify.loginMissingWorkspace'));
      }

      applyWorkspaceSnapshot(result.workspace, {
        section: 'inbox',
        preferredMessageId: readingLayout === 'split' ? result.workspace.activePage.messages[0]?.id ?? null : null,
        clearMailView: true,
        resetUserScoped: true,
        syncUrl: true
      });
      clearClientAuthExpired();
      authExpired = false;
      authRecoveryError = '';
      authSessionSync?.publish({ type: 'authenticated' });
      notify(t('notify.loggedIn'), 'success');
    } catch (error) {
      loginError = displayError(error, t('auth.loginFailed'));
      notifyError(error, t('auth.loginFailed'));
    } finally {
      pending = false;
    }
  }

  async function handleLogout() {
    pending = true;

    try {
      const result = await deleteSession();
      workspaceSync?.publish({ type: 'session-ended' });
      resetWorkspace();
      if (result.logoutUrl) {
        window.location.assign(result.logoutUrl);
        return;
      }
      await goto(buildWorkspaceUrl(currentWorkspaceUrl, {
        section: 'inbox', query: '', filter: 'all', messageId: null
      }), { replaceState: true, noScroll: true, keepFocus: false });
      notify(t('notify.loggedOut'), 'success');
    } catch (error) {
      notifyError(error, t('notify.logoutFailed'));
    } finally {
      pending = false;
    }
  }

  async function saveProfile(nextProfile: UserProfile) {
    pending = true;
    profileStatus = '';
    profileStatusError = false;

    try {
      const result = await updateProfile(nextProfile);

      profile = result.profile ?? profile;
      metrics = result.metrics ?? metrics;
      runtimeOperationError = false;
      profileStatus = t('notify.profileSaved');
      notify(t('notify.profileUpdated'), 'success');
      return profile;
    } catch (error) {
      profileStatusError = true;
      profileStatus = displayError(error, t('notify.saveFailed'));
      notifyError(error, t('notify.profileSaveFailed'));
      return null;
    } finally {
      pending = false;
    }
  }

  async function saveDraft(input: ComposeInput) {
    if (authExpired) return;
    clearComposeAutosaveTimer();
    pending = true;

    try {
      const result = await persistDraft(withCurrentComposePersistence(input));

      applyMessageDelta(result, {
        section: 'drafts',
        preferredMessageId: result.message.id,
        clearMailView: true
      });
      resetComposeState();
      notify((input.draftId ?? composeDraftId) ? t('notify.draftUpdated') : t('notify.draftSaved'), 'success');
    } catch (error) {
      const conflict = draftConflictFromError(error);
      if (conflict) {
        draftConflict = conflict;
        draftConflictLocalEditedAt = new Date().toISOString();
        composeAutosaveStatus = 'error';
        composeAutosaveMessage = t('compose.conflictAutosave');
      }
      notifyError(error, t('notify.draftSaveFailed'));
    } finally {
      pending = false;
    }
  }

  async function performAutosaveDraft() {
    const liveInput = composeLiveInput;

    if (authExpired || authRecoverySaveRequired || !liveInput || !composeOpen || draftConflict) {
      return;
    }

    const input = withCurrentComposePersistence(liveInput);
    const signature = serializeComposeInput(input);

    if (!hasComposeContent(input) || signature === composeLastSavedSignature) {
      return;
    }

    composeAutosavePending = true;
    composeAutosaveStatus = 'saving';
    composeAutosaveMessage = t('compose.autosaving');
    const save = composeAutosave.sequence.begin();

    try {
      const result = await persistDraft(input);

      if (!save.isActive()) return;
      applyMessageDelta(result);
      if (save.isCurrent()) {
        syncComposeDraftState(
          result.message,
          t('compose.autosavedAt', { date: formatComposeSavedAt(result.message.sentAt, i18n.locale) }),
          result.bodyRevision,
          result.attachments,
          result.attachmentRevision
        );
      } else {
        composeDraftId = result.message.id;
        if (composeLiveInput) {
          composeLiveInput = mergeSavedDraftMetadata(
            composeLiveInput,
            result.message,
            result.bodyRevision,
            result.attachments,
            result.attachmentRevision
          );
        }
        composeLastSavedSignature = serializeComposeInput({ ...input, draftId: result.message.id, bodyRevision: result.bodyRevision ?? undefined });
        composeTouched = true;
        composeAutosaveStatus = 'dirty';
        composeAutosaveMessage = t('compose.autosaveQueued');
      }
    } catch (error) {
      if (save.isActive()) {
        const conflict = draftConflictFromError(error);
        if (conflict) {
          draftConflict = conflict;
          draftConflictLocalEditedAt = new Date().toISOString();
        }
        composeAutosaveStatus = 'error';
        composeAutosaveMessage = displayError(error, t('compose.autosaveFailed'));
      }
    } finally {
      if (save.isActive()) composeAutosavePending = false;
    }
  }

  async function autosaveDraft() {
    if (composeSavePromise) return composeSavePromise;
    const operation = performAutosaveDraft();
    composeSavePromise = operation;
    try {
      await operation;
    } finally {
      if (composeSavePromise === operation) composeSavePromise = null;
    }
  }

  async function prepareComposeAttachments(input: ComposeInput) {
    if (authExpired) throw new ClientApiError(401, 'AUTH_SESSION_EXPIRED', t('auth.sessionExpiredTitle'));
    clearComposeAutosaveTimer();
    if (composeSavePromise) await composeSavePromise;
    composeAutosavePending = true;
    composeAutosaveStatus = 'saving';
    composeAutosaveMessage = t('compose.preparingAttachments');
    try {
      const result = await persistDraft(withCurrentComposePersistence(input));
      applyMessageDelta(result);
      syncComposeDraftState(
        result.message,
        t('compose.attachmentsReady'),
        result.bodyRevision,
        result.attachments,
        result.attachmentRevision
      );
      return composeLiveInput!;
    } catch (error) {
      const conflict = draftConflictFromError(error);
      if (conflict) {
        draftConflict = conflict;
        draftConflictLocalEditedAt = new Date().toISOString();
      }
      composeAutosaveStatus = 'error';
      composeAutosaveMessage = displayError(error, t('compose.prepareAttachmentsFailed'));
      throw error;
    } finally {
      composeAutosavePending = false;
    }
  }

  async function sendMessage(input: ComposeInput) {
    if (authExpired) return;
    clearComposeAutosaveTimer();
    sendAnnouncement = '';
    pending = true;

    try {
      const result = await submitMessage(withCurrentComposePersistence(input), composeSubmissionId);

      deliveryDetails = Object.fromEntries(
        Object.entries(deliveryDetails).filter(([id]) => id !== result.message.id)
      );
      deliveryDetailErrors = Object.fromEntries(
        Object.entries(deliveryDetailErrors).filter(([id]) => id !== result.message.id)
      );
      // A sent message may reuse its draft id. Drop the draft body snapshot so
      // the sent detail reloads transferred attachment metadata.
      workspaceBodyCache.invalidate(result.message.id);

      applyMessageDelta(result, {
        section: 'sent',
        preferredMessageId: result.message.id,
        clearMailView: true,
        removeDraftId: input.draftId ?? composeDraftId
      });
      const deliveryMessage =
        result.message.deliveryResultKind === 'accepted' && (input.draftId ?? composeDraftId)
          ? t('notify.draftSubmitted', { provider: result.message.deliveryProvider ?? t('notify.deliveryService') })
          : result.message.deliveryResultKind === 'accepted'
            ? t('notify.deliverySubmitted', { provider: result.message.deliveryProvider ?? t('notify.deliveryService') })
            : describeDeliveryState(result.message);
      const deliveryTone: ToastTone = result.message.deliveryResultKind === 'accepted' ? 'success' : 'warning';
      resetComposeState();
      if (deliveryTone === 'success') sendAnnouncement = deliveryMessage;
      else notify(deliveryMessage, deliveryTone, { persistent: true });
      workspaceSync?.publish({ type: 'message-updated', id: result.message.id });
    } catch (error) {
      notifyError(error, t('notify.sendFailed'));
    } finally {
      pending = false;
    }
  }

  async function retryMessageDelivery(message: MailMessage) {
    pending = true;

    try {
      const result = await retryDelivery(message.id);

      deliveryDetails = Object.fromEntries(
        Object.entries(deliveryDetails).filter(([id]) => id !== result.message.id)
      );
      deliveryDetailErrors = Object.fromEntries(
        Object.entries(deliveryDetailErrors).filter(([id]) => id !== result.message.id)
      );

      applyMessageDelta(result, {
        section: 'sent',
        preferredMessageId: result.message.id
      });
      const deliveryMessage =
        result.message.deliveryResultKind === 'accepted'
          ? t('notify.retryAccepted', { subject: result.message.subject, provider: result.message.deliveryProvider ?? t('notify.deliveryService') })
          : result.message.deliveryResultKind === 'queued'
            ? t('notify.retryQueued', { subject: result.message.subject })
            : result.message.deliveryResultKind === 'temporary_failure'
              ? t('notify.retryDelayed', { subject: result.message.subject, error: result.message.deliveryError ?? t('notify.tryLater') })
              : result.message.deliveryResultKind === 'rate_limited'
                ? t('notify.retryRateLimited', { subject: result.message.subject })
                : t('notify.retryFailed', { subject: result.message.subject, error: result.message.deliveryError ?? t('notify.tryLater') });
      const deliveryTone: ToastTone = result.message.deliveryResultKind === 'accepted' ? 'success' : 'warning';
      notify(deliveryMessage, deliveryTone, { persistent: deliveryTone === 'warning' });
      workspaceSync?.publish({ type: 'message-updated', id: result.message.id });
    } catch (error) {
      notifyError(error, t('notify.retryDeliveryFailed'));
    } finally {
      pending = false;
    }
  }

  function identityKey(identity: MailboxIdentityFilter | null) {
    return identity ? `${identity.kind}:${identity.id}` : 'owner';
  }

  function acceptMetrics(value: WorkspaceMetrics, identity: MailboxIdentityFilter | null) {
    metricsCache.set(identityKey(identity), { value, updatedAt: Date.now() });
    if (sameIdentityScope(identity, mailIdentityFilter)) {
      metrics = value;
      metricsIdentity = identity;
    }
  }

  async function refreshMetrics(identity = mailIdentityFilter, force = false) {
    if (!authenticated || authExpired) return;
    const cached = metricsCache.get(identityKey(identity));
    if (cached && sameIdentityScope(identity, mailIdentityFilter)) { metrics = cached.value; metricsIdentity = identity; }
    if (!force && cached && Date.now() - cached.updatedAt < 30_000) return;
    const request = metricsRequest.begin();
    try {
      const result = await fetchMailboxMetrics(identity, request.signal);
      if (request.isCurrent()) acceptMetrics(result.metrics, result.metricsScope.identityFilter);
    } catch (error) {
      if (request.isCurrent()) notifyError(error, t('mail.listError'));
    }
  }

  let flagsInterruptedPageRequest = false;

  function applyFlagPatch(id: string, patch: MessagePatch) {
    if (patch.read === undefined && patch.starred === undefined) return;
    metricsRequest.cancel();
    metricsCache.clear();
    flagsInterruptedPageRequest = mailboxController.patchFlags(id, patch) || flagsInterruptedPageRequest;
    const existing = deepLinkedMessage?.id === id ? deepLinkedMessage : [...mailbox.inbox, ...mailbox.sent, ...mailbox.drafts,
      ...Object.values(mailboxPages ?? {}).flatMap((cached) => cached?.messages ?? [])].find((message) => message.id === id);
    if (existing && patch.read !== undefined && existing.read !== patch.read && existing.folder === 'inbox' && !existing.archivedAt &&
      sameIdentityScope(metricsIdentity, mailIdentityFilter) && messageMatchesIdentity(existing)) {
      metrics = { ...metrics, unreadCount: Math.max(0, metrics.unreadCount + (patch.read ? -1 : 1)) };
    }
    // Hold the visible reader independently when a flag removes its filtered row.
    if (existing && selectedMessageId === id) deepLinkedMessage = { ...existing, ...patch };
    else if (deepLinkedMessage?.id === id) deepLinkedMessage = { ...deepLinkedMessage, ...patch };
    const updated = patchMailboxFlags({ mailbox, mailboxPages, metrics }, id, patch);
    mailbox = updated.mailbox;
    mailboxPages = updated.mailboxPages;
  }

  function messageMatchesIdentity(message: MailMessage) {
    if (!mailIdentityFilter) return true;
    const address = message.folder === 'inbox' ? message.recipientAddressId : message.senderAddressId;
    return mailIdentityFilter.kind === 'address' ? address === mailIdentityFilter.id :
      mailIdentityOptions.addresses.some((item) => item.id === address && item.domainId === mailIdentityFilter?.id);
  }

  const flagController = new MessageFlagsController({
    onPatch: applyFlagPatch,
    onConfirmed: (result, current) => {
      if (current) acceptMetrics(result.metrics, result.metricsScope.identityFilter);
      workspaceSync?.publish({ type: 'message-updated', id: result.message.id });
    },
    onError: (error) => notifyError(error, t('notify.updateMessageFailed')),
    onSettled: () => {
      if (!flagController.busy && authenticated && !authExpired) {
        void refreshMetrics(mailIdentityFilter);
        const refreshPage = flagsInterruptedPageRequest || searchQuery.trim() || mailFilter !== 'all' || activeSection === 'starred';
        flagsInterruptedPageRequest = false;
        if (refreshPage) scheduleMailboxRefresh(activeSection, searchQuery, mailFilter, 0);
      }
    }
  });

  async function patchMessage(message: MailMessage, patch: MessagePatch, nextBanner?: string) {
    const identity = mailIdentityFilter;
    const updated = await flagController.update(message, patch, () => updateMessageFlags(message.id, patch, identity));
    if (updated && nextBanner) notify(nextBanner, 'success');
  }

  $effect(() => {
    const visible = authenticated && !authExpired && activeSection !== 'trash' && activeSection !== 'profile' &&
      (mobileDetailOpen || readerOpen || (readingLayout === 'split' && workspaceWidth >= 901));
    const message = visible ? selectedMessage : null;
    untrack(() => {
      if (readActivation.activate(message) && message) {
        if (!selectedMessageId) selectedMessageId = message.id;
        void patchMessage(message, { read: true });
      }
    });
  });

  async function loadServerDraft() {
    if (!draftConflict) return;
    const conflict = draftConflict;
    try {
      const { message, bodyRevision, attachments, attachmentRevision } = await fetchDraftDetail(conflict.id);
      composeInitialInput = composeInputFromSavedDraft(message, bodyRevision, attachments, attachmentRevision);
      syncComposeDraftState(message, t('compose.serverDraftLoaded'), bodyRevision, attachments, attachmentRevision);
      draftConflict = null;
      draftConflictLocalEditedAt = null;
    } catch (error) {
      notifyError(error, t('notify.loadServerDraftFailed'));
    }
  }

  async function saveDraftCopy() {
    const local = composeLiveInput;
    if (!local) return;
    draftConflict = null;
    draftConflictLocalEditedAt = null;
    await saveDraft({ ...local, draftId: undefined, saveAsCopy: true });
  }

  async function overwriteServerDraft() {
    const local = composeLiveInput;
    if (!local || !draftConflict) return;
    const expectedUpdatedAt = draftConflict.sentAt;
    const draftId = draftConflict.id;
    draftConflict = null;
    draftConflictLocalEditedAt = null;
    await saveDraft({ ...local, draftId, expectedUpdatedAt, overwrite: true });
  }

  async function handleSelectMessage(message: MailMessage) {
    if (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement && document.activeElement.closest('.mail-list-panel')) listReturnFocus = document.activeElement;
    if (message.folder === 'drafts' && activeSection !== 'trash' && readingLayout === 'list') {
      await handleEditDraft(message);
      return;
    }
    selectedMessageId = message.id;
    mobileDetailOpen = true;
    updateWorkspaceUrl({ messageId: message.id });

    if (isInboundMessageId(message.id)) {
      await loadInboundDetail(message);
    }
  }

  async function handleSelectThread(thread: MailThread) {
    await handleSelectMessage(thread.sectionLatestMessage);
  }

  async function closeMobileDetail() {
    mobileDetailOpen = false;
    selectedMessageId = null;
    updateWorkspaceUrl({ messageId: null }, true);
    await tick();
    if (listReturnFocus?.isConnected) listReturnFocus.focus();
  }

  function standaloneMessageHref(message: MailMessage) {
    if (message.folder === 'drafts') return null;
    const params = new URLSearchParams();
    for (const key of ['folder', 'q', 'filter', 'category', 'identity', 'label']) {
      const value = currentWorkspaceUrl.searchParams.get(key);
      if (value) params.set(key, value);
    }
    params.set('message', message.id);
    const query = params.toString();
    return `/messages/${encodeURIComponent(message.id)}${query ? `?${query}` : ''}`;
  }

  function persistLayoutPreferences() {
    if (typeof localStorage === 'undefined') return;
    writeLayoutPreferences({ version: 1, sidebarCollapsed, listWidth, density, readingLayout }, localStorage);
  }

  function toggleReadingLayout() {
    readingLayout = readingLayout === 'list' ? 'split' : 'list';
    mobileDetailOpen = false;
    updateWorkspaceUrl({ messageId: null }, true);
    persistLayoutPreferences();
  }

  function setDensity(next: DisplayDensity) {
    density = next;
    if (typeof document !== 'undefined') document.documentElement.dataset.density = next;
    persistLayoutPreferences();
  }

  function toggleDensity() {
    setDensity(density === 'comfortable' ? 'compact' : 'comfortable');
  }

  function toggleSidebar() {
    sidebarCollapsed = !sidebarCollapsed;
    persistLayoutPreferences();
  }

  function updateListWidth(next: number, availableWidth = Number.POSITIVE_INFINITY) {
    listWidth = clampListWidth(next, availableWidth);
  }

  function startListResize(event: PointerEvent) {
    stopListResize?.();
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget as HTMLElement;
    const workspace = handle.closest<HTMLElement>('.mail-workspace');
    const startRect = workspace?.getBoundingClientRect();
    if (!startRect) return;
    const availableWidth = startRect.width;
    document.body.classList.add('fm-is-resizing');
    handle.setPointerCapture?.(event.pointerId);
    const move = (moveEvent: PointerEvent) => {
      updateListWidth(moveEvent.clientX - startRect.left, availableWidth);
    };
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      window.removeEventListener('blur', finish);
      if (handle.hasPointerCapture?.(event.pointerId)) handle.releasePointerCapture?.(event.pointerId);
      document.body.classList.remove('fm-is-resizing');
      persistLayoutPreferences();
      if (stopListResize === finish) stopListResize = null;
    };
    stopListResize = finish;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    window.addEventListener('blur', finish);
  }

  function adjustListWidth(event: KeyboardEvent) {
    const workspace = (event.currentTarget as HTMLElement).closest<HTMLElement>('.mail-workspace');
    const availableWidth = workspace?.getBoundingClientRect().width ?? Number.POSITIVE_INFINITY;
    const nextWidth = listWidthFromKeyboard(listWidth, event.key, availableWidth);
    if (nextWidth === null) return;
    event.preventDefault();
    updateListWidth(nextWidth, availableWidth);
    persistLayoutPreferences();
  }

  function openReader() {
    if (!selectedMessage) return;
    toastController.dismissPassive();
    readerOpen = true;
  }

  async function closeReader() {
    readerOpen = false;
    await tick();
    document.getElementById('fm-open-reader-trigger')?.focus();
  }

  async function handleToggleStar(message: MailMessage) {
    await patchMessage(
      message,
      { starred: !message.starred },
      message.starred ? t('notify.unstarred') : t('notify.starred')
    );
  }

  async function handleToggleRead(message: MailMessage) {
    if (message.folder !== 'inbox') {
      return;
    }

    await patchMessage(
      message,
      { read: !message.read },
      message.read ? t('notify.markedUnread') : t('notify.markedRead')
    );
  }

  async function handleDeleteMessage(message: MailMessage) {
    pending = true;

    try {
      const result = await deleteMessage(message.id);

      const removed = removeMessage(
        { mailbox, mailboxPages, metrics },
        result.removedId,
        result.folder,
        activeSection,
        selectedMessageId,
        sameIdentityScope(result.metricsScope.identityFilter, mailIdentityFilter) ? result.metrics : undefined
      );
      mailbox = removed.snapshot.mailbox;
      mailboxPages = removed.snapshot.mailboxPages;
      metrics = removed.snapshot.metrics;
      runtimeOperationError = false;
      trashLoaded = false;
      if (readingLayout === 'list' && selectedMessageId === message.id) closeMobileDetail();
      else selectedMessageId = readingLayout === 'list' && !mobileDetailOpen ? null : removed.selectedMessageId;
      if (!sameIdentityScope(result.metricsScope.identityFilter, mailIdentityFilter)) {
        scheduleMailboxRefresh(activeSection, searchQuery, mailFilter, 0, mailIdentityFilter);
      }
      if (activeSection === 'starred' || activeSection === 'label' || (activeSection === 'inbox' && inboxCategory !== 'all')) await refreshWorkspace(false);
      selectedMessageIds = selectedMessageIds.filter((id) => id !== result.removedId);
      if (composeInitialInput?.draftId === message.id) {
        resetComposeState();
      }
      workspaceSync?.publish({ type: 'mailbox-refresh', id: result.removedId });

      notify(
        t('notify.movedTrash'),
        'warning',
        {
          timeoutMs: 8_000,
          action: {
            label: t('common.undo'),
            run: async () => {
              const restored = await restoreTrashItem(result.removedId);
              metrics = restored.metrics;
              trashLoaded = false;
              workspaceSync?.publish({ type: 'mailbox-refresh', id: result.removedId });
              if (activeSection !== 'trash' && activeSection !== 'profile') await refreshWorkspace(false);
              notify(t('notify.trashUndone'), 'success');
            }
          }
        }
      );
    } catch (error) {
      notifyError(error, t('notify.deleteMessageFailed'));
    } finally {
      pending = false;
    }
  }

  function removeTrashItemFromView(messageId: string) {
    trashItems = trashItems.filter((item) => item.id !== messageId);
    selectedMessageId = trashItems.some((item) => item.id === selectedMessageId)
      ? selectedMessageId
      : trashItems[0]?.id ?? null;
    mobileDetailOpen = Boolean(selectedMessageId);
    updateWorkspaceUrl({ messageId: selectedMessageId }, true);
  }

  async function handleRestoreTrash(message: MailMessage) {
    pending = true;
    try {
      const result = await restoreTrashItem(message.id);
      metrics = result.metrics;
      runtimeOperationError = false;
      removeTrashItemFromView(message.id);
      workspaceSync?.publish({ type: 'mailbox-refresh', id: message.id });
      notify(t('notify.restoredTo', { folder: result.originalFolder === 'archive' ? t('shell.archive') : result.originalFolder === 'sent' ? t('shell.sent') : result.originalFolder === 'drafts' ? t('shell.drafts') : t('shell.inbox') }), 'success');
    } catch (error) {
      notifyError(error, t('notify.restoreFailed'));
    } finally {
      pending = false;
    }
  }

  async function handlePermanentDelete(message: MailMessage) {
    pending = true;
    try {
      const result = await permanentlyDeleteTrashItem(message.id);
      metrics = result.metrics;
      runtimeOperationError = false;
      removeTrashItemFromView(message.id);
      inboundDetailCache.invalidate(message.id);
      deliveryDetailCache.invalidate(message.id);
      workspaceBodyCache.invalidate(message.id);
      workspaceSync?.publish({ type: 'mailbox-refresh', id: message.id });
      notify(
        result.cleanupPending ? t('notify.permanentDeleteCleanupPending') : t('notify.permanentDeleted'),
        'warning',
        { persistent: Boolean(result.cleanupPending) }
      );
    } catch (error) {
      notifyError(error, t('notify.permanentDeleteFailed'));
    } finally {
      pending = false;
    }
  }

  async function handleEmptyTrash() {
    pending = true;
    try {
      const result = await emptyTrash();
      metrics = result.metrics;
      runtimeOperationError = false;
      for (const item of trashItems) {
        inboundDetailCache.invalidate(item.id);
        deliveryDetailCache.invalidate(item.id);
        workspaceBodyCache.invalidate(item.id);
      }
      trashItems = [];
      trashHasMore = false;
      selectedMessageId = null;
      mobileDetailOpen = false;
      emptyTrashConfirmOpen = false;
      workspaceSync?.publish({ type: 'mailbox-refresh' });
      notify(translateCount(i18n.locale, 'notify.trashEmptied', result.deleted), 'warning');
    } catch (error) {
      notifyError(error, t('notify.emptyTrashFailed'));
    } finally {
      pending = false;
    }
  }

  async function handleEditDraft(message: MailMessage) {
    const request = draftOpenRequest.begin();
    const context = currentWorkspaceUrl.href;
    try {
      const current = await fetchDraftDetail(message.id, request.signal);
      if (!request.isCurrent() || currentWorkspaceUrl.href !== context || !authenticated || authExpired) return;
      openCompose('draft', composeInputFromSavedDraft(
        current.message,
        current.bodyRevision,
        current.attachments,
        current.attachmentRevision
      ));
    } catch (error) {
      if (request.signal.aborted || !request.isCurrent()) return;
      notifyError(error, t('notify.loadDraftFailed'));
    }
  }

  async function handleReplyMessage(message: MailMessage) {
    if (isInboundMessageId(message.id) && !inboundDetails[message.id]) {
      if (!(await loadInboundDetail(message)) || !inboundDetails[message.id]) {
        notify(t('notify.bodyRequiredReply'), 'error');
        return;
      }
    }
    if (!isInboundMessageId(message.id) && !workspaceBodies[message.id]) {
      if (!(await loadWorkspaceBody(message)) || !workspaceBodies[message.id]) {
        notify(t('notify.bodyRequiredReply'), 'error');
        return;
      }
    }
    const quotedBody = isInboundMessageId(message.id)
      ? inboundDetails[message.id]?.body ?? ''
      : workspaceBodies[message.id]?.body ?? message.body;

    openCompose('reply', createReplyComposeInput(replySource(message), quotedBody, {
      replyTo: isInboundMessageId(message.id) ? inboundDetails[message.id]?.replyTo : undefined
    }));
  }

  async function handleReplyAllMessage(message: MailMessage) {
    if (isInboundMessageId(message.id) && !inboundDetails[message.id]) {
      if (!(await loadInboundDetail(message)) || !inboundDetails[message.id]) {
        notify(t('notify.bodyRequiredReply'), 'error');
        return;
      }
    }
    if (!isInboundMessageId(message.id) && !workspaceBodies[message.id]) {
      if (!(await loadWorkspaceBody(message)) || !workspaceBodies[message.id]) {
        notify(t('notify.bodyRequiredReply'), 'error');
        return;
      }
    }
    const quotedBody = isInboundMessageId(message.id)
      ? inboundDetails[message.id]?.body ?? ''
      : workspaceBodies[message.id]?.body ?? message.body;

    openCompose('reply', createReplyAllComposeInput(replySource(message), {
      selfEmail: profile.email,
      selfEmails: mailIdentityOptions.addresses.map((address) => address.email),
      replyTo: isInboundMessageId(message.id) ? inboundDetails[message.id]?.replyTo : undefined
    }, quotedBody));
  }

  async function handleForwardMessage(message: MailMessage) {
    if (isInboundMessageId(message.id) && !inboundDetails[message.id]) {
      if (!(await loadInboundDetail(message)) || !inboundDetails[message.id]) {
        notify(t('notify.bodyRequiredForward'), 'error');
        return;
      }
    }
    if (!isInboundMessageId(message.id) && !workspaceBodies[message.id]) {
      if (!(await loadWorkspaceBody(message)) || !workspaceBodies[message.id]) {
        notify(t('notify.bodyRequiredForward'), 'error');
        return;
      }
    }
    const forwardedBody = isInboundMessageId(message.id)
      ? inboundDetails[message.id]?.body ?? ''
      : workspaceBodies[message.id]?.body ?? message.body;

    const forwardAttachmentCandidates = isInboundMessageId(message.id)
      ? inboundDetails[message.id]?.attachments ?? []
      : workspaceBodies[message.id]?.attachments ?? [];
    openCompose('forward', createForwardComposeInput(message, forwardedBody, forwardAttachmentCandidates));
  }

  function handleReportHtmlIssue() {
    notify(t('mail.reportDownloaded'), 'success');
  }

  async function handleReloadInboundDetail(message: MailMessage) {
    const ok = await loadInboundDetail(message, true);
    notify(
      ok ? t('notify.inboundReloaded', { subject: message.subject }) : t('notify.inboundReloadFailed'),
      ok ? 'success' : 'error'
    );
  }

  async function handleReloadDeliveryDetail(message: MailMessage) {
    const ok = await loadDeliveryDetail(message, true);
    notify(
      ok ? t('notify.deliveryReloaded', { subject: message.subject }) : t('notify.deliveryReloadFailed'),
      ok ? 'success' : 'error'
    );
  }

  function moveMessageSelection(direction: -1 | 1) {
    const next = moveSelection(
      selectionCandidates(mailbox, activeSection, visibleMessages, visibleThreads),
      selectedMessageId,
      direction
    );
    if (next) void handleSelectMessage(next);
  }

  $effect(() => {
    const element = workspaceElement;
    if (!element || typeof window === 'undefined') return;

    const measure = () => {
      const width = element.getBoundingClientRect().width;
      if (Number.isFinite(width) && width > 0) workspaceWidth = width;
    };
    measure();

    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(measure);
      observer.observe(element);
      return () => observer.disconnect();
    }

    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  });

  onMount(() => {
    const syncBrowserWorkspaceUrl = () => { browserWorkspaceUrl = window.location.href; };
    syncBrowserWorkspaceUrl();
    window.addEventListener('popstate', syncBrowserWorkspaceUrl);
    const layout = readLayoutPreferences(localStorage);
    sidebarCollapsed = layout.sidebarCollapsed;
    listWidth = layout.listWidth;
    density = layout.density;
    readingLayout = layout.readingLayout ?? 'list';
    document.documentElement.dataset.density = density;
    workspaceSync = createWorkspaceSync(handleWorkspaceSync);
    authSessionSync = createAuthSessionChannel((message) => {
      if (message.type === 'expired') {
        markClientAuthExpired('other-tab');
      } else if (authExpired) {
        void recoverExpiredSession();
      }
    });
    const handleAuthExpired = (event: Event) => {
      const source = (event as CustomEvent<{ source?: AuthExpirySource }>).detail?.source;
      enterAuthExpired(source ?? 'worker-session');
    };
    window.addEventListener(AUTH_EXPIRED_EVENT, handleAuthExpired);
    if (isClientAuthExpired()) enterAuthExpired('worker-session');
    else if (authenticated) authSessionSync.publish({ type: 'authenticated' });

    const handleShortcut = (event: KeyboardEvent) => {
      if (!authenticated || composeOpen) return;
      const action = shortcuts.handle(event, {
        helpOpen: shortcutHelpOpen,
        mobileDetailOpen,
        canReply: Boolean(activeSection !== 'trash' && selectedMessage && selectedMessage.folder !== 'drafts'),
        canReplyAll: selectedReplyAllAvailable,
        canForward: Boolean(activeSection !== 'trash' && selectedMessage && selectedMessage.folder !== 'drafts')
      });
      const actions: Partial<Record<WorkspaceShortcutAction, () => void>> = {
        'close-help': () => (shortcutHelpOpen = false),
        'close-mobile-detail': closeMobileDetail,
        'folder-inbox': () => setSection('inbox'),
        'folder-sent': () => setSection('sent'),
        'folder-drafts': () => setSection('drafts'),
        'focus-search': () => window.dispatchEvent(new CustomEvent('flaremail:focus-search')),
        compose: () => openCompose('new'),
        'next-message': () => moveMessageSelection(1),
        'previous-message': () => moveMessageSelection(-1),
        reply: () => selectedMessage && handleReplyMessage(selectedMessage),
        'reply-all': () => selectedMessage && handleReplyAllMessage(selectedMessage),
        forward: () => selectedMessage && handleForwardMessage(selectedMessage),
        'open-help': () => (shortcutHelpOpen = true)
      };
      if (action) {
        actions[action]?.();
      }
    };

    document.addEventListener('keydown', handleShortcut);
    const handleLocaleChange = () => toastController.reset();
    window.addEventListener(LOCALE_CHANGE_EVENT, handleLocaleChange);
    return () => {
      document.removeEventListener('keydown', handleShortcut);
      window.removeEventListener('popstate', syncBrowserWorkspaceUrl);
      window.removeEventListener(LOCALE_CHANGE_EVENT, handleLocaleChange);
      window.removeEventListener(AUTH_EXPIRED_EVENT, handleAuthExpired);
      workspaceSync?.close();
      workspaceSync = null;
      authSessionSync?.close();
      authSessionSync = null;
      stopListResize?.();
      document.body.classList.remove('fm-is-resizing');
      clearMailboxRefreshTimer();
      mailboxController.cancel();
      draftOpenRequest.cancel();
      labelRequest.cancel();
      cancelLabelActions();
      shortcuts.dispose();
      toastController.reset();
    };
  });
</script>

<svelte:head>
  <title>FlareMail</title>
  <meta
    name="description"
    content={t('shell.metaDescription')}
  />
</svelte:head>

<div class="fm-app-shell" data-density={density} style={`--fm-sidebar-width: ${sidebarCollapsed ? '64px' : '232px'}`}>
  {#if data.runtimeState.state === 'unavailable'}
    <RuntimeUnavailableView state={data.runtimeState} />
  {:else if !authenticated}
    <LoginView
      authConfigured={data.authConfigured}
      authMode={data.authMode}
      dbBound={data.dbBound}
      bucketBound={data.bucketBound}
      {loginError}
      {pending}
      {runtimeLabel}
      onLogin={handleLogin}
    />
  {:else}
    <div class="fm-app-shell">
      {#if authExpired}
        <AuthExpiredNotice
          busy={authRecoveryPending}
          error={authRecoveryError}
          onOpenSignIn={() => openReauthenticationTab()}
          onRetry={recoverExpiredSession}
        />
      {/if}
      <AppTopbar
        bouncedCount={metrics.bouncedCount}
        complainedCount={metrics.complainedCount}
        delayedCount={metrics.delayedCount}
        draftCount={metrics.draftsCount}
        failedCount={metrics.failedCount}
        {pending}
        {profile}
        queuedCount={metrics.queuedCount}
        {runtimeLabel}
        {serviceDegraded}
        staleDeliveryCount={metrics.staleDeliveryCount}
        unreadCount={unreadCount}
        searchQuery={searchQuery}
        {density}
        onEditProfile={() => {
          setSection('profile');
          notify(t('notify.settingsOpened'));
        }}
        onLogout={handleLogout}
        onSearchQueryChange={handleSearchQueryChange}
        onToggleDensity={toggleDensity}
      />

      <div class:mobile-detail-nav-hidden={mobileDetailOpen}>
        <MobileNavigation
          activeSection={activeSection}
          {managementView}
          {userLabels}
          {activeLabelId}
          draftCount={metrics.draftsCount}
          unreadCount={unreadCount}
          starredCount={metrics.starredCount}
          trashCount={metrics.trashCount}
          {pending}
          onCompose={() => {
            openCompose('new');
          }}
          onSelectSection={setSection}
          onSelectLabel={selectLabel}
          onCreateLabel={() => editLabel('create')}
          onSelectManagementView={setManagementView}
        />
      </div>

      <div class:mobile-detail-mode={mobileDetailOpen} class="fm-workspace-body">
        <div class="fm-workspace-shell">
          <AppSidebar
            activeSection={activeSection}
            {managementView}
            labels={userLabels}
            {activeLabelId}
            collapsed={sidebarCollapsed}
            draftCount={metrics.draftsCount}
            unreadCount={unreadCount}
            starredCount={metrics.starredCount}
            trashCount={metrics.trashCount}
            {pending}
            sentCount={metrics.sentCount}
            onCompose={() => {
              openCompose('new');
            }}
            onSelectSection={setSection}
            onSelectLabel={selectLabel}
            onCreateLabel={() => editLabel('create')}
            onSelectManagementView={setManagementView}
            onToggleCollapsed={toggleSidebar}
          />

          <main class:settings-main={activeSection === 'profile'} class="fm-workspace-main" aria-label={t('shell.mailWorkspace')}>
            {#if activeSection === 'profile'}
              <div class="h-full overflow-y-auto bg-fm-surface p-6 lg:p-8">
                {#if managementView === 'settings' && ProfilePane}
                  <ProfilePane
                    {metrics}
                    {pending}
                    {profile}
                    {serviceDegraded}
                    diagnostics={data.runtimeDiagnostics ? {
                      ...data.runtimeDiagnostics,
                      senderConfigured: mailIdentityOptions.addresses.some((address) => address.sendReady)
                    } : null}
                    status={profileStatus}
                    statusError={profileStatusError}
                    onSave={saveProfile}
                    onOpenDomains={() => setManagementView('domains')}
                    onOpenAddresses={() => setManagementView('addresses')}
                  />
                {:else if managementView !== 'settings' && MailIdentityManager}
                  <MailIdentityManager
                    view={managementView}
                    initialDomainId={createAddressDomainId}
                    initialAddressLocalPart={createAddressLocalPart}
                    onCreateAddressForDomain={(domainId, addressLocalPart) => setManagementView('addresses', domainId, addressLocalPart)}
                    onSelectedDomainChange={(domainId) => {
                      createAddressDomainId = domainId;
                      updateWorkspaceUrl({ managementDomainId: domainId }, true);
                    }}
                    onOptionsChange={(options) => {
                      const changed = JSON.stringify(mailIdentityOptions) !== JSON.stringify(options);
                      mailIdentityOptions = options;
                      if (changed) workspaceSync?.publish({ type: 'mail-identity-options-changed' });
                    }}
                  />
                {:else if managementView === 'settings' ? profilePaneLoadFailed : mailIdentityManagerLoadFailed}
                  <p class="mx-auto max-w-lg rounded-[var(--radius-md)] border border-[var(--fm-border)] bg-[var(--fm-surface-subtle)] p-5 text-sm text-[var(--fm-text-secondary)]" role="alert">
                    {t('shell.managementLoadFailed', { section: managementTitle })}
                  </p>
                {:else}
                  <div
                    class={`mx-auto grid gap-5 ${managementView === 'settings' ? 'max-w-[920px]' : 'max-w-[72rem]'}`}
                    role="status"
                    data-management-loading
                  >
                    <p class="sr-only">{t('shell.managementLoading', { section: managementTitle })}</p>
                    <div class="grid gap-2 py-1">
                      <Skeleton width="11rem" height="1.375rem" />
                      <Skeleton width="min(24rem, 75%)" height="0.75rem" />
                    </div>
                    {#if managementView === 'settings'}
                      <div class="flex flex-wrap gap-3 border-b border-[var(--fm-border)] pb-4" aria-hidden="true">
                        {#each Array(4) as _, index (index)}<Skeleton width={index === 0 ? '5rem' : '4rem'} height="1.25rem" />{/each}
                      </div>
                    {/if}
                    <div class="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--fm-border)] bg-[var(--fm-surface)]">
                      <div class="grid gap-2 border-b border-[var(--fm-border)] px-4 py-3">
                        <Skeleton width="9rem" height="0.875rem" />
                        <Skeleton width="min(20rem, 75%)" height="0.75rem" />
                      </div>
                      <div class="grid gap-4 p-4">
                        <Skeleton height="2.5rem" />
                        <Skeleton height="2.5rem" />
                      </div>
                    </div>
                  </div>
                {/if}
              </div>
            {:else}
              <div
                bind:this={workspaceElement}
                class:detail-open={mobileDetailOpen}
                class:list-layout={readingLayout === 'list'}
                data-reading-layout={readingLayout}
                class="mail-workspace"
                data-list-width-preference={listWidth}
                data-list-width-effective={effectiveListWidth}
                style={`--fm-list-width: ${effectiveListWidth}px`}
              >
                <section class="mail-list-panel" aria-label={t('mail.listLabel', { section: t('shell.mailNavigation') })}>
                  <FolderHeader
                    activeSection={activeSection}
                    title={activeSection === 'label' ? userLabels.find((label) => label.id === activeLabelId)?.name : undefined}
                    {readingLayout}
                    onToggleReadingLayout={toggleReadingLayout}
                    count={(searchQuery.trim() || (activeSection === 'inbox' && inboxCategory !== 'all')) && activeSection !== 'trash'
                      ? mailboxPages?.[activeSection]?.searchTotal ?? 0
                      : activeSection === 'inbox' ? metrics.inboxCount
                        : activeSection === 'archive' ? metrics.archiveCount
                          : activeSection === 'starred' ? metrics.starredCount
                            : activeSection === 'label' ? mailboxPages?.label?.searchTotal ?? activeMessages.length
                          : activeSection === 'sent' ? metrics.sentCount
                            : activeSection === 'drafts' ? metrics.draftsCount : activeMessages.length}
                    unreadCount={activeSection === 'inbox' && inboxCategory === 'all' ? unreadCount : 0}
                    query={searchQuery}
                    filter={mailFilter}
                    identityFilter={mailIdentityFilter}
                    identityOptions={mailIdentityOptions}
                    loading={activeSection === 'trash' ? trashLoading : mailboxLoading}
                    onQueryChange={handleSearchQueryChange}
                    onFilterChange={handleFilterChange}
                    onIdentityFilterChange={handleIdentityFilterChange}
                    onRefresh={refreshWorkspace}
                  />
                  {#if activeSection === 'label'}
                    <div class="flex items-center gap-1 border-b border-[var(--fm-border)] bg-[var(--fm-surface-subtle)] px-3 py-1" role="toolbar" aria-label={t('shell.labels')}>
                      <Tag class="size-3.5 text-[var(--fm-text-muted)]" aria-hidden="true" />
                      <IconButton ariaLabel={t('label.rename')} title={t('label.rename')} size="sm" onclick={() => editLabel('rename')}><Pencil class="size-4" aria-hidden="true" /></IconButton>
                      <IconButton ariaLabel={t('label.delete')} title={t('label.delete')} size="sm" class="text-[var(--fm-danger)]" onclick={() => (deleteLabelConfirmOpen = true)}><Trash2 class="size-4" aria-hidden="true" /></IconButton>
                    </div>
                  {/if}
                  {#if activeSection === 'trash'}
                    <div class="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--fm-border)] bg-[var(--fm-surface-subtle)] px-3 py-2">
                      <span class="text-xs text-[var(--fm-text-muted)]">{t('mail.trashRetention')}</span>
                      <button class="min-h-9 rounded-[var(--radius-md)] border border-[var(--fm-danger)]/40 px-2.5 text-xs font-medium text-[var(--fm-danger)] hover:bg-[var(--fm-danger-soft)]" type="button" disabled={pending || trashItems.length === 0} onclick={() => (emptyTrashConfirmOpen = true)}>{t('mail.emptyTrash')}</button>
                    </div>
                  {/if}
                  {#if activeSection !== 'drafts' && activeSection !== 'trash'}
                    <div class="bulk-toolbar" role="group" aria-label={t('mail.bulkActions')}>
                      <label class="bulk-select-control fm-touch-target" title={bulkAllSelected ? t('mail.clearSelection') : t('mail.selectPage')}>
                        <input
                          bind:this={bulkSelectInput}
                          type="checkbox"
                          checked={bulkAllSelected}
                          aria-label={bulkAllSelected ? t('mail.clearSelection') : t('mail.selectPage')}
                          aria-checked={bulkSomeSelected ? 'mixed' : bulkAllSelected ? 'true' : 'false'}
                          disabled={bulkSelectableIds.length === 0 || mailboxLoading || Boolean(mailboxError)}
                          onchange={selectAllVisible}
                        />
                      </label>
                      <span class="bulk-context">
                        {bulkSelectedVisibleCount > 0
                          ? translateCount(i18n.locale, 'mail.selectedCount', bulkSelectedVisibleCount)
                          : t('mail.selectPage')}
                      </span>
                      {#if bulkSelectedVisibleCount > 0}
                        <div class="bulk-actions">
                          {#if activeSection === 'inbox'}
                            <DropdownMenu id="inbox-category-actions" align="end" showChevron={false} triggerAriaLabel={t('mail.category.move')} triggerTitle={t('mail.category.move')} class="bulk-action-menu">
                              {#snippet trigger()}<Inbox class="size-4" aria-hidden="true" />{/snippet}
                              {#snippet children()}
                                {#each inboxCategories as category}
                                  <button class="menu-action" role="menuitem" type="button" disabled={categoryPending || pending} onclick={() => void changeSelectedCategory(category)}>{t(`mail.category.${category}`)}</button>
                                {/each}
                                <button class="menu-action" role="menuitem" type="button" disabled={categoryPending || pending} onclick={() => void changeSelectedCategory(null)}>{t('mail.category.automatic')}</button>
                              {/snippet}
                            </DropdownMenu>
                          {/if}
                          <IconButton ariaLabel={t('label.bulkManage')} title={t('label.bulkManage')} size="sm" disabled={pending || bulkLabelPending} onclick={openBulkLabelDialog}><Tag class="size-4" aria-hidden="true" /></IconButton>
                          {#if bulkSelectedThreadCount > 0 && activeSection !== 'starred' && activeSection !== 'label'}
                            <label class="inline-flex min-h-8 items-center gap-1.5 text-xs text-[var(--fm-text-muted)]" title={t('mail.threadScopeDescription')}>
                              <span class="sr-only">{t('mail.threadScope')}</span>
                              <select
                                class="min-h-8 max-w-48 rounded-[var(--radius-md)] border border-[var(--fm-border)] bg-[var(--fm-surface)] px-2 text-xs text-[var(--fm-text)]"
                                aria-label={t('mail.threadScope')}
                                value={bulkThreadScope}
                                onchange={(event) => (bulkThreadScope = event.currentTarget.value as 'selected' | 'filtered' | 'owner')}
                              >
                                <option value="selected">{t('mail.threadScopeSelected')}</option>
                                <option value="filtered">{t('mail.threadScopeFiltered')}</option>
                                <option value="owner">{t('mail.threadScopeOwner')}</option>
                              </select>
                              <span class="sr-only">{t('mail.threadScopeDescription')}</span>
                            </label>
                          {/if}
                          {#if activeSection === 'archive' || ((activeSection === 'starred' || activeSection === 'label') && bulkHasArchivedInbox)}
                            <IconButton ariaLabel={t('mail.moveToInbox')} title={t('mail.moveToInbox')} size="sm" disabled={pending} onclick={() => void handleBulkMutation('unarchive')}><Inbox class="size-4" aria-hidden="true" /></IconButton>
                          {/if}
                          {#if activeSection === 'inbox' || ((activeSection === 'starred' || activeSection === 'label') && bulkHasUnarchivedInbox)}
                            <IconButton ariaLabel={t('shell.archive')} title={t('shell.archive')} size="sm" disabled={pending} onclick={() => void handleBulkMutation('archive')}><Archive class="size-4" aria-hidden="true" /></IconButton>
                          {/if}
                          {#if bulkCanMutateMessages}
                            <IconButton ariaLabel={t('mail.markRead')} title={t('mail.markRead')} size="sm" disabled={pending} onclick={() => void handleBulkMutation('read')}><MailOpen class="size-4" aria-hidden="true" /></IconButton>
                            <IconButton ariaLabel={t('mail.moveTrash')} title={t('mail.moveTrash')} variant="ghost" size="sm" class="text-[var(--fm-danger)]" disabled={pending} onclick={() => void handleBulkMutation('trash')}><Trash2 class="size-4" aria-hidden="true" /></IconButton>
                            <DropdownMenu id="bulk-more-actions" align="end" showChevron={false} triggerAriaLabel={t('mail.moreActions')} triggerTitle={t('mail.moreActions')} class="bulk-action-menu">
                              {#snippet trigger()}
                                <MoreHorizontal class="size-4" aria-hidden="true" />
                              {/snippet}
                              {#snippet children()}
                                <button class="menu-action" role="menuitem" type="button" onclick={() => void handleBulkMutation('unread')}><Mail class="size-4" aria-hidden="true" />{t('mail.markUnread')}</button>
                                <button class="menu-action" role="menuitem" type="button" onclick={() => void handleBulkMutation('star')}><Star class="size-4" aria-hidden="true" />{t('mail.star')}</button>
                                <button class="menu-action" role="menuitem" type="button" onclick={() => void handleBulkMutation('unstar')}><Star class="size-4" aria-hidden="true" />{t('mail.unstar')}</button>
                              {/snippet}
                            </DropdownMenu>
                          {/if}
                        </div>
                      {/if}
                    </div>
                    {#if bulkHasDraftSelection}
                      <p class="border-b border-[var(--fm-border)] bg-[var(--fm-surface-subtle)] px-3 py-1 text-xs text-[var(--fm-text-muted)]" role="status">{t('mail.bulkDraftRestriction')}</p>
                    {/if}
                  {/if}
                  {#if activeSection === 'inbox'}
                    <InboxCategoryTabs category={inboxCategory} onChange={handleCategoryChange} />
                  {/if}
                  <MessageList
                    category={activeSection === 'inbox' ? inboxCategory : undefined}
                    fullWidth={readingLayout === 'list'}
                    {pending}
                    onArchive={activeSection !== 'trash' ? handleRowArchive : undefined}
                    onToggleRead={activeSection !== 'trash' ? handleToggleRead : undefined}
                    onRemove={activeSection !== 'trash' ? handleDeleteMessage : undefined}
                    activeSection={activeSection}
                    messages={visibleMessages}
                    selectedThreadId={readingLayout === 'list' && !mobileDetailOpen ? null : selectedThreadId}
                    threads={visibleThreads}
                    selectedMessageId={readingLayout === 'list' && !mobileDetailOpen ? null : selectedMessageId}
                    query={searchQuery}
                    filter={mailFilter}
                    viewKey={[activeSection, inboxCategory, searchQuery.trim(), mailFilter, identityKey(mailIdentityFilter), activeLabelId ?? ''].join('|')}
                    refreshing={mailboxRefreshing}
                    loading={activeSection === 'trash' ? trashLoading : mailboxLoading}
                    loadingMore={activeSection === 'trash' ? false : mailboxLoadingMore}
                    error={activeSection === 'trash' ? trashError : mailboxError}
                    hasMore={activeSection === 'trash' ? trashHasMore : mailboxPages?.[activeSection]?.hasMore ?? false}
                    paginationEnd={activeSection === 'trash' ? !trashHasMore : !(mailboxPages?.[activeSection]?.hasMore ?? false)}
                    onSelect={handleSelectMessage}
                    onSelectThread={handleSelectThread}
                    onToggleStar={activeSection === 'trash' ? undefined : handleToggleStar}
                    onQueryChange={handleSearchQueryChange}
                    onFilterChange={handleFilterChange}
                    onClearFilters={clearMailFilters}
                    onRefresh={refreshWorkspace}
                    onLoadMore={loadMoreMailbox}
                    selectable={activeSection !== 'drafts' && activeSection !== 'trash'}
                    selectedMessageIds={selectedMessageIdSet}
                    onToggleSelect={toggleBulkSelection}
                  />
                </section>
                <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
                <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
                <div
                  class="mail-splitter"
                  role="separator"
                  tabindex="0"
                  aria-orientation="vertical"
                  aria-valuemin={effectiveListWidthRange.min}
                  aria-valuemax={effectiveListWidthRange.max}
                  aria-valuenow={effectiveListWidth}
                  aria-keyshortcuts="ArrowLeft ArrowRight Home End Enter"
                  aria-label={t('mail.adjustList')}
                  title={t('mail.listWidthHint')}
                  onpointerdown={startListResize}
                  onkeydown={adjustListWidth}
                ></div>
                <section class="mail-detail-panel" aria-label={t('mail.detail')}>
                  {#if !readerOpen}
                    <MessageDetail
                    message={selectedMessage}
                    deliveryDetail={selectedDeliveryDetail}
                    deliveryDetailError={selectedDeliveryDetailError}
                    deliveryDetailPending={deliveryDetailPendingId === selectedMessage?.id}
                    inboundDetail={selectedInboundDetail}
                    inboundDetailError={selectedInboundDetailError}
                    inboundDetailPending={inboundDetailPendingId === selectedMessage?.id}
                    workspaceBody={selectedWorkspaceBody}
                    workspaceAttachments={selectedMessage ? workspaceBodies[selectedMessage.id]?.attachments ?? [] : []}
                    workspaceBodyError={selectedWorkspaceBodyError}
                    workspaceBodyPending={workspaceBodyPendingId === selectedMessage?.id}
                    {pending}
                    rawDownloadHref={selectedInboundDownloadHref}
                    showBack={true}
                    sectionTitle={activeSectionTitle}
                    threadMessages={selectedThreadMessages}
                    onBack={closeMobileDetail}
                    onEditDraft={handleEditDraft}
                    onForward={handleForwardMessage}
                    onReply={handleReplyMessage}
                    onReplyAll={selectedReplyAllAvailable ? handleReplyAllMessage : undefined}
                    trashMode={activeSection === 'trash'}
                    onRestore={handleRestoreTrash}
                    onPermanentDelete={handlePermanentDelete}
                    onReportHtmlIssue={handleReportHtmlIssue}
                    onReloadDeliveryDetail={handleReloadDeliveryDetail}
                    onRetryDelivery={retryMessageDelivery}
                    onReloadInboundDetail={handleReloadInboundDetail}
                    onArchive={activeSection !== 'trash' ? handleRowArchive : undefined}
                    onRemove={handleDeleteMessage}
                    onSelectThreadMessage={handleSelectMessage}
                    onToggleRead={handleToggleRead}
                    onToggleStar={handleToggleStar}
                    onManageLabels={(message) => (labelTargetMessage = message)}
                    onOpenReader={openReader}
                    standaloneHref={selectedMessage ? standaloneMessageHref(selectedMessage) : null}
                    bodyView={selectedBodyView}
                    allowRemoteImages={selectedRemoteImagesAllowed}
                    onBodyViewChange={(view) => { if (selectedMessage) bodyViewByMessage[selectedMessage.id] = view; }}
                    onRemoteImagesChange={(allowed) => { remoteImagesMessageId = allowed && selectedMessage ? selectedMessage.id : null; }}
                    />
                  {:else}
                    <div class="grid h-full place-items-center p-6 text-center text-sm text-[var(--fm-text-muted)]">{t('mail.readerOpen')}</div>
                  {/if}
                </section>
              </div>
            {/if}
          </main>
        </div>

      </div>
    </div>

    {#if readerOpen && selectedMessage}
      <ReaderDialog id="reader-dialog" open showHeader={false} title={selectedMessage.subject || t('mail.noSubject')} onClose={() => void closeReader()}>
        <MessageDetail
          message={selectedMessage}
          deliveryDetail={selectedDeliveryDetail}
          deliveryDetailError={selectedDeliveryDetailError}
          deliveryDetailPending={deliveryDetailPendingId === selectedMessage.id}
          inboundDetail={selectedInboundDetail}
          inboundDetailError={selectedInboundDetailError}
          inboundDetailPending={inboundDetailPendingId === selectedMessage.id}
          workspaceBody={selectedWorkspaceBody}
          workspaceAttachments={workspaceBodies[selectedMessage.id]?.attachments ?? []}
          workspaceBodyError={selectedWorkspaceBodyError}
          workspaceBodyPending={workspaceBodyPendingId === selectedMessage.id}
          {pending}
          rawDownloadHref={selectedInboundDownloadHref}
          threadMessages={selectedThreadMessages}
          onEditDraft={handleEditDraft}
          onForward={handleForwardMessage}
          onReply={handleReplyMessage}
          onReplyAll={selectedReplyAllAvailable ? handleReplyAllMessage : undefined}
          trashMode={activeSection === 'trash'}
          onRestore={handleRestoreTrash}
          onPermanentDelete={handlePermanentDelete}
          onReportHtmlIssue={handleReportHtmlIssue}
          onReloadDeliveryDetail={handleReloadDeliveryDetail}
          onRetryDelivery={retryMessageDelivery}
          onReloadInboundDetail={handleReloadInboundDetail}
          onArchive={activeSection !== 'trash' ? handleRowArchive : undefined}
          onRemove={handleDeleteMessage}
          onSelectThreadMessage={handleSelectMessage}
          onToggleRead={handleToggleRead}
          onToggleStar={handleToggleStar}
          onManageLabels={(message) => (labelTargetMessage = message)}
          onCloseReader={() => void closeReader()}
          bodyView={selectedBodyView}
          allowRemoteImages={selectedRemoteImagesAllowed}
          readerMode
          onBodyViewChange={(view) => { if (selectedMessage) bodyViewByMessage[selectedMessage.id] = view; }}
          onRemoteImagesChange={(allowed) => { remoteImagesMessageId = allowed ? selectedMessage.id : null; }}
        />
      </ReaderDialog>
    {/if}

    {#if composeOpen}
      {#if ComposeModal}
        <ComposeModal
          autosaveMessage={composeAutosaveMessage}
          autosaveStatus={composeAutosaveStatus}
          draftId={composeDraftId}
          expectedUpdatedAt={composeLiveInput?.expectedUpdatedAt}
          bodyRevision={composeLiveInput ? composeLiveInput.bodyRevision ?? null : undefined}
          initialInput={composeInitialInput}
          {recipientSuggestions}
          mode={composeMode}
          pending={composeBusy}
          {authExpired}
          {profile}
          senderAddresses={mailIdentityOptions.addresses}
          onClose={closeCompose}
          onDiscard={discardCompose}
          draftConflict={draftConflict}
          localEditedAt={draftConflictLocalEditedAt}
          onLoadServerDraft={loadServerDraft}
          onSaveDraftCopy={saveDraftCopy}
          onOverwriteServerDraft={overwriteServerDraft}
          onPrepareAttachments={prepareComposeAttachments}
          onInputChange={(input) => {
            composeAutosave.changed();
            const nextInput = withCurrentComposePersistence(input);
            const nextSignature = serializeComposeInput(nextInput);

            composeLiveInput = nextInput;
            composeTouched = true;

            if (authExpired) {
              authRecoverySaveRequired = true;
              composeAutosaveStatus = 'error';
              composeAutosaveMessage = t('compose.authExpiredDraftPreserved');
              return;
            }
            if (authRecoverySaveRequired) authRecoverySaveRequired = false;

            if (!hasComposeContent(nextInput)) {
              composeAutosaveStatus = 'idle';
              composeAutosaveMessage = t('compose.autosaveIdle');
              return;
            }

            if (nextSignature === composeLastSavedSignature) {
              composeAutosaveStatus = 'saved';
              return;
            }

            composeAutosaveStatus = 'dirty';
            composeAutosaveMessage = t('compose.autosavePending');
          }}
          onSaveDraft={saveDraft}
          onSend={sendMessage}
        />
      {:else}
        <div
          class="fixed bottom-4 right-4 z-50 rounded-[var(--radius-md)] border border-[var(--fm-border)] bg-[var(--fm-surface)] px-4 py-3 text-sm text-[var(--fm-text)] shadow-[var(--fm-shadow-overlay)]"
          role="status"
          aria-live="polite"
        >{t('compose.loadingEditor')}</div>
      {/if}
    {/if}

    <Dialog id="label-editor" open={labelEditorMode !== null} title={labelEditorMode === 'rename' ? t('label.rename') : t('label.create')} dismissible={!labelActionPending} closeOnBackdrop={!labelActionPending} onClose={closeLabelEditor}>
      <form onsubmit={(event) => { event.preventDefault(); void saveLabel(); }}>
        {#if labelEditorInterrupted}<Banner variant="warning" class="mb-3">{t('label.interrupted')}</Banner>{/if}
        <TextField id="mail-label-name" label={t('label.name')} bind:value={labelEditorName} maxlength={48} required disabled={labelActionPending} />
        <div class="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onclick={closeLabelEditor} disabled={labelActionPending}>{t('common.cancel')}</Button>
          <Button type="submit" loading={labelActionPending} disabled={authExpired}>{t('label.save')}</Button>
        </div>
      </form>
    </Dialog>

    <Dialog id="message-labels" open={labelTargetMessage !== null} title={t('label.apply')} onClose={() => (labelTargetMessage = null)}>
      {#if labelTargetMessage}
        <p class="mb-3 truncate text-xs text-[var(--fm-text-muted)]">{labelTargetMessage.subject || t('mail.noSubject')}</p>
        {#if userLabels.length === 0}<p class="text-sm text-[var(--fm-text-muted)]">{t('label.empty')}</p>{/if}
        <div class="grid gap-1">
          {#each userLabels as userLabel (userLabel.id)}
            <Checkbox id={`message-label-${userLabel.id}`} label={userLabel.name} checked={(labelTargetMessage.userLabels ?? []).some((item) => item.id === userLabel.id)} disabled={labelActionPending || authExpired} class="rounded-[var(--radius-md)] px-2 hover:bg-[var(--fm-surface-hover)]" onchange={() => { if (labelTargetMessage) void toggleMessageLabel(labelTargetMessage, userLabel.id); }} />
          {/each}
        </div>
        <Button variant="ghost" size="sm" class="mt-3" onclick={() => { const target = labelTargetMessage; labelTargetMessage = null; editLabel('create', target); }}>{t('label.create')}</Button>
      {/if}
    </Dialog>

    <Dialog id="bulk-message-labels" open={bulkLabelDialogOpen} title={t('label.bulkManage')} description={t('label.bulkDescription', { count: bulkSelectedMessages.length })} dismissible={!bulkLabelPending} closeOnBackdrop={!bulkLabelPending} onClose={() => (bulkLabelDialogOpen = false)}>
      {#if userLabels.length}
        <Select id="bulk-label-target" label={t('label.name')} options={userLabels.map((label) => ({ value: label.id, label: label.name }))} value={bulkLabelId} disabled={bulkLabelPending} onchange={(value) => (bulkLabelId = value)} />
      {:else}
        <p class="text-sm text-[var(--fm-text-muted)]">{t('label.empty')}</p>
        <Button variant="ghost" size="sm" class="mt-3" onclick={() => { bulkLabelDialogOpen = false; editLabel('create'); }}>{t('label.create')}</Button>
      {/if}
      <div class="mt-5 grid grid-cols-1 gap-2 min-[360px]:grid-cols-2 sm:flex sm:flex-wrap sm:justify-end">
        <Button variant="secondary" class="w-full sm:w-auto" disabled={bulkLabelPending} onclick={() => (bulkLabelDialogOpen = false)}>{t('common.cancel')}</Button>
        <Button variant="outline" class="w-full sm:w-auto" loading={bulkLabelPending} disabled={!bulkLabelId || authExpired} onclick={() => void changeBulkLabel(false)}>{t('label.removeFromSelected')}</Button>
        <Button variant="primary" class="w-full min-[360px]:col-span-2 sm:w-auto" loading={bulkLabelPending} disabled={!bulkLabelId || authExpired} onclick={() => void changeBulkLabel(true)}>{t('label.addToSelected')}</Button>
      </div>
    </Dialog>

    <ConfirmDialog id="delete-label-confirm" open={deleteLabelConfirmOpen} title={t('label.delete')} description={t('label.deleteDescription')} confirmLabel={t('label.delete')} pending={labelActionPending} onCancel={() => (deleteLabelConfirmOpen = false)} onConfirm={removeActiveLabel} />

    <Dialog
      id="shortcut-dialog"
      open={shortcutHelpOpen}
      title={t('shortcut.title')}
      description={t('shortcut.description')}
      onClose={() => (shortcutHelpOpen = false)}
    >
      <dl class="shortcut-grid">
        <div><dt><kbd>/</kbd></dt><dd>{t('shortcut.search')}</dd></div>
        <div><dt><kbd>C</kbd></dt><dd>{t('shortcut.compose')}</dd></div>
        <div><dt><kbd>G</kbd> <kbd>I</kbd></dt><dd>{t('shortcut.inbox')}</dd></div>
        <div><dt><kbd>G</kbd> <kbd>S</kbd></dt><dd>{t('shortcut.sent')}</dd></div>
        <div><dt><kbd>G</kbd> <kbd>D</kbd></dt><dd>{t('shortcut.drafts')}</dd></div>
        <div><dt><kbd>J</kbd> / <kbd>K</kbd></dt><dd>{t('shortcut.nextPrevious')}</dd></div>
        <div><dt><kbd>R</kbd></dt><dd>{t('shortcut.reply')}</dd></div>
        <div><dt><kbd>A</kbd></dt><dd>{t('shortcut.replyAll')}</dd></div>
        <div><dt><kbd>F</kbd></dt><dd>{t('shortcut.forward')}</dd></div>
        <div><dt><kbd>Esc</kbd></dt><dd>{t('shortcut.close')}</dd></div>
        <div><dt><kbd>?</kbd></dt><dd>{t('shortcut.help')}</dd></div>
      </dl>
    </Dialog>

    <ConfirmDialog
      id="empty-trash-confirm"
      open={emptyTrashConfirmOpen}
      title={t('mail.emptyTrashConfirm')}
      description={t('mail.emptyTrashDescription')}
      confirmLabel={t('mail.emptyTrash')}
      {pending}
      onCancel={() => (emptyTrashConfirmOpen = false)}
      onConfirm={handleEmptyTrash}
    />
  {/if}

  <div id="send-status-announcement" class="sr-only" role="status" aria-live="polite">{sendAnnouncement}</div>
  <ToastRegion
    messages={toastMessages}
    aboveActions={composeOpen}
    aboveSettingsSave={authenticated && activeSection === 'profile' && managementView === 'settings' && !composeOpen}
    onAction={(id) => void toastController.invoke(id)}
    onDismiss={(id) => toastController.dismiss(id)}
  />
</div>

<style>
  .shortcut-grid {
    display: grid;
    gap: 0;
    margin: 0;
  }

  .shortcut-grid div {
    display: grid;
    grid-template-columns: 124px minmax(0, 1fr);
    align-items: center;
    gap: var(--space-4);
    padding: var(--space-2) 0;
    border-bottom: 1px solid var(--fm-border);
  }

  .shortcut-grid div:last-child {
    border-bottom: 0;
  }

  .shortcut-grid dt,
  .shortcut-grid dd {
    margin: 0;
  }

  .shortcut-grid dd {
    color: var(--fm-text-secondary);
    font-size: 13px;
  }

  .shortcut-grid kbd {
    display: inline-flex;
    min-width: 26px;
    min-height: 24px;
    align-items: center;
    justify-content: center;
    padding: 0 6px;
    border: 1px solid var(--fm-border-strong);
    border-radius: var(--radius-sm);
    color: var(--fm-text-secondary);
    background: var(--fm-surface-subtle);
    font: 600 11px/1 var(--font-sans);
  }

  .mail-workspace {
    display: grid;
    grid-template-columns: minmax(280px, var(--fm-list-width)) 8px minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr);
    height: 100%;
    min-width: 0;
  }

  .mail-workspace.list-layout { grid-template-columns: minmax(0, 1fr); }
  .list-layout .mail-splitter, .list-layout .mail-detail-panel { display: none; }
  .list-layout.detail-open .mail-list-panel { display: none; }
  .list-layout.detail-open .mail-detail-panel { display: block; }
  @media (min-width: 901px) {
    .mail-workspace:not(.list-layout) :global(.fm-detail-back) { display: none; }
  }

  .mail-list-panel {
    display: flex;
    min-width: 0;
    min-height: 0;
    flex-direction: column;
    background: var(--fm-surface);
  }

  .bulk-toolbar {
    display: flex;
    min-width: 0;
    min-height: 42px;
    align-items: center;
    gap: 0.5rem;
    border-bottom: 1px solid var(--fm-border);
    background: var(--fm-surface);
    padding: 0.25rem 0.75rem;
  }

  .bulk-select-control {
    display: grid;
    width: 30px;
    height: 30px;
    flex: 0 0 auto;
    place-items: center;
    border-radius: var(--radius-md);
    cursor: pointer;
  }

  .bulk-select-control:hover {
    background: var(--fm-surface-hover);
  }

  .bulk-select-control input {
    width: 16px;
    height: 16px;
    accent-color: var(--fm-primary);
  }

  .bulk-context {
    min-width: 0;
    overflow: hidden;
    color: var(--fm-text-muted);
    font-size: 11px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .bulk-actions {
    display: flex;
    min-width: 0;
    align-items: center;
    gap: 0.125rem;
    margin-left: auto;
  }

  :global(.bulk-action-menu > button) {
    width: var(--control-compact);
    height: var(--control-compact);
    padding: 0;
    color: var(--fm-text-secondary);
  }

  :global(.bulk-action-menu [role='menu']) {
    width: 13rem;
  }

  .mail-detail-panel {
    min-width: 0;
    min-height: 0;
    background: var(--fm-surface);
  }

  .mail-splitter {
    position: relative;
    z-index: 5;
    cursor: col-resize;
    background: var(--fm-border);
    outline: none;
  }

  .mail-splitter::after {
    position: absolute;
    top: 50%;
    left: 50%;
    width: 3px;
    height: 42px;
    border-radius: var(--radius-pill);
    background: var(--fm-border-strong);
    content: '';
    opacity: 0;
    transform: translate(-50%, -50%);
    transition: opacity var(--motion-fast);
  }

  .mail-splitter:hover::after,
  .mail-splitter:focus-visible::after {
    opacity: 1;
  }

  :global(.fm-app-shell[data-density='compact']) :global(.mail-list-panel article) {
    min-height: 60px;
  }

  :global(.fm-app-shell[data-density='compact']) :global(.mail-list-panel article > button) {
    min-height: 60px;
    padding-block: 0.375rem;
  }

  @media (min-width: 901px) {
    :global(.fm-app-shell[data-density='compact']) .list-layout :global(.mail-list-item),
    :global(.fm-app-shell[data-density='compact']) .list-layout :global(.mail-list-item-button) { min-height: 40px; }
  }

  @media (max-width: 900px) {
    .settings-main {
      height: 100%;
    }

    .mail-workspace {
      grid-template-columns: minmax(0, 1fr);
    }

    .mail-splitter {
      display: none;
    }

    .bulk-select-control,
    :global(.bulk-action-menu > button) {
      width: 44px;
      height: 44px;
    }

    .bulk-toolbar {
      min-height: 50px;
      padding-block: 0.25rem;
    }

    .mail-detail-panel,
    .mail-workspace.detail-open .mail-list-panel {
      display: none;
    }

    .mail-workspace.detail-open .mail-detail-panel {
      display: block;
    }
  }

  @media (max-width: 767px) {
    :global(.fm-workspace-body) {
      height: calc(100dvh - 52px - env(safe-area-inset-top));
    }

    .mail-workspace,
    .mail-detail-panel {
      width: 100%;
      max-width: 100vw;
    }

    .mail-detail-panel {
      flex: 0 0 100%;
      overflow-x: hidden;
    }

    .mobile-detail-nav-hidden {
      display: none;
    }

    :global(.fm-workspace-body.mobile-detail-mode) {
      grid-template-rows: minmax(0, 1fr);
      height: calc(100dvh - env(safe-area-inset-top));
    }

  }
</style>
