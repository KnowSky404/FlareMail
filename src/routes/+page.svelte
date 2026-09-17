<script lang="ts">
  import { goto, pushState, replaceState } from '$app/navigation';
  import { page } from '$app/state';
  import { onMount, untrack } from 'svelte';
  import { Archive, Inbox, Mail, MailOpen, MoreHorizontal, Star, Trash2 } from '@lucide/svelte';
  import type { PageData } from './$types';
  import ComposeModal from '$lib/components/mail/ComposeModal.svelte';
  import FolderHeader from '$lib/components/mail/FolderHeader.svelte';
  import LoginView from '$lib/components/mail/LoginView.svelte';
  import MessageDetail from '$lib/components/mail/MessageDetail.svelte';
  import RuntimeUnavailableView from '$lib/components/mail/RuntimeUnavailableView.svelte';
  import MessageList from '$lib/components/mail/MessageList.svelte';
  import ProfilePane from '$lib/components/mail/ProfilePane.svelte';
  import AppSidebar from '$lib/components/shell/AppSidebar.svelte';
  import AppTopbar from '$lib/components/shell/AppTopbar.svelte';
  import MobileNavigation from '$lib/components/shell/MobileNavigation.svelte';
  import Dialog from '$lib/components/ui/Dialog.svelte';
  import ReaderDialog from '$lib/components/ui/ReaderDialog.svelte';
  import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte';
  import ToastRegion from '$lib/components/ui/ToastRegion.svelte';
  import { DropdownMenu, IconButton } from '$lib/components/ui';
  import { ClientApiError } from '$lib/client/api';
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
  import {
    MailboxController,
    createEmptyWorkspaceViewState,
    mergeMailboxPage,
    mergeMessageDelta,
    moveSelection,
    reconcileBulkSelection,
    removeMessage,
    selectNextMessage,
    selectionCandidates,
    workspaceViewStateFromSnapshot,
    type MailFilter,
    type WorkspaceSection
  } from '$lib/client/mailbox-controller';
  import { LatestRequest } from '$lib/client/latest-request';
  import {
    createSession,
    deleteMessage,
    deleteSession,
    emptyTrash,
    fetchDeliveryDetail,
    fetchDraftDetail,
    fetchInboundDetail,
    fetchMailboxPage,
    fetchWorkspaceMessage,
    fetchMessageBody,
    fetchTrash,
    permanentlyDeleteTrashItem,
    persistDraft,
    restoreTrashItem,
    retryDelivery,
    submitMessage,
    updateMessageFlags,
    updateProfile,
    mutateMailbox
  } from '$lib/client/workspace-api';
  import { WorkspaceShortcutController, type WorkspaceShortcutAction } from '$lib/client/workspace-shortcuts';
  import { ToastController, type ToastMessage, type ToastTone } from '$lib/client/toast-controller';
  import { TrashController } from '$lib/client/trash-controller';
  import { readWorkspaceUrl, updateWorkspaceUrl as buildWorkspaceUrl } from '$lib/client/workspace-url-controller';
  import { WorkspaceSnapshotController } from '$lib/client/workspace-snapshot-controller';
  import { createWorkspaceSync, type WorkspaceSyncController } from '$lib/client/workspace-sync';
  import { LOCALE_CHANGE_EVENT } from '$lib/client/locale-preferences';
  import { useLocale } from '$lib/i18n/runtime.svelte';
  import { formatDate, formatNumber, translateCount } from '$lib/i18n';
  import {
    clampListWidth,
    layoutPreferenceRange,
    listWidthFromKeyboard,
    readLayoutPreferences,
    writeLayoutPreferences,
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
    serializeAddressList,
    type DeliveryDetail,
    type ComposeInput,
    type ComposeMode,
    type InboundMessageDetail,
    type LoginInput,
    type MailboxSection,
    type MailMessage,
    type MailboxState,
    type MailboxPage,
    type MailThread,
    type MessagePatch,
    type TrashItem,
    type UserProfile,
    type WorkspaceMetrics
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
  let profile = $state<UserProfile>(cloneProfile());
  let mailbox = $state<MailboxState>(cloneMailbox());
  let metrics = $state<WorkspaceMetrics>({ inboxCount: 0, sentCount: 0, draftsCount: 0, trashCount: 0, unreadCount: 0, starredCount: 0,
    queuedCount: 0, delayedCount: 0, failedCount: 0, bouncedCount: 0, complainedCount: 0, staleDeliveryCount: 0 });
  let mailboxPages = $state<Partial<Record<MailboxSection, MailboxPage>> | null>(null);
  let trashItems = $state<TrashItem[]>([]);
  let trashHasMore = $state(false);
  let trashLoading = $state(false);
  let trashLoaded = $state(false);
  let trashError = $state('');
  let emptyTrashConfirmOpen = $state(false);
  let outboundSenderEmail = $state<string | null>(null);
  let activeSection = $state<AppSection>('inbox');
  let selectedMessageId = $state<string | null>(null);
  let selectedMessageIds = $state<string[]>([]);
  let bulkSelectInput = $state<HTMLInputElement>();
  let searchQuery = $state('');
  let mailFilter = $state<MailFilter>('all');
  let mobileDetailOpen = $state(false);
  let readerOpen = $state(false);
  let sidebarCollapsed = $state(false);
  let listWidth = $state(360);
  let workspaceElement = $state<HTMLElement>();
  let workspaceWidth = $state(Number.POSITIVE_INFINITY);
  let density = $state<DisplayDensity>('comfortable');
  let bodyViewByMessage = $state<Record<string, 'text' | 'html'>>({});
  let remoteImagesMessageId = $state<string | null>(null);
  let shortcutHelpOpen = $state(false);
  let composeOpen = $state(false);
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
  let runtimeOperationError = $state(false);
  let loginError = $state('');
  let profileStatus = $state('');
  let profileStatusError = $state(false);
  let pending = $state(false);
  let mailboxLoading = $state(false);
  let mailboxRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  let workspaceSync: WorkspaceSyncController | null = null;
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

  function replySource(message: MailMessage): MailMessage {
    if (!isInboundMessageId(message.id)) return message;
    const detail = inboundDetails[message.id];
    if (!detail) return message;
    return {
      ...message,
      toAddresses: detail.toAddresses.length ? detail.toAddresses : message.toAddresses,
      ccAddresses: detail.ccAddresses.length ? detail.ccAddresses : message.ccAddresses
    };
  }
  const toastController = new ToastController((messages) => (toastMessages = messages));
  const workspaceSnapshotController = new WorkspaceSnapshotController();
  const targetMessageRequest = new LatestRequest();
  const trashController = new TrashController(fetchTrash, {
    onResult: (result) => {
      trashItems = result.items;
      trashHasMore = result.hasMore;
      trashLoaded = true;
      trashError = '';
      metrics = result.metrics;
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
    if (!(error instanceof ClientApiError) || error.status >= 500) runtimeOperationError = true;
    notify(
      displayError(error, fallback),
      'error',
      { requestId: error instanceof ClientApiError ? error.requestId : undefined }
    );
  };

  const urlState = $derived(readWorkspaceUrl(page.url));
  const urlSection = $derived(urlState.section);
  const urlQuery = $derived(urlState.query);
  const urlFilter = $derived(urlState.filter);
  const urlMessageId = $derived(urlState.messageId);

  $effect(() => {
    activeSection = urlSection;
    searchQuery = urlQuery;
    mailFilter = urlFilter;
    selectedMessageId = urlMessageId;
    selectedMessageIds = [];
    mobileDetailOpen = Boolean(urlMessageId);
  });

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
      !targetId ||
      !isInboundMessageId(targetId) ||
      section === 'profile' ||
      section === 'trash' ||
      (section !== 'inbox' && section !== 'archive')
    ) return;
    const currentMessages = section === 'archive'
      ? mailboxPages?.archive?.messages ?? []
      : section === 'inbox'
        ? mailbox.inbox
        : [];
    if (currentMessages.some((message) => message.id === targetId)) return;

    const request = targetMessageRequest.begin();
    void (async () => {
      try {
        const result = await fetchWorkspaceMessage(targetId, request.signal);
        if (!request.isCurrent() || urlMessageId !== targetId || activeSection !== section) return;
        const targetSection = result.message.archivedAt ? 'archive' : 'inbox';
        applyMessageDelta(result, { section: targetSection, preferredMessageId: targetId });
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

  const unreadCount = $derived(metrics.unreadCount);
  const serviceDegraded = $derived(
    runtimeOperationError || metrics.delayedCount + metrics.failedCount + metrics.bouncedCount + metrics.complainedCount + metrics.staleDeliveryCount > 0
  );
  const activeMessages = $derived(
    activeSection === 'trash'
      ? trashItems.map((item) => item.message)
      : activeSection === 'drafts'
      ? mailbox.drafts
      : activeSection === 'archive'
        ? mailboxPages?.archive?.messages ?? []
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
    activeThreads.filter((thread) => {
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
  const bulkSelectedVisibleCount = $derived(bulkSelectableIds.filter((id) => selectedMessageIds.includes(id)).length);
  const bulkAllSelected = $derived(bulkSelectableIds.length > 0 && bulkSelectedVisibleCount === bulkSelectableIds.length);
  const bulkSomeSelected = $derived(bulkSelectedVisibleCount > 0 && !bulkAllSelected);

  $effect(() => {
    if (bulkSelectInput) bulkSelectInput.indeterminate = bulkSomeSelected;
  });
  const selectedThread = $derived.by(() => {
    if (activeSection === 'drafts' || activeSection === 'trash' || activeSection === 'profile') {
      return null;
    }

    const threads = visibleThreads;

    if (!threads.length) {
      return null;
    }

    return threads.find((thread) => thread.messages.some((message) => message.id === selectedMessageId))
      ?? (selectedMessageId ? null : threads[0]);
  });
  const selectedThreadId = $derived(selectedThread?.id ?? null);
  const selectedMessage = $derived.by(() => {
    if (activeSection === 'drafts' || activeSection === 'trash') {
      const list = visibleMessages;

      if (!list.length) {
        return null;
      }

      return list.find((message) => message.id === selectedMessageId) ?? (selectedMessageId ? null : list[0]);
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
    const action = page.url.searchParams.get('compose');
    const requestedMessageId = page.url.searchParams.get('message');
    if (action !== 'reply' && action !== 'forward') {
      handledComposeAction = null;
      return;
    }
    if (!authenticated || !selectedMessage || requestedMessageId !== selectedMessage.id) return;
    const actionKey = `${action}:${requestedMessageId}`;
    if (handledComposeAction === actionKey) return;
    handledComposeAction = actionKey;
    const nextUrl = new URL(page.url);
    nextUrl.searchParams.delete('compose');
    replaceState(nextUrl, page.state);
    if (action === 'reply') void handleReplyMessage(selectedMessage);
    else void handleForwardMessage(selectedMessage);
  });

  $effect(() => {
    if (!selectedMessage) readerOpen = false;
  });
  const composeBusy = $derived(pending || composeAutosavePending || composeClosePending);

  $effect(() => {
    if (authenticated && activeSection === 'trash' && !trashLoaded && !trashLoading) {
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

  function applyMessageDelta(result: { message: MailMessage; metrics: WorkspaceMetrics }, options?: { section?: AppSection; preferredMessageId?: string | null; clearMailView?: boolean; removeDraftId?: string }) {
    const merged = mergeMessageDelta(
      { mailbox, mailboxPages, metrics },
      result,
      {
        currentSection: activeSection,
        currentSelectedMessageId: selectedMessageId,
        section: options?.section,
        preferredMessageId: options?.preferredMessageId,
        removeDraftId: options?.removeDraftId
      }
    );
    mailbox = merged.snapshot.mailbox;
    mailboxPages = merged.snapshot.mailboxPages;
    metrics = merged.snapshot.metrics;
    runtimeOperationError = false;
    authenticated = true;
    if (options?.section) activeSection = options.section;
    if (options?.clearMailView) {
      searchQuery = '';
      mailFilter = 'all';
      mobileDetailOpen = false;
    }
    selectedMessageId = merged.selectedMessageId;
    if (options?.section) {
      mobileDetailOpen = options.section !== 'profile' && Boolean(selectedMessageId);
      updateWorkspaceUrl({ section: options.section, query: options.clearMailView ? '' : undefined, filter: options.clearMailView ? 'all' : undefined, messageId: options.section === 'profile' ? null : selectedMessageId }, true);
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
    mailboxController.cancel();
    if (options?.resetUserScoped) {
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
    mailboxPages = next.mailboxPages;
    outboundSenderEmail = next.outboundSenderEmail;
    activeSection = next.activeSection;
    selectedMessageId = next.selectedMessageId;
    selectedMessageIds = next.selectedMessageIds;
    searchQuery = next.searchQuery;
    mailFilter = next.mailFilter;
    mobileDetailOpen = false;
    authenticated = true;
    workspaceSnapshotController.noteUser(workspace.profile.email);

    if (options?.syncUrl) {
      updateWorkspaceUrl(
        {
          section: next.activeSection,
          query: next.searchQuery,
          filter: next.mailFilter,
          messageId: next.activeSection === 'profile' ? null : next.selectedMessageId
        },
        true
      );
    }
  }

  function resetWorkspace() {
    const initial = createEmptyWorkspaceViewState();
    mailboxController.cancel();
    trashController.cancel();
    authenticated = false;
    profile = initial.profile;
    mailbox = initial.mailbox;
    activeSection = initial.activeSection;
    selectedMessageId = initial.selectedMessageId;
    selectedMessageIds = initial.selectedMessageIds;
    mailboxPages = initial.mailboxPages;
    metrics = initial.metrics;
    searchQuery = initial.searchQuery;
    mailFilter = initial.mailFilter;
    outboundSenderEmail = initial.outboundSenderEmail;
    mobileDetailOpen = false;
    shortcutHelpOpen = false;
    mailboxLoading = false;
    trashItems = [];
    trashHasMore = false;
    trashLoading = false;
    trashLoaded = false;
    trashError = '';
    emptyTrashConfirmOpen = false;
    resetComposeState();
    inboundDetailCache.reset();
    deliveryDetailCache.reset();
    workspaceBodyCache.reset();
    profileStatus = '';
    profileStatusError = false;
    loginError = '';
    runtimeOperationError = false;
    workspaceSnapshotController.reset();
  }

  async function loadInboundDetail(message: MailMessage, force = false) {
    if (!isInboundMessageId(message.id)) {
      return false;
    }
    return inboundDetailCache.load(
      message.id,
      async (signal) => (await fetchInboundDetail(message.id, signal)).detail,
      force
    );
  }

  async function loadDeliveryDetail(message: MailMessage, force = false) {
    if (message.folder !== 'sent' || message.source !== 'workspace') {
      return false;
    }
    return deliveryDetailCache.load(
      message.id,
      async (signal) => (await fetchDeliveryDetail(message.id, signal)).detail,
      force
    );
  }

  async function loadWorkspaceBody(message: MailMessage, force = false) {
    if (isInboundMessageId(message.id)) return false;
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
      query?: string;
      filter?: MailFilter;
      messageId?: string | null;
    },
    replaceHistory = false
  ) {
    const next = buildWorkspaceUrl(page.url, updates);
    if (replaceHistory) {
      replaceState(next, page.state);
    } else {
      pushState(next, page.state);
    }
  }

  function setSection(section: AppSection, syncUrl = true) {
    clearMailboxRefreshTimer();
    selectedMessageIds = [];
    activeSection = section;
    searchQuery = '';
    mailFilter = 'all';
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
      if (authenticated) void mailboxController.refresh(section, '', 'all');
      return;
    }

    if (section === 'trash') {
      selectedMessageId = trashItems.some((item) => item.id === selectedMessageId)
        ? selectedMessageId
        : trashItems[0]?.id ?? null;
      if (syncUrl) updateWorkspaceUrl({ section, query: '', filter: 'all', messageId: null });
      if (authenticated) void trashController.load();
      return;
    }

    selectedMessageId = selectNextMessage(mailbox, section, selectedMessageId);
    if (syncUrl) {
      updateWorkspaceUrl({ section, query: '', filter: 'all', messageId: null });
    }
    if (authenticated && section === 'drafts') void mailboxController.refresh(section, '', 'all');
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
    delayMs = 250
  ) {
    clearMailboxRefreshTimer();
    if (!authenticated || folder === 'profile' || folder === 'trash') return;
    mailboxRefreshTimer = setTimeout(() => {
      mailboxRefreshTimer = undefined;
      if (authenticated && activeSection === folder) {
        void mailboxController.refresh(folder, query, filter);
      }
    }, delayMs);
  }

  function handleSearchQueryChange(query: string) {
    searchQuery = query;
    selectedMessageId = null;
    selectedMessageIds = [];
    mobileDetailOpen = false;
    updateWorkspaceUrl({ query, messageId: null }, true);
    scheduleMailboxRefresh(activeSection, query, mailFilter);
  }

  function handleFilterChange(filter: MailFilter) {
    mailFilter = filter;
    selectedMessageId = null;
    selectedMessageIds = [];
    mobileDetailOpen = false;
    updateWorkspaceUrl({ filter, messageId: null });
    scheduleMailboxRefresh(activeSection, searchQuery, filter, 0);
  }

  function clearMailFilters() {
    searchQuery = '';
    mailFilter = 'all';
    selectedMessageId = null;
    selectedMessageIds = [];
    mobileDetailOpen = false;
    updateWorkspaceUrl({ query: '', filter: 'all', messageId: null }, true);
    scheduleMailboxRefresh(activeSection, '', 'all', 0);
  }

  async function refreshWorkspace(announce = true) {
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
      mailFilter
    );
    if (refreshed) {
      runtimeOperationError = false;
      if (announce) notify(t('notify.mailboxRefreshed'), 'success');
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
      void goto(buildWorkspaceUrl(page.url, {
        section: 'inbox', query: '', filter: 'all', messageId: null
      }), { replaceState: true, noScroll: true, keepFocus: false });
      return;
    }

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
    const merged = mergeMailboxPage({ mailbox, mailboxPages, metrics }, page, append);
    mailbox = merged.mailbox;
    mailboxPages = merged.mailboxPages;
    metrics = merged.metrics;
    runtimeOperationError = false;
    const currentMessages = merged.mailboxPages?.[page.folder]?.messages ?? [];
    if (activeSection === page.folder) {
      selectedMessageIds = reconcileBulkSelection(selectedMessageIds, currentMessages);
    }
    if (
      activeSection === page.folder &&
      (!selectedMessageId || !currentMessages.some((message) => message.id === selectedMessageId))
    ) {
      selectedMessageId = currentMessages[0]?.id ?? null;
    }
  }

  function toggleBulkSelection(message: MailMessage) {
    selectedMessageIds = selectedMessageIds.includes(message.id)
      ? selectedMessageIds.filter((id) => id !== message.id)
      : [...selectedMessageIds, message.id];
  }

  function selectAllVisible() {
    const ids = bulkSelectableIds;
    selectedMessageIds = bulkAllSelected
      ? selectedMessageIds.filter((id) => !ids.includes(id))
      : [...new Set([...selectedMessageIds, ...ids])];
  }

  async function handleBulkMutation(action: import('$lib/domain/mail').MailboxMutationAction) {
    if (!selectedMessageIds.length) return;
    pending = true;
    try {
      const selected = [...visibleThreads.flatMap((thread) => [thread.sectionLatestMessage]), ...visibleMessages]
        .filter((message, index, all) => selectedMessageIds.includes(message.id) && all.findIndex((candidate) => candidate.id === message.id) === index);
      const validSelectedIds = selected.map((message) => message.id);
      if (!validSelectedIds.length) {
        selectedMessageIds = [];
        return;
      }
      const threadKeys = selected.map((message) => message.threadKey).filter((key): key is string => Boolean(key));
      const result = await mutateMailbox(action, validSelectedIds, threadKeys);
      metrics = result.result.metrics;
      if (action === 'trash') trashLoaded = false;
      selectedMessageIds = [];
      await refreshWorkspace();
      workspaceSync?.publish({ type: 'mailbox-refresh' });
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
    onLoading: (loading) => (mailboxLoading = loading),
    onError: () => notify(t('mail.listError'), 'error')
  });

  async function loadMoreMailbox() {
    if (activeSection === 'profile' || activeSection === 'trash') return;
    await mailboxController.loadMore(activeSection, searchQuery, mailFilter, mailboxPages?.[activeSection]);
  }

  function openCompose(mode: ComposeMode = 'new', initialInput: ComposeInput | null = null) {
    clearComposeAutosaveTimer();
    composeAutosave.reset();
    composeMode = mode;
    composeInitialInput = initialInput;
    composeDraftId = initialInput?.draftId;
    composeSubmissionId = crypto.randomUUID();
    composeLiveInput = initialInput ? { ...initialInput } : createEmptyComposeInput();
    composeTouched = false;
    composeAutosavePending = false;
    draftConflict = null;
    draftConflictLocalEditedAt = null;
    composeAutosaveStatus = initialInput?.draftId ? 'saved' : 'idle';
    composeAutosaveMessage = initialInput?.draftId
      ? t('compose.draftLoaded')
      : t('compose.autosaveIdle');
    composeLastSavedSignature = initialInput?.draftId ? serializeComposeInput(initialInput) : '';
    composeOpen = true;
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
        composeAutosaveMessage = displayError(error, t('compose.saveBeforeCloseFailed'));
        notify(composeAutosaveMessage, 'error');
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
        preferredMessageId: result.workspace.activePage.messages[0]?.id ?? null,
        clearMailView: true,
        resetUserScoped: true,
        syncUrl: true
      });
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
      await deleteSession();
      workspaceSync?.publish({ type: 'session-ended' });
      resetWorkspace();
      await goto(buildWorkspaceUrl(page.url, {
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
    } catch (error) {
      profileStatusError = true;
      profileStatus = displayError(error, t('notify.saveFailed'));
      notifyError(error, t('notify.profileSaveFailed'));
    } finally {
      pending = false;
    }
  }

  async function saveDraft(input: ComposeInput) {
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

    if (!liveInput || !composeOpen || draftConflict) {
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
    clearComposeAutosaveTimer();
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
          ? t('notify.draftSubmitted', { provider: result.message.deliveryProvider ?? t('notify.deliveryService'), email: result.message.toEmail })
          : result.message.deliveryResultKind === 'accepted'
            ? t('notify.deliverySubmitted', { email: result.message.toEmail, provider: result.message.deliveryProvider ?? t('notify.deliveryService') })
            : describeDeliveryState(result.message);
      const deliveryReceipt = result.message.deliveryResultKind === 'accepted' && result.message.deliveryProviderMessageId
        ? t('notify.providerMessageId', { id: result.message.deliveryProviderMessageId, date: formatDate(result.message.sentAt, i18n.locale, { dateStyle: 'medium', timeStyle: 'short' }) })
        : '';
      const deliveryTone: ToastTone = result.message.deliveryResultKind === 'accepted' ? 'success' : 'warning';
      resetComposeState();
      notify(`${deliveryMessage}${deliveryReceipt}`, deliveryTone, { persistent: deliveryTone === 'warning' });
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

  async function patchMessage(message: MailMessage, patch: MessagePatch, nextBanner?: string) {
    pending = true;

    try {
      const result = await updateMessageFlags(message.id, patch);

      const nextSection = activeSection === 'profile' ? message.folder : activeSection;
      applyMessageDelta(result, {
        section: nextSection === activeSection ? undefined : nextSection,
        preferredMessageId: result.message.id
      });

      if (nextBanner) {
        notify(nextBanner, 'success');
      }
      workspaceSync?.publish({ type: 'message-updated', id: result.message.id });
    } catch (error) {
      notifyError(error, t('notify.updateMessageFailed'));
    } finally {
      pending = false;
    }
  }

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
    selectedMessageId = message.id;
    mobileDetailOpen = true;
    updateWorkspaceUrl({ messageId: message.id });

    if (activeSection !== 'trash' && message.folder === 'inbox' && !message.read) {
      await patchMessage(message, { read: true });
    }

    if (isInboundMessageId(message.id)) {
      await loadInboundDetail(message);
    }
  }

  async function handleSelectThread(thread: MailThread) {
    await handleSelectMessage(thread.sectionLatestMessage);
  }

  function closeMobileDetail() {
    mobileDetailOpen = false;
    updateWorkspaceUrl({ messageId: null }, true);
  }

  function standaloneMessageHref(message: MailMessage) {
    if (message.folder === 'drafts') return null;
    const params = new URLSearchParams();
    for (const key of ['folder', 'q', 'filter']) {
      const value = page.url.searchParams.get(key);
      if (value) params.set(key, value);
    }
    params.set('message', message.id);
    const query = params.toString();
    return `/messages/${encodeURIComponent(message.id)}${query ? `?${query}` : ''}`;
  }

  function persistLayoutPreferences() {
    if (typeof localStorage === 'undefined') return;
    writeLayoutPreferences({ version: 1, sidebarCollapsed, listWidth, density }, localStorage);
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
    if (selectedMessage) readerOpen = true;
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
        result.metrics
      );
      mailbox = removed.snapshot.mailbox;
      mailboxPages = removed.snapshot.mailboxPages;
      metrics = removed.snapshot.metrics;
      runtimeOperationError = false;
      trashLoaded = false;
      selectedMessageId = removed.selectedMessageId;
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
              if (activeSection !== 'trash' && activeSection !== 'profile') await refreshWorkspace();
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
    try {
      const current = await fetchDraftDetail(message.id);
      openCompose('draft', composeInputFromSavedDraft(
        current.message,
        current.bodyRevision,
        current.attachments,
        current.attachmentRevision
      ));
      notify(t('notify.editingDraft'));
    } catch (error) {
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
    notify(t('notify.replying', { subject: message.subject }));
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
      replyTo: isInboundMessageId(message.id) ? inboundDetails[message.id]?.replyTo : undefined
    }, quotedBody));
    notify(t('notify.replyAll', { subject: message.subject }));
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
    notify(t('notify.forwarding', { subject: message.subject }));
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
    const layout = readLayoutPreferences(localStorage);
    sidebarCollapsed = layout.sidebarCollapsed;
    listWidth = layout.listWidth;
    density = layout.density;
    document.documentElement.dataset.density = density;
    workspaceSync = createWorkspaceSync(handleWorkspaceSync);

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
      window.removeEventListener(LOCALE_CHANGE_EVENT, handleLocaleChange);
      workspaceSync?.close();
      workspaceSync = null;
      stopListResize?.();
      document.body.classList.remove('fm-is-resizing');
      clearMailboxRefreshTimer();
      mailboxController.cancel();
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
      dbBound={data.dbBound}
      bucketBound={data.bucketBound}
      {loginError}
      {pending}
      {runtimeLabel}
      onLogin={handleLogin}
    />
  {:else}
    <div class="fm-app-shell">
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
          draftCount={metrics.draftsCount}
          inboxCount={metrics.inboxCount}
          trashCount={metrics.trashCount}
          {pending}
          onCompose={() => {
            openCompose('new');
            notify(t('notify.composeOpened'));
          }}
          onSelectSection={setSection}
        />
      </div>

      <div class:mobile-detail-mode={mobileDetailOpen} class="fm-workspace-body">
        <div class="fm-workspace-shell">
          <AppSidebar
            activeSection={activeSection}
            collapsed={sidebarCollapsed}
            draftCount={metrics.draftsCount}
            inboxCount={metrics.inboxCount}
            trashCount={metrics.trashCount}
            {pending}
            sentCount={metrics.sentCount}
            onCompose={() => {
              openCompose('new');
              notify(t('notify.composeOpened'));
            }}
            onSelectSection={setSection}
            onToggleCollapsed={toggleSidebar}
          />

          <main class="fm-workspace-main" aria-label={t('shell.mailWorkspace')}>
            {#if activeSection === 'profile'}
              <div class="h-full overflow-y-auto bg-fm-surface p-6 lg:p-8">
                <ProfilePane
                  {metrics}
                  {pending}
                  {profile}
                  {serviceDegraded}
                  diagnostics={data.runtimeDiagnostics}
                  status={profileStatus}
                  statusError={profileStatusError}
                  onSave={saveProfile}
                />
              </div>
            {:else}
              <div
                bind:this={workspaceElement}
                class:detail-open={mobileDetailOpen}
                class="mail-workspace"
                data-list-width-preference={listWidth}
                data-list-width-effective={effectiveListWidth}
                style={`--fm-list-width: ${effectiveListWidth}px`}
              >
                <section class="mail-list-panel" aria-label={t('mail.listLabel', { section: t('shell.mailNavigation') })}>
                  <FolderHeader
                    activeSection={activeSection}
                    count={searchQuery.trim() && activeSection !== 'trash'
                      ? mailboxPages?.[activeSection]?.searchTotal ?? 0
                      : activeSection === 'drafts' || activeSection === 'trash' ? activeMessages.length : activeThreads.length}
                    unreadCount={activeSection === 'inbox' ? unreadCount : 0}
                    query={searchQuery}
                    filter={mailFilter}
                    loading={activeSection === 'trash' ? trashLoading : mailboxLoading}
                    onQueryChange={handleSearchQueryChange}
                    onFilterChange={handleFilterChange}
                    onRefresh={refreshWorkspace}
                  />
                  {#if activeSection === 'trash'}
                    <div class="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--fm-border)] bg-[var(--fm-surface-subtle)] px-3 py-2">
                      <span class="text-xs text-[var(--fm-text-muted)]">{t('mail.trashRetention')}</span>
                      <button class="min-h-9 rounded-[var(--radius-md)] border border-[var(--fm-danger)]/40 px-2.5 text-xs font-medium text-[var(--fm-danger)] hover:bg-[var(--fm-danger-soft)]" type="button" disabled={pending || trashItems.length === 0} onclick={() => (emptyTrashConfirmOpen = true)}>{t('mail.emptyTrash')}</button>
                    </div>
                  {:else if activeSection !== 'drafts'}
                    <div class="bulk-toolbar" aria-label={t('mail.bulkActions')}>
                      <label class="bulk-select-control fm-touch-target" title={bulkAllSelected ? t('mail.clearSelection') : t('mail.selectPage')}>
                        <input
                          bind:this={bulkSelectInput}
                          type="checkbox"
                          checked={bulkAllSelected}
                          aria-label={bulkAllSelected ? t('mail.clearSelection') : t('mail.selectPage')}
                          aria-checked={bulkSomeSelected ? 'mixed' : bulkAllSelected ? 'true' : 'false'}
                          disabled={bulkSelectableIds.length === 0}
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
                          {#if activeSection === 'archive'}
                            <IconButton ariaLabel={t('mail.moveToInbox')} title={t('mail.moveToInbox')} size="sm" disabled={pending} onclick={() => void handleBulkMutation('unarchive')}><Inbox class="size-4" aria-hidden="true" /></IconButton>
                          {:else if activeSection === 'inbox'}
                            <IconButton ariaLabel={t('shell.archive')} title={t('shell.archive')} size="sm" disabled={pending} onclick={() => void handleBulkMutation('archive')}><Archive class="size-4" aria-hidden="true" /></IconButton>
                          {/if}
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
                        </div>
                      {/if}
                    </div>
                  {/if}
                  <MessageList
                    activeSection={activeSection}
                    messages={activeMessages}
                    selectedThreadId={selectedThreadId}
                    threads={activeThreads}
                    {selectedMessageId}
                    query={searchQuery}
                    filter={mailFilter}
                    loading={activeSection === 'trash' ? trashLoading : mailboxLoading}
                    error={activeSection === 'trash' ? trashError : ''}
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
                    selectedMessageIds={selectedMessageIds}
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
                    onRemove={handleDeleteMessage}
                    onSelectThreadMessage={handleSelectMessage}
                    onToggleRead={handleToggleRead}
                    onToggleStar={handleToggleStar}
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
      <ReaderDialog id="reader-dialog" open showHeader={false} title={selectedMessage.subject || t('mail.noSubject')} onClose={() => (readerOpen = false)}>
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
          onRemove={handleDeleteMessage}
          onSelectThreadMessage={handleSelectMessage}
          onToggleRead={handleToggleRead}
          onToggleStar={handleToggleStar}
          onCloseReader={() => (readerOpen = false)}
          bodyView={selectedBodyView}
          allowRemoteImages={selectedRemoteImagesAllowed}
          readerMode
          onBodyViewChange={(view) => { if (selectedMessage) bodyViewByMessage[selectedMessage.id] = view; }}
          onRemoteImagesChange={(allowed) => { remoteImagesMessageId = allowed ? selectedMessage.id : null; }}
        />
      </ReaderDialog>
    {/if}

    {#if composeOpen}
      <ComposeModal
        autosaveMessage={composeAutosaveMessage}
        autosaveStatus={composeAutosaveStatus}
        draftId={composeDraftId}
        expectedUpdatedAt={composeLiveInput?.expectedUpdatedAt}
        bodyRevision={composeLiveInput ? composeLiveInput.bodyRevision ?? null : undefined}
        initialInput={composeInitialInput}
        mode={composeMode}
        pending={composeBusy}
        {profile}
        senderEmail={outboundSenderEmail}
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
    {/if}

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

  <ToastRegion
    messages={toastMessages}
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
    height: 100%;
    min-width: 0;
  }

  .mail-list-panel {
    display: flex;
    min-width: 0;
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
    background: var(--fm-surface-subtle);
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

  @media (max-width: 900px) {
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
