<script lang="ts">
  import { goto, pushState, replaceState } from '$app/navigation';
  import { page } from '$app/state';
  import { onMount, untrack } from 'svelte';
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
  import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte';
  import ToastRegion from '$lib/components/ui/ToastRegion.svelte';
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
  import {
    createSession,
    deleteMessage,
    deleteSession,
    emptyTrash,
    fetchDeliveryDetail,
    fetchDraftDetail,
    fetchInboundDetail,
    fetchMailboxPage,
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
  const serverWorkspace = $derived(data.workspace);

  const runtimeLabel = $derived(
    data.runtimeState.state === 'ready'
      ? data.dbBound && data.bucketBound
        ? '运行依赖已就绪'
        : '开发绑定'
      : data.runtimeState.state === 'unauthenticated'
        ? '等待登录'
        : '服务不可用'
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
  let searchQuery = $state('');
  let mailFilter = $state<MailFilter>('all');
  let mobileDetailOpen = $state(false);
  let shortcutHelpOpen = $state(false);
  let composeOpen = $state(false);
  let composeMode = $state<ComposeMode>('new');
  let composeInitialInput = $state<ComposeInput | null>(null);
  let composeDraftId = $state<string | undefined>(undefined);
  let composeSubmissionId = $state<string | undefined>(undefined);
  let composeLiveInput = $state<ComposeInput | null>(null);
  let composeTouched = $state(false);
  let composeAutosavePending = $state(false);
  let composeClosePending = $state(false);
  let composeAutosaveStatus = $state<ComposeAutosaveStatus>('idle');
  let composeAutosaveMessage = $state('自动保存会在停顿后触发。');
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
  let pending = $state(false);
  let mailboxLoading = $state(false);
  let mailboxRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  let composeSavePromise: Promise<void> | null = null;
  const composeAutosave = new ComposeAutosaveController();
  const inboundDetailCache = new DetailCacheController<InboundMessageDetail>('加载原始邮件失败。', (snapshot) => {
    inboundDetails = snapshot.values;
    inboundDetailErrors = snapshot.errors;
    inboundDetailPendingId = snapshot.pendingId;
  });
  const deliveryDetailCache = new DetailCacheController<DeliveryDetail>('加载投递回执失败。', (snapshot) => {
    deliveryDetails = snapshot.values;
    deliveryDetailErrors = snapshot.errors;
    deliveryDetailPendingId = snapshot.pendingId;
  });
  const workspaceBodyCache = new DetailCacheController<WorkspaceBodyDetail>('加载邮件正文失败。', (snapshot) => {
    workspaceBodies = snapshot.values;
    workspaceBodyErrors = snapshot.errors;
    workspaceBodyPendingId = snapshot.pendingId;
  });
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
    onError: (message) => {
      trashLoaded = true;
      trashError = message;
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
      error instanceof Error ? error.message : fallback,
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
          notify('工作台已从服务端恢复。你可以直接继续读信、保存草稿或发送邮件。', 'success');
        }
      });
    }
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
  const selectedThread = $derived.by(() => {
    if (activeSection === 'drafts' || activeSection === 'trash' || activeSection === 'profile') {
      return null;
    }

    const threads = visibleThreads;

    if (!threads.length) {
      return null;
    }

    return threads.find((thread) => thread.messages.some((message) => message.id === selectedMessageId)) ?? threads[0];
  });
  const selectedThreadId = $derived(selectedThread?.id ?? null);
  const selectedMessage = $derived.by(() => {
    if (activeSection === 'drafts' || activeSection === 'trash') {
      const list = visibleMessages;

      if (!list.length) {
        return null;
      }

      return list.find((message) => message.id === selectedMessageId) ?? list[0];
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
    composeAutosaveMessage = '自动保存会在停顿后触发。';
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
      ? `邮件已提交到 ${message.deliveryProvider ?? '投递服务'}。`
      : message.deliveryResultKind === 'queued'
        ? `邮件已进入发送队列，等待投递到 ${message.toEmail}。`
        : message.deliveryResultKind === 'temporary_failure'
          ? `投递服务暂时不可用，已保留重试入口：${message.deliveryError ?? '请稍后重试。'}`
          : message.deliveryResultKind === 'rate_limited'
            ? `投递服务触发限流，这封邮件暂时未发出：${message.deliveryError ?? '请稍后重试。'}`
            : `邮件已写入已发送，但投递失败：${message.deliveryError ?? '请稍后重试。'}`;

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

  async function refreshWorkspace() {
    if (activeSection === 'trash') {
      const refreshed = await trashController.load();
      if (refreshed) {
        runtimeOperationError = false;
        notify('垃圾箱已刷新。', 'success');
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
      notify('邮件列表已刷新。', 'success');
    }
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
    const ids = activeSection === 'drafts' || activeSection === 'trash' || activeSection === 'profile'
      ? []
      : visibleThreads.length
        ? visibleThreads.map((thread) => thread.sectionLatestMessage.id)
        : visibleMessages.map((message) => message.id);
    selectedMessageIds = selectedMessageIds.length === ids.length ? [] : ids.slice(0, 100);
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
      notify(
        action === 'archive'
          ? '已归档所选邮件。'
          : action === 'unarchive'
            ? '已将所选邮件移回收件箱。'
            : action === 'trash'
              ? '已将所选会话移入垃圾箱。'
            : '已更新所选邮件状态。',
        'success'
      );
    } catch (error) {
      notifyError(error, '批量更新邮件失败。');
    } finally {
      pending = false;
    }
  }

  const mailboxController = new MailboxController(fetchMailboxPage, {
    onPage: (page, append) => applyMailboxPage(page, append),
    onLoading: (loading) => (mailboxLoading = loading),
    onError: (message) => notify(message, 'error')
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
      ? '草稿内容已载入，继续编辑后会自动保存。'
      : '自动保存会在停顿后触发。';
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
      composeAutosaveMessage = '正在关闭前保存草稿...';
      const save = composeAutosave.sequence.begin();
      try {
        const result = await persistDraft(input);
        if (!save.isActive()) return;
        applyMessageDelta(result);
        savedBeforeClose = true;
        if (save.isCurrent()) {
          syncComposeDraftState(
            result.message,
            `离开前已保存草稿于 ${formatComposeSavedAt(result.message.sentAt)}。`,
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
        composeAutosaveMessage = error instanceof Error ? error.message : '关闭前自动保存失败。';
        notify(composeAutosaveMessage, 'error');
        composeClosePending = false;
        return;
      } finally {
        if (save.isActive()) composeAutosavePending = false;
      }
    }

    resetComposeState();
    notify(savedBeforeClose ? '未完成内容已保存为草稿。' : '已关闭写信面板。', savedBeforeClose ? 'success' : 'info');
  }

  function discardCompose() {
    resetComposeState();
    notify('已放弃本次未保存的改动。', 'warning');
  }

  async function handleLogin(payload: LoginInput) {
    pending = true;
    loginError = '';

    try {
      const result = await createSession(payload);

      if (!result.workspace) {
        throw new Error('登录后未返回工作区数据。');
      }

      applyWorkspaceSnapshot(result.workspace, {
        section: 'inbox',
        preferredMessageId: result.workspace.activePage.messages[0]?.id ?? null,
        clearMailView: true,
        resetUserScoped: true,
        syncUrl: true
      });
      notify('已进入工作台。当前会话由 Cookie、SvelteKit API 和 D1 状态驱动。', 'success');
    } catch (error) {
      loginError = error instanceof Error ? error.message : '登录失败。';
      notifyError(error, '登录失败。');
    } finally {
      pending = false;
    }
  }

  async function handleLogout() {
    pending = true;

    try {
      await deleteSession();
      resetWorkspace();
      await goto(buildWorkspaceUrl(page.url, {
        section: 'inbox', query: '', filter: 'all', messageId: null
      }), { replaceState: true, noScroll: true, keepFocus: false });
      notify('你已退出工作台。', 'success');
    } catch (error) {
      notifyError(error, '退出失败。');
    } finally {
      pending = false;
    }
  }

  async function saveProfile(nextProfile: UserProfile) {
    pending = true;
    profileStatus = '';

    try {
      const result = await updateProfile(nextProfile);

      profile = result.profile ?? profile;
      metrics = result.metrics ?? metrics;
      runtimeOperationError = false;
      profileStatus = '个人资料已保存到工作区。';
      notify('个人信息已更新，写信时会自动使用新的身份与签名。', 'success');
    } catch (error) {
      profileStatus = error instanceof Error ? error.message : '保存失败。';
      notifyError(error, '保存个人信息失败。');
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
      notify((input.draftId ?? composeDraftId) ? '草稿已更新。' : '草稿已保存到工作区。', 'success');
    } catch (error) {
      const conflict = draftConflictFromError(error);
      if (conflict) {
        draftConflict = conflict;
        draftConflictLocalEditedAt = new Date().toISOString();
        composeAutosaveStatus = 'error';
        composeAutosaveMessage = '服务器版本已更新，请选择如何处理冲突。';
      }
      notifyError(error, '保存草稿失败。');
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
    composeAutosaveMessage = '正在自动保存草稿...';
    const save = composeAutosave.sequence.begin();

    try {
      const result = await persistDraft(input);

      if (!save.isActive()) return;
      applyMessageDelta(result);
      if (save.isCurrent()) {
        syncComposeDraftState(
          result.message,
          `已自动保存于 ${formatComposeSavedAt(result.message.sentAt)}。`,
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
        composeAutosaveMessage = '较早改动已保存，正在等待保存最新内容。';
      }
    } catch (error) {
      if (save.isActive()) {
        const conflict = draftConflictFromError(error);
        if (conflict) {
          draftConflict = conflict;
          draftConflictLocalEditedAt = new Date().toISOString();
        }
        composeAutosaveStatus = 'error';
        composeAutosaveMessage = error instanceof Error ? error.message : '自动保存失败。';
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
    composeAutosaveMessage = '正在保存草稿并准备附件上传...';
    try {
      const result = await persistDraft(withCurrentComposePersistence(input));
      applyMessageDelta(result);
      syncComposeDraftState(
        result.message,
        `草稿已准备好接收附件。`,
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
      composeAutosaveMessage = error instanceof Error ? error.message : '准备附件上传失败。';
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
          ? `草稿已提交到 ${result.message.deliveryProvider ?? '投递服务'}，目标 ${result.message.toEmail}。`
          : result.message.deliveryResultKind === 'accepted'
            ? `已向 ${result.message.toEmail} 发起投递，并提交到 ${result.message.deliveryProvider ?? '投递服务'}。`
            : describeDeliveryState(result.message);
      const deliveryReceipt = result.message.deliveryResultKind === 'accepted' && result.message.deliveryProviderMessageId
        ? ` Resend message id ${result.message.deliveryProviderMessageId}，发送时间 ${new Date(result.message.sentAt).toLocaleString('zh-CN')}。`
        : '';
      const deliveryTone: ToastTone = result.message.deliveryResultKind === 'accepted' ? 'success' : 'warning';
      resetComposeState();
      notify(`${deliveryMessage}${deliveryReceipt}`, deliveryTone, { persistent: deliveryTone === 'warning' });
    } catch (error) {
      notifyError(error, '发送失败。');
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
          ? `《${result.message.subject}》已重新提交到 ${result.message.deliveryProvider ?? '投递服务'}。`
          : result.message.deliveryResultKind === 'queued'
            ? `《${result.message.subject}》仍在发送队列中。`
            : result.message.deliveryResultKind === 'temporary_failure'
              ? `《${result.message.subject}》重试后仍需等待：${result.message.deliveryError ?? '请稍后重试。'}`
              : result.message.deliveryResultKind === 'rate_limited'
                ? `《${result.message.subject}》被投递服务限流，请稍后再试。`
                : `《${result.message.subject}》再次投递失败：${result.message.deliveryError ?? '请稍后重试。'}`;
      const deliveryTone: ToastTone = result.message.deliveryResultKind === 'accepted' ? 'success' : 'warning';
      notify(deliveryMessage, deliveryTone, { persistent: deliveryTone === 'warning' });
    } catch (error) {
      notifyError(error, '重试投递失败。');
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
    } catch (error) {
      notifyError(error, '更新邮件状态失败。');
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
      syncComposeDraftState(message, '已载入服务器版本。', bodyRevision, attachments, attachmentRevision);
      draftConflict = null;
      draftConflictLocalEditedAt = null;
    } catch (error) {
      notifyError(error, '载入服务器草稿失败。');
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

  async function handleToggleStar(message: MailMessage) {
    await patchMessage(
      message,
      { starred: !message.starred },
      message.starred ? '已取消星标。' : '已加入星标邮件。'
    );
  }

  async function handleToggleRead(message: MailMessage) {
    if (message.folder !== 'inbox') {
      return;
    }

    await patchMessage(
      message,
      { read: !message.read },
      message.read ? '邮件已标记为未读。' : '邮件已标记为已读。'
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

      notify(
        '已移入垃圾箱。',
        'warning',
        {
          timeoutMs: 8_000,
          action: {
            label: '撤销',
            run: async () => {
              const restored = await restoreTrashItem(result.removedId);
              metrics = restored.metrics;
              trashLoaded = false;
              if (activeSection !== 'trash' && activeSection !== 'profile') await refreshWorkspace();
              notify('已撤销移入垃圾箱。', 'success');
            }
          }
        }
      );
    } catch (error) {
      notifyError(error, '删除邮件失败。');
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
      notify(`已恢复到${result.originalFolder === 'archive' ? '归档' : result.originalFolder === 'sent' ? '已发送' : result.originalFolder === 'drafts' ? '草稿箱' : '收件箱'}。`, 'success');
    } catch (error) {
      notifyError(error, '恢复垃圾箱项目失败。');
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
      notify(
        result.cleanupPending ? '项目已永久删除；对象存储清理将在维护任务中重试。' : '项目已永久删除。',
        'warning',
        { persistent: Boolean(result.cleanupPending) }
      );
    } catch (error) {
      notifyError(error, '永久删除失败。');
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
      notify(`已永久删除 ${result.deleted} 个垃圾箱项目。`, 'warning');
    } catch (error) {
      notifyError(error, '清空垃圾箱失败。');
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
      notify('你正在继续编辑一封草稿。');
    } catch (error) {
      notifyError(error, '载入草稿失败。');
    }
  }

  async function handleReplyMessage(message: MailMessage) {
    if (isInboundMessageId(message.id) && !inboundDetails[message.id]) {
      if (!(await loadInboundDetail(message)) || !inboundDetails[message.id]) {
        notify('正文尚未载入，暂时无法引用回复。', 'error');
        return;
      }
    }
    if (!isInboundMessageId(message.id) && !workspaceBodies[message.id]) {
      if (!(await loadWorkspaceBody(message)) || !workspaceBodies[message.id]) {
        notify('正文尚未载入，暂时无法引用回复。', 'error');
        return;
      }
    }
    const quotedBody = isInboundMessageId(message.id)
      ? inboundDetails[message.id]?.body ?? ''
      : workspaceBodies[message.id]?.body ?? message.body;

    openCompose('reply', createReplyComposeInput(replySource(message), quotedBody, {
      replyTo: isInboundMessageId(message.id) ? inboundDetails[message.id]?.replyTo : undefined
    }));
    notify(`正在回复《${message.subject}》。`);
  }

  async function handleReplyAllMessage(message: MailMessage) {
    if (isInboundMessageId(message.id) && !inboundDetails[message.id]) {
      if (!(await loadInboundDetail(message)) || !inboundDetails[message.id]) {
        notify('正文尚未载入，暂时无法引用回复。', 'error');
        return;
      }
    }
    if (!isInboundMessageId(message.id) && !workspaceBodies[message.id]) {
      if (!(await loadWorkspaceBody(message)) || !workspaceBodies[message.id]) {
        notify('正文尚未载入，暂时无法引用回复。', 'error');
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
    notify(`正在回复《${message.subject}》中的所有收件人。`);
  }

  async function handleForwardMessage(message: MailMessage) {
    if (isInboundMessageId(message.id) && !inboundDetails[message.id]) {
      if (!(await loadInboundDetail(message)) || !inboundDetails[message.id]) {
        notify('正文尚未载入，暂时无法引用转发。', 'error');
        return;
      }
    }
    if (!isInboundMessageId(message.id) && !workspaceBodies[message.id]) {
      if (!(await loadWorkspaceBody(message)) || !workspaceBodies[message.id]) {
        notify('正文尚未载入，暂时无法引用转发。', 'error');
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
    notify(`正在转发《${message.subject}》。`);
  }

  function handleReportHtmlIssue() {
    notify('显示问题报告已下载；文件只包含本地显示环境，不含邮件正文或地址。', 'success');
  }

  async function handleReloadInboundDetail(message: MailMessage) {
    const ok = await loadInboundDetail(message, true);
    notify(
      ok ? `已重新载入《${message.subject}》的原始邮件详情。` : '重新载入原始邮件失败。',
      ok ? 'success' : 'error'
    );
  }

  async function handleReloadDeliveryDetail(message: MailMessage) {
    const ok = await loadDeliveryDetail(message, true);
    notify(
      ok ? `已重新载入《${message.subject}》的投递回执。` : '重新载入投递回执失败。',
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

  onMount(() => {
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
    return () => {
      document.removeEventListener('keydown', handleShortcut);
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
    content="FlareMail 邮件工作台，覆盖收件箱、已发送、草稿、投递状态与安全写信流程。"
  />
</svelte:head>

<div class="fm-app-shell">
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
        onEditProfile={() => {
          setSection('profile');
          notify('已打开设置。');
        }}
        onLogout={handleLogout}
        onSearch={() => {
          window.dispatchEvent(new CustomEvent('flaremail:focus-search'));
        }}
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
            notify('正在写新邮件。');
          }}
          onSelectSection={setSection}
        />
      </div>

      <div class:mobile-detail-mode={mobileDetailOpen} class="fm-workspace-body">
        <div class="fm-workspace-shell">
          <AppSidebar
            activeSection={activeSection}
            draftCount={metrics.draftsCount}
            inboxCount={metrics.inboxCount}
            trashCount={metrics.trashCount}
            {pending}
            sentCount={metrics.sentCount}
            onCompose={() => {
              openCompose('new');
              notify('正在写新邮件。');
            }}
            onSelectSection={setSection}
          />

          <main class="fm-workspace-main" aria-label="邮件工作区">
            {#if activeSection === 'profile'}
              <div class="h-full overflow-y-auto bg-fm-surface p-6 lg:p-8">
                <ProfilePane
                  {metrics}
                  {pending}
                  {profile}
                  {serviceDegraded}
                  diagnostics={data.runtimeDiagnostics}
                  status={profileStatus}
                  onSave={saveProfile}
                />
              </div>
            {:else}
              <div class:detail-open={mobileDetailOpen} class="mail-workspace">
                <section class="mail-list-panel" aria-label="邮件列表">
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
                      <span class="text-xs text-[var(--fm-text-muted)]">项目保留至手动删除；维护任务默认只报告超过 30 天的项目。</span>
                      <button class="min-h-9 rounded-[var(--radius-md)] border border-[var(--fm-danger)]/40 px-2.5 text-xs font-medium text-[var(--fm-danger)] hover:bg-[var(--fm-danger-soft)]" type="button" disabled={pending || trashItems.length === 0} onclick={() => (emptyTrashConfirmOpen = true)}>清空垃圾箱</button>
                    </div>
                  {:else if activeSection !== 'drafts'}
                    <div class="flex flex-wrap items-center gap-2 border-b border-[var(--fm-border)] bg-[var(--fm-surface-subtle)] px-3 py-2" aria-label="批量邮件操作">
                      <button class="min-h-9 rounded-[var(--radius-md)] border border-[var(--fm-border)] px-2.5 text-xs font-medium text-[var(--fm-text-secondary)] hover:bg-[var(--fm-surface-hover)]" type="button" onclick={selectAllVisible}>
                        {selectedMessageIds.length ? '取消选择' : '选择当前页'}
                      </button>
                      {#if selectedMessageIds.length > 0}
                        {#if activeSection === 'archive'}
                          <button class="min-h-9 rounded-[var(--radius-md)] border border-[var(--fm-border)] px-2.5 text-xs font-medium text-[var(--fm-text-secondary)] hover:bg-[var(--fm-surface-hover)]" type="button" disabled={pending} onclick={() => void handleBulkMutation('unarchive')}>移回收件箱</button>
                        {:else if activeSection === 'inbox'}
                          <button class="min-h-9 rounded-[var(--radius-md)] border border-[var(--fm-border)] px-2.5 text-xs font-medium text-[var(--fm-text-secondary)] hover:bg-[var(--fm-surface-hover)]" type="button" disabled={pending} onclick={() => void handleBulkMutation('archive')}>归档</button>
                        {/if}
                        <button class="min-h-9 rounded-[var(--radius-md)] border border-[var(--fm-border)] px-2.5 text-xs font-medium text-[var(--fm-text-secondary)] hover:bg-[var(--fm-surface-hover)]" type="button" disabled={pending} onclick={() => void handleBulkMutation('read')}>标记已读</button>
                        <button class="min-h-9 rounded-[var(--radius-md)] border border-[var(--fm-border)] px-2.5 text-xs font-medium text-[var(--fm-text-secondary)] hover:bg-[var(--fm-surface-hover)]" type="button" disabled={pending} onclick={() => void handleBulkMutation('unread')}>标记未读</button>
                        <button class="min-h-9 rounded-[var(--radius-md)] border border-[var(--fm-border)] px-2.5 text-xs font-medium text-[var(--fm-text-secondary)] hover:bg-[var(--fm-surface-hover)]" type="button" disabled={pending} onclick={() => void handleBulkMutation('star')}>加星标</button>
                        <button class="min-h-9 rounded-[var(--radius-md)] border border-[var(--fm-border)] px-2.5 text-xs font-medium text-[var(--fm-text-secondary)] hover:bg-[var(--fm-surface-hover)]" type="button" disabled={pending} onclick={() => void handleBulkMutation('unstar')}>取消星标</button>
                        <button class="min-h-9 rounded-[var(--radius-md)] border border-[var(--fm-danger)]/40 px-2.5 text-xs font-medium text-[var(--fm-danger)] hover:bg-[var(--fm-danger-soft)]" type="button" disabled={pending} onclick={() => void handleBulkMutation('trash')}>移入垃圾箱</button>
                        <span class="text-xs text-[var(--fm-text-muted)]">已选 {selectedMessageIds.length} 封</span>
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
                <section class="mail-detail-panel" aria-label="邮件详情">
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
                  />
                </section>
              </div>
            {/if}
          </main>
        </div>

      </div>
    </div>

    {#if composeOpen}
      <ComposeModal
        autosaveMessage={composeAutosaveMessage}
        autosaveStatus={composeAutosaveStatus}
        draftId={composeDraftId}
        expectedUpdatedAt={composeLiveInput?.expectedUpdatedAt}
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
            composeAutosaveMessage = '自动保存会在停顿后触发。';
            return;
          }

          if (nextSignature === composeLastSavedSignature) {
            composeAutosaveStatus = 'saved';
            return;
          }

          composeAutosaveStatus = 'dirty';
          composeAutosaveMessage = '检测到未保存改动，正在等待自动保存。';
        }}
        onSaveDraft={saveDraft}
        onSend={sendMessage}
      />
    {/if}

    <Dialog
      open={shortcutHelpOpen}
      title="键盘快捷键"
      description="在输入框和正文编辑器中，单键快捷键会自动停用。"
      onClose={() => (shortcutHelpOpen = false)}
    >
      <dl class="shortcut-grid">
        <div><dt><kbd>/</kbd></dt><dd>聚焦邮件搜索</dd></div>
        <div><dt><kbd>C</kbd></dt><dd>写邮件</dd></div>
        <div><dt><kbd>G</kbd> <kbd>I</kbd></dt><dd>前往收件箱</dd></div>
        <div><dt><kbd>G</kbd> <kbd>S</kbd></dt><dd>前往已发送</dd></div>
        <div><dt><kbd>G</kbd> <kbd>D</kbd></dt><dd>前往草稿箱</dd></div>
        <div><dt><kbd>J</kbd> / <kbd>K</kbd></dt><dd>下一封 / 上一封</dd></div>
        <div><dt><kbd>R</kbd></dt><dd>回复当前邮件</dd></div>
        <div><dt><kbd>A</kbd></dt><dd>回复全部（有其他收件人时）</dd></div>
        <div><dt><kbd>F</kbd></dt><dd>转发当前邮件</dd></div>
        <div><dt><kbd>Esc</kbd></dt><dd>关闭面板或返回列表</dd></div>
        <div><dt><kbd>?</kbd></dt><dd>打开快捷键帮助</dd></div>
      </dl>
    </Dialog>

    <ConfirmDialog
      open={emptyTrashConfirmOpen}
      title="永久清空垃圾箱？"
      description="垃圾箱中的邮件、草稿、正文和附件会被永久删除，且无法恢复。"
      confirmLabel="永久清空"
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
    display: flex;
    height: 100%;
    min-width: 0;
  }

  .mail-list-panel {
    display: flex;
    width: 392px;
    min-width: 0;
    flex: none;
    flex-direction: column;
    border-right: 1px solid var(--fm-border);
    background: var(--fm-surface);
  }

  .mail-detail-panel {
    min-width: 520px;
    flex: 1;
    background: var(--fm-surface);
  }

  @media (max-width: 1279px) {
    .mail-list-panel,
    .mail-detail-panel {
      width: 100%;
      min-width: 0;
      border-right: 0;
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
