import type { CloudflareEnv } from './cloudflare';

type AddressLike = string | string[] | undefined;

type CloudflareSendInput = {
  fromName?: string;
  fromEmail?: string;
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  subject: string;
  text: string;
  replyTo?: string;
  headers?: Record<string, string>;
};

const truthyValues = new Set(['1', 'true', 'yes', 'on']);
const autoReplyBlockedLocalParts = new Set([
  'mailer-daemon',
  'postmaster',
  'bounce',
  'noreply',
  'no-reply',
  'donotreply',
  'do-not-reply'
]);

const nowIso = () => new Date().toISOString();

const normalizeText = (value: string) => value.trim().replace(/\r\n/g, '\n');

const normalizeHeader = (value: string) => value.replace(/[\r\n]+/g, ' ').trim();

const normalizeBoolean = (value: string | undefined | null) =>
  value ? truthyValues.has(value.trim().toLowerCase()) : false;

const normalizeAddressList = (value: AddressLike) => {
  if (Array.isArray(value)) {
    return value.map((item) => item.trim()).filter(Boolean);
  }

  return (value ?? '')
    .split(/[;,]/)
    .map((item) => item.trim())
    .filter(Boolean);
};

const buildAddress = (name: string | undefined, email: string) => {
  const safeEmail = email.trim();
  const safeName = name?.trim() ?? '';
  return safeName ? `${normalizeHeader(safeName)} <${safeEmail}>` : safeEmail;
};

const deriveMessageIdDomain = (email: string) => {
  const [, domain = 'workers.dev'] = email.trim().split('@');
  return domain || 'workers.dev';
};

const buildRawPlainTextEmail = (input: {
  from: string;
  to: string;
  subject: string;
  text: string;
  messageIdDomain?: string;
  replyTo?: string;
  inReplyTo?: string | null;
  references?: string | null;
  headers?: Record<string, string>;
}) => {
  const headers = [
    `From: ${normalizeHeader(input.from)}`,
    `To: ${normalizeHeader(input.to)}`,
    `Subject: ${normalizeHeader(input.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${deriveMessageIdDomain(input.messageIdDomain ?? input.from)}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit'
  ];

  if (input.replyTo?.trim()) {
    headers.push(`Reply-To: ${normalizeHeader(input.replyTo)}`);
  }

  if (input.inReplyTo?.trim()) {
    headers.push(`In-Reply-To: ${normalizeHeader(input.inReplyTo)}`);
  }

  if (input.references?.trim()) {
    headers.push(`References: ${normalizeHeader(input.references)}`);
  }

  for (const [key, value] of Object.entries(input.headers ?? {})) {
    const safeKey = normalizeHeader(key);
    const safeValue = normalizeHeader(value);

    if (safeKey && safeValue) {
      headers.push(`${safeKey}: ${safeValue}`);
    }
  }

  return `${headers.join('\r\n')}\r\n\r\n${normalizeText(input.text).replace(/\n/g, '\r\n')}`;
};

const classifyCloudflareFailure = (value: string) => {
  const reason = value.toLowerCase();

  if (reason.includes('rate limit') || reason.includes('quota')) {
    return 'rate_limited' as const;
  }

  if (reason.includes('temporary') || reason.includes('timeout') || reason.includes('retry')) {
    return 'temporary_failure' as const;
  }

  return 'permanent_failure' as const;
};

const resolveSender = (env: CloudflareEnv | undefined, fallbackEmail: string, fallbackName = '') => {
  const fromEmail = env?.OUTBOUND_FROM_EMAIL?.trim() || fallbackEmail.trim();
  const fromName = env?.OUTBOUND_FROM_NAME?.trim() || fallbackName.trim();

  if (!fromEmail) {
    throw new Error('缺少可用的发件地址，请配置 OUTBOUND_FROM_EMAIL。');
  }

  return {
    fromEmail,
    fromName,
    from: buildAddress(fromName, fromEmail)
  };
};

const shouldSkipAutoReply = (message: ForwardableEmailMessage) => {
  const autoSubmitted = message.headers.get('auto-submitted')?.trim().toLowerCase();
  const precedence = message.headers.get('precedence')?.trim().toLowerCase();
  const listId = message.headers.get('list-id')?.trim();
  const sender = message.from.trim().toLowerCase();
  const localPart = sender.split('@')[0] ?? '';

  return (
    autoSubmitted === 'auto-generated' ||
    autoSubmitted === 'auto-replied' ||
    precedence === 'bulk' ||
    precedence === 'list' ||
    Boolean(listId) ||
    autoReplyBlockedLocalParts.has(localPart)
  );
};

const buildAutoReplySubject = (env: CloudflareEnv | undefined, originalSubject: string) => {
  const baseSubject = originalSubject.trim() || '(no subject)';
  const prefix = env?.AUTO_REPLY_SUBJECT_PREFIX?.trim() || 'Re: ';

  if (prefix && baseSubject.toLowerCase().startsWith(prefix.toLowerCase())) {
    return baseSubject;
  }

  return `${prefix}${baseSubject}`;
};

const buildAutoReplyBody = (message: ForwardableEmailMessage, env: CloudflareEnv | undefined) => {
  const configuredBody = env?.AUTO_REPLY_TEXT?.trim();

  if (configuredBody) {
    return configuredBody;
  }

  return [
    '你好，',
    '',
    `我们已经收到你发往 ${message.to} 的邮件，后续会尽快处理。`,
    '',
    '这是一封由 FlareMail on Cloudflare Workers 自动发出的回信。',
    '',
    'Regards,',
    env?.OUTBOUND_FROM_NAME?.trim() || 'FlareMail'
  ].join('\n');
};

export async function sendCloudflareProgrammaticEmail(
  env: CloudflareEnv | undefined,
  input: CloudflareSendInput
) {
  if (!env?.OUTBOUND_EMAIL) {
    throw new Error('缺少 OUTBOUND_EMAIL send_email 绑定，无法使用 Cloudflare 原生发信。');
  }

  const sender = resolveSender(env, input.fromEmail ?? '', input.fromName);
  const to = normalizeAddressList(input.to);
  const cc = normalizeAddressList(input.cc);
  const bcc = normalizeAddressList(input.bcc);

  if (!to.length) {
    throw new Error('Cloudflare 原生发信缺少收件人。');
  }

  return env.OUTBOUND_EMAIL.send({
    from: sender.from,
    to,
    cc: cc.length ? cc : undefined,
    bcc: bcc.length ? bcc : undefined,
    subject: input.subject.trim(),
    text: input.text,
    replyTo: input.replyTo?.trim() || undefined,
    headers: input.headers
  });
}

export async function sendCloudflareAutoReply(
  message: ForwardableEmailMessage,
  env: CloudflareEnv | undefined
) {
  if (!normalizeBoolean(env?.AUTO_REPLY_ENABLED)) {
    return {
      sent: false,
      reason: 'AUTO_REPLY_ENABLED 未开启。'
    };
  }

  if (shouldSkipAutoReply(message)) {
    return {
      sent: false,
      reason: '当前邮件命中了自动回信跳过规则。'
    };
  }

  const sender = resolveSender(env, message.to, message.to.split('@')[0]);
  const subject = buildAutoReplySubject(env, message.headers.get('subject') ?? '(no subject)');
  const body = buildAutoReplyBody(message, env);
  const originalMessageId = message.headers.get('message-id');
  const references = [message.headers.get('references'), originalMessageId].filter(Boolean).join(' ').trim();
  const raw = buildRawPlainTextEmail({
    from: sender.from,
    to: message.from,
    subject,
    text: body,
    messageIdDomain: sender.fromEmail,
    inReplyTo: originalMessageId,
    references,
    headers: {
      'Auto-Submitted': 'auto-replied',
      'X-Auto-Response-Suppress': 'All'
    }
  });
  const { EmailMessage } = await import('cloudflare:email');
  const result = await message.reply(new EmailMessage(sender.fromEmail, message.from, raw));

  return {
    sent: true,
    reason: '',
    messageId: result.messageId
  };
}

export async function sendInboundNotification(
  env: CloudflareEnv | undefined,
  input: {
    from: string;
    to: string;
    subject: string;
    timestamp: string;
    snippet: string;
    rawKey: string;
  }
) {
  if (!normalizeBoolean(env?.INBOUND_NOTIFICATION_ENABLED)) {
    return {
      sent: false,
      reason: 'INBOUND_NOTIFICATION_ENABLED 未开启。'
    };
  }

  const to = env?.NOTIFICATION_EMAIL?.trim();

  if (!to) {
    return {
      sent: false,
      reason: '缺少 NOTIFICATION_EMAIL，无法发送入站通知。'
    };
  }

  const subjectPrefix = env?.NOTIFICATION_SUBJECT_PREFIX?.trim() || '[FlareMail] 新入站邮件';
  const response = await sendCloudflareProgrammaticEmail(env, {
    to,
    subject: `${subjectPrefix}: ${input.subject}`,
    text: [
      '收到一封新的入站邮件。',
      '',
      `From: ${input.from}`,
      `To: ${input.to}`,
      `Subject: ${input.subject}`,
      `Received At: ${input.timestamp}`,
      `R2 Key: ${input.rawKey}`,
      '',
      'Snippet:',
      input.snippet || '(empty body)',
      '',
      `Generated At: ${nowIso()}`
    ].join('\n'),
    replyTo: input.from
  });

  return {
    sent: true,
    reason: '',
    messageId: response.messageId
  };
}

export function classifyCloudflareSendFailure(error: unknown) {
  const reason =
    error instanceof Error ? error.message.trim() : 'Cloudflare Email Workers 发送失败。';

  return {
    reason,
    resultKind: classifyCloudflareFailure(reason)
  };
}
