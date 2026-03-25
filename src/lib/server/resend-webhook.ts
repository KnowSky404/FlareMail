import type { DeliveryEventType, DeliveryResultKind, DeliveryStatus } from '$lib/mock/mailbox';

type ResendWebhookPayload = {
  type: string;
  created_at?: string;
  data?: Record<string, unknown>;
};

export type NormalizedResendWebhookEvent = {
  provider: 'resend';
  providerMessageId: string;
  eventType: DeliveryEventType;
  createdAt: string;
  status: DeliveryStatus;
  resultKind: DeliveryResultKind;
  deliveredAt: string | null;
  lastError: string;
  responsePreview: string;
  summary: string;
  payloadJson: string;
};

const fiveMinutesInSeconds = 5 * 60;

const nowIso = () => new Date().toISOString();

const normalizeText = (value: string) => value.trim().replace(/\s+/g, ' ');

const toIsoOrNow = (value: unknown) => {
  if (typeof value !== 'string' || !value.trim()) {
    return nowIso();
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? nowIso() : parsed.toISOString();
};

const getString = (value: unknown) => (typeof value === 'string' ? value : '');

const getStringArray = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

const base64ToBytes = (value: string) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));

const bytesToBase64 = (buffer: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(buffer)));

const safeEquals = (left: string, right: string) => {
  if (left.length !== right.length) {
    return false;
  }

  let mismatch = 0;

  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }

  return mismatch === 0;
};

const decodeSecret = (value: string) => {
  const trimmed = value.trim();
  const secret = trimmed.startsWith('whsec_') ? trimmed.slice('whsec_'.length) : trimmed;
  return base64ToBytes(secret);
};

const parseSvixSignatures = (value: string) =>
  value
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .flatMap((item) => {
      const [version, signature] = item.split(',');
      return version === 'v1' && signature ? [signature] : [];
    });

const classifyFailureFromReason = (value: string): DeliveryResultKind => {
  const reason = value.toLowerCase();

  if (reason.includes('rate limit') || reason.includes('too many') || reason.includes('quota')) {
    return 'rate_limited';
  }

  if (reason.includes('temporary') || reason.includes('timeout') || reason.includes('retry')) {
    return 'temporary_failure';
  }

  return 'permanent_failure';
};

const buildSummary = (type: DeliveryEventType, data: Record<string, unknown>) => {
  const recipients = getStringArray(data.to).join(', ') || getString(data.to);
  const baseRecipient = recipients ? ` (${recipients})` : '';
  const bounce = typeof data.bounce === 'object' && data.bounce ? (data.bounce as Record<string, unknown>) : null;
  const errorMessage =
    getString(data.reason) ||
    getString(data.response) ||
    getString(bounce?.message) ||
    getString(bounce?.diagnostic_code);

  switch (type) {
    case 'email.sent':
      return `邮件已被 Resend 接收${baseRecipient}`;
    case 'email.delivered':
      return `邮件已送达${baseRecipient}`;
    case 'email.delivery_delayed':
      return errorMessage
        ? `邮件投递延迟${baseRecipient}：${normalizeText(errorMessage)}`
        : `邮件投递延迟${baseRecipient}`;
    case 'email.bounced':
      return errorMessage
        ? `邮件被退回${baseRecipient}：${normalizeText(errorMessage)}`
        : `邮件被退回${baseRecipient}`;
    case 'email.failed':
      return errorMessage
        ? `邮件发送失败${baseRecipient}：${normalizeText(errorMessage)}`
        : `邮件发送失败${baseRecipient}`;
    case 'email.complained':
      return `收件人投诉了这封邮件${baseRecipient}`;
    case 'email.opened':
      return `收件人已打开邮件${baseRecipient}`;
    case 'email.clicked':
      return `收件人点击了邮件中的链接${baseRecipient}`;
    default:
      return `收到 ${type} 回执${baseRecipient}`;
  }
};

export async function verifyResendWebhook(body: string, headers: Headers, secret: string) {
  const svixId = headers.get('svix-id');
  const svixTimestamp = headers.get('svix-timestamp');
  const svixSignature = headers.get('svix-signature');

  if (!svixId || !svixTimestamp || !svixSignature) {
    throw new Error('缺少 Svix 签名头。');
  }

  const timestamp = Number(svixTimestamp);

  if (!Number.isFinite(timestamp)) {
    throw new Error('Svix 时间戳无效。');
  }

  const age = Math.abs(Math.floor(Date.now() / 1000) - timestamp);

  if (age > fiveMinutesInSeconds) {
    throw new Error('Svix 时间戳已过期。');
  }

  const signedContent = `${svixId}.${svixTimestamp}.${body}`;
  const key = await crypto.subtle.importKey(
    'raw',
    decodeSecret(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedContent));
  const expectedSignature = bytesToBase64(digest);
  const signatures = parseSvixSignatures(svixSignature);

  if (!signatures.some((signature) => safeEquals(signature, expectedSignature))) {
    throw new Error('Svix 签名校验失败。');
  }

  return {
    svixId,
    payload: JSON.parse(body) as ResendWebhookPayload
  };
}

export function normalizeResendWebhookEvent(payload: ResendWebhookPayload): NormalizedResendWebhookEvent {
  const rawType = payload.type?.trim();
  const data = payload.data ?? {};
  const providerMessageId = getString(data.email_id).trim();

  if (!rawType || !providerMessageId) {
    throw new Error('Webhook 缺少必要字段。');
  }

  const eventType = rawType as DeliveryEventType;
  const createdAt = toIsoOrNow(payload.created_at);
  const bounce = typeof data.bounce === 'object' && data.bounce ? (data.bounce as Record<string, unknown>) : null;
  const failureReason =
    getString(data.reason) ||
    getString(data.response) ||
    getString(bounce?.message) ||
    getString(bounce?.diagnostic_code);

  let status: DeliveryStatus = 'sent';
  let resultKind: DeliveryResultKind = 'accepted';
  let deliveredAt: string | null = null;
  let lastError = '';

  switch (eventType) {
    case 'email.sent':
      status = 'sent';
      resultKind = 'accepted';
      break;
    case 'email.delivered':
      status = 'sent';
      resultKind = 'accepted';
      deliveredAt = createdAt;
      break;
    case 'email.delivery_delayed':
      status = 'queued';
      resultKind = 'temporary_failure';
      lastError = normalizeText(failureReason || 'Resend 反馈该邮件投递延迟。');
      break;
    case 'email.bounced':
      resultKind =
        getString(bounce?.type).toLowerCase() === 'temporary'
          ? 'temporary_failure'
          : 'permanent_failure';
      status = resultKind === 'permanent_failure' ? 'failed' : 'queued';
      lastError = normalizeText(failureReason || 'Resend 反馈该邮件被退回。');
      break;
    case 'email.failed':
      resultKind = classifyFailureFromReason(failureReason || '');
      status = resultKind === 'permanent_failure' ? 'failed' : 'queued';
      lastError = normalizeText(failureReason || 'Resend 反馈该邮件发送失败。');
      break;
    case 'email.complained':
    case 'email.opened':
    case 'email.clicked':
      status = 'sent';
      resultKind = 'accepted';
      break;
    default:
      status = 'sent';
      resultKind = 'accepted';
      break;
  }

  const summary = buildSummary(eventType, data);

  return {
    provider: 'resend',
    providerMessageId,
    eventType,
    createdAt,
    status,
    resultKind,
    deliveredAt,
    lastError,
    responsePreview: summary,
    summary,
    payloadJson: JSON.stringify(payload)
  };
}
