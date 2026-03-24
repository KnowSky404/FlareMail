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
    cloneMailbox,
    cloneProfile,
    type ComposeInput,
    type LoginInput,
    type MailFolder,
    type MailMessage,
    type MailboxState,
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

  let { data }: { data: PageData } = $props();
  const serverWorkspace = $derived(data.workspace);

  const runtimeLabel = $derived(data.dbBound && data.bucketBound ? 'Cloudflare 绑定在线' : '模拟模式');

  let authenticated = $state(false);
  let profile = $state<UserProfile>(cloneProfile());
  let mailbox = $state<MailboxState>(cloneMailbox());
  let activeSection = $state<AppSection>('inbox');
  let selectedMessageId = $state<string | null>(null);
  let composeOpen = $state(false);
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
      banner = '已从模拟 API 加载工作台。你可以刷新页面验证会话恢复。';
      hydratedFromServer = true;
    }
  });

  const unreadCount = $derived(mailbox.inbox.filter((message) => !message.read).length);
  const starredCount = $derived(
    mailbox.inbox.filter((message) => message.starred).length +
      mailbox.sent.filter((message) => message.starred).length
  );
  const activeMessages = $derived(
    activeSection === 'inbox' ? mailbox.inbox : activeSection === 'sent' ? mailbox.sent : []
  );
  const selectedMessage = $derived.by(() => {
    const list = activeMessages;

    if (!list.length) {
      return null;
    }

    return list.find((message) => message.id === selectedMessageId) ?? list[0];
  });
  const lastActivityAt = $derived(
    mailbox.inbox[0]?.sentAt ?? mailbox.sent[0]?.sentAt ?? data.lastTimestamp ?? null
  );

  function nextSelection(
    nextMailbox: MailboxState,
    section: AppSection,
    preferredMessageId: string | null = selectedMessageId
  ) {
    if (section === 'profile') {
      return selectedMessageId;
    }

    const list = section === 'inbox' ? nextMailbox.inbox : nextMailbox.sent;
    return list.find((message) => message.id === preferredMessageId)?.id ?? list[0]?.id ?? null;
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

  function setSection(section: AppSection) {
    activeSection = section;
    selectedMessageId = nextSelection(mailbox, section, selectedMessageId);
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
      banner = '已进入演示工作台。当前会话由 Cookie 与 SvelteKit API 驱动。';
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
      profileStatus = '个人资料已保存到模拟后端。';
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

  async function sendMessage(input: ComposeInput) {
    pending = true;

    try {
      const result = await requestJson<MessageResponse>('/api/workspace/messages', {
        method: 'POST',
        body: JSON.stringify(input)
      });

      applyWorkspace(result.workspace, {
        section: 'sent',
        preferredMessageId: result.message.id
      });
      composeOpen = false;
      banner = `已向 ${result.message.toEmail} 发送一封模拟邮件。`;
    } catch (error) {
      banner = error instanceof Error ? error.message : '发送失败。';
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
        section: message.folder,
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
        section: result.folder
      });
      banner = result.folder === 'inbox' ? '邮件已从收件箱移除。' : '该发送记录已移除。';
    } finally {
      pending = false;
    }
  }
</script>

<svelte:head>
  <title>FlareMail</title>
  <meta
    name="description"
    content="极简风格的 FlareMail 邮件工作台原型，覆盖登录、个人信息、收件箱、发件箱与写信交互。"
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
        {pending}
        {profile}
        {runtimeLabel}
        {starredCount}
        totalMessages={data.totalMessages}
        unreadCount={unreadCount}
        onCompose={() => {
          composeOpen = true;
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
            {selectedMessageId}
            onSelect={handleSelectMessage}
          />
          <MessageDetailPane
            message={selectedMessage}
            {pending}
            onRemove={handleDeleteMessage}
            onToggleRead={handleToggleRead}
            onToggleStar={handleToggleStar}
          />
        {/if}
      </section>
    </main>

    {#if composeOpen}
      <ComposeModal
        {pending}
        {profile}
        onClose={() => {
          composeOpen = false;
          banner = '已关闭写信面板。';
        }}
        onSend={sendMessage}
      />
    {/if}
  {/if}
</div>
