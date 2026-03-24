<script lang="ts">
  import type { MailFolder, UserProfile } from '$lib/mock/mailbox';

  type AppSection = MailFolder | 'profile';

  let {
    profile,
    activeSection,
    unreadCount,
    sentCount,
    draftCount,
    lastTimestamp,
    forwardingEnabled,
    onSelectSection
  }: {
    profile: UserProfile;
    activeSection: AppSection;
    unreadCount: number;
    sentCount: number;
    draftCount: number;
    lastTimestamp: string | null;
    forwardingEnabled: boolean;
    onSelectSection: (section: AppSection) => void;
  } = $props();

  const sections = $derived([
    { id: 'inbox', label: '收件箱', count: unreadCount, note: '新来信与待处理邮件' },
    { id: 'sent', label: '已发送', count: sentCount, note: '查看发送历史与草拟节奏' },
    { id: 'drafts', label: '草稿箱', count: draftCount, note: '继续编辑尚未发送的邮件' },
    { id: 'profile', label: '个人信息', count: 1, note: '编辑签名、邮箱身份与偏好' }
  ] as const);

  const formatDate = (value: string) =>
    new Intl.DateTimeFormat('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    }).format(new Date(value));
</script>

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
        onclick={() => onSelectSection(section.id)}
        type="button"
      >
        <div class="flex items-center justify-between gap-3">
          <span class="text-sm font-medium">{section.label}</span>
          <span
            class={`rounded-full px-2 py-0.5 text-[11px] ${
              activeSection === section.id ? 'bg-paper/12 text-paper' : 'bg-night/5 text-mist'
            }`}
          >
            {section.count}
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
      <p>转发状态：{forwardingEnabled ? '已开启' : '已关闭'}</p>
      <p>最近活动：{lastTimestamp ? formatDate(lastTimestamp) : '暂无'}</p>
    </div>
  </div>
</aside>
