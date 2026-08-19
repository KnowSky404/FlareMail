<script lang="ts">
  import { onMount } from 'svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import Badge from '$lib/components/ui/Badge.svelte';
  import Panel from '$lib/components/ui/Panel.svelte';
  import Select from '$lib/components/ui/Select.svelte';
  import Switch from '$lib/components/ui/Switch.svelte';
  import TextArea from '$lib/components/ui/TextArea.svelte';
  import TextField from '$lib/components/ui/TextField.svelte';
  import type { UserProfile } from '$lib/domain/mail';
  import { applyTheme, readThemePreference, type ThemePreference } from '$lib/theme';

  const createProfileDraft = (profile: UserProfile): UserProfile => ({ ...profile });

  type RuntimeDiagnostics = {
    environment: string;
    d1Configured: boolean;
    r2Configured: boolean;
    outboundConfigured: boolean;
    outboundMode: string;
    webhookConfigured: boolean;
    senderConfigured: boolean;
    autoReplyEnabled: boolean;
    notificationEnabled: boolean;
  };

  let {
    profile,
    diagnostics = null,
    status = '',
    pending = false,
    onSave
  }: {
    profile: UserProfile;
    diagnostics?: RuntimeDiagnostics | null;
    status?: string;
    pending?: boolean;
    onSave: (next: UserProfile) => void | Promise<void>;
  } = $props();

  let nextProfile = $state<UserProfile>(
    createProfileDraft({
      name: '',
      role: '',
      email: '',
      company: '',
      location: '',
      timezone: '',
      forwardingEnabled: false,
      signature: ''
    })
  );
  let themePreference = $state<ThemePreference>('system');

  onMount(() => {
    themePreference = readThemePreference();
  });

  $effect(() => {
    nextProfile = createProfileDraft(profile);
  });

  function submit(event: SubmitEvent) {
    event.preventDefault();
    void onSave(nextProfile);
  }
</script>

<div class="settings-layout">
  <header>
    <h1>设置</h1>
    <p>管理个人资料、发件身份与邮件偏好。</p>
  </header>

  <form onsubmit={submit}>
    <Panel title="个人资料" description="这些信息用于工作区账号上下文。">
      <div class="field-grid">
        <TextField
          id="profile-name"
          label="显示姓名"
          value={nextProfile.name}
          required
          disabled={pending}
          oninput={(event) => (nextProfile.name = event.currentTarget.value)}
        />
        <TextField
          id="profile-role"
          label="职位角色"
          value={nextProfile.role}
          disabled={pending}
          oninput={(event) => (nextProfile.role = event.currentTarget.value)}
        />
        <TextField
          id="profile-company"
          label="公司名称"
          value={nextProfile.company}
          disabled={pending}
          oninput={(event) => (nextProfile.company = event.currentTarget.value)}
        />
        <TextField
          id="profile-timezone"
          label="所在时区"
          value={nextProfile.timezone}
          disabled={pending}
          oninput={(event) => (nextProfile.timezone = event.currentTarget.value)}
        />
        <TextField
          id="profile-location"
          label="所在地区"
          value={nextProfile.location}
          disabled={pending}
          oninput={(event) => (nextProfile.location = event.currentTarget.value)}
        />
      </div>
    </Panel>

    <Panel title="发件身份" description="用于新邮件、回复和转发；生产外发由统一网关处理。">
      <div class="identity-grid">
        <TextField
          id="profile-email"
          label="发件邮箱"
          type="email"
          value={nextProfile.email}
          required
          disabled={pending}
          oninput={(event) => (nextProfile.email = event.currentTarget.value)}
        />
        <TextArea
          id="profile-signature"
          label="纯文本签名"
          value={nextProfile.signature}
          rows={4}
          disabled={pending}
          placeholder="此致，"
          oninput={(event) => (nextProfile.signature = event.currentTarget.value)}
        />
      </div>
      {#if diagnostics}<p class="section-note">当前通道：<Badge>{diagnostics.outboundMode}</Badge> · 发件地址{diagnostics.senderConfigured ? '已配置' : '缺失'}</p>{/if}
    </Panel>

    <Panel title="自动回复" description="自动回复由 Worker 运行时配置控制，避免在浏览器保存供应商凭据。">
      <div class="configuration-row">
        <div><strong>入站自动回复</strong><p>主题前缀与正文由受保护的运行时变量管理。</p></div>
        <Badge>{diagnostics?.autoReplyEnabled ? '已启用' : '未启用'}</Badge>
      </div>
    </Panel>

    <Panel title="通知" description="控制入站邮件在工作区之外的通知行为。">
      <Switch
        id="profile-forwarding"
        checked={nextProfile.forwardingEnabled}
        label="入站邮件通知"
        description="收到新邮件后，向运行时配置的通知地址发送一条摘要通知；不会转发原始邮件。"
        disabled={pending}
        onchange={(checked) => (nextProfile.forwardingEnabled = checked)}
      />
      <p class="section-note">系统通知：{diagnostics?.notificationEnabled ? '运行时已启用' : '运行时未启用'}。通知地址不会在此页面显示。</p>
    </Panel>

    <Panel title="外观" description="主题选择保存在当前浏览器，并在首屏绘制前应用。">
      <div class="theme-field">
        <Select
          id="profile-theme"
          label="颜色主题"
          value={themePreference}
          options={[
            { value: 'system', label: '跟随系统' },
            { value: 'light', label: '浅色' },
            { value: 'dark', label: '深色' }
          ]}
          onchange={(value) => {
            themePreference = value as ThemePreference;
            applyTheme(themePreference);
          }}
        />
      </div>
    </Panel>

    <Panel title="诊断" description="仅显示配置状态，不返回 secret、凭据或邮件正文。">
      {#if diagnostics}
        <dl class="diagnostic-grid">
          <div><dt>运行环境</dt><dd><Badge>{diagnostics.environment}</Badge></dd></div>
          <div><dt>D1</dt><dd>{diagnostics.d1Configured ? '已配置' : '缺失'}</dd></div>
          <div><dt>R2</dt><dd>{diagnostics.r2Configured ? '已配置' : '缺失'}</dd></div>
          <div><dt>外发网关</dt><dd>{diagnostics.outboundConfigured ? '已配置' : '缺失'}</dd></div>
          <div><dt>Webhook 验签</dt><dd>{diagnostics.webhookConfigured ? '已配置' : '缺失'}</dd></div>
        </dl>
      {:else}
        <p class="section-note">诊断状态暂不可用，请稍后刷新。</p>
      {/if}
    </Panel>

    <div class="save-row">
      <Button type="submit" loading={pending}>{pending ? '正在保存' : '保存设置'}</Button>
      {#if status}
        <p role="status" aria-live="polite" class:error={!status.includes('已保存')}>{status}</p>
      {/if}
    </div>
  </form>
</div>

<style>
  .settings-layout {
    width: min(100%, 920px);
    margin: 0 auto;
  }

  header {
    margin-bottom: var(--space-6);
  }

  h1 {
    margin: 0;
    font-size: 22px;
    font-weight: 650;
    letter-spacing: -0.025em;
  }

  header p {
    margin: var(--space-1) 0 0;
    color: var(--fm-text-muted);
  }

  form {
    display: grid;
    gap: var(--space-5);
  }

  .field-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--space-4);
  }

  .identity-grid {
    display: grid;
    gap: var(--space-4);
  }

  .configuration-row,
  .diagnostic-grid > div {
    display: flex;
    min-height: 44px;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
  }

  .configuration-row strong,
  .diagnostic-grid dt {
    color: var(--fm-text);
    font-size: 14px;
    font-weight: 600;
  }

  .configuration-row p,
  .section-note {
    margin: var(--space-1) 0 0;
    color: var(--fm-text-muted);
    font-size: 12px;
  }

  .diagnostic-grid {
    display: grid;
    margin: 0;
  }

  .diagnostic-grid > div + div {
    border-top: 1px solid var(--fm-border);
  }

  .diagnostic-grid dd {
    margin: 0;
    color: var(--fm-text-secondary);
    font-size: 13px;
  }

  .save-row {
    display: flex;
    min-height: 44px;
    align-items: center;
    gap: var(--space-4);
  }

  .theme-field {
    max-width: 320px;
  }

  .save-row p {
    margin: 0;
    color: var(--fm-success);
    font-size: 13px;
  }

  .save-row p.error {
    color: var(--fm-danger);
  }

  @media (max-width: 720px) {
    .field-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
