<script lang="ts">
  import type { PageData } from './$types';
  import ComposeModal from '$lib/components/mail/ComposeModal.svelte';
  import LoginView from '$lib/components/mail/LoginView.svelte';
  import MailSidebar from '$lib/components/mail/MailSidebar.svelte';
  import MessageDetailPane from '$lib/components/mail/MessageDetailPane.svelte';
  import MessageListPane from '$lib/components/mail/MessageListPane.svelte';
  import ProfilePane from '$lib/components/mail/ProfilePane.svelte';
  import WorkspaceHeader from '$lib/components/mail/WorkspaceHeader.svelte';
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
    type MailThread,
    type MessagePatch,
    type UserProfile,
    type WorkspacePayload
  } from '$lib/mock/mailbox';

  type AppSection = MailFolder | 'profile';

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

  let { data }: { data: PageData } = $props();
  const serverWorkspace = $derived(data.workspace);

  const runtimeLabel = $derived(data.dbBound && data.bucketBound ? 'Cloudflare 绑定在线' : '模拟模式');

  let authenticated = $state(false);
  let profile = $state<UserProfile>(cloneProfile());
  let mailbox = $state<MailboxState>(cloneMailbox());
  let activeSection = $state<AppSection>('inbox');
  let selectedMessageId = $state<string | null>(null);
  let composeOpen = $state(false);
  let composeMode = $state<ComposeMode>('new');
  let composeInitialInput = $state<ComposeInput | null>(null);
  let inboundDetails = $state<Record<string, InboundMessageDetail>>({});
  let deliveryDetails = $state<Record<string, DeliveryDetail>>({});
  let inboundDetailErrors = $state<Record<string, string>>({});
  let deliveryDetailErrors = $state<Record<string, string>>({});
  let inboundDetailPendingId = $state<string | null>(null);
  let deliveryDetailPendingId = $state<string | null>(null);
  let banner = $state('当前界面使用模拟数据，先验证完整的产品交互。');
  let loginError = $state('');
  let profileStatus = $state('');
  let pending = $state(false);
  let hydratedFromServer = $state(false);

  $effect(() => {
    if (!hydratedFromServer && serverWorkspace) {
      authenticated = true;
      profile = serverWorkspace.profile;
      mailbox = serverWorkspace.mailbox;
      selectedMessageId = serverWorkspace.mailbox.inbox[0]?.id ?? null;
      banner = '工作台已从服务端恢复。你可以直接继续读信、保存草稿或发送邮件。';
      hydratedFromServer = true;
    }
  });

  const unreadCount = $derived(mailbox.inbox.filter((message) => !message.read).length);
  const starredCount = $derived(
    mailbox.inbox.filter((message) => message.starred).length +
      mailbox.sent.filter((message) => message.starred).length +
      mailbox.drafts.filter((message) => message.starred).length
  );
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
  const selectedThread = $derived.by(() => {
    if (activeSection === 'drafts' || activeSection === 'profile') {
      return null;
    }

    const threads = activeThreads;

    if (!threads.length) {
      return null;
    }

    return threads.find((thread) => thread.messages.some((message) => message.id === selectedMessageId)) ?? threads[0];
  });
  const selectedThreadId = $derived(selectedThread?.id ?? null);
  const selectedMessage = $derived.by(() => {
    if (activeSection === 'drafts') {
      const list = activeMessages;

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
  const lastActivityAt = $derived(
    mailbox.inbox[0]?.sentAt ??
      mailbox.sent[0]?.sentAt ??
      mailbox.drafts[0]?.sentAt ??
      data.lastTimestamp ??
      null
  );
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

  const describeDeliveryState = (message: MailMessage) =>
    message.deliveryResultKind === 'accepted'
      ? `邮件已提交到 ${message.deliveryProvider ?? 'provider'}。`
      : message.deliveryResultKind === 'queued'
        ? `邮件已进入发送队列，等待投递到 ${message.toEmail}。`
        : message.deliveryResultKind === 'temporary_failure'
          ? `Provider 暂时不可用，已保留重试入口：${message.deliveryError ?? '请稍后重试。'}`
          : message.deliveryResultKind === 'rate_limited'
            ? `Provider 触发限流，这封邮件暂时未发出：${message.deliveryError ?? '请稍后重试。'}`
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
    }
  ) {
    profile = workspace.profile;
    mailbox = workspace.mailbox;
    authenticated = true;

    if (options?.section) {
      activeSection = options.section;
    }

    selectedMessageId = nextSelection(
      workspace.mailbox,
      options?.section ?? activeSection,
      options?.preferredMessageId ?? selectedMessageId
    );
  }

  function resetWorkspace() {
    const initialProfile = cloneProfile();
    const initialMailbox = cloneMailbox();

    authenticated = false;
    profile = initialProfile;
    mailbox = initialMailbox;
    activeSection = 'inbox';
    selectedMessageId = initialMailbox.inbox[0]?.id ?? null;
    composeOpen = false;
    composeMode = 'new';
    composeInitialInput = null;
    deliveryDetailPendingId = null;
    deliveryDetails = {};
    deliveryDetailErrors = {};
    profileStatus = '';
    loginError = '';
  }

  async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
    const response = await fetch(url, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(init?.headers ?? {})
      }
    });

    const payload = (await response.json()) as T & { error?: string };

    if (!response.ok) {
      throw new Error(payload.error ?? '请求失败。');
    }

    return payload;
  }

  async function loadInboundDetail(message: MailMessage, force = false) {
    if (!isInboundMessageId(message.id)) {
      return false;
    }

    if (!force && inboundDetails[message.id]) {
      return true;
    }

    inboundDetailPendingId = message.id;
    inboundDetailErrors = {
      ...inboundDetailErrors,
      [message.id]: ''
    };

    try {
      const result = await requestJson<InboundDetailResponse>(
        `/api/workspace/messages/${encodeURIComponent(message.id)}/detail`
      );

      inboundDetails = {
        ...inboundDetails,
        [message.id]: result.detail
      };
      return true;
    } catch (error) {
      inboundDetailErrors = {
        ...inboundDetailErrors,
        [message.id]: error instanceof Error ? error.message : '加载原始邮件失败。'
      };
      return false;
    } finally {
      if (inboundDetailPendingId === message.id) {
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

    deliveryDetailPendingId = message.id;
    deliveryDetailErrors = {
      ...deliveryDetailErrors,
      [message.id]: ''
    };

    try {
      const result = await requestJson<DeliveryDetailResponse>(
        `/api/workspace/messages/${encodeURIComponent(message.id)}/delivery`
      );

      deliveryDetails = {
        ...deliveryDetails,
        [message.id]: result.detail
      };
      return true;
    } catch (error) {
      deliveryDetailErrors = {
        ...deliveryDetailErrors,
        [message.id]: error instanceof Error ? error.message : '加载投递回执失败。'
      };
      return false;
    } finally {
      if (deliveryDetailPendingId === message.id) {
        deliveryDetailPendingId = null;
      }
    }
  }

  function setSection(section: AppSection) {
    activeSection = section;

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
      return;
    }

    selectedMessageId = nextSelection(mailbox, section, selectedMessageId);
  }

  function openCompose(mode: ComposeMode = 'new', initialInput: ComposeInput | null = null) {
    composeMode = mode;
    composeInitialInput = initialInput;
    composeOpen = true;
  }

  function closeCompose() {
    composeOpen = false;
    composeMode = 'new';
    composeInitialInput = null;
    banner = '已关闭写信面板。';
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
        preferredMessageId: result.workspace.mailbox.inbox[0]?.id ?? null
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
      banner = '你已退出演示工作台。';
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

  async function receiveDemoMail() {
    pending = true;

    try {
      const result = await requestJson<MessageResponse>('/api/workspace/mailbox/receive-demo', {
        method: 'POST'
      });

      applyWorkspace(result.workspace, {
        section: 'inbox',
        preferredMessageId: result.message.id
      });
      banner = `已模拟接收来自 ${result.message.fromName} 的新邮件。`;
    } finally {
      pending = false;
    }
  }

  async function saveDraft(input: ComposeInput) {
    pending = true;

    try {
      const result = await requestJson<MessageResponse>('/api/workspace/drafts', {
        method: 'POST',
        body: JSON.stringify(input)
      });

      applyWorkspace(result.workspace, {
        section: 'drafts',
        preferredMessageId: result.message.id
      });
      composeOpen = false;
      composeMode = 'new';
      composeInitialInput = null;
      banner = input.draftId ? '草稿已更新。' : '草稿已保存到工作区。';
    } catch (error) {
      banner = error instanceof Error ? error.message : '保存草稿失败。';
    } finally {
      pending = false;
    }
  }

  async function sendMessage(input: ComposeInput) {
    pending = true;

    try {
      const result = await requestJson<MessageResponse>('/api/workspace/messages', {
        method: 'POST',
        body: JSON.stringify(input)
      });

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
      composeOpen = false;
      composeMode = 'new';
      composeInitialInput = null;
      banner =
        result.message.deliveryResultKind === 'accepted' && input.draftId
          ? `草稿已提交到 ${result.message.deliveryProvider ?? 'provider'}，目标 ${result.message.toEmail}。`
          : result.message.deliveryResultKind === 'accepted'
            ? `已向 ${result.message.toEmail} 发起投递，并提交到 ${result.message.deliveryProvider ?? 'provider'}。`
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
          ? `《${result.message.subject}》已重新提交到 ${result.message.deliveryProvider ?? 'provider'}。`
          : result.message.deliveryResultKind === 'queued'
            ? `《${result.message.subject}》仍在发送队列中。`
            : result.message.deliveryResultKind === 'temporary_failure'
              ? `《${result.message.subject}》重试后仍需等待：${result.message.deliveryError ?? '请稍后重试。'}`
              : result.message.deliveryResultKind === 'rate_limited'
                ? `《${result.message.subject}》被 provider 限流，请稍后再试。`
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
        composeMode = 'new';
        composeInitialInput = null;
        composeOpen = false;
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
</script>

<svelte:head>
  <title>FlareMail</title>
  <meta
    name="description"
    content="极简风格的 FlareMail 邮件工作台，覆盖登录、个人信息、收件箱、草稿箱、发件箱与写信交互。"
  />
</svelte:head>

<div class="min-h-screen">
  {#if !authenticated}
    <LoginView
      dbBound={data.dbBound}
      bucketBound={data.bucketBound}
      {loginError}
      {pending}
      {runtimeLabel}
      lastSubject={data.lastSubject}
      totalMessages={data.totalMessages}
      onLogin={handleLogin}
    />
  {:else}
    <main class="mx-auto flex min-h-screen w-full max-w-[1680px] flex-col gap-5 px-4 py-4 md:px-6 md:py-6">
      <WorkspaceHeader
        {banner}
        draftCount={mailbox.drafts.length}
        failedCount={failedCount}
        {pending}
        {profile}
        queuedCount={queuedCount}
        {runtimeLabel}
        {starredCount}
        totalMessages={data.totalMessages}
        unreadCount={unreadCount}
        onCompose={() => {
          openCompose('new');
          banner = '正在写新邮件。';
        }}
        onEditProfile={() => {
          setSection('profile');
          banner = '你正在编辑个人资料。';
        }}
        onLogout={handleLogout}
        onReceive={receiveDemoMail}
      />

      <section class="grid flex-1 gap-4 xl:grid-cols-[260px_380px_minmax(0,1fr)]">
        <MailSidebar
          activeSection={activeSection}
          draftCount={mailbox.drafts.length}
          forwardingEnabled={profile.forwardingEnabled}
          lastTimestamp={lastActivityAt}
          {profile}
          sentCount={mailbox.sent.length}
          unreadCount={unreadCount}
          onSelectSection={setSection}
        />

        {#if activeSection === 'profile'}
          <ProfilePane {pending} {profile} status={profileStatus} onSave={saveProfile} />
        {:else}
          <MessageListPane
            activeSection={activeSection}
            messages={activeMessages}
            selectedThreadId={selectedThreadId}
            threads={activeThreads}
            {selectedMessageId}
            onSelect={handleSelectMessage}
            onSelectThread={handleSelectThread}
          />
          <MessageDetailPane
            message={selectedMessage}
            deliveryDetail={selectedDeliveryDetail}
            deliveryDetailError={selectedDeliveryDetailError}
            deliveryDetailPending={deliveryDetailPendingId === selectedMessage?.id}
            inboundDetail={selectedInboundDetail}
            inboundDetailError={selectedInboundDetailError}
            inboundDetailPending={inboundDetailPendingId === selectedMessage?.id}
            {pending}
            rawDownloadHref={selectedInboundDownloadHref}
            threadMessages={selectedThreadMessages}
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
        {/if}
      </section>
    </main>

    {#if composeOpen}
      <ComposeModal
        initialInput={composeInitialInput}
        mode={composeMode}
        {pending}
        {profile}
        onClose={closeCompose}
        onSaveDraft={saveDraft}
        onSend={sendMessage}
      />
    {/if}
  {/if}
</div>
