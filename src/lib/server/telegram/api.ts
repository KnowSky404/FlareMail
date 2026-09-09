import type { CloudflareEnv } from '$lib/server/cloudflare';
import { resolveTelegramConfig } from './config';

export type TelegramFailureKind = 'temporary' | 'permanent' | 'rate_limited' | 'unknown' | 'configuration';

export class TelegramApiError extends Error {
  constructor(
    readonly kind: TelegramFailureKind,
    readonly code: string,
    readonly retryAfterSeconds?: number,
    readonly httpStatus?: number
  ) {
    super('Telegram request failed.');
    this.name = 'TelegramApiError';
  }
}

interface TelegramApiResponse {
  ok?: unknown;
  result?: unknown;
  error_code?: unknown;
  parameters?: unknown;
}

const MAX_RESPONSE_BYTES = 32 * 1024;
export type TelegramFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

async function boundedText(response: Response) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel('telegram response too large').catch(() => undefined);
        throw new TelegramApiError('unknown', 'response_too_large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function responseParameters(value: unknown) {
  if (!value || typeof value !== 'object') return undefined;
  const retryAfter = (value as { retry_after?: unknown }).retry_after;
  return typeof retryAfter === 'number' && Number.isSafeInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 86_400
    ? retryAfter
    : undefined;
}

function messageId(value: unknown) {
  if (!value || typeof value !== 'object') return null;
  const id = (value as { message_id?: unknown }).message_id;
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? String(id) : null;
}

export async function callTelegramApi(
  env: CloudflareEnv,
  method: string,
  payload: Record<string, unknown>,
  options: { fetchImpl?: TelegramFetch; signal?: AbortSignal } = {}
) {
  const config = resolveTelegramConfig(env);
  if (!config.ready || !config.botToken) throw new TelegramApiError('configuration', 'telegram_not_ready');
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint = `https://api.telegram.org/bot${config.botToken}/${method}`;
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      redirect: 'error',
      signal: options.signal
    });
  } catch {
    throw new TelegramApiError('unknown', 'network_unknown');
  }

  let parsed: TelegramApiResponse;
  try {
    const body = await boundedText(response);
    parsed = JSON.parse(body) as TelegramApiResponse;
  } catch (error) {
    if (error instanceof TelegramApiError) throw error;
    throw new TelegramApiError('unknown', 'invalid_response', undefined, response.status);
  }

  if (response.ok && parsed.ok === true) return parsed.result;
  const hasErrorCode = typeof parsed.error_code === 'number' && Number.isSafeInteger(parsed.error_code);
  if (!hasErrorCode) throw new TelegramApiError('unknown', 'missing_error_code', undefined, response.status);
  const errorCode = parsed.error_code as number;
  const retryAfter = responseParameters(parsed.parameters);
  if (errorCode === 429 || response.status === 429) throw new TelegramApiError('rate_limited', 'rate_limited', retryAfter ?? 60, response.status);
  if (response.status >= 500 || errorCode >= 500) throw new TelegramApiError('temporary', 'telegram_server_error', undefined, response.status);
  if (response.status === 401 || response.status === 403 || errorCode >= 400) throw new TelegramApiError('permanent', `telegram_${errorCode}`, undefined, response.status);
  throw new TelegramApiError('temporary', 'telegram_request_failed', undefined, response.status);
}

export async function sendTelegramMessage(
  env: CloudflareEnv,
  input: { chatId: string; text: string; disableWebPagePreview: boolean; replyMarkup?: Record<string, unknown> },
  options: { fetchImpl?: TelegramFetch; signal?: AbortSignal } = {}
) {
  const result = await callTelegramApi(env, 'sendMessage', {
    chat_id: input.chatId,
    text: input.text,
    disable_web_page_preview: input.disableWebPagePreview,
    ...(input.replyMarkup ? { reply_markup: input.replyMarkup } : {})
  }, options);
  const id = messageId(result);
  if (!id) throw new TelegramApiError('unknown', 'missing_message_id');
  return { messageId: id };
}
