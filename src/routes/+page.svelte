<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { onMount } from 'svelte';
  import type { PageData } from './$types';
  import ComposeModal from '$lib/components/mail/ComposeModal.svelte';
  import FolderHeader from '$lib/components/mail/FolderHeader.svelte';
  import LoginView from '$lib/components/mail/LoginView.svelte';
  import MessageDetail from '$lib/components/mail/MessageDetail.svelte';
  import MessageList from '$lib/components/mail/MessageList.svelte';
  import ProfilePane from '$lib/components/mail/ProfilePane.svelte';
  import AppSidebar from '$lib/components/shell/AppSidebar.svelte';
  import AppTopbar from '$lib/components/shell/AppTopbar.svelte';
  import MobileNavigation from '$lib/components/shell/MobileNavigation.svelte';
  import Dialog from '$lib/components/ui/Dialog.svelte';
  import { requestJson } from '$lib/client/api';
  import { LatestRequest } from '$lib/client/latest-request';
  import {
    buildMailThreads,
    cloneMailbox,
    cloneProfile,
    createComposeInputFromDraft,
    createForwardComposeInput,
    createReplyComposeInput,
    type DeliveryDetail,
    isInboundMessageId,
    type ComposeInput,
    type ComposeMode,
    type InboundMessageDetail,
    type LoginInput,
    type MailFolder,
    type MailMessage,
    type MailboxState,
    type MailboxPage,
    type MailThread,
    type MessagePatch,
    type UserProfile,
    type WorkspacePayload
  } from '$lib/domain/mail';

  type AppSection = MailFolder | 'profile';
  type MailFilter = 'all' | 'unread' | 'starred';

  type SessionResponse = {
    ok: boolean;
    authenticated: boolean;
    workspace: WorkspacePayload | null;
    error?: string;
  };

  type WorkspaceResponse = {
    ok: boolean;
    workspace: WorkspacePayload;
    error?: string;
  };

  type MailboxPageResponse = { page: MailboxPage };

  type MessageResponse = WorkspaceResponse & {
    message: MailMessage;
  };

  type DeleteResponse = WorkspaceResponse & {
    folder: MailFolder;
  };

  type InboundDetailResponse = {
    ok: boolean;
    detail: InboundMessageDetail;
    error?: string;
  };

  type DeliveryDetailResponse = {
    ok: boolean;
    detail: DeliveryDetail;
    error?: string;
  };

  type ComposeAutosaveStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

  let { data }: { data: PageData } = $props();
  const serverWorkspace = $derived(data.workspace);

  const runtimeLabel = $derived(data.dbBound && data.bucketBound ? 'Cloudflare 绑定在线' : '模拟模式');

  let authenticated = $state(false);
  let profile = $state<UserProfile>(cloneProfile());
  let mailbox = $state<MailboxState>(cloneMailbox());
  let mailboxPages = $state<Record<MailFolder, MailboxPage> | null>(null);
  let activeSection = $state<AppSection>('inbox');
  let selectedMessageId = $state<string | null>(null);
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
  let composeAutosaveStatus = $state<ComposeAutosaveStatus>('idle');
  let composeAutosaveMessage = $state('自动保存会在停顿后触发。');
  let composeLastSavedSignature = $state('');
  let inboundDetails = $state<Record<string, InboundMessageDetail>>({});
  let deliveryDetails = $state<Record<string, DeliveryDetail>>({});
  let inboundDetailErrors = $state<Record<string, string>>({});
  let deliveryDetailErrors = $state<Record<string, string>>({});
  let inboundDetailPendingId = $state<string | null>(null);
  let deliveryDetailPendingId = $state<string | null>(null);
  let banner = $state('工作台已准备就绪，当前列表只展示真实写入或当前会话产生的数据。');
  let loginError = $state('');
  let profileStatus = $state('');
  let pending = $state(false);
  let mailboxLoading = $state(false);
  let hydratedFromServer = $state(false);
  let appliedServerWorkspace = $state<WorkspacePayload | null>(null);
  const mailboxRequest = new LatestRequest();
  const inboundDetailRequest = new LatestRequest();
  const deliveryDetailRequest = new LatestRequest();
  let composeAutosaveTimer: ReturnType<typeof setTimeout> | null = null;
  let shortcutPrefix = '';
  let shortcutPrefixTimer: ReturnType<typeof setTimeout> | null = null;

  const urlSection = $derived.by<AppSection>(() => {
    const folder = page.url.searchParams.get('folder');
    return folder === 'sent' || folder === 'drafts'
      ? folder
      : folder === 'settings'
        ? 'profile'
        : 'inbox';
  });
  const urlQuery = $derived(page.url.searchParams.get('q')?.slice(0, 200) ?? '');
  const urlFilter = $derived.by<MailFilter>(() => {
    const filter = page.url.searchParams.get('filter');
    return filter === 'unread' || filter === 'starred' ? filter : 'all';
  });
  const urlMessageId = $derived(page.url.searchParams.get('message'));

  $effect(() => {
    activeSection = urlSection;
    searchQuery = urlQuery;
    mailFilter = urlFilter;
    selectedMessageId = urlMessageId;
    mobileDetailOpen = Boolean(urlMessageId);
  });

  $effect(() => {
    if (serverWorkspace && appliedServerWorkspace !== serverWorkspace) {
      authenticated = true;
      profile = serverWorkspace.profile;
      mailbox = serverWorkspace.mailbox;
      mailboxPages = data.mailboxPages;
      selectedMessageId = urlMessageId ?? nextSelection(serverWorkspace.mailbox, urlSection, null);
      if (!hydratedFromServer) {
        banner = '工作台已从服务端恢复。你可以直接继续读信、保存草稿或发送邮件。';
      }
      hydratedFromServer = true;
      appliedServerWorkspace = serverWorkspace;
    }
  });

  const unreadCount = $derived(mailbox.inbox.filter((message) => !message.read).length);
  const queuedCount = $derived(
    mailbox.sent.filter((message) => message.deliveryStatus === 'queued').length
  );
  const failedCount = $derived(
    mailbox.sent.filter((message) => message.deliveryStatus === 'failed').length
  );
  const activeMessages = $derived(
    activeSection === 'drafts' ? mailbox.drafts : []
  );
  const activeThreads = $derived(
    activeSection === 'inbox' || activeSection === 'sent' ? buildMailThreads(mailbox, activeSection) : []
  );
  const normalizedSearchQuery = $derived(searchQuery.trim().toLocaleLowerCase('zh-CN'));
  const visibleMessages = $derived.by(() =>
    activeMessages.filter((message) => {
      const matchesQuery =
        !normalizedSearchQuery ||
        [message.toName, message.toEmail, message.subject, message.preview]
          .join('\n')
          .toLocaleLowerCase('zh-CN')
          .includes(normalizedSearchQuery);
      const matchesFilter =
        mailFilter === 'all' ||
        (mailFilter === 'unread' && !message.read) ||
        (mailFilter === 'starred' && message.starred);
      return matchesQuery && matchesFilter;
    })
  );
  const visibleThreads = $derived.by(() =>
    activeThreads.filter((thread) => {
      const matchesQuery =
        !normalizedSearchQuery ||
        [thread.counterpartLabel, thread.subject, thread.preview]
          .join('\n')
          .toLocaleLowerCase('zh-CN')
          .includes(normalizedSearchQuery);
      const matchesFilter =
        mailFilter === 'all' ||
        (mailFilter === 'unread' && thread.unreadCount > 0) ||
        (mailFilter === 'starred' && thread.messages.some((message) => message.starred));
      return matchesQuery && matchesFilter;
    })
  );
  const selectedThread = $derived.by(() => {
    if (activeSection === 'drafts' || activeSection === 'profile') {
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
    if (activeSection === 'drafts') {
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
  const composeBusy = $derived(pending || composeAutosavePending);

  const createEmptyComposeInput = (): ComposeInput => ({
    toEmail: '',
    cc: '',
    subject: '',
    body: ''
  });

  const serializeComposeInput = (input: ComposeInput | null) => {
    if (!input) {
      return '';
    }

    return JSON.stringify({
      draftId: input.draftId?.trim() || null,
      toEmail: input.toEmail.trim(),
      cc: (input.cc ?? '').trim(),
      subject: input.subject,
      body: input.body,
      messageId: input.messageId ?? null,
      inReplyTo: input.inReplyTo ?? null,
      references: input.references ?? null
    });
  };

  const withComposeDraftId = (input: ComposeInput) => ({
    ...input,
    draftId: composeDraftId ?? input.draftId
  });

  const hasComposeContent = (input: ComposeInput | null) =>
    Boolean(
      input &&
        (input.toEmail.trim() || (input.cc ?? '').trim() || input.subject.trim() || input.body.trim())
    );

  const formatComposeSavedAt = (value: string) =>
    new Intl.DateTimeFormat('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).format(new Date(value));

  const clearComposeAutosaveTimer = () => {
    if (composeAutosaveTimer) {
      clearTimeout(composeAutosaveTimer);
      composeAutosaveTimer = null;
    }
  };

  const resetComposeState = () => {
    clearComposeAutosaveTimer();
    composeOpen = false;
    composeMode = 'new';
    composeInitialInput = null;
    composeDraftId = undefined;
    composeSubmissionId = undefined;
    composeLiveInput = null;
    composeTouched = false;
    composeAutosavePending = false;
    composeAutosaveStatus = 'idle';
    composeAutosaveMessage = '自动保存会在停顿后触发。';
    composeLastSavedSignature = '';
  };

  const syncComposeDraftState = (message: MailMessage, statusMessage: string) => {
    const nextInput = {
      draftId: message.id,
      toEmail: message.toEmail,
      cc: message.cc ?? '',
      subject: message.subject === '未命名草稿' ? '' : message.subject,
      body: message.body,
      messageId: message.messageId,
      inReplyTo: message.inReplyTo,
      references: message.references
    } satisfies ComposeInput;

    composeDraftId = message.id;
    composeLiveInput = nextInput;
    composeTouched = false;
    composeAutosaveStatus = 'saved';
    composeAutosaveMessage = statusMessage;
    composeLastSavedSignature = serializeComposeInput(nextInput);
  };

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
    clearComposeAutosaveTimer();

    const input = composeLiveInput;
    const signature = serializeComposeInput(input ? withComposeDraftId(input) : null);

    if (
      !composeOpen ||
      !composeTouched ||
      !input ||
      pending ||
      composeAutosavePending ||
      !hasComposeContent(input) ||
      signature === composeLastSavedSignature
    ) {
      return;
    }

    composeAutosaveTimer = setTimeout(() => {
      void autosaveDraft();
    }, 1500);

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

  function nextSelection(
    nextMailbox: MailboxState,
    section: AppSection,
    preferredMessageId: string | null = selectedMessageId
  ) {
    if (section === 'profile') {
      return selectedMessageId;
    }

    if (section === 'drafts') {
      const list = nextMailbox.drafts;
      return list.find((message) => message.id === preferredMessageId)?.id ?? list[0]?.id ?? null;
    }

    const threads = buildMailThreads(nextMailbox, section);
    const preferredThread = preferredMessageId
      ? threads.find((thread) => thread.messages.some((message) => message.id === preferredMessageId))
      : null;

    if (preferredThread && preferredMessageId) {
      return preferredMessageId;
    }

    return threads[0]?.sectionLatestMessage.id ?? null;
  }

  function applyWorkspace(
    workspace: WorkspacePayload,
    options?: {
      section?: AppSection;
      preferredMessageId?: string | null;
      clearMailView?: boolean;
    }
  ) {
    profile = workspace.profile;
    mailbox = workspace.mailbox;
    authenticated = true;

    if (options?.section) {
      activeSection = options.section;
    }

    if (options?.clearMailView) {
      searchQuery = '';
      mailFilter = 'all';
      mobileDetailOpen = false;
    }

    selectedMessageId = nextSelection(
      workspace.mailbox,
      options?.section ?? activeSection,
      options?.preferredMessageId ?? selectedMessageId
    );

    if (options?.section) {
      updateWorkspaceUrl(
        {
          section: options.section,
          query: options.clearMailView ? '' : undefined,
          filter: options.clearMailView ? 'all' : undefined,
          messageId: options.section === 'profile' ? null : selectedMessageId
        },
        true
      );
    }
  }

  function resetWorkspace() {
    const initialProfile = cloneProfile();
    const initialMailbox = cloneMailbox();

    authenticated = false;
    profile = initialProfile;
    mailbox = initialMailbox;
    activeSection = 'inbox';
    selectedMessageId = initialMailbox.inbox[0]?.id ?? null;
    resetComposeState();
    deliveryDetailPendingId = null;
    deliveryDetails = {};
    deliveryDetailErrors = {};
    profileStatus = '';
    loginError = '';
  }

  async function loadInboundDetail(message: MailMessage, force = false) {
    if (!isInboundMessageId(message.id)) {
      return false;
    }

    if (!force && inboundDetails[message.id]) {
      return true;
    }

    const request = inboundDetailRequest.begin();
    inboundDetailPendingId = message.id;
    inboundDetailErrors = {
      ...inboundDetailErrors,
      [message.id]: ''
    };

    try {
      const result = await requestJson<InboundDetailResponse>(
        `/api/workspace/messages/${encodeURIComponent(message.id)}/detail`,
        { signal: request.signal }
      );
      if (request.isCurrent()) {
        inboundDetails = {
          ...inboundDetails,
          [message.id]: result.detail
        };
      }
      return true;
    } catch (error) {
      if (request.signal.aborted) return false;
      inboundDetailErrors = {
        ...inboundDetailErrors,
        [message.id]: error instanceof Error ? error.message : '加载原始邮件失败。'
      };
      return false;
    } finally {
      if (request.isCurrent() && inboundDetailPendingId === message.id) {
        inboundDetailPendingId = null;
      }
    }
  }

  async function loadDeliveryDetail(message: MailMessage, force = false) {
    if (message.folder !== 'sent' || message.source !== 'workspace') {
      return false;
    }

    if (!force && deliveryDetails[message.id]) {
      return true;
    }

    const request = deliveryDetailRequest.begin();
    deliveryDetailPendingId = message.id;
    deliveryDetailErrors = {
      ...deliveryDetailErrors,
      [message.id]: ''
    };

    try {
      const result = await requestJson<DeliveryDetailResponse>(
        `/api/workspace/messages/${encodeURIComponent(message.id)}/delivery`,
        { signal: request.signal }
      );
      if (request.isCurrent()) {
        deliveryDetails = {
          ...deliveryDetails,
          [message.id]: result.detail
        };
      }
      return true;
    } catch (error) {
      if (request.signal.aborted) return false;
      deliveryDetailErrors = {
        ...deliveryDetailErrors,
        [message.id]: error instanceof Error ? error.message : '加载投递回执失败。'
      };
      return false;
    } finally {
      if (request.isCurrent() && deliveryDetailPendingId === message.id) {
        deliveryDetailPendingId = null;
      }
    }
  }

  function updateWorkspaceUrl(
    updates: {
      section?: AppSection;
      query?: string;
      filter?: MailFilter;
      messageId?: string | null;
    },
    replaceState = false
  ) {
    const url = new URL(page.url);

    if (updates.section) {
      url.searchParams.set('folder', updates.section === 'profile' ? 'settings' : updates.section);
    }
    if (updates.query !== undefined) {
      const query = updates.query.trim().slice(0, 200);
      if (query) url.searchParams.set('q', query);
      else url.searchParams.delete('q');
    }
    if (updates.filter !== undefined) {
      if (updates.filter === 'all') url.searchParams.delete('filter');
      else url.searchParams.set('filter', updates.filter);
    }
    if (updates.messageId !== undefined) {
      if (updates.messageId) url.searchParams.set('message', updates.messageId);
      else url.searchParams.delete('message');
    }

    void goto(url, { replaceState, noScroll: true, keepFocus: true });
  }

  function setSection(section: AppSection, syncUrl = true) {
    activeSection = section;
    searchQuery = '';
    mailFilter = 'all';
    mobileDetailOpen = false;

    if (section === 'inbox' || section === 'sent') {
      const threads = buildMailThreads(mailbox, section);
      const currentThread = selectedMessageId
        ? threads.find((thread) => thread.messages.some((message) => message.id === selectedMessageId))
        : null;

      selectedMessageId = nextSelection(
        mailbox,
        section,
        currentThread?.sectionLatestMessage.id ?? selectedMessageId
      );

      if (syncUrl) {
        updateWorkspaceUrl({ section, query: '', filter: 'all', messageId: null });
      }
      return;
    }

    selectedMessageId = nextSelection(mailbox, section, selectedMessageId);
    if (syncUrl) {
      updateWorkspaceUrl({ section, query: '', filter: 'all', messageId: null });
    }
  }

  function handleSearchQueryChange(query: string) {
    searchQuery = query;
    selectedMessageId = null;
    mobileDetailOpen = false;
    updateWorkspaceUrl({ query, messageId: null }, true);
  }

  function handleFilterChange(filter: MailFilter) {
    mailFilter = filter;
    selectedMessageId = null;
    mobileDetailOpen = false;
    updateWorkspaceUrl({ filter, messageId: null });
  }

  function clearMailFilters() {
    searchQuery = '';
    mailFilter = 'all';
    selectedMessageId = null;
    mobileDetailOpen = false;
    updateWorkspaceUrl({ query: '', filter: 'all', messageId: null }, true);
  }

  async function refreshWorkspace() {
    const request = mailboxRequest.begin();
    mailboxLoading = true;
    try {
      const params = new URLSearchParams({
        folder: activeSection === 'profile' ? 'inbox' : activeSection,
        limit: '40'
      });
      if (searchQuery.trim()) params.set('q', searchQuery.trim());
      if (mailFilter !== 'all') params.set('filter', mailFilter);
      const result = await requestJson<MailboxPageResponse>(`/api/workspace/mailbox?${params}`, {
        signal: request.signal
      });
      if (request.isCurrent()) {
        applyMailboxPage(result.page, false);
        banner = '邮件列表已刷新。';
      }
    } catch (error) {
      if (request.signal.aborted) return;
      banner = error instanceof Error ? error.message : '刷新邮件列表失败。';
    } finally {
      if (request.isCurrent()) mailboxLoading = false;
    }
  }

  function applyMailboxPage(page: MailboxPage, append: boolean) {
    const existing = append ? mailbox[page.folder] : [];
    const byId = new Map(existing.map((message) => [message.id, message]));
    for (const message of page.messages) byId.set(message.id, message);
    mailbox = {
      ...mailbox,
      [page.folder]: [...byId.values()].sort(
        (left, right) => right.sentAt.localeCompare(left.sentAt) || right.id.localeCompare(left.id)
      )
    };
    mailboxPages = {
      ...(mailboxPages ?? {} as Record<MailFolder, MailboxPage>),
      [page.folder]: page
    };
  }

  async function loadMoreMailbox() {
    if (activeSection === 'profile') return;
    const currentPage = mailboxPages?.[activeSection];
    if (!currentPage?.nextCursor || !currentPage.hasMore) return;
    const request = mailboxRequest.begin();
    mailboxLoading = true;
    try {
      const params = new URLSearchParams({
        folder: activeSection,
        cursor: currentPage.nextCursor,
        limit: String(currentPage.limit)
      });
      if (searchQuery.trim()) params.set('q', searchQuery.trim());
      if (mailFilter !== 'all') params.set('filter', mailFilter);
      const result = await requestJson<MailboxPageResponse>(`/api/workspace/mailbox?${params}`, {
        signal: request.signal
      });
      if (request.isCurrent()) applyMailboxPage(result.page, true);
    } catch (error) {
      if (!request.signal.aborted) {
        banner = error instanceof Error ? error.message : '加载更多邮件失败。';
      }
    } finally {
      if (request.isCurrent()) mailboxLoading = false;
    }
  }

  function openCompose(mode: ComposeMode = 'new', initialInput: ComposeInput | null = null) {
    clearComposeAutosaveTimer();
    composeMode = mode;
    composeInitialInput = initialInput;
    composeDraftId = initialInput?.draftId;
    composeSubmissionId = crypto.randomUUID();
    composeLiveInput = initialInput ? { ...initialInput } : createEmptyComposeInput();
    composeTouched = false;
    composeAutosavePending = false;
    composeAutosaveStatus = initialInput?.draftId ? 'saved' : 'idle';
    composeAutosaveMessage = initialInput?.draftId
      ? '草稿内容已载入，继续编辑后会自动保存。'
      : '自动保存会在停顿后触发。';
    composeLastSavedSignature = initialInput?.draftId ? serializeComposeInput(initialInput) : '';
    composeOpen = true;
  }

  async function closeCompose() {
    clearComposeAutosaveTimer();
    let savedBeforeClose = false;

    const input = composeLiveInput ? withComposeDraftId(composeLiveInput) : null;
    const signature = serializeComposeInput(input);

    if (
      input &&
      hasComposeContent(input) &&
      signature !== composeLastSavedSignature &&
      !pending &&
      !composeAutosavePending
    ) {
      composeAutosavePending = true;
      composeAutosaveStatus = 'saving';
      composeAutosaveMessage = '正在关闭前保存草稿...';

      try {
        const result = await requestJson<MessageResponse>('/api/workspace/drafts', {
          method: 'POST',
          body: JSON.stringify(input)
        });

        applyWorkspace(result.workspace);
        syncComposeDraftState(
          result.message,
          `离开前已保存草稿于 ${formatComposeSavedAt(result.message.sentAt)}。`
        );
        savedBeforeClose = true;
      } catch (error) {
        composeAutosaveStatus = 'error';
        composeAutosaveMessage = error instanceof Error ? error.message : '关闭前自动保存失败。';
        banner = composeAutosaveMessage;
        composeAutosavePending = false;
        return;
      } finally {
        composeAutosavePending = false;
      }
    }

    resetComposeState();
    banner = savedBeforeClose ? '未完成内容已保存为草稿。' : '已关闭写信面板。';
  }

  function discardCompose() {
    resetComposeState();
    banner = '已放弃本次未保存的改动。';
  }

  async function handleLogin(payload: LoginInput) {
    pending = true;
    loginError = '';

    try {
      const result = await requestJson<SessionResponse>('/api/workspace/session', {
        method: 'POST',
        body: JSON.stringify(payload)
      });

      if (!result.workspace) {
        throw new Error('登录后未返回工作区数据。');
      }

      applyWorkspace(result.workspace, {
        section: 'inbox',
        preferredMessageId: result.workspace.mailbox.inbox[0]?.id ?? null,
        clearMailView: true
      });
      banner = '已进入工作台。当前会话由 Cookie、SvelteKit API 和 D1 状态驱动。';
    } catch (error) {
      loginError = error instanceof Error ? error.message : '登录失败。';
    } finally {
      pending = false;
    }
  }

  async function handleLogout() {
    pending = true;

    try {
      await requestJson<SessionResponse>('/api/workspace/session', {
        method: 'DELETE'
      });
      resetWorkspace();
      banner = '你已退出工作台。';
    } finally {
      pending = false;
    }
  }

  async function saveProfile(nextProfile: UserProfile) {
    pending = true;
    profileStatus = '';

    try {
      const result = await requestJson<WorkspaceResponse>('/api/workspace/profile', {
        method: 'PUT',
        body: JSON.stringify(nextProfile)
      });

      applyWorkspace(result.workspace, {
        section: 'profile'
      });
      profileStatus = '个人资料已保存到工作区。';
      banner = '个人信息已更新，写信时会自动使用新的身份与签名。';
    } catch (error) {
      profileStatus = error instanceof Error ? error.message : '保存失败。';
    } finally {
      pending = false;
    }
  }

  async function saveDraft(input: ComposeInput) {
    clearComposeAutosaveTimer();
    pending = true;

    try {
      const result = await requestJson<MessageResponse>('/api/workspace/drafts', {
        method: 'POST',
        body: JSON.stringify(withComposeDraftId(input))
      });

      applyWorkspace(result.workspace, {
        section: 'drafts',
        preferredMessageId: result.message.id,
        clearMailView: true
      });
      resetComposeState();
      banner = (input.draftId ?? composeDraftId) ? '草稿已更新。' : '草稿已保存到工作区。';
    } catch (error) {
      banner = error instanceof Error ? error.message : '保存草稿失败。';
    } finally {
      pending = false;
    }
  }

  async function autosaveDraft() {
    const liveInput = composeLiveInput;

    if (!liveInput || !composeOpen) {
      return;
    }

    const input = withComposeDraftId(liveInput);
    const signature = serializeComposeInput(input);

    if (!hasComposeContent(input) || signature === composeLastSavedSignature) {
      return;
    }

    composeAutosavePending = true;
    composeAutosaveStatus = 'saving';
    composeAutosaveMessage = '正在自动保存草稿...';

    try {
      const result = await requestJson<MessageResponse>('/api/workspace/drafts', {
        method: 'POST',
        body: JSON.stringify(input)
      });

      applyWorkspace(result.workspace);
      syncComposeDraftState(
        result.message,
        `已自动保存于 ${formatComposeSavedAt(result.message.sentAt)}。`
      );
    } catch (error) {
      composeAutosaveStatus = 'error';
      composeAutosaveMessage = error instanceof Error ? error.message : '自动保存失败。';
    } finally {
      composeAutosavePending = false;
    }
  }

  async function sendMessage(input: ComposeInput) {
    clearComposeAutosaveTimer();
    pending = true;

    try {
      const result = await requestJson<MessageResponse>('/api/workspace/messages', {
        method: 'POST',
        headers: composeSubmissionId ? { 'Idempotency-Key': composeSubmissionId } : undefined,
        body: JSON.stringify(withComposeDraftId(input))
      });

      deliveryDetails = Object.fromEntries(
        Object.entries(deliveryDetails).filter(([id]) => id !== result.message.id)
      );
      deliveryDetailErrors = Object.fromEntries(
        Object.entries(deliveryDetailErrors).filter(([id]) => id !== result.message.id)
      );

      applyWorkspace(result.workspace, {
        section: 'sent',
        preferredMessageId: result.message.id,
        clearMailView: true
      });
      resetComposeState();
      banner =
        result.message.deliveryResultKind === 'accepted' && (input.draftId ?? composeDraftId)
          ? `草稿已提交到 ${result.message.deliveryProvider ?? '投递服务'}，目标 ${result.message.toEmail}。`
          : result.message.deliveryResultKind === 'accepted'
            ? `已向 ${result.message.toEmail} 发起投递，并提交到 ${result.message.deliveryProvider ?? '投递服务'}。`
            : describeDeliveryState(result.message);
    } catch (error) {
      banner = error instanceof Error ? error.message : '发送失败。';
    } finally {
      pending = false;
    }
  }

  async function retryMessageDelivery(message: MailMessage) {
    pending = true;

    try {
      const result = await requestJson<MessageResponse>(
        `/api/workspace/messages/${encodeURIComponent(message.id)}/retry`,
        {
          method: 'POST'
        }
      );

      deliveryDetails = Object.fromEntries(
        Object.entries(deliveryDetails).filter(([id]) => id !== result.message.id)
      );
      deliveryDetailErrors = Object.fromEntries(
        Object.entries(deliveryDetailErrors).filter(([id]) => id !== result.message.id)
      );

      applyWorkspace(result.workspace, {
        section: 'sent',
        preferredMessageId: result.message.id
      });
      banner =
        result.message.deliveryResultKind === 'accepted'
          ? `《${result.message.subject}》已重新提交到 ${result.message.deliveryProvider ?? '投递服务'}。`
          : result.message.deliveryResultKind === 'queued'
            ? `《${result.message.subject}》仍在发送队列中。`
            : result.message.deliveryResultKind === 'temporary_failure'
              ? `《${result.message.subject}》重试后仍需等待：${result.message.deliveryError ?? '请稍后重试。'}`
              : result.message.deliveryResultKind === 'rate_limited'
                ? `《${result.message.subject}》被投递服务限流，请稍后再试。`
                : `《${result.message.subject}》再次投递失败：${result.message.deliveryError ?? '请稍后重试。'}`;
    } catch (error) {
      banner = error instanceof Error ? error.message : '重试投递失败。';
    } finally {
      pending = false;
    }
  }

  async function patchMessage(message: MailMessage, patch: MessagePatch, nextBanner?: string) {
    pending = true;

    try {
      const result = await requestJson<MessageResponse>(
        `/api/workspace/messages/${message.id}/flags`,
        {
          method: 'PATCH',
          body: JSON.stringify(patch)
        }
      );

      applyWorkspace(result.workspace, {
        section: activeSection === 'profile' ? message.folder : activeSection,
        preferredMessageId: result.message.id
      });

      if (nextBanner) {
        banner = nextBanner;
      }
    } finally {
      pending = false;
    }
  }

  async function handleSelectMessage(message: MailMessage) {
    selectedMessageId = message.id;
    mobileDetailOpen = true;
    updateWorkspaceUrl({ messageId: message.id });

    if (message.folder === 'inbox' && !message.read) {
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
      const result = await requestJson<DeleteResponse>(`/api/workspace/messages/${message.id}`, {
        method: 'DELETE'
      });

      applyWorkspace(result.workspace, {
        section: activeSection === 'profile' ? result.folder : activeSection
      });
      if (composeInitialInput?.draftId === message.id) {
        resetComposeState();
      }

      banner =
        result.folder === 'inbox'
          ? '邮件已从收件箱移除。'
          : result.folder === 'sent'
            ? '该发送记录已移除。'
            : '草稿已删除。';
    } finally {
      pending = false;
    }
  }

  function handleEditDraft(message: MailMessage) {
    openCompose('draft', createComposeInputFromDraft(message));
    banner = '你正在继续编辑一封草稿。';
  }

  function handleReplyMessage(message: MailMessage) {
    const quotedBody =
      isInboundMessageId(message.id) ? inboundDetails[message.id]?.body ?? message.body : message.body;

    openCompose('reply', createReplyComposeInput(message, quotedBody));
    banner = `正在回复《${message.subject}》。`;
  }

  function handleForwardMessage(message: MailMessage) {
    const forwardedBody =
      isInboundMessageId(message.id) ? inboundDetails[message.id]?.body ?? message.body : message.body;

    openCompose('forward', createForwardComposeInput(message, forwardedBody));
    banner = `正在转发《${message.subject}》。`;
  }

  async function handleReloadInboundDetail(message: MailMessage) {
    const ok = await loadInboundDetail(message, true);
    banner = ok
      ? `已重新载入《${message.subject}》的原始邮件详情。`
      : '重新载入原始邮件失败。';
  }

  async function handleReloadDeliveryDetail(message: MailMessage) {
    const ok = await loadDeliveryDetail(message, true);
    banner = ok
      ? `已重新载入《${message.subject}》的投递回执。`
      : '重新载入投递回执失败。';
  }

  function isEditableTarget(target: EventTarget | null) {
    return (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement ||
      (target instanceof HTMLElement && target.isContentEditable)
    );
  }

  function moveMessageSelection(direction: -1 | 1) {
    const candidates =
      activeSection === 'drafts'
        ? visibleMessages
        : visibleThreads.map((thread) => thread.sectionLatestMessage);
    if (!candidates.length) return;

    const currentIndex = candidates.findIndex((message) => message.id === selectedMessageId);
    const fallbackIndex = direction > 0 ? 0 : candidates.length - 1;
    const nextIndex =
      currentIndex < 0
        ? fallbackIndex
        : Math.min(candidates.length - 1, Math.max(0, currentIndex + direction));
    void handleSelectMessage(candidates[nextIndex]);
  }

  function setShortcutPrefix(value: string) {
    shortcutPrefix = value;
    if (shortcutPrefixTimer) clearTimeout(shortcutPrefixTimer);
    shortcutPrefixTimer = setTimeout(() => {
      shortcutPrefix = '';
      shortcutPrefixTimer = null;
    }, 900);
  }

  onMount(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (!authenticated || composeOpen) return;

      if (event.key === 'Escape') {
        if (shortcutHelpOpen) {
          event.preventDefault();
          shortcutHelpOpen = false;
        } else if (mobileDetailOpen) {
          event.preventDefault();
          closeMobileDetail();
        }
        return;
      }

      if (isEditableTarget(event.target) || event.ctrlKey || event.metaKey || event.altKey) return;

      const key = event.key.toLocaleLowerCase('en-US');
      if (shortcutPrefix === 'g' && (key === 'i' || key === 's' || key === 'd')) {
        event.preventDefault();
        shortcutPrefix = '';
        setSection(key === 'i' ? 'inbox' : key === 's' ? 'sent' : 'drafts');
        return;
      }

      if (key === 'g') {
        event.preventDefault();
        setShortcutPrefix('g');
        return;
      }

      if (key === '/') {
        event.preventDefault();
        window.dispatchEvent(new CustomEvent('flaremail:focus-search'));
      } else if (key === 'c') {
        event.preventDefault();
        openCompose('new');
      } else if (key === 'j') {
        event.preventDefault();
        moveMessageSelection(1);
      } else if (key === 'k') {
        event.preventDefault();
        moveMessageSelection(-1);
      } else if (key === 'r' && selectedMessage?.folder === 'inbox') {
        event.preventDefault();
        handleReplyMessage(selectedMessage);
      } else if (key === 'f' && selectedMessage && selectedMessage.folder !== 'drafts') {
        event.preventDefault();
        handleForwardMessage(selectedMessage);
      } else if (event.key === '?') {
        event.preventDefault();
        shortcutHelpOpen = true;
      }
    };

    document.addEventListener('keydown', handleShortcut);
    return () => {
      document.removeEventListener('keydown', handleShortcut);
      if (shortcutPrefixTimer) clearTimeout(shortcutPrefixTimer);
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
  {#if !authenticated}
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
        draftCount={mailbox.drafts.length}
        failedCount={failedCount}
        {pending}
        {profile}
        queuedCount={queuedCount}
        {runtimeLabel}
        unreadCount={unreadCount}
        onEditProfile={() => {
          setSection('profile');
          banner = '已打开设置。';
        }}
        onLogout={handleLogout}
        onSearch={() => {
          window.dispatchEvent(new CustomEvent('flaremail:focus-search'));
        }}
      />

      <div class:mobile-detail-nav-hidden={mobileDetailOpen}>
        <MobileNavigation
          activeSection={activeSection}
          draftCount={mailbox.drafts.length}
          {pending}
          unreadCount={unreadCount}
          onCompose={() => {
            openCompose('new');
            banner = '正在写新邮件。';
          }}
          onSelectSection={setSection}
        />
      </div>

      <div class:mobile-detail-mode={mobileDetailOpen} class="fm-workspace-body">
        <div class="fm-workspace-shell">
          <AppSidebar
            activeSection={activeSection}
            draftCount={mailbox.drafts.length}
            {pending}
            sentCount={mailbox.sent.length}
            unreadCount={unreadCount}
            onCompose={() => {
              openCompose('new');
              banner = '正在写新邮件。';
            }}
            onSelectSection={setSection}
          />

          <main class="fm-workspace-main" aria-label="邮件工作区">
            {#if activeSection === 'profile'}
              <div class="h-full overflow-y-auto bg-fm-surface p-6 lg:p-8">
                <ProfilePane {pending} {profile} status={profileStatus} onSave={saveProfile} />
              </div>
            {:else}
              <div class:detail-open={mobileDetailOpen} class="mail-workspace">
                <section class="mail-list-panel" aria-label="邮件列表">
                  <FolderHeader
                    activeSection={activeSection}
                    count={activeSection === 'drafts' ? activeMessages.length : activeThreads.length}
                    unreadCount={activeSection === 'inbox' ? unreadCount : 0}
                    query={searchQuery}
                    filter={mailFilter}
                    loading={mailboxLoading}
                    onQueryChange={handleSearchQueryChange}
                    onFilterChange={handleFilterChange}
                    onRefresh={refreshWorkspace}
                  />
                  <MessageList
                    activeSection={activeSection}
                    messages={activeMessages}
                    selectedThreadId={selectedThreadId}
                    threads={activeThreads}
                    {selectedMessageId}
                    query={searchQuery}
                    filter={mailFilter}
                    loading={mailboxLoading}
                    hasMore={mailboxPages?.[activeSection]?.hasMore ?? false}
                    paginationEnd={!(mailboxPages?.[activeSection]?.hasMore ?? false)}
                    onSelect={handleSelectMessage}
                    onSelectThread={handleSelectThread}
                    onToggleStar={handleToggleStar}
                    onQueryChange={handleSearchQueryChange}
                    onFilterChange={handleFilterChange}
                    onClearFilters={clearMailFilters}
                    onRefresh={refreshWorkspace}
                    onLoadMore={loadMoreMailbox}
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
                    {pending}
                    rawDownloadHref={selectedInboundDownloadHref}
                    showBack={true}
                    threadMessages={selectedThreadMessages}
                    onBack={closeMobileDetail}
                    onEditDraft={handleEditDraft}
                    onForward={handleForwardMessage}
                    onReply={handleReplyMessage}
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

        <div class="fm-workspace-status" role="status" aria-live="polite">
          <span>{banner}</span>
        </div>
      </div>
    </div>

    {#if composeOpen}
      <ComposeModal
        autosaveMessage={composeAutosaveMessage}
        autosaveStatus={composeAutosaveStatus}
        draftId={composeDraftId}
        initialInput={composeInitialInput}
        mode={composeMode}
        pending={composeBusy}
        {profile}
        onClose={closeCompose}
        onDiscard={discardCompose}
        onInputChange={(input) => {
          const nextInput = withComposeDraftId(input);
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
        <div><dt><kbd>F</kbd></dt><dd>转发当前邮件</dd></div>
        <div><dt><kbd>Esc</kbd></dt><dd>关闭面板或返回列表</dd></div>
        <div><dt><kbd>?</kbd></dt><dd>打开快捷键帮助</dd></div>
      </dl>
    </Dialog>
  {/if}
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
      height: 100dvh;
    }

    :global(.fm-workspace-body.mobile-detail-mode) :global(.fm-workspace-status) {
      display: none;
    }
  }
</style>
