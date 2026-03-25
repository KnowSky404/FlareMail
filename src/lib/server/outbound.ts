import type { DeliveryResultKind, DeliveryStatus } from '$lib/mock/mailbox';
import type { CloudflareEnv } from '$lib/server/cloudflare';

export type OutboundProviderName = 'demo' | 'resend';

export type OutboundDeliveryState = {
  provider: OutboundProviderName;
  resultKind: DeliveryResultKind;
  status: DeliveryStatus;
  attempts: number;
  deliveredAt: string | null;
  lastError: string;
  providerMessageId: string | null;
  remoteStatus: number | null;
  responsePreview: string;
};

type OutboundAttemptResult = {
  provider: OutboundProviderName;
  resultKind: DeliveryResultKind;
  attempted: boolean;
  deliveredAt: string | null;
  lastError: string;
  providerMessageId: string | null;
  remoteStatus: number | null;
  responsePreview: string;
};

type OutboundMessage = {
  messageId: string;
  fromName: string;
  fromEmail: string;
  toEmail: string;
  cc?: string;
  subject: string;
  text: string;
};

const nowIso = () => new Date().toISOString();

const normalizeProvider = (value: string | undefined | null): OutboundProviderName =>
  value?.trim().toLowerCase() === 'resend' ? 'resend' : 'demo';

const normalizeReason = (value: string) => value.trim().replace(/\s+/g, ' ');

const buildAddress = (name: string, email: string) => {
  const safeEmail = email.trim();
  const safeName = name.trim();
  return safeName ? `${safeName} <${safeEmail}>` : safeEmail;
};

const addressList = (value: string | undefined) =>
  (value ?? '')
    .split(/[;,]/)
    .map((item) => item.trim())
    .filter(Boolean);

const deliveryKeyword = (message: Pick<OutboundMessage, 'toEmail' | 'subject'>) =>
  `${message.toEmail} ${message.subject}`.toLowerCase();

const shouldQueueDelivery = (message: Pick<OutboundMessage, 'toEmail' | 'subject'>) => {
  const value = deliveryKeyword(message);
  return value.includes('+queue@') || value.includes('[queue]') || value.includes('hold@');
};

const shouldFailDelivery = (message: Pick<OutboundMessage, 'toEmail' | 'subject'>) => {
  const value = deliveryKeyword(message);
  return value.includes('+fail@') || value.includes('[fail]') || value.includes('bounce@');
};

const resultKindToStatus = (resultKind: DeliveryResultKind): DeliveryStatus =>
  resultKind === 'accepted'
    ? 'sent'
    : resultKind === 'permanent_failure'
      ? 'failed'
      : 'queued';

const toDeliveryState = (
  result: OutboundAttemptResult,
  currentAttempts: number
): OutboundDeliveryState => ({
  provider: result.provider,
  resultKind: result.resultKind,
  status: resultKindToStatus(result.resultKind),
  attempts: currentAttempts + (result.attempted ? 1 : 0),
  deliveredAt: result.deliveredAt,
  lastError: result.lastError,
  providerMessageId: result.providerMessageId,
  remoteStatus: result.remoteStatus,
  responsePreview: result.responsePreview
});

const parseJsonSafely = async (response: Response) => {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
};

const extractErrorMessage = (payload: Record<string, unknown> | null, fallback: string) => {
  const message =
    typeof payload?.message === 'string'
      ? payload.message
      : typeof payload?.error === 'string'
        ? payload.error
        : typeof payload?.name === 'string'
          ? payload.name
          : fallback;

  return normalizeReason(message);
};

const extractResponsePreview = (payload: Record<string, unknown> | null, fallback: string) => {
  if (!payload) {
    return fallback;
  }

  const parts = [
    typeof payload.name === 'string' ? payload.name : '',
    typeof payload.message === 'string' ? payload.message : '',
    typeof payload.error === 'string' ? payload.error : ''
  ].filter(Boolean);

  return normalizeReason(parts.join(': ') || fallback);
};

const classifyResendFailure = (status: number) => {
  if (status === 429) {
    return 'rate_limited' as const;
  }

  if (status === 408 || status === 409 || status === 425 || status >= 500) {
    return 'temporary_failure' as const;
  }

  return 'permanent_failure' as const;
};

const resolveProviderEnvelope = (env: CloudflareEnv | undefined, message: OutboundMessage) => {
  const configuredFromEmail = env?.OUTBOUND_FROM_EMAIL?.trim() || message.fromEmail.trim();
  const configuredFromName = env?.OUTBOUND_FROM_NAME?.trim() || message.fromName.trim();

  return {
    from: buildAddress(configuredFromName, configuredFromEmail),
    replyTo:
      configuredFromEmail.toLowerCase() === message.fromEmail.trim().toLowerCase()
        ? undefined
        : message.fromEmail.trim()
  };
};

async function sendWithDemoProvider(message: OutboundMessage): Promise<OutboundAttemptResult> {
  if (shouldQueueDelivery(message)) {
    return {
      provider: 'demo',
      resultKind: 'queued',
      attempted: false,
      deliveredAt: null,
      lastError: '',
      providerMessageId: null,
      remoteStatus: null,
      responsePreview: '演示 provider 将这封邮件保留在待发送队列中。'
    };
  }

  if (shouldFailDelivery(message)) {
    return {
      provider: 'demo',
      resultKind: 'permanent_failure',
      attempted: true,
      deliveredAt: null,
      lastError: '演示 provider 模拟了永久失败，请更换收件地址或稍后重试。',
      providerMessageId: null,
      remoteStatus: null,
      responsePreview: '演示 provider 返回永久失败。'
    };
  }

  return {
    provider: 'demo',
    resultKind: 'accepted',
    attempted: true,
    deliveredAt: nowIso(),
    lastError: '',
    providerMessageId: `demo-send-${crypto.randomUUID()}`,
    remoteStatus: null,
    responsePreview: '演示 provider 已接受这封邮件。'
  };
}

async function sendWithResendProvider(
  env: CloudflareEnv | undefined,
  message: OutboundMessage
): Promise<OutboundAttemptResult> {
  const apiKey = env?.RESEND_API_KEY?.trim();

  if (!apiKey) {
    return {
      provider: 'resend',
      resultKind: 'permanent_failure',
      attempted: false,
      deliveredAt: null,
      lastError: '缺少 RESEND_API_KEY，无法调用 Resend 发送邮件。',
      providerMessageId: null,
      remoteStatus: null,
      responsePreview: 'Resend provider 未配置 API Key。'
    };
  }

  const endpointBase = (env?.RESEND_API_BASE_URL?.trim() || 'https://api.resend.com').replace(
    /\/+$/,
    ''
  );
  const envelope = resolveProviderEnvelope(env, message);
  const response = await fetch(`${endpointBase}/emails`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `flaremail:${message.messageId}`
    },
    body: JSON.stringify({
      from: envelope.from,
      to: [message.toEmail.trim()],
      cc: addressList(message.cc).length ? addressList(message.cc) : undefined,
      subject: message.subject.trim(),
      text: message.text,
      replyTo: envelope.replyTo ? [envelope.replyTo] : undefined
    })
  });
  const payload = await parseJsonSafely(response);

  if (response.ok) {
    return {
      provider: 'resend',
      resultKind: 'accepted',
      attempted: true,
      deliveredAt: nowIso(),
      lastError: '',
      providerMessageId: typeof payload?.id === 'string' ? payload.id : null,
      remoteStatus: response.status,
      responsePreview: extractResponsePreview(payload, 'Resend 已接受这封邮件。')
    };
  }

  const lastError = extractErrorMessage(payload, `Resend 返回了 ${response.status}。`);

  return {
    provider: 'resend',
    resultKind: classifyResendFailure(response.status),
    attempted: true,
    deliveredAt: null,
    lastError,
    providerMessageId: typeof payload?.id === 'string' ? payload.id : null,
    remoteStatus: response.status,
    responsePreview: extractResponsePreview(payload, lastError)
  };
}

export async function deliverOutboundMessage(
  env: CloudflareEnv | undefined,
  message: OutboundMessage,
  currentAttempts = 0
) {
  const provider = normalizeProvider(env?.OUTBOUND_PROVIDER);
  const result =
    provider === 'resend'
      ? await sendWithResendProvider(env, message)
      : await sendWithDemoProvider(message);

  return toDeliveryState(result, currentAttempts);
}
