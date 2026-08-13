import type { CloudflareEnv } from '$lib/server/cloudflare';
import type { OutboundMailInput } from './gateway';
import { createOutboundGateway } from './provider';

const truthy = (value: string | undefined) => value?.trim().toLowerCase() === 'true';
const blockedLocalParts = new Set(['mailer-daemon', 'postmaster', 'bounce', 'noreply', 'no-reply', 'donotreply', 'do-not-reply']);

const cleanHeader = (value: string) => value.replace(/[\r\n]+/g, ' ').trim();

const sender = (env: CloudflareEnv) => {
  const email = env.OUTBOUND_FROM_EMAIL?.trim() ?? '';
  if (!email) throw new Error('OUTBOUND_FROM_EMAIL is required for outbound email.');
  const name = cleanHeader(env.OUTBOUND_FROM_NAME?.trim() || 'FlareMail');
  return name ? `${name} <${email}>` : email;
};

const messageId = (logicalId: string, env: CloudflareEnv) => {
  const domain = env.OUTBOUND_FROM_EMAIL?.split('@')[1]?.trim() || 'flaremail.invalid';
  return `<${cleanHeader(logicalId)}@${domain}>`;
};

function shouldSkipAutoReply(message: ForwardableEmailMessage) {
  const autoSubmitted = message.headers.get('auto-submitted')?.trim().toLowerCase();
  const precedence = message.headers.get('precedence')?.trim().toLowerCase();
  const localPart = message.from.trim().toLowerCase().split('@')[0] ?? '';
  return autoSubmitted === 'auto-generated' || autoSubmitted === 'auto-replied' ||
    precedence === 'bulk' || precedence === 'list' || Boolean(message.headers.get('list-id')?.trim()) ||
    blockedLocalParts.has(localPart);
}

const send = (env: CloudflareEnv, input: OutboundMailInput) => createOutboundGateway(env).send(input);

export async function sendAutomaticReply(message: ForwardableEmailMessage, env: CloudflareEnv, storageId: string) {
  if (!truthy(env.AUTO_REPLY_ENABLED)) return { sent: false, reason: 'AUTO_REPLY_ENABLED is disabled.' };
  if (shouldSkipAutoReply(message)) return { sent: false, reason: 'Auto-reply loop guard matched.' };

  const originalMessageId = cleanHeader(message.headers.get('message-id') ?? '');
  const existingReferences = cleanHeader(message.headers.get('references') ?? '');
  const references = [existingReferences, originalMessageId].filter(Boolean).join(' ');
  const originalSubject = cleanHeader(message.headers.get('subject') ?? '(no subject)');
  const prefix = cleanHeader(env.AUTO_REPLY_SUBJECT_PREFIX?.trim() || 'Re:');
  const subject = originalSubject.toLowerCase().startsWith(prefix.toLowerCase()) ? originalSubject : `${prefix} ${originalSubject}`;
  const body = env.AUTO_REPLY_TEXT?.trim() || `We received your email to ${message.to} and will respond soon.`;
  const logicalId = `auto-reply-${storageId}`;
  const result = await send(env, {
    idempotencyKey: `flaremail:auto-reply:${storageId}`,
    from: sender(env),
    to: [message.from.trim()],
    subject,
    text: body,
    replyTo: env.OUTBOUND_FROM_EMAIL ? [env.OUTBOUND_FROM_EMAIL.trim()] : undefined,
    headers: {
      'Message-ID': messageId(logicalId, env),
      ...(originalMessageId ? { 'In-Reply-To': originalMessageId } : {}),
      ...(references ? { References: references } : {}),
      'Auto-Submitted': 'auto-replied',
      'X-Auto-Response-Suppress': 'All'
    },
    tags: [{ name: 'flaremail_kind', value: 'auto_reply' }]
  });
  return { sent: true, reason: '', messageId: result.providerMessageId };
}

export async function sendInboundNotification(env: CloudflareEnv, input: {
  storageId: string; from: string; to: string; subject: string; timestamp: string; snippet: string;
}) {
  if (!truthy(env.INBOUND_NOTIFICATION_ENABLED)) return { sent: false, reason: 'INBOUND_NOTIFICATION_ENABLED is disabled.' };
  const recipient = env.NOTIFICATION_EMAIL?.trim();
  if (!recipient) throw new Error('NOTIFICATION_EMAIL is required when inbound notifications are enabled.');
  const subjectPrefix = cleanHeader(env.NOTIFICATION_SUBJECT_PREFIX?.trim() || '[FlareMail] New inbound message');
  const result = await send(env, {
    idempotencyKey: `flaremail:inbound-notification:${input.storageId}`,
    from: sender(env),
    to: [recipient],
    subject: `${subjectPrefix}: ${cleanHeader(input.subject)}`,
    text: [
      'A new inbound message was stored.', '', `From: ${input.from}`, `To: ${input.to}`,
      `Subject: ${input.subject}`, `Received At: ${input.timestamp}`, '', input.snippet || '(empty body)'
    ].join('\n'),
    replyTo: [input.from],
    headers: { 'Message-ID': messageId(`inbound-notification-${input.storageId}`, env) },
    tags: [{ name: 'flaremail_kind', value: 'inbound_notification' }]
  });
  return { sent: true, reason: '', messageId: result.providerMessageId };
}
