import type { PageServerLoad } from './$types';
import type { CloudflareEnv } from '$lib/server/cloudflare';
import type { MailFolder, MailboxFilter, MailboxPage, WorkspacePayload } from '$lib/domain/mail';
import { loadMailboxPage } from '$lib/server/workspace';
import { parseMailboxQuery } from '$lib/server/workspace/mailbox-query';

const mailFolders: MailFolder[] = ['inbox', 'sent', 'drafts'];

const enabled = (value: string | undefined) => /^(1|true|yes|on)$/iu.test(value?.trim() ?? '');

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
    autoReplyEnabled: enabled(env.AUTO_REPLY_ENABLED),
    notificationEnabled: enabled(env.INBOUND_NOTIFICATION_ENABLED)
  };
}

function requestedFolder(value: string | null): MailFolder {
  return mailFolders.includes(value as MailFolder) ? value as MailFolder : 'inbox';
}

export const load: PageServerLoad = async ({ platform, locals, url }) => {
  const env = platform?.env as CloudflareEnv | undefined;
  const dbBound = Boolean(env?.DB);
  const bucketBound = Boolean(env?.BUCKET);
  const context = locals.workspaceSession;

  if (!context || !env?.DB) {
    return {
      dbBound,
      bucketBound,
      workspace: null,
      mailboxPages: null,
      runtimeDiagnostics: null,
      schemaReady: false,
      totalMessages: 0,
      lastSubject: null,
      lastTimestamp: null
    };
  }

  try {
    const activeFolder = requestedFolder(url.searchParams.get('folder'));
    const pages = await Promise.all(mailFolders.map((folder) => {
      const params = new URLSearchParams({ folder, limit: '40' });
      if (folder === activeFolder) {
        const query = url.searchParams.get('q');
        const filter = url.searchParams.get('filter');
        const status = url.searchParams.get('status');
        if (query) params.set('q', query);
        if (filter) params.set('filter', filter);
        if (status) params.set('status', status);
      }
      return loadMailboxPage(env, context, parseMailboxQuery(params));
    }));
    const mailboxPages = Object.fromEntries(pages.map((page) => [page.folder, page])) as Record<MailFolder, MailboxPage>;
    const mailbox = {
      inbox: mailboxPages.inbox.messages,
      sent: mailboxPages.sent.messages,
      drafts: mailboxPages.drafts.messages
    };
    const metrics = mailboxPages.inbox.metrics;
    const workspace: WorkspacePayload = { profile: context.profile, mailbox, metrics };
    const latest = mailbox.inbox[0] ?? mailbox.sent[0] ?? null;

    return {
      dbBound,
      bucketBound,
      workspace,
      mailboxPages,
      runtimeDiagnostics: safeRuntimeDiagnostics(env),
      schemaReady: true,
      totalMessages: metrics.inboxCount + metrics.sentCount,
      lastSubject: latest?.subject ?? null,
      lastTimestamp: latest?.sentAt ?? null
    };
  } catch {
    return {
      dbBound,
      bucketBound,
      workspace: null,
      mailboxPages: null,
      runtimeDiagnostics: null,
      schemaReady: false,
      totalMessages: 0,
      lastSubject: null,
      lastTimestamp: null
    };
  }
};
