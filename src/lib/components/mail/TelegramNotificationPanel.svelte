<script lang="ts">
  import { onMount } from 'svelte';
  import Badge from '$lib/components/ui/Badge.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import Panel from '$lib/components/ui/Panel.svelte';
  import Switch from '$lib/components/ui/Switch.svelte';
  import {
    confirmTelegramBinding,
    createTelegramBinding,
    fetchTelegramSettings,
    retryTelegramDelivery,
    sendTelegramTest,
    unbindTelegram,
    updateTelegramSettings,
    type TelegramSettingsStatus
  } from '$lib/client/telegram-api';
  import { ClientApiError } from '$lib/client/api';

  let telegramState = $state<TelegramSettingsStatus | null>(null);
  let bindingLink = $state<string | null>(null);
  let bindingExpiresAt = $state<string | null>(null);
  let loading = $state(true);
  let action = $state('');
  let error = $state('');
  let message = $state('');
  let pollCount = 0;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;

  const formatDate = (value: string | null) => value ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '—';

  function errorMessage(value: unknown) {
    return value instanceof ClientApiError ? value.message : 'Telegram 设置暂时无法更新，请稍后重试。';
  }

  async function refresh() {
    try {
      telegramState = await fetchTelegramSettings();
      error = '';
      if (telegramState?.binding?.state === 'candidate' && pollCount < 12) {
        pollCount += 1;
        pollTimer = setTimeout(() => void refresh(), 5_000);
      }
    } catch (value) {
      error = errorMessage(value);
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void refresh();
    return () => {
      if (pollTimer) clearTimeout(pollTimer);
    };
  });

  async function beginBinding() {
    action = 'bind';
    error = '';
    message = '';
    try {
      const result = await createTelegramBinding();
      bindingLink = result.deepLink;
      bindingExpiresAt = result.expiresAt;
      pollCount = 0;
      message = '请在 Telegram 私聊中打开链接并发送 /start；识别后回到这里确认。';
      await refresh();
    } catch (value) {
      error = errorMessage(value);
    } finally {
      action = '';
    }
  }

  async function confirmBinding() {
    action = 'confirm';
    error = '';
    try {
      telegramState = await confirmTelegramBinding();
      bindingLink = null;
      message = '绑定已确认。通知仍保持关闭，请按需开启。';
    } catch (value) {
      error = errorMessage(value);
    } finally {
      action = '';
    }
  }

  async function changeSettings(input: { enabled?: boolean; privacyMode?: boolean; summaryEnabled?: boolean }) {
    if (!telegramState?.binding || telegramState.binding.state !== 'active') return;
    action = 'settings';
    error = '';
    try {
      const result = await updateTelegramSettings(input);
      if (result.settings && telegramState?.binding) telegramState = { ...telegramState, userEnabled: result.settings.enabled, binding: { ...telegramState.binding, ...result.settings } };
      message = 'Telegram 设置已保存。';
    } catch (value) {
      error = errorMessage(value);
    } finally {
      action = '';
    }
  }

  async function testNotification() {
    action = 'test';
    error = '';
    try {
      await sendTelegramTest();
      message = '测试通知已发送。';
    } catch (value) {
      error = errorMessage(value);
    } finally {
      action = '';
    }
  }

  async function removeBinding() {
    if (!window.confirm('解除绑定并取消尚未发出的 Telegram 通知？')) return;
    action = 'unbind';
    error = '';
    try {
      telegramState = await unbindTelegram();
      bindingLink = null;
      message = 'Telegram 绑定已解除。';
    } catch (value) {
      error = errorMessage(value);
    } finally {
      action = '';
    }
  }

  async function retry(id: string) {
    if (!window.confirm('unknown_delivery 可能已经在 Telegram 显示；手动重试可能产生重复通知。继续？')) return;
    action = `retry:${id}`;
    error = '';
    try {
      await retryTelegramDelivery(id);
      message = '通知已加入手动重试队列。';
      await refresh();
    } catch (value) {
      error = errorMessage(value);
    } finally {
      action = '';
    }
  }
</script>

<Panel title="Telegram 通知" description="将入站邮件的最小摘要发送到你绑定的 Telegram 私聊。不会发送正文、附件或原始邮件。">
  {#if loading}
    <p class="muted">正在读取 Telegram 通知状态…</p>
  {:else if !telegramState?.globalEnabled}
    <div class="notice"><Badge>未启用</Badge><span>此部署尚未启用 Telegram 通知。</span></div>
  {:else if !telegramState.configReady || !telegramState.schemaReady}
    <div class="notice warning"><Badge>需配置</Badge><span>Telegram 运行时或数据库迁移尚未就绪，请联系部署管理员。</span></div>
  {:else if telegramState.binding?.state === 'candidate'}
    <div class="stack">
      <div class="notice"><Badge>待确认</Badge><span>Telegram 已识别此私聊；请在 FlareMail 点击确认。</span></div>
      {#if bindingLink}
        <a class="bind-link" href={bindingLink} target="_blank" rel="noreferrer">重新打开 Telegram 绑定链接</a>
      {/if}
      <p class="muted">链接有效至 {formatDate(telegramState.binding.candidateExpiresAt ?? bindingExpiresAt)}。确认后通知仍默认关闭。</p>
      <div class="actions"><Button loading={action === 'confirm'} onclick={() => void confirmBinding()}>确认绑定</Button><Button variant="secondary" onclick={() => void refresh()}>刷新状态</Button></div>
    </div>
  {:else if telegramState.binding?.state === 'active'}
    <div class="stack">
      <div class="notice"><Badge class={telegramState.binding.enabled ? 'success' : ''}>{telegramState.binding.enabled ? '已启用' : '已绑定'}</Badge><span>{telegramState.binding.enabled ? '新邮件会进入 Telegram 私聊。' : '绑定已确认，通知当前关闭。'}</span></div>
      <Switch
        id="telegram-enabled"
        checked={telegramState.binding.enabled}
        label="启用入站 Telegram 通知"
        description="仅通知可信登录地址收到的入站邮件。"
        disabled={action !== ''}
        onchange={(checked) => void changeSettings({ enabled: checked })}
      />
      <Switch
        id="telegram-privacy"
        checked={telegramState.binding.privacyMode}
        label="隐私模式"
        description="只发送“收到一封新邮件”和查看按钮，不包含发件人、主题或地址。"
        disabled={action !== ''}
        onchange={(checked) => void changeSettings({ privacyMode: checked })}
      />
      <Switch
        id="telegram-summary"
        checked={telegramState.binding.summaryEnabled}
        label="包含短摘要"
        description="在非隐私模式下附带最多 300 个字符的纯文本摘要。"
        disabled={action !== '' || telegramState.binding.privacyMode}
        onchange={(checked) => void changeSettings({ summaryEnabled: checked })}
      />
      <div class="actions"><Button variant="secondary" loading={action === 'test'} disabled={!telegramState.binding.enabled || action !== ''} onclick={() => void testNotification()}>发送测试通知</Button><Button variant="danger" loading={action === 'unbind'} disabled={action !== ''} onclick={() => void removeBinding()}>解除绑定</Button></div>
      {#if telegramState.binding.lastErrorCode}<p class="muted">最近错误：{telegramState.binding.lastErrorCode} · {formatDate(telegramState.binding.lastErrorAt)}</p>{/if}
    </div>
  {:else}
    <div class="stack">
      <div class="notice"><Badge>未绑定</Badge><span>生成一次性链接后，在 Telegram 私聊中发送 /start。</span></div>
      <Button loading={action === 'bind'} disabled={action !== ''} onclick={() => void beginBinding()}>生成 Telegram 绑定链接</Button>
    </div>
  {/if}

  {#if bindingLink && telegramState?.binding?.state !== 'candidate'}
    <div class="generated-link">
      <strong>绑定链接（仅显示本次）</strong>
      <a class="bind-link" href={bindingLink} target="_blank" rel="noreferrer">打开 Telegram 继续绑定</a>
      <p class="muted">链接有效至 {formatDate(bindingExpiresAt)}，不会保存在浏览器或 URL 状态中。</p>
    </div>
  {/if}

  {#if message}<p class="feedback" role="status" aria-live="polite">{message}</p>{/if}
  {#if error}<p class="feedback error" role="alert">{error}</p>{/if}

  {#if telegramState?.recentDeliveries?.length}
    <div class="history">
      <h3>最近通知</h3>
      {#each telegramState.recentDeliveries as delivery (delivery.id)}
        <div class="delivery-row">
          <div><strong>{delivery.subject || '无主题'}</strong><span>{formatDate(delivery.receivedAt)} · {delivery.status}</span></div>
          {#if ['failed', 'retryable', 'unknown_delivery'].includes(delivery.status)}<Button variant="secondary" disabled={action !== ''} onclick={() => void retry(delivery.id)}>重试</Button>{/if}
        </div>
      {/each}
    </div>
  {/if}
</Panel>

<style>
  .stack { display: grid; gap: var(--space-3); }
  .notice { display: flex; align-items: center; gap: var(--space-3); color: var(--fm-text-secondary); font-size: 13px; }
  .notice.warning { color: var(--fm-warning); }
  .muted { margin: 0; color: var(--fm-text-muted); font-size: 12px; line-height: 1.6; }
  .bind-link { color: var(--fm-accent); font-size: 13px; overflow-wrap: anywhere; }
  .actions { display: flex; flex-wrap: wrap; gap: var(--space-3); align-items: center; }
  .generated-link { display: grid; gap: var(--space-2); margin-top: var(--space-4); padding-top: var(--space-4); border-top: 1px solid var(--fm-border); }
  .feedback { margin: var(--space-3) 0 0; color: var(--fm-success); font-size: 13px; }
  .feedback.error { color: var(--fm-danger); }
  .history { display: grid; gap: var(--space-2); margin-top: var(--space-5); padding-top: var(--space-4); border-top: 1px solid var(--fm-border); }
  .history h3 { margin: 0; font-size: 14px; }
  .delivery-row { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); padding: var(--space-2) 0; border-top: 1px solid var(--fm-border); }
  .delivery-row > div { min-width: 0; display: grid; gap: 2px; }
  .delivery-row strong, .delivery-row span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .delivery-row span { color: var(--fm-text-muted); font-size: 12px; }
  @media (max-width: 520px) { .delivery-row { align-items: flex-start; flex-direction: column; } }
</style>
