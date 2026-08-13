import type { DeliveryEventType, DeliveryResultKind, DeliveryStatus } from '$lib/domain/mail';

export type ResendWebhookPayload = {
  type?: unknown;
  created_at?: unknown;
  data?: unknown;
};

export type ResendWebhookErrorCode =
  | 'missing_config'
  | 'missing_headers'
  | 'invalid_timestamp'
  | 'expired'
  | 'invalid_signature'
  | 'invalid_json'
  | 'invalid_payload';

export class ResendWebhookError extends Error {
  constructor(readonly code: ResendWebhookErrorCode, message: string) {
    super(message);
    this.name = 'ResendWebhookError';
  }
}

export type NormalizedResendWebhookEvent = {
  provider: 'resend';
  providerMessageId: string;
  eventType: DeliveryEventType;
  createdAt: string;
  statusUpdate: DeliveryStatus | null;
  resultKind: DeliveryResultKind | null;
  deliveredAt: string | null;
  lastError: string;
  responsePreview: string;
  summary: string;
  payloadJson: string;
};

const FIVE_MINUTES_SECONDS = 5 * 60;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const getString = (value: unknown) => typeof value === 'string' ? value.trim() : '';

const base64ToBytes = (value: string) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));

const bytesToBase64 = (buffer: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(buffer)));

const constantTimeEqual = (left: string, right: string) => {
  const length = Math.max(left.length, right.length);
  let mismatch = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    mismatch |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return mismatch === 0;
};

const parseSignatures = (value: string) => value.split(/\s+/u).flatMap((item) => {
  const comma = item.indexOf(',');
  return comma > 0 && item.slice(0, comma) === 'v1' && item.slice(comma + 1)
    ? [item.slice(comma + 1)]
    : [];
});

const secretBytes = (secret: string) => {
  const value = secret.trim();
  if (!value) throw new ResendWebhookError('missing_config', 'Webhook signing secret is unavailable.');
  try {
    const bytes = base64ToBytes(value.startsWith('whsec_') ? value.slice(6) : value);
    if (bytes.byteLength < 16) throw new Error('secret too short');
    return bytes;
  } catch {
    throw new ResendWebhookError('missing_config', 'Webhook signing secret is malformed.');
  }
};

export async function verifyResendWebhook(
  body: string,
  headers: Headers,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000)
) {
  const svixId = headers.get('svix-id')?.trim();
  const svixTimestamp = headers.get('svix-timestamp')?.trim();
  const svixSignature = headers.get('svix-signature')?.trim();
  if (!svixId || !svixTimestamp || !svixSignature) {
    throw new ResendWebhookError('missing_headers', 'Required webhook signature headers are missing.');
  }

  const timestamp = Number(svixTimestamp);
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
    throw new ResendWebhookError('invalid_timestamp', 'Webhook timestamp is invalid.');
  }
  if (Math.abs(nowSeconds - timestamp) > FIVE_MINUTES_SECONDS) {
    throw new ResendWebhookError('expired', 'Webhook timestamp is outside the accepted window.');
  }

  const key = await crypto.subtle.importKey(
    'raw', secretBytes(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const signed = `${svixId}.${svixTimestamp}.${body}`;
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signed));
  const expected = bytesToBase64(digest);
  const signatures = parseSignatures(svixSignature);
  if (!signatures.some((candidate) => constantTimeEqual(candidate, expected))) {
    throw new ResendWebhookError('invalid_signature', 'Webhook signature verification failed.');
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new ResendWebhookError('invalid_json', 'Webhook body is not valid JSON.');
  }
  if (!isRecord(payload)) throw new ResendWebhookError('invalid_payload', 'Webhook payload must be an object.');
  return { svixId, payload: payload as ResendWebhookPayload };
}

const eventSemantics = (eventType: string): {
  statusUpdate: DeliveryStatus | null;
  resultKind: DeliveryResultKind | null;
  summary: string;
  lastError: string;
} => {
  switch (eventType) {
    case 'email.sent': return { statusUpdate: 'sent', resultKind: 'accepted', summary: 'Resend reported that the email was sent.', lastError: '' };
    case 'email.delivered': return { statusUpdate: 'delivered', resultKind: 'accepted', summary: 'Resend reported that the email was delivered.', lastError: '' };
    case 'email.delivery_delayed': return { statusUpdate: 'delayed', resultKind: 'temporary_failure', summary: 'Resend reported a delivery delay.', lastError: 'Delivery was delayed by the provider.' };
    case 'email.bounced': return { statusUpdate: 'bounced', resultKind: 'permanent_failure', summary: 'Resend reported that the email bounced.', lastError: 'The provider reported a bounce.' };
    case 'email.failed': return { statusUpdate: 'failed', resultKind: 'permanent_failure', summary: 'Resend reported that the email failed.', lastError: 'The provider reported a delivery failure.' };
    case 'email.complained': return { statusUpdate: 'complained', resultKind: 'permanent_failure', summary: 'Resend reported a recipient complaint.', lastError: 'The provider reported a recipient complaint.' };
    case 'email.suppressed': return { statusUpdate: 'suppressed', resultKind: 'permanent_failure', summary: 'Resend reported that the email was suppressed.', lastError: 'The provider suppressed the message.' };
    case 'email.opened': return { statusUpdate: null, resultKind: null, summary: 'Resend reported an email open.', lastError: '' };
    case 'email.clicked': return { statusUpdate: null, resultKind: null, summary: 'Resend reported a link click.', lastError: '' };
    default: return { statusUpdate: null, resultKind: null, summary: `Resend reported ${eventType.slice(0, 120)}.`, lastError: '' };
  }
};

export function normalizeResendWebhookEvent(payload: ResendWebhookPayload): NormalizedResendWebhookEvent {
  const eventType = getString(payload.type);
  const data = isRecord(payload.data) ? payload.data : null;
  const providerMessageId = getString(data?.email_id);
  const createdAtValue = getString(payload.created_at);
  const createdAtDate = new Date(createdAtValue);
  if (!eventType || eventType.length > 160 || !/^[A-Za-z0-9._-]+$/u.test(eventType) ||
      !data || !providerMessageId || providerMessageId.length > 256 ||
      !createdAtValue || Number.isNaN(createdAtDate.valueOf())) {
    throw new ResendWebhookError('invalid_payload', 'Webhook payload is missing required event fields.');
  }

  const semantics = eventSemantics(eventType);
  const createdAt = createdAtDate.toISOString();
  return {
    provider: 'resend',
    providerMessageId,
    eventType: eventType as DeliveryEventType,
    createdAt,
    ...semantics,
    deliveredAt: semantics.statusUpdate === 'delivered' ? createdAt : null,
    responsePreview: semantics.summary,
    summary: semantics.summary,
    payloadJson: JSON.stringify({ type: eventType, created_at: createdAt, data: { email_id: providerMessageId } })
  };
}
