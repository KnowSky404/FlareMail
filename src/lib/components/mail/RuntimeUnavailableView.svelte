<script lang="ts">
  import CircleAlert from '@lucide/svelte/icons/circle-alert';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import type { RuntimeUnavailableState } from '$lib/domain/runtime-state';

  let { state }: { state: RuntimeUnavailableState } = $props();

  const labels: Record<RuntimeUnavailableState['code'], { title: string; description: string }> = {
    CONFIG_INVALID: { title: '服务配置尚未完成', description: '运行环境缺少必要绑定或生产配置。请由操作者检查部署诊断。' },
    AUTHENTICATION_UNAVAILABLE: { title: '认证服务暂不可用', description: '当前无法安全读取会话。你的登录状态没有被当作退出处理。' },
    SCHEMA_NOT_READY: { title: '数据库迁移尚未完成', description: '代码与 D1 schema 版本不一致。请先执行对应的 append-only migration。' },
    D1_UNAVAILABLE: { title: '工作区数据服务暂不可用', description: '当前无法安全读取 D1。页面没有把存储故障伪装成未登录。' },
    R2_UNAVAILABLE: { title: '对象存储暂不可用', description: '邮件正文或附件存储当前不可访问。请稍后重试。' },
    NETWORK_FAILURE: { title: '外部服务连接失败', description: '运行时网络请求没有完成。请稍后重试并保留详情 ID。' },
    INTERNAL_ERROR: { title: '工作区暂时无法载入', description: '服务器遇到未分类错误。请使用详情 ID 查询脱敏日志。' }
  };
  const copy = $derived(labels[state.code]);
</script>

<main class="unavailable-shell">
  <section aria-labelledby="unavailable-title">
    <span class="icon" aria-hidden="true"><CircleAlert size={24} /></span>
    <div>
      <p class="eyebrow">FlareMail runtime</p>
      <h1 id="unavailable-title">{copy.title}</h1>
      <p class="description">{copy.description}</p>
      <p class="request-id">详情 ID：<code>{state.requestId}</code></p>
      <div class="actions">
        <button type="button" onclick={() => location.reload()} disabled={!state.retryable}><RefreshCw size={16} aria-hidden="true" />重试</button>
        <a href="/api/health" target="_blank" rel="noreferrer">打开只读诊断</a>
      </div>
    </div>
  </section>
</main>

<style>
  .unavailable-shell { display: grid; min-height: 100dvh; place-items: center; padding: 24px; background: var(--fm-canvas); }
  section { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 16px; width: min(620px, 100%); padding: 24px; border: 1px solid var(--fm-border); border-radius: var(--radius-lg); background: var(--fm-surface); }
  .icon { display: grid; width: 44px; height: 44px; place-items: center; border-radius: var(--radius-md); color: var(--fm-danger); background: var(--fm-danger-soft); }
  .eyebrow { margin: 0 0 6px; color: var(--fm-text-muted); font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
  h1 { margin: 0; color: var(--fm-text); font-size: 20px; line-height: 1.3; }
  .description { margin: 10px 0 0; color: var(--fm-text-secondary); font-size: 14px; line-height: 1.6; }
  .request-id { margin: 12px 0 0; color: var(--fm-text-muted); font-size: 12px; overflow-wrap: anywhere; }
  code { color: var(--fm-text-secondary); }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 18px; }
  button, a { display: inline-flex; min-height: 44px; align-items: center; justify-content: center; gap: 7px; padding: 0 14px; border: 1px solid var(--fm-border); border-radius: var(--radius-md); color: var(--fm-text); background: var(--fm-surface); font-size: 13px; font-weight: 600; text-decoration: none; }
  button:not(:disabled), a { cursor: pointer; }
  button:not(:disabled):hover, a:hover { background: var(--fm-surface-hover); }
  button:disabled { opacity: .55; }
  @media (max-width: 480px) { section { grid-template-columns: 1fr; padding: 18px; } }
</style>
