import type { CloudflareEnv } from '$lib/server/cloudflare';
import { mailAiApiFormats, type MailAiApiFormat } from '$lib/domain/mail/ai';
import { parseBoolean } from '$lib/server/config/env';

export interface MailAiConfig {
  apiFormat: MailAiApiFormat;
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  maxInputChars: number;
}

export type MailAiConfiguration =
  | { status: 'disabled' | 'unconfigured'; config: null }
  | { status: 'configured'; config: MailAiConfig };

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number) {
  if (value === undefined) return fallback;
  if (!/^\d+$/u.test(value)) return null;
  const result = Number(value);
  return Number.isSafeInteger(result) && result >= min && result <= max ? result : null;
}

/** Admin-controlled public HTTPS host only; only the Owner settings endpoint may persist it. */
export function parseAiBaseUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    // Reject IP literals (including non-canonical IPv4 forms normalized by URL),
    // single-label/private names and credentials; do not follow redirects.
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      (url.port && url.port !== '443') || !host.includes('.') || host.includes(':') ||
      /^[\d.]+$/u.test(host) || !/^[a-z0-9.-]+\.[a-z]{2,}$/u.test(host) ||
      /(?:^|\.)(?:localhost|local|internal|test|invalid|example)$/u.test(host)) return null;
    return url.href.replace(/\/+$/u, '');
  } catch { return null; }
}

export function resolveMailAiConfiguration(env: Partial<CloudflareEnv> = {}): MailAiConfiguration {
  if (!parseBoolean(env.AI_ENABLED)) return { status: 'disabled', config: null };
  const apiFormat = env.AI_API_FORMAT ?? 'chat-completions';
  const baseUrl = parseAiBaseUrl(env.AI_BASE_URL);
  const model = env.AI_MODEL?.trim();
  const apiKey = env.AI_API_KEY?.trim();
  const timeoutMs = boundedInteger(env.AI_TIMEOUT_MS, 15000, 100, 30000);
  const maxInputChars = boundedInteger(env.AI_MAX_INPUT_CHARS, 16000, 256, 32000);
  if (!(mailAiApiFormats as readonly string[]).includes(apiFormat) || (env.AI_PROVIDER ?? 'openai-compatible') !== 'openai-compatible' || !baseUrl ||
    !model || model.length > 128 || /[\r\n]/u.test(model) || !apiKey || /\s/u.test(apiKey) ||
    !timeoutMs || !maxInputChars) return { status: 'unconfigured', config: null };
  return { status: 'configured', config: { baseUrl, model, apiKey, timeoutMs, maxInputChars, apiFormat: apiFormat as MailAiApiFormat } };
}
