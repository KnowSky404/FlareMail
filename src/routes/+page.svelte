<script lang="ts">
  import type { PageData } from './$types';
  import {
    cloneMailbox,
    cloneProfile,
    createIncomingMessage,
    createSentMessage,
    demoCredentials,
    type MailFolder,
    type MailMessage,
    type UserProfile
  } from '$lib/mock/mailbox';

  type AppSection = MailFolder | 'profile';
  type MailboxState = {
    inbox: MailMessage[];
    sent: MailMessage[];
  };

  let { data }: { data: PageData } = $props();

  const sections = [
    { id: 'inbox', label: '收件箱', count: () => unreadCount, note: '新来信与待处理邮件' },
    { id: 'sent', label: '已发送', count: () => mailbox.sent.length, note: '查看发送历史与草拟节奏' },
    { id: 'profile', label: '个人信息', count: () => 1, note: '编辑签名、邮箱身份与偏好' }
  ] as const;

  const runtimeLabel = $derived(data.dbBound && data.bucketBound ? 'Cloudflare 绑定在线' : '模拟模式');

  let authenticated = $state(false);
  let loginForm = $state({
    email: demoCredentials.email,
    password: demoCredentials.password,
    remember: true
  });
  let loginError = $state('');
  let banner = $state('当前界面使用模拟数据，先验证完整的产品交互。');
  let mailbox = $state<MailboxState>(cloneMailbox());
  let profile = $state<UserProfile>(cloneProfile());
  let activeSection = $state<AppSection>('inbox');
  let selectedMessageId = $state<string | null>(mailbox.inbox[0]?.id ?? null);
  let composeOpen = $state(false);
  let composeForm = $state({
    toEmail: 'team@northstar.so',
    cc: '',
    subject: 'FlareMail UI prototype update',
    body: 'Hi,\n\nThe next pass focuses on a quieter reading view, profile editing, and a simpler send flow.\n\n'
  });
  let profileStatus = $state('');
  let incomingSequence = $state(0);

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

  const formatDate = (value: string) =>
    new Intl.DateTimeFormat('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    }).format(new Date(value));

  function setSection(section: AppSection) {
    activeSection = section;

    if (section === 'profile') {
      return;
    }

    const nextList = section === 'inbox' ? mailbox.inbox : mailbox.sent;
    selectedMessageId = nextList[0]?.id ?? null;
  }

  function handleLogin(event: SubmitEvent) {
    event.preventDefault();

    if (
      loginForm.email.trim() !== demoCredentials.email ||
      loginForm.password.trim() !== demoCredentials.password
    ) {
      loginError = `请使用演示账号 ${demoCredentials.email} / ${demoCredentials.password}`;
      return;
    }

    authenticated = true;
    loginError = '';
    banner = '已进入演示工作台。你可以直接修改个人信息、收发邮件和切换收件箱。';
    setSection('inbox');
  }

  function handleLogout() {
    authenticated = false;
    composeOpen = false;
    loginError = '';
    banner = '你已退出演示工作台。';
  }

  function selectMessage(message: MailMessage) {
    selectedMessageId = message.id;

    if (message.folder === 'inbox' && !message.read) {
      mailbox.inbox = mailbox.inbox.map((item) =>
        item.id === message.id ? { ...item, read: true } : item
      );
    }
  }

  function toggleStar(messageId: string, folder: MailFolder) {
    mailbox[folder] = mailbox[folder].map((message) =>
      message.id === messageId ? { ...message, starred: !message.starred } : message
    );
  }

  function toggleRead(messageId: string) {
    mailbox.inbox = mailbox.inbox.map((message) =>
      message.id === messageId ? { ...message, read: !message.read } : message
    );
  }

  function removeMessage(messageId: string, folder: MailFolder) {
    mailbox[folder] = mailbox[folder].filter((message) => message.id !== messageId);

    const nextList = folder === 'inbox' ? mailbox.inbox : mailbox.sent;
    selectedMessageId = nextList[0]?.id ?? null;
    banner = folder === 'inbox' ? '邮件已从收件箱移除。' : '该发送记录已移除。';
  }

  function openCompose() {
    composeOpen = true;
    banner = '正在写新邮件。';
  }

  function closeCompose() {
    composeOpen = false;
    banner = '已关闭写信面板。';
  }

  function sendMessage(event: SubmitEvent) {
    event.preventDefault();

    if (!composeForm.toEmail.trim() || !composeForm.subject.trim() || !composeForm.body.trim()) {
      banner = '收件人、主题和正文不能为空。';
      return;
    }

    const nextMessage = createSentMessage({
      from: profile as UserProfile,
      toEmail: composeForm.toEmail,
      subject: composeForm.subject,
      body: composeForm.body,
      cc: composeForm.cc
    });

    mailbox.sent = [nextMessage, ...mailbox.sent];
    composeForm = {
      toEmail: '',
      cc: '',
      subject: '',
      body: ''
    };
    composeOpen = false;
    banner = `已向 ${nextMessage.toEmail} 发送一封模拟邮件。`;
    setSection('sent');
    selectedMessageId = nextMessage.id;
  }

  function receiveDemoMail() {
    incomingSequence += 1;
    const nextMessage = createIncomingMessage(profile as UserProfile, incomingSequence);

    mailbox.inbox = [nextMessage, ...mailbox.inbox];
    banner = `已模拟接收来自 ${nextMessage.fromName} 的新邮件。`;
    setSection('inbox');
    selectedMessageId = nextMessage.id;
  }

  function saveProfile(event: SubmitEvent) {
    event.preventDefault();
    profileStatus = '个人资料已保存到本地演示状态。';
    banner = '个人信息已更新，写信时会自动使用新的身份与签名。';
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
    <main class="mx-auto grid min-h-screen w-full max-w-7xl items-center gap-8 px-5 py-8 lg:grid-cols-[1.15fr_0.85fr] lg:px-8">
      <section class="space-y-10 rounded-[2rem] border border-night/10 bg-shell/92 p-7 shadow-[0_24px_80px_rgba(32,27,22,0.06)] md:p-10">
        <div class="flex flex-wrap items-center gap-3 text-[11px] uppercase tracking-[0.28em] text-mist">
          <span class="rounded-full border border-night/10 px-3 py-1">FlareMail</span>
          <span class="rounded-full border border-night/10 px-3 py-1">{runtimeLabel}</span>
          <span class="rounded-full border border-night/10 px-3 py-1">Mock Workspace</span>
        </div>

        <div class="max-w-4xl space-y-5">
          <h1 class="font-display text-5xl leading-none tracking-[-0.04em] text-ink md:text-7xl">
            极简邮件工作台，先把收发与身份管理的体验打磨清楚。
          </h1>
          <p class="max-w-2xl text-base leading-7 text-mist md:text-lg">
            当前原型先用模拟数据推进 UI 交互。你可以直接体验登录、编辑个人信息、阅读收件箱、查看已发送，以及写一封新邮件。
          </p>
        </div>

        <div class="grid gap-4 md:grid-cols-3">
          <article class="rounded-[1.75rem] border border-night/10 bg-paper p-5">
            <p class="text-[11px] uppercase tracking-[0.24em] text-mist">登录入口</p>
            <p class="mt-3 text-2xl font-semibold text-ink">单一身份流</p>
            <p class="mt-3 text-sm leading-6 text-mist">
              先从单账户工作台切入，验证邮箱身份切换、签名管理与会话入口是否顺手。
            </p>
          </article>

          <article class="rounded-[1.75rem] border border-night/10 bg-paper p-5">
            <p class="text-[11px] uppercase tracking-[0.24em] text-mist">邮件阅读</p>
            <p class="mt-3 text-2xl font-semibold text-ink">三栏但克制</p>
            <p class="mt-3 text-sm leading-6 text-mist">
              左侧导航、中间列表、右侧详情，保留操作效率，同时避免传统后台式的拥挤感。
            </p>
          </article>

          <article class="rounded-[1.75rem] border border-night/10 bg-paper p-5">
            <p class="text-[11px] uppercase tracking-[0.24em] text-mist">模拟收发</p>
            <p class="mt-3 text-2xl font-semibold text-ink">先跑通路径</p>
            <p class="mt-3 text-sm leading-6 text-mist">
              点击即可生成新来信，写信后自动进入已发送列表，方便先确认核心交互节奏。
            </p>
          </article>
        </div>

        <div class="grid gap-4 rounded-[1.75rem] border border-night/10 bg-paper p-5 md:grid-cols-[1fr_auto] md:items-center">
          <div>
            <p class="text-[11px] uppercase tracking-[0.24em] text-mist">运行时状态</p>
            <p class="mt-2 text-lg text-ink">
              D1: {data.dbBound ? '已绑定' : '未绑定'} / R2: {data.bucketBound ? '已绑定' : '未绑定'}
            </p>
          </div>
          <div class="text-right text-sm text-mist">
            <p>数据库消息数：{data.totalMessages}</p>
            <p>最新主题：{data.lastSubject ?? '暂无真实来信'}</p>
          </div>
        </div>
      </section>

      <section class="rounded-[2rem] border border-night/10 bg-shell/95 p-7 shadow-[0_24px_80px_rgba(32,27,22,0.08)] md:p-8">
        <div class="space-y-3">
          <p class="text-[11px] uppercase tracking-[0.28em] text-mist">登录演示</p>
          <h2 class="font-display text-4xl leading-none text-ink">进入 FlareMail</h2>
          <p class="text-sm leading-6 text-mist">
            先用固定演示账号体验交互，后续再接真实鉴权与用户数据。
          </p>
        </div>

        <form class="mt-8 space-y-5" onsubmit={handleLogin}>
          <label class="block space-y-2">
            <span class="text-sm text-mist">邮箱</span>
            <input
              bind:value={loginForm.email}
              class="w-full rounded-2xl border border-night/10 bg-paper px-4 py-3 text-base text-ink outline-none transition focus:border-accent"
              type="email"
            />
          </label>

          <label class="block space-y-2">
            <span class="text-sm text-mist">密码</span>
            <input
              bind:value={loginForm.password}
              class="w-full rounded-2xl border border-night/10 bg-paper px-4 py-3 text-base text-ink outline-none transition focus:border-accent"
              type="password"
            />
          </label>

          <label class="flex items-center justify-between rounded-2xl border border-night/10 bg-paper px-4 py-3 text-sm text-mist">
            <span>保持登录</span>
            <input bind:checked={loginForm.remember} class="h-4 w-4 accent-accent" type="checkbox" />
          </label>

          {#if loginError}
            <p class="rounded-2xl border border-coral/20 bg-coral/8 px-4 py-3 text-sm text-coral">
              {loginError}
            </p>
          {/if}

          <button
            class="w-full rounded-full bg-ink px-5 py-3 text-sm font-medium text-paper transition hover:bg-accent"
            type="submit"
          >
            登录并进入工作台
          </button>
        </form>

        <div class="mt-6 rounded-[1.75rem] border border-night/10 bg-paper p-5 text-sm leading-6 text-mist">
          <p class="font-medium text-ink">演示账号</p>
          <p class="mt-2 font-mono text-xs text-ink">{demoCredentials.email}</p>
          <p class="font-mono text-xs text-ink">{demoCredentials.password}</p>
        </div>
      </section>
    </main>
  {:else}
    <main class="mx-auto flex min-h-screen w-full max-w-[1680px] flex-col gap-5 px-4 py-4 md:px-6 md:py-6">
      <section class="rounded-[2rem] border border-night/10 bg-shell/94 px-5 py-4 shadow-[0_20px_70px_rgba(32,27,22,0.06)] md:px-7">
        <div class="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div class="space-y-2">
            <div class="flex flex-wrap items-center gap-3 text-[11px] uppercase tracking-[0.28em] text-mist">
              <span>FlareMail Workspace</span>
              <span>{runtimeLabel}</span>
              <span>{profile.company}</span>
            </div>
            <h1 class="font-display text-3xl leading-none tracking-[-0.04em] text-ink md:text-5xl">
              一个克制的邮件工作台，先把流程跑顺。
            </h1>
          </div>

          <div class="flex flex-wrap items-center gap-3">
            <button
              class="rounded-full border border-night/10 px-4 py-2 text-sm text-ink transition hover:border-accent hover:text-accent"
              onclick={receiveDemoMail}
              type="button"
            >
              模拟收信
            </button>
            <button
              class="rounded-full border border-night/10 px-4 py-2 text-sm text-ink transition hover:border-accent hover:text-accent"
              onclick={() => setSection('profile')}
              type="button"
            >
              编辑资料
            </button>
            <button
              class="rounded-full bg-ink px-4 py-2 text-sm text-paper transition hover:bg-accent"
              onclick={openCompose}
              type="button"
            >
              写邮件
            </button>
            <button
              class="rounded-full border border-night/10 px-4 py-2 text-sm text-mist transition hover:border-night/20 hover:text-ink"
              onclick={handleLogout}
              type="button"
            >
              退出
            </button>
          </div>
        </div>

        <div class="mt-4 flex flex-col gap-3 border-t border-night/8 pt-4 lg:flex-row lg:items-center lg:justify-between">
          <p class="text-sm text-mist">{banner}</p>
          <div class="flex flex-wrap gap-3 text-sm text-ink">
            <span class="rounded-full border border-night/10 px-3 py-1">未读 {unreadCount}</span>
            <span class="rounded-full border border-night/10 px-3 py-1">星标 {starredCount}</span>
            <span class="rounded-full border border-night/10 px-3 py-1">
              真实消息 {data.totalMessages}
            </span>
          </div>
        </div>
      </section>

      <section class="grid flex-1 gap-4 xl:grid-cols-[260px_380px_minmax(0,1fr)]">
        <aside class="rounded-[2rem] border border-night/10 bg-shell/94 p-4 shadow-[0_20px_70px_rgba(32,27,22,0.04)]">
          <div class="rounded-[1.5rem] border border-night/10 bg-paper p-4">
            <p class="text-[11px] uppercase tracking-[0.28em] text-mist">当前身份</p>
            <div class="mt-4 flex items-center gap-3">
              <div class="flex h-12 w-12 items-center justify-center rounded-full bg-ink text-sm font-medium text-paper">
                {profile.name.split(' ').map((part) => part[0]).join('').slice(0, 2)}
              </div>
              <div>
                <p class="text-base font-medium text-ink">{profile.name}</p>
                <p class="text-sm text-mist">{profile.role}</p>
              </div>
            </div>
            <p class="mt-4 text-sm leading-6 text-mist">{profile.email}</p>
          </div>

          <nav class="mt-4 space-y-2">
            {#each sections as section}
              <button
                class={`w-full rounded-[1.5rem] border px-4 py-4 text-left transition ${
                  activeSection === section.id
                    ? 'border-ink bg-ink text-paper'
                    : 'border-night/10 bg-paper text-ink hover:border-night/20'
                }`}
                onclick={() => setSection(section.id)}
                type="button"
              >
                <div class="flex items-center justify-between gap-3">
                  <span class="text-sm font-medium">{section.label}</span>
                  <span
                    class={`rounded-full px-2 py-0.5 text-[11px] ${
                      activeSection === section.id ? 'bg-paper/12 text-paper' : 'bg-night/5 text-mist'
                    }`}
                  >
                    {section.count()}
                  </span>
                </div>
                <p
                  class={`mt-2 text-sm leading-6 ${
                    activeSection === section.id ? 'text-paper/72' : 'text-mist'
                  }`}
                >
                  {section.note}
                </p>
              </button>
            {/each}
          </nav>

          <div class="mt-4 rounded-[1.5rem] border border-night/10 bg-paper p-4">
            <p class="text-[11px] uppercase tracking-[0.28em] text-mist">偏好摘要</p>
            <div class="mt-4 space-y-3 text-sm text-ink">
              <p>所在时区：{profile.timezone}</p>
              <p>转发状态：{profile.forwardingEnabled ? '已开启' : '已关闭'}</p>
              <p>最新真实邮件：{data.lastTimestamp ? formatDate(data.lastTimestamp) : '暂无'}</p>
            </div>
          </div>
        </aside>

        <section class="rounded-[2rem] border border-night/10 bg-shell/94 p-4 shadow-[0_20px_70px_rgba(32,27,22,0.04)]">
          {#if activeSection === 'profile'}
            <div class="rounded-[1.5rem] border border-night/10 bg-paper p-5">
              <p class="text-[11px] uppercase tracking-[0.28em] text-mist">账户概览</p>
              <h2 class="mt-3 font-display text-3xl text-ink">个人信息</h2>
              <div class="mt-6 grid gap-3">
                <div class="rounded-2xl border border-night/10 px-4 py-3">
                  <p class="text-xs uppercase tracking-[0.22em] text-mist">邮箱身份</p>
                  <p class="mt-2 text-lg text-ink">{profile.email}</p>
                </div>
                <div class="rounded-2xl border border-night/10 px-4 py-3">
                  <p class="text-xs uppercase tracking-[0.22em] text-mist">邮件签名</p>
                  <p class="mt-2 whitespace-pre-line text-sm leading-6 text-ink">{profile.signature}</p>
                </div>
                <div class="rounded-2xl border border-night/10 px-4 py-3">
                  <p class="text-xs uppercase tracking-[0.22em] text-mist">工作状态</p>
                  <p class="mt-2 text-sm leading-6 text-ink">
                    已发送 {mailbox.sent.length} 封 / 收到 {mailbox.inbox.length} 封
                  </p>
                </div>
              </div>
            </div>
          {:else}
            <div class="flex items-center justify-between border-b border-night/8 px-2 pb-4">
              <div>
                <p class="text-[11px] uppercase tracking-[0.28em] text-mist">
                  {activeSection === 'inbox' ? 'Inbox' : 'Sent'}
                </p>
                <h2 class="mt-1 text-2xl text-ink">{activeSection === 'inbox' ? '邮件列表' : '发送记录'}</h2>
              </div>
              <p class="text-sm text-mist">{activeMessages.length} 封邮件</p>
            </div>

            <div class="mt-4 space-y-3">
              {#each activeMessages as message}
                <button
                  class={`block w-full rounded-[1.5rem] border px-4 py-4 text-left transition ${
                    selectedMessage?.id === message.id
                      ? 'border-ink bg-ink text-paper'
                      : 'border-night/10 bg-paper text-ink hover:border-night/20'
                  }`}
                  onclick={() => selectMessage(message)}
                  type="button"
                >
                  <div class="flex items-start justify-between gap-3">
                    <div class="min-w-0">
                      <div class="flex items-center gap-2 text-sm">
                        <span class={`font-medium ${!message.read && message.folder === 'inbox' ? 'text-coral' : ''}`}>
                          {message.folder === 'inbox' ? message.fromName : message.toEmail}
                        </span>
                        {#if message.starred}
                          <span class={`text-[11px] ${selectedMessage?.id === message.id ? 'text-paper/70' : 'text-accent'}`}>
                            星标
                          </span>
                        {/if}
                      </div>
                      <p class="mt-2 line-clamp-1 text-base font-medium">{message.subject}</p>
                      <p class={`mt-2 line-clamp-2 text-sm leading-6 ${
                        selectedMessage?.id === message.id ? 'text-paper/72' : 'text-mist'
                      }`}>
                        {message.preview}
                      </p>
                    </div>
                    <span class={`shrink-0 text-xs ${selectedMessage?.id === message.id ? 'text-paper/65' : 'text-mist'}`}>
                      {formatDate(message.sentAt)}
                    </span>
                  </div>
                </button>
              {/each}
            </div>
          {/if}
        </section>

        <section class="rounded-[2rem] border border-night/10 bg-shell/94 p-4 shadow-[0_20px_70px_rgba(32,27,22,0.04)]">
          {#if activeSection === 'profile'}
            <form class="rounded-[1.5rem] border border-night/10 bg-paper p-5 md:p-6" onsubmit={saveProfile}>
              <div class="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p class="text-[11px] uppercase tracking-[0.28em] text-mist">资料编辑</p>
                  <h2 class="mt-2 font-display text-3xl text-ink">管理个人信息</h2>
                </div>
                <button class="rounded-full bg-ink px-4 py-2 text-sm text-paper transition hover:bg-accent" type="submit">
                  保存修改
                </button>
              </div>

              <div class="mt-6 grid gap-4 md:grid-cols-2">
                <label class="space-y-2">
                  <span class="text-sm text-mist">姓名</span>
                  <input bind:value={profile.name} class="w-full rounded-2xl border border-night/10 bg-shell px-4 py-3 text-ink outline-none transition focus:border-accent" type="text" />
                </label>
                <label class="space-y-2">
                  <span class="text-sm text-mist">职位</span>
                  <input bind:value={profile.role} class="w-full rounded-2xl border border-night/10 bg-shell px-4 py-3 text-ink outline-none transition focus:border-accent" type="text" />
                </label>
                <label class="space-y-2">
                  <span class="text-sm text-mist">公司</span>
                  <input bind:value={profile.company} class="w-full rounded-2xl border border-night/10 bg-shell px-4 py-3 text-ink outline-none transition focus:border-accent" type="text" />
                </label>
                <label class="space-y-2">
                  <span class="text-sm text-mist">邮箱</span>
                  <input bind:value={profile.email} class="w-full rounded-2xl border border-night/10 bg-shell px-4 py-3 text-ink outline-none transition focus:border-accent" type="email" />
                </label>
                <label class="space-y-2">
                  <span class="text-sm text-mist">地区</span>
                  <input bind:value={profile.location} class="w-full rounded-2xl border border-night/10 bg-shell px-4 py-3 text-ink outline-none transition focus:border-accent" type="text" />
                </label>
                <label class="space-y-2">
                  <span class="text-sm text-mist">时区</span>
                  <input bind:value={profile.timezone} class="w-full rounded-2xl border border-night/10 bg-shell px-4 py-3 text-ink outline-none transition focus:border-accent" type="text" />
                </label>
              </div>

              <label class="mt-4 flex items-center justify-between rounded-2xl border border-night/10 bg-shell px-4 py-3 text-sm text-ink">
                <span>开启自动转发到个人收件地址</span>
                <input bind:checked={profile.forwardingEnabled} class="h-4 w-4 accent-accent" type="checkbox" />
              </label>

              <label class="mt-4 block space-y-2">
                <span class="text-sm text-mist">签名</span>
                <textarea
                  bind:value={profile.signature}
                  class="min-h-40 w-full rounded-[1.5rem] border border-night/10 bg-shell px-4 py-3 text-sm leading-7 text-ink outline-none transition focus:border-accent"
                ></textarea>
              </label>

              {#if profileStatus}
                <p class="mt-4 rounded-2xl border border-accent/20 bg-accent/8 px-4 py-3 text-sm text-accent">
                  {profileStatus}
                </p>
              {/if}
            </form>
          {:else if selectedMessage}
            <article class="flex h-full flex-col rounded-[1.5rem] border border-night/10 bg-paper p-5 md:p-6">
              <div class="flex flex-wrap items-start justify-between gap-4 border-b border-night/8 pb-5">
                <div class="space-y-3">
                  <p class="text-[11px] uppercase tracking-[0.28em] text-mist">
                    {selectedMessage.folder === 'inbox' ? '收到的邮件' : '发送的邮件'}
                  </p>
                  <h2 class="max-w-3xl font-display text-3xl leading-tight text-ink">
                    {selectedMessage.subject}
                  </h2>
                  <div class="text-sm leading-6 text-mist">
                    <p>
                      {selectedMessage.folder === 'inbox' ? '发件人' : '收件人'}：
                      <span class="text-ink">
                        {selectedMessage.folder === 'inbox'
                          ? `${selectedMessage.fromName} <${selectedMessage.fromEmail}>`
                          : `${selectedMessage.toName} <${selectedMessage.toEmail}>`}
                      </span>
                    </p>
                    <p>时间：<span class="text-ink">{formatDate(selectedMessage.sentAt)}</span></p>
                    <p>标签：<span class="text-ink">{selectedMessage.labels.join(' / ')}</span></p>
                  </div>
                </div>

                <div class="flex flex-wrap gap-2">
                  <button
                    class="rounded-full border border-night/10 px-3 py-2 text-sm text-ink transition hover:border-accent hover:text-accent"
                    onclick={() => toggleStar(selectedMessage.id, selectedMessage.folder)}
                    type="button"
                  >
                    {selectedMessage.starred ? '取消星标' : '标记星标'}
                  </button>

                  {#if selectedMessage.folder === 'inbox'}
                    <button
                      class="rounded-full border border-night/10 px-3 py-2 text-sm text-ink transition hover:border-accent hover:text-accent"
                      onclick={() => toggleRead(selectedMessage.id)}
                      type="button"
                    >
                      {selectedMessage.read ? '标记未读' : '标记已读'}
                    </button>
                  {/if}

                  <button
                    class="rounded-full border border-night/10 px-3 py-2 text-sm text-ink transition hover:border-coral hover:text-coral"
                    onclick={() => removeMessage(selectedMessage.id, selectedMessage.folder)}
                    type="button"
                  >
                    删除
                  </button>
                </div>
              </div>

              <div class="flex-1 whitespace-pre-line py-6 text-[15px] leading-8 text-ink">
                {selectedMessage.body}
              </div>

              <div class="border-t border-night/8 pt-4 text-sm text-mist">
                <p>
                  {selectedMessage.folder === 'inbox'
                    ? '这里可以继续扩展回复、转发、归档、多选批量处理等真实邮件能力。'
                    : '这里可以继续扩展撤回、再次编辑、模板发送与草稿箱。'}
                </p>
              </div>
            </article>
          {:else}
            <div class="flex h-full items-center justify-center rounded-[1.5rem] border border-dashed border-night/14 bg-paper p-8 text-center text-sm leading-7 text-mist">
              当前列表为空，可以点击“模拟收信”或“写邮件”继续演示。
            </div>
          {/if}
        </section>
      </section>
    </main>

    {#if composeOpen}
      <div class="fixed inset-0 z-40 flex items-end justify-center bg-ink/16 p-3 backdrop-blur-sm md:items-center">
        <div class="w-full max-w-2xl rounded-[2rem] border border-night/10 bg-shell p-5 shadow-[0_30px_100px_rgba(32,27,22,0.12)] md:p-6">
          <div class="flex items-center justify-between gap-4">
            <div>
              <p class="text-[11px] uppercase tracking-[0.28em] text-mist">写邮件</p>
              <h2 class="mt-2 font-display text-3xl text-ink">新建邮件</h2>
            </div>
            <button
              class="rounded-full border border-night/10 px-3 py-2 text-sm text-mist transition hover:text-ink"
              onclick={closeCompose}
              type="button"
            >
              关闭
            </button>
          </div>

          <form class="mt-6 space-y-4" onsubmit={sendMessage}>
            <label class="block space-y-2">
              <span class="text-sm text-mist">收件人</span>
              <input bind:value={composeForm.toEmail} class="w-full rounded-2xl border border-night/10 bg-paper px-4 py-3 text-ink outline-none transition focus:border-accent" type="email" />
            </label>

            <label class="block space-y-2">
              <span class="text-sm text-mist">抄送</span>
              <input bind:value={composeForm.cc} class="w-full rounded-2xl border border-night/10 bg-paper px-4 py-3 text-ink outline-none transition focus:border-accent" type="text" />
            </label>

            <label class="block space-y-2">
              <span class="text-sm text-mist">主题</span>
              <input bind:value={composeForm.subject} class="w-full rounded-2xl border border-night/10 bg-paper px-4 py-3 text-ink outline-none transition focus:border-accent" type="text" />
            </label>

            <label class="block space-y-2">
              <span class="text-sm text-mist">正文</span>
              <textarea
                bind:value={composeForm.body}
                class="min-h-56 w-full rounded-[1.5rem] border border-night/10 bg-paper px-4 py-3 text-sm leading-7 text-ink outline-none transition focus:border-accent"
              ></textarea>
            </label>

            <div class="flex flex-wrap items-center justify-between gap-3 pt-2">
              <p class="text-sm text-mist">
                将使用 <span class="text-ink">{profile.email}</span> 与当前签名发送。
              </p>
              <div class="flex gap-2">
                <button
                  class="rounded-full border border-night/10 px-4 py-2 text-sm text-ink transition hover:border-night/20"
                  onclick={closeCompose}
                  type="button"
                >
                  取消
                </button>
                <button class="rounded-full bg-ink px-4 py-2 text-sm text-paper transition hover:bg-accent" type="submit">
                  发送邮件
                </button>
              </div>
            </div>
          </form>
        </div>
      </div>
    {/if}
  {/if}
</div>
