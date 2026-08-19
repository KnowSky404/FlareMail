import { MAIL_LIMITS, sanitizeFilename } from '$lib/domain/mail/validation';
import { utf8ByteLength } from '$lib/domain/utf8';

/**
 * The only provider-facing contract used by outbound application services.
 *
 * This module deliberately does not know about Cloudflare bindings or D1. The
 * caller owns the durable idempotency key and must pass the same key and
 * payload when retrying an unknown outcome.
 */

export type OutboundMailTag = {
  name: string;
  value: string;
};

/** Bytes are owned by the caller and must already have passed its integrity checks. */
export type OutboundMailAttachment = {
  filename: string;
  bytes: Uint8Array;
  contentType?: string;
  /** Resend's content_id is the CID value referenced by inline HTML. */
  contentId?: string;
  /** Inline is represented to Resend by content_id; the REST API has no separate disposition field. */
  disposition?: 'attachment' | 'inline';
};

export type OutboundMailInput = {
  /** A durable key, normally derived from the persisted message/delivery id. */
  idempotencyKey: string;
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text?: string;
  html?: string;
  replyTo?: string[];
  headers?: Record<string, string>;
  tags?: OutboundMailTag[];
  attachments?: OutboundMailAttachment[];
};

export type OutboundMailResult = {
  status: 'submitted';
  providerMessageId: string;
  remoteStatus: number;
};

export type OutboundGatewayErrorKind =
  | 'configuration'
  | 'idempotency_conflict'
  | 'concurrent'
  | 'rate_limited'
  | 'client_error'
  | 'server_error'
  | 'invalid_response'
  | 'timeout'
  | 'network_unknown'
  | 'idempotency_expired';

export class OutboundGatewayError extends Error {
  readonly kind: OutboundGatewayErrorKind;
  readonly retryable: boolean;
  readonly remoteStatus: number | null;
  /** A short provider response summary, never a request body or credential. */
  readonly responsePreview: string;

  constructor(
    kind: OutboundGatewayErrorKind,
    message: string,
    options: {
      retryable?: boolean;
      remoteStatus?: number | null;
      responsePreview?: string;
    } = {}
  ) {
    super(message);
    this.name = 'OutboundGatewayError';
    this.kind = kind;
    this.retryable = options.retryable ?? (kind === 'concurrent' || kind === 'rate_limited' || kind === 'server_error' || kind === 'timeout' || kind === 'network_unknown');
    this.remoteStatus = options.remoteStatus ?? null;
    this.responsePreview = options.responsePreview ?? message;
  }
}

export interface OutboundMailGateway {
  send(input: OutboundMailInput, options?: { signal?: AbortSignal }): Promise<OutboundMailResult>;
}

export type ResendOutboundGatewayOptions = {
  apiKey?: string;
  apiBaseUrl?: string;
  timeoutMs?: number;
  fetch?: OutboundFetch;
};

export type OutboundFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const DEFAULT_API_BASE_URL = 'https://api.resend.com';
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_IDEMPOTENCY_KEY_LENGTH = 256;
const MAX_PREVIEW_LENGTH = 400;
// Keep substantial headroom below Resend's 40 MB post-Base64 email limit and
// the Workers isolate limit for JSON/base64 copies made during serialization.
export const MAX_OUTBOUND_ATTACHMENT_COUNT = 10;
export const MAX_OUTBOUND_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const MAX_OUTBOUND_ATTACHMENT_TOTAL_BYTES = 20 * 1024 * 1024;
export const MAX_OUTBOUND_ATTACHMENT_JSON_BYTES = 32 * 1024 * 1024;
const MAX_OUTBOUND_CONTENT_ID_LENGTH = 128;
const MIME_TYPE_PATTERN = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u;

const compact = (value: string) => value.replace(/\s+/g, ' ').trim().slice(0, MAX_PREVIEW_LENGTH);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const responseMessage = (payload: unknown, fallback: string) => {
  if (!isRecord(payload)) return fallback;
  const nested = isRecord(payload.error) ? payload.error : null;
  const value = payload.message ?? payload.error ?? payload.name ?? nested?.message;
  return typeof value === 'string' && value.trim() ? compact(value) : fallback;
};

const normalizeBaseUrl = (value: string | undefined) => {
  const baseUrl = value?.trim() || DEFAULT_API_BASE_URL;
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new OutboundGatewayError('configuration', 'Resend API base URL is invalid.', { retryable: false });
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new OutboundGatewayError('configuration', 'Resend API base URL must be an HTTPS origin or path without credentials, query, or fragment.', { retryable: false });
  }
  return parsed.toString().replace(/\/+$/, '');
};

function validateInput(input: OutboundMailInput) {
  const key = input.idempotencyKey.trim();
  if (!key || key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new OutboundGatewayError(
      'configuration',
      `Idempotency-Key must be between 1 and ${MAX_IDEMPOTENCY_KEY_LENGTH} characters.`
    );
  }
  if (!input.from.trim() || input.to.length === 0) {
    throw new OutboundGatewayError('configuration', 'Outbound mail requires from and at least one recipient.');
  }
  if (!input.text?.trim() && !input.html?.trim()) {
    throw new OutboundGatewayError('configuration', 'Outbound mail requires text or html content.');
  }
  validateAttachments(input.attachments);
  return key;
}

function bytesToBase64(bytes: Uint8Array): string {
  let result = '';
  // Keep chunks below argument/string limits while preserving Base64 groups.
  const chunkSize = 0x7ffe; // 32766, divisible by 3
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    let binary = '';
    const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
    for (const byte of chunk) binary += String.fromCharCode(byte);
    result += btoa(binary);
  }
  return result;
}

function validateAttachments(attachments: OutboundMailAttachment[] | undefined) {
  if (attachments === undefined) return;
  if (!Array.isArray(attachments) || attachments.length > MAX_OUTBOUND_ATTACHMENT_COUNT) {
    throw new OutboundGatewayError('configuration', `Outbound mail supports at most ${MAX_OUTBOUND_ATTACHMENT_COUNT} attachments.`);
  }
  let totalBytes = 0;
  for (const attachment of attachments) {
    if (!attachment || typeof attachment.filename !== 'string' || !attachment.filename.trim()) {
      throw new OutboundGatewayError('configuration', 'Outbound attachment filename is required.');
    }
    const filename = sanitizeFilename(attachment.filename);
    if (
      !filename ||
      attachment.filename.length > MAIL_LIMITS.filename ||
      utf8ByteLength(filename) > MAIL_LIMITS.filename
    ) {
      throw new OutboundGatewayError('configuration', 'Outbound attachment filename is invalid.');
    }
    if (!(attachment.bytes instanceof Uint8Array)) {
      throw new OutboundGatewayError('configuration', 'Outbound attachment bytes are invalid.');
    }
    if (attachment.bytes.byteLength > MAX_OUTBOUND_ATTACHMENT_BYTES) {
      throw new OutboundGatewayError('configuration', `Each outbound attachment must be at most ${MAX_OUTBOUND_ATTACHMENT_BYTES} bytes.`);
    }
    totalBytes += attachment.bytes.byteLength;
    if (totalBytes > MAX_OUTBOUND_ATTACHMENT_TOTAL_BYTES) {
      throw new OutboundGatewayError('configuration', `Outbound attachments must total at most ${MAX_OUTBOUND_ATTACHMENT_TOTAL_BYTES} bytes.`);
    }
    if (attachment.contentType !== undefined && (typeof attachment.contentType !== 'string' || !attachment.contentType.trim() || !MIME_TYPE_PATTERN.test(attachment.contentType.trim().toLowerCase()))) {
      throw new OutboundGatewayError('configuration', 'Outbound attachment MIME type is invalid.');
    }
    if (attachment.contentId !== undefined && (typeof attachment.contentId !== 'string' || !attachment.contentId.trim() || attachment.contentId.length > MAX_OUTBOUND_CONTENT_ID_LENGTH || /[\u0000\r\n]/u.test(attachment.contentId))) {
      throw new OutboundGatewayError('configuration', 'Outbound attachment content id is invalid.');
    }
    if (attachment.disposition !== undefined && attachment.disposition !== 'attachment' && attachment.disposition !== 'inline') {
      throw new OutboundGatewayError('configuration', 'Outbound attachment disposition is invalid.');
    }
    if (attachment.disposition === 'inline' && !attachment.contentId?.trim()) {
      throw new OutboundGatewayError('configuration', 'Inline outbound attachments require a content id.');
    }
  }
}

function buildResendBody(input: OutboundMailInput) {
  const body = Object.fromEntries(
    Object.entries({
      from: input.from,
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      subject: input.subject,
      text: input.text,
      html: input.html,
      reply_to: input.replyTo,
      headers: input.headers,
      tags: input.tags,
      attachments: input.attachments?.map((attachment) => ({
        filename: sanitizeFilename(attachment.filename),
        content: bytesToBase64(attachment.bytes),
        ...(attachment.contentType ? { content_type: attachment.contentType.trim().toLowerCase() } : {}),
        ...(attachment.contentId ? { content_id: attachment.contentId.trim() } : {})
      }))
    }).filter(([, value]) => value !== undefined)
  );
  return body;
}

const looksLikePayloadMismatch = (message: string) =>
  /payload|idempotenc|same request|request body|parameters/i.test(message);

const parseResponseBody = async (response: Response) => {
  const raw = await response.text();
  if (!raw.trim()) return { payload: null as unknown, raw: '' };
  try {
    return { payload: JSON.parse(raw) as unknown, raw };
  } catch {
    return { payload: null as unknown, raw: compact(raw) };
  }
};

const abortError = (error: unknown) => error instanceof Error && error.name === 'AbortError';

export class ResendOutboundGateway implements OutboundMailGateway {
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: OutboundFetch;

  constructor(options: ResendOutboundGatewayOptions = {}) {
    this.apiKey = options.apiKey?.trim() ?? '';
    this.endpoint = `${normalizeBaseUrl(options.apiBaseUrl)}/emails`;
    this.timeoutMs = Number.isFinite(options.timeoutMs) && (options.timeoutMs ?? 0) > 0 ? Math.floor(options.timeoutMs!) : DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  }

  async send(input: OutboundMailInput, options: { signal?: AbortSignal } = {}): Promise<OutboundMailResult> {
    const idempotencyKey = validateInput(input);
    if (!this.apiKey) {
      throw new OutboundGatewayError('configuration', 'Resend API key is not configured.', { retryable: false });
    }

    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    const forwardAbort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', forwardAbort, { once: true });
    if (options.signal?.aborted) controller.abort(options.signal.reason);

    const requestBody = JSON.stringify(buildResendBody(input));
    if (utf8ByteLength(requestBody) > MAX_OUTBOUND_ATTACHMENT_JSON_BYTES) {
      throw new OutboundGatewayError('configuration', `Outbound attachment payload must be smaller than ${MAX_OUTBOUND_ATTACHMENT_JSON_BYTES} serialized bytes.`);
    }
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey
        },
        body: requestBody,
        signal: controller.signal
      });
    } catch (error) {
      if (timedOut || abortError(error) && !options.signal?.aborted) {
        throw new OutboundGatewayError('timeout', 'Resend request timed out.', { retryable: true });
      }
      throw new OutboundGatewayError('network_unknown', 'Resend request outcome is unknown; do not change the idempotency key.', { retryable: true });
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', forwardAbort);
    }

    const { payload, raw } = await parseResponseBody(response);
    if (response.status >= 200 && response.status < 300) {
      const providerMessageId = isRecord(payload) && typeof payload.id === 'string' ? payload.id.trim() : '';
      if (!providerMessageId) {
        throw new OutboundGatewayError('invalid_response', 'Resend returned a successful response without a message id.', {
          remoteStatus: response.status,
          retryable: true,
          responsePreview: 'Successful Resend response did not include an id.'
        });
      }
      return { status: 'submitted', providerMessageId, remoteStatus: response.status };
    }

    // Do not expose a non-JSON response body: it may contain an intermediary
    // error page, reflected request data, or other provider-sensitive text.
    const providerMessage = responseMessage(
      payload,
      raw ? `Resend returned HTTP ${response.status}.` : `Resend returned HTTP ${response.status} with a non-JSON response.`
    );
    const message = `Resend returned HTTP ${response.status}.`;
    if (response.status === 409) {
      const kind = looksLikePayloadMismatch(providerMessage) ? 'idempotency_conflict' : 'concurrent';
      throw new OutboundGatewayError(kind, message, { remoteStatus: response.status, retryable: kind === 'concurrent' });
    }
    if (response.status === 429) {
      throw new OutboundGatewayError('rate_limited', message, { remoteStatus: response.status, retryable: true });
    }
    if (response.status >= 500) {
      throw new OutboundGatewayError('server_error', message, { remoteStatus: response.status, retryable: true });
    }
    throw new OutboundGatewayError('client_error', message, { remoteStatus: response.status, retryable: false });
  }
}

export type FakeOutboundGatewayOptions = {
  providerMessageId?: string;
  result?: OutboundMailResult;
  error?: OutboundGatewayError;
};

/** Explicit test/development transport. It never performs network I/O. */
export class FakeOutboundGateway implements OutboundMailGateway {
  readonly sent: OutboundMailInput[] = [];
  private readonly options: FakeOutboundGatewayOptions;

  constructor(options: FakeOutboundGatewayOptions = {}) {
    this.options = options;
  }

  async send(input: OutboundMailInput): Promise<OutboundMailResult> {
    validateInput(input);
    this.sent.push(structuredClone(input));
    if (this.options.error) throw this.options.error;
    return this.options.result ?? {
      status: 'submitted',
      providerMessageId: this.options.providerMessageId ?? `fake-${input.idempotencyKey.slice(0, 240)}`,
      remoteStatus: 202
    };
  }
}

export function isOutboundGatewayError(error: unknown): error is OutboundGatewayError {
  return error instanceof OutboundGatewayError;
}
