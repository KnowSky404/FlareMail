<script lang="ts">
  import { onMount, tick } from 'svelte';
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
    setupTelegram,
    unbindTelegram,
    updateTelegramSettings,
    type TelegramSettingsStatus
  } from '$lib/client/telegram-api';
  import { ClientApiError } from '$lib/client/api';

  let telegramState = $state<TelegramSettingsStatus | null>(null);
  let bindingLink = $state<string | null>(null);
  let bindingExpiresAt = $state<string | null>(null);
  let bindingCommandElement = $state<HTMLTextAreaElement>();
  const bindingCommand = $derived(bindingLink ? `/start ${new URL(bindingLink).searchParams.get('start') ?? ''}` : '');
  let generatedLinkElement = $state<HTMLDivElement>();
  let candidateElement = $state<HTMLDivElement>();
  let loading = $state(true);
  let action = $state('');
  let error = $state('');
  let message = $state('');
  let bindingExpired = $state(false);
  let disposed = false;
  let refreshRevision = 0;
  let refreshController: AbortController | undefined;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;

  const deliveryStatusLabels: Record<TelegramSettingsStatus['recentDeliveries'][number]['status'], string> = {
    pending: '已排队',
    processing: '处理中',
    retryable: '等待重试',
    sent: '已发送',
    failed: '发送失败',
    unknown_delivery: '结果未知',
    cancelled: '已取消'
  };

  function formatDate(value: string | null, timezone = telegramState?.timezone ?? 'UTC') {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.valueOf())) return '—';
    try {
      return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short', timeZone: timezone || 'UTC' }).format(date);
    } catch {
      return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(date);
    }
  }

  function errorMessage(value: unknown) {
    return value instanceof ClientApiError ? value.message : 'Telegram 设置暂时无法更新，请稍后重试。';
  }

  function cancelRefresh() {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = undefined;
    // Aborting alone cannot prevent a response already being parsed from
    // overwriting a newer confirmation/settings mutation.
    refreshRevision += 1;
    refreshController?.abort();
    refreshController = undefined;
  }

  function scheduleRefresh() {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = undefined;
    if (disposed) return;
    // Use the challenge lifetime, not a fixed attempt count: Telegram may
    // stay in the foreground for several minutes before the user returns.
    const expiresAt = bindingExpiresAt ? Date.parse(bindingExpiresAt) : NaN;
    bindingExpired = Boolean(bindingLink) && (!Number.isFinite(expiresAt) || expiresAt <= Date.now());
    if (action || !bindingLink || bindingExpired || document.visibilityState === 'hidden' ||
      telegramState?.binding?.state === 'active' || telegramState?.binding?.state === 'candidate') return;
    pollTimer = setTimeout(() => void refresh(), Math.min(5_000, expiresAt - Date.now()));
  }

  async function refresh() {
    cancelRefresh();
    if (disposed) return;
    const revision = refreshRevision;
    const controller = new AbortController();
    refreshController = controller;
    try {
      const result = await fetchTelegramSettings(controller.signal);
      if (disposed || revision !== refreshRevision) return;
      const revealCandidate = result.binding?.state === 'candidate' && telegramState?.binding?.state !== 'candidate';
      telegramState = result;
      error = '';
      if (result.binding?.state === 'active') {
        bindingLink = null;
        bindingExpiresAt = null;
      }
      if (revealCandidate) {
        await tick();
        if (disposed || revision !== refreshRevision) return;
        candidateElement?.focus({ preventScroll: true });
        candidateElement?.scrollIntoView({ block: 'center' });
      }
    } catch (value) {
      if (disposed || revision !== refreshRevision) return;
      error = errorMessage(value);
    } finally {
      if (!disposed && revision === refreshRevision) {
        refreshController = undefined;
        loading = false;
        scheduleRefresh();
      }
    }
  }

  onMount(() => {
    const resume = () => {
      if (document.visibilityState === 'hidden') cancelRefresh();
      else if (!action) void refresh();
    };
    window.addEventListener('focus', resume);
    document.addEventListener('visibilitychange', resume);
    void refresh();
    return () => {
      disposed = true;
      cancelRefresh();
      window.removeEventListener('focus', resume);
      document.removeEventListener('visibilitychange', resume);
    };
  });

  async function beginBinding() {
    cancelRefresh();
    action = 'bind';
    error = '';
    message = '';
    try {
      const result = await createTelegramBinding();
      bindingLink = result.deepLink;
      bindingExpiresAt = result.expiresAt;
      bindingExpired = false;
      message = '打开 Telegram 后点击 Start / 开始；若没有反应，请复制下方完整绑定命令发送，识别后回到这里确认。';
      await refresh();
      await tick();
      generatedLinkElement?.focus();
      generatedLinkElement?.scrollIntoView({ block: 'center' });
    } catch (value) {
      error = errorMessage(value);
    } finally {
      action = '';
      scheduleRefresh();
    }
  }

  async function connectTelegram() {
    cancelRefresh();
    action = 'setup';
    error = '';
    message = '';
    try {
      const result = await setupTelegram();
      message = `Telegram 已连接（@${result.botUsername}），Webhook 已更新。这不代表账号已绑定，请继续生成链接并完成绑定确认。`;
    } catch (value) {
      error = errorMessage(value);
    } finally {
      action = '';
      scheduleRefresh();
    }
  }

  async function copyBindingCommand() {
    try {
      await navigator.clipboard.writeText(bindingCommand);
      message = '完整绑定命令已复制，请粘贴到机器人私聊中发送，再回到这里确认绑定。';
    } catch {
      bindingCommandElement?.focus();
      bindingCommandElement?.select();
      message = '无法自动复制，已选中完整绑定命令，请手动复制后发送到机器人私聊。';
    }
  }

  async function confirmBinding() {
    cancelRefresh();
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
      scheduleRefresh();
    }
  }

  async function changeSettings(input: { enabled?: boolean; privacyMode?: boolean; summaryEnabled?: boolean }) {
    if (!telegramState?.binding || telegramState.binding.state !== 'active') return;
    cancelRefresh();
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
      scheduleRefresh();
    }
  }

  async function testNotification() {
    cancelRefresh();
    action = 'test';
    error = '';
    try {
      await sendTelegramTest();
      message = '测试通知已发送。';
    } catch (value) {
      error = errorMessage(value);
    } finally {
      action = '';
      scheduleRefresh();
    }
  }

  async function removeBinding() {
    if (!window.confirm('解除绑定并取消尚未发出的 Telegram 通知？')) return;
    cancelRefresh();
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
      scheduleRefresh();
    }
  }

  async function retry(id: string) {
    if (!window.confirm('unknown_delivery 可能已经在 Telegram 显示；手动重试可能产生重复通知。继续？')) return;
    cancelRefresh();
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
      scheduleRefresh();
    }
  }
</script>

<Panel title="Telegram 通知" description="将入站邮件的最小摘要发送到你绑定的 Telegram 私聊。不会发送正文、附件或原始邮件。">
  {#if loading}
    <p class="muted">正在读取 Telegram 通知状态…</p>
  {:else if !telegramState?.globalEnabled}
    <div class="notice"><Badge>未启用</Badge><span>请在 Cloudflare Dashboard 的 Variables and Secrets 中启用 Telegram 后刷新。</span></div>
  {:else if !telegramState.configReady}
    <div class="notice warning"><Badge>需配置</Badge><span>请在 Cloudflare Dashboard 的 Variables and Secrets 中补齐 Telegram 配置后刷新。</span></div>
  {:else if !telegramState.schemaReady}
    <div class="notice warning"><Badge>需迁移</Badge><span>Telegram 配置已就绪，但数据库迁移尚未完成。</span></div>
  {:else}
    <div class="stack">
      <div class="setup-strip">
        <div class="setup-copy">
          <strong>线上连接</strong>
          <p class="muted">首次使用或更换 Bot 时点击。页面会自动验证 Bot 并注册 Webhook；当前登录用户即可操作，无需管理员/普通用户角色。</p>
        </div>
        <Button variant="secondary" loading={action === 'setup'} disabled={action !== ''} onclick={() => void connectTelegram()}>连接 / 更新 Webhook</Button>
      </div>

      {#if telegramState.binding?.state === 'candidate'}
        <div class="stack" bind:this={candidateElement} tabindex="-1" role="group" aria-label="确认 Telegram 绑定">
          <div class="notice"><Badge class="shrink-0 whitespace-nowrap">待确认</Badge><span>Telegram 已识别此私聊；请在 FlareMail 点击确认。</span></div>
          <p class="muted">链接有效至 {formatDate(telegramState.binding.candidateExpiresAt ?? bindingExpiresAt)}。确认后通知仍默认关闭。</p>
          <div class="actions"><Button loading={action === 'confirm'} disabled={action !== ''} onclick={() => void confirmBinding()}>确认绑定</Button><Button variant="secondary" loading={action === 'bind'} disabled={action !== ''} onclick={() => void beginBinding()}>重新生成链接</Button><Button variant="secondary" disabled={action !== ''} onclick={() => void refresh()}>刷新状态</Button></div>
        </div>
      {:else if telegramState.binding?.state === 'active'}
        <div class="stack">
          <div class="notice"><Badge class={telegramState.binding.enabled ? 'success' : ''}>{telegramState.binding.enabled ? '已启用' : '已绑定'}</Badge><span>{telegramState.binding.enabled ? '新邮件会进入 Telegram 私聊。' : '绑定已确认，通知当前关闭。'}</span></div>
          <div class="identity-summary" role="group" aria-label="Telegram 绑定身份">
            <span class="muted">绑定身份</span>
            <strong>{telegramState.binding.telegramDisplayName || 'Telegram 用户'}</strong>
            {#if telegramState.binding.telegramUsername}<span class="muted">@{telegramState.binding.telegramUsername}</span>{/if}
          </div>
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
          <div class="notice"><Badge class="shrink-0 whitespace-nowrap">未绑定</Badge><span>首次使用请先连接 Webhook，再生成链接并在 Telegram 私聊中发送带绑定码的完整命令。</span></div>
          <Button loading={action === 'bind'} disabled={action !== ''} onclick={() => void beginBinding()}>生成 Telegram 绑定链接</Button>
          {#if !bindingLink}<Button variant="secondary" disabled={action !== ''} onclick={() => void refresh()}>刷新绑定状态</Button>{/if}
        </div>
      {/if}
    </div>
  {/if}

  {#if bindingLink && bindingExpired}
    <p class="feedback error" role="status">本次绑定链接已过期，请重新生成链接和命令。若已在 Telegram 完成操作，请先刷新绑定状态。</p>
    <Button variant="secondary" disabled={action !== ''} onclick={() => void refresh()}>刷新绑定状态</Button>
  {:else if bindingLink}
    <div class="generated-link" bind:this={generatedLinkElement} tabindex="-1" role="group" aria-label="生成的 Telegram 绑定链接">
      <strong>绑定链接（仅显示本次）</strong>
      <a class="bind-link" href={bindingLink} target="_blank" rel="noreferrer">打开 Telegram 继续绑定</a>
      <label class="muted" for="telegram-binding-link">也可以复制以下完整链接</label>
      <textarea id="telegram-binding-link" class="link-value" readonly value={bindingLink} rows="3" onclick={(event) => event.currentTarget.select()}></textarea>
      <p class="muted">仅打开聊天不会完成绑定。若链接跳转后没有反应，请发送以下完整命令；只发送 /start 不会绑定。</p>
      <label class="muted" for="telegram-binding-command">完整绑定命令（含一次性绑定码）</label>
      <textarea id="telegram-binding-command" class="link-value" bind:this={bindingCommandElement} readonly value={bindingCommand} rows="2" onclick={(event) => event.currentTarget.select()}></textarea>
      <div class="actions"><Button variant="secondary" onclick={() => void copyBindingCommand()}>复制绑定命令</Button><Button variant="secondary" disabled={action !== ''} onclick={() => void refresh()}>刷新绑定状态</Button></div>
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
          <div><strong>{delivery.subject || '无主题'}</strong><span>{formatDate(delivery.receivedAt)} · {deliveryStatusLabels[delivery.status]}</span></div>
          {#if ['failed', 'retryable', 'unknown_delivery'].includes(delivery.status)}<Button variant="secondary" disabled={action !== ''} onclick={() => void retry(delivery.id)}>{delivery.status === 'unknown_delivery' ? '手动重试（可能重复）' : '重试'}</Button>{/if}
        </div>
      {/each}
    </div>
  {/if}
</Panel>

<style>
  .stack { display: grid; gap: var(--space-3); }
  .notice { display: flex; align-items: center; gap: var(--space-3); color: var(--fm-text-secondary); font-size: 13px; }
  .notice.warning { color: var(--fm-warning); }
  .identity-summary { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--space-2); }
  .identity-summary strong { color: var(--fm-text); font-size: 13px; }
  .setup-strip { display: flex; align-items: center; justify-content: space-between; gap: var(--space-4); padding: var(--space-3); border: 1px solid var(--fm-border); border-radius: var(--radius-md); background: var(--fm-surface-subtle); }
  .setup-copy { display: grid; gap: var(--space-1); min-width: 0; }
  .setup-copy strong { color: var(--fm-text); font-size: 13px; }
  .muted { margin: 0; color: var(--fm-text-muted); font-size: 12px; line-height: 1.6; }
  .bind-link { color: var(--fm-accent); font-size: 13px; overflow-wrap: anywhere; }
  .link-value { width: 100%; min-width: 0; box-sizing: border-box; padding: var(--space-2); border: 1px solid var(--fm-border); border-radius: var(--radius-md); background: var(--fm-surface); color: var(--fm-text); font: inherit; font-size: 13px; overflow-wrap: anywhere; resize: vertical; }
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
  @media (max-width: 620px) { .setup-strip { align-items: flex-start; flex-direction: column; } }
  @media (max-width: 520px) { .delivery-row { align-items: flex-start; flex-direction: column; } }
</style>
