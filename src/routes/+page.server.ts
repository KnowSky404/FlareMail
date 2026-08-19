import type { PageServerLoad } from './$types';
import type { CloudflareEnv } from '$lib/server/cloudflare';
import type { MailboxSection } from '$lib/domain/mail';
import { loadWorkspaceSnapshot } from '$lib/server/workspace';
import { parseMailboxQuery } from '$lib/server/workspace/mailbox-query';
import { parseBoolean } from '$lib/server/config/env';
import { classifyRuntimeError, runtimeUnavailableState } from '$lib/server/http/api';
import type { RuntimeState } from '$lib/domain/runtime-state';

const mailFolders: MailboxSection[] = ['inbox', 'sent', 'drafts', 'archive'];

function safeRuntimeDiagnostics(env: CloudflareEnv) {
  const provider = env.OUTBOUND_PROVIDER?.trim().toLowerCase() ?? '';
  return {
    environment: env.APP_ENV?.trim() || 'development',
    d1Configured: Boolean(env.DB),
    r2Configured: Boolean(env.BUCKET),
    outboundConfigured: provider === 'resend' ? Boolean(env.RESEND_API_KEY?.trim()) : /^(demo|fake)$/u.test(provider),
    outboundMode: provider === 'resend' ? 'Resend' : /^(demo|fake)$/u.test(provider) ? '开发假服务' : '未配置',
    webhookConfigured: Boolean(env.RESEND_WEBHOOK_SECRET?.trim()),
    senderConfigured: Boolean(env.OUTBOUND_FROM_EMAIL?.trim()),
    autoReplyEnabled: parseBoolean(env.AUTO_REPLY_ENABLED),
    notificationEnabled: parseBoolean(env.INBOUND_NOTIFICATION_ENABLED)
  };
}

function requestedFolder(value: string | null): MailboxSection {
  return mailFolders.includes(value as MailboxSection) ? value as MailboxSection : 'inbox';
}

export const load: PageServerLoad = async ({ platform, locals, url }) => {
  const env = platform?.env as CloudflareEnv | undefined;
  const dbBound = Boolean(env?.DB);
  const bucketBound = Boolean(env?.BUCKET);
  const context = locals.workspaceSession;
  const requestId = locals.requestId ?? crypto.randomUUID();

  const emptyData = (runtimeState: RuntimeState) => ({
    dbBound,
    bucketBound,
    snapshotIdentity: requestId,
    workspace: null,
    runtimeDiagnostics: null,
    schemaReady: runtimeState.state === 'ready',
    runtimeState,
    totalMessages: 0,
    lastSubject: null,
    lastTimestamp: null
  });

  if (locals.runtimeState) {
    return emptyData(locals.runtimeState);
  }

  if (!env?.DB) {
    return emptyData(runtimeUnavailableState(new Error('D1 binding is unavailable.'), requestId));
  }

  if (!context) {
    return emptyData({ state: 'unauthenticated', requestId });
  }

  try {
    const activeFolder = requestedFolder(url.searchParams.get('folder'));
    const params = new URLSearchParams({ limit: '40', folder: activeFolder });
    for (const key of ['q', 'filter', 'status']) {
      const value = url.searchParams.get(key);
      if (value) params.set(key, value);
    }
    const activeQuery = parseMailboxQuery(params);
    const loaded = await loadWorkspaceSnapshot(env, context, {
      activeFolder,
      limit: activeQuery.limit,
      query: activeQuery.query,
      filter: activeQuery.filter,
      deliveryStatus: activeQuery.deliveryStatus
    });
    const workspace = loaded.workspace;
    const latest = workspace.activePage.messages[0] ?? null;

    return {
      dbBound,
      bucketBound,
      snapshotIdentity: requestId,
      workspace,
      runtimeDiagnostics: safeRuntimeDiagnostics(env),
      schemaReady: true,
      runtimeState: { state: 'ready' as const, requestId },
      totalMessages: workspace.metrics.inboxCount + workspace.metrics.sentCount,
      lastSubject: latest?.subject ?? null,
      lastTimestamp: latest?.sentAt ?? null
    };
  } catch (error) {
    const classified = classifyRuntimeError(error);
    if (classified.status < 500) throw error;
    const runtimeState = runtimeUnavailableState(classified, requestId);
    console.error(JSON.stringify({
      level: 'error',
      event: 'page_load_failed',
      requestId,
      path: url.pathname,
      code: runtimeState.code,
      errorName: error instanceof Error ? error.name : 'UnknownError'
    }));
    return emptyData(runtimeState);
  }
};
