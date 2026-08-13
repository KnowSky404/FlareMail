<script lang="ts">
  import Button from '$lib/components/ui/Button.svelte';
  import Panel from '$lib/components/ui/Panel.svelte';
  import Switch from '$lib/components/ui/Switch.svelte';
  import TextArea from '$lib/components/ui/TextArea.svelte';
  import TextField from '$lib/components/ui/TextField.svelte';
  import type { UserProfile } from '$lib/domain/mail';

  const createProfileDraft = (profile: UserProfile): UserProfile => ({ ...profile });

  let {
    profile,
    status = '',
    pending = false,
    onSave
  }: {
    profile: UserProfile;
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
    <Panel title="个人资料" description="这些信息会显示在工作区和新邮件中。">
      <div class="field-grid">
        <TextField
          id="profile-email"
          label="邮箱地址"
          type="email"
          value={nextProfile.email}
          required
          disabled={pending}
          oninput={(event) => (nextProfile.email = event.currentTarget.value)}
        />
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

    <Panel title="邮件偏好" description="控制入站邮件在工作区之外的处理方式。">
      <Switch
        id="profile-forwarding"
        checked={nextProfile.forwardingEnabled}
        label="转发入站邮件"
        description="将收到的邮件转发到已配置的通知地址。"
        disabled={pending}
        onchange={(checked) => (nextProfile.forwardingEnabled = checked)}
      />
    </Panel>

    <Panel title="邮件签名" description="新邮件、回复和转发会使用这段纯文本签名。">
      <TextArea
        id="profile-signature"
        label="签名内容"
        value={nextProfile.signature}
        rows={6}
        disabled={pending}
        placeholder="此致，"
        oninput={(event) => (nextProfile.signature = event.currentTarget.value)}
      />
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

  .save-row {
    display: flex;
    min-height: 44px;
    align-items: center;
    gap: var(--space-4);
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
