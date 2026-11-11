import type { MailAiSettings, MailAiSettingsView } from '$lib/domain/mail/ai';
import { mailAiApiFormats } from '$lib/domain/mail/ai';
import type { CloudflareEnv } from '$lib/server/cloudflare';
import { ApiError } from '$lib/server/http/api';
import { parseBoolean } from '$lib/server/config/env';
import { parseAiBaseUrl, resolveMailAiConfiguration, type MailAiConfiguration } from './config';

interface SavedSettings extends MailAiSettings { revision: string; encryptedKey: string | null }
const unavailable = () => new ApiError(503, 'AI_SETTINGS_KEY_UNAVAILABLE', 'AI settings encryption is unavailable.');
const invalid = () => new ApiError(400, 'AI_INVALID_SETTINGS', 'Invalid AI settings.');
const encoder = new TextEncoder();
const validKey = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/\s/u.test(value);
const canEncrypt = (env: CloudflareEnv) => typeof env.AI_SETTINGS_KEY === 'string' && /^[a-f0-9]{64}$/iu.test(env.AI_SETTINGS_KEY);

async function encryptionKey(env: CloudflareEnv) {
  if (!canEncrypt(env)) throw unavailable();
  const bytes = Uint8Array.from(env.AI_SETTINGS_KEY!.match(/../gu)!, (part) => Number.parseInt(part, 16));
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function encrypt(env: CloudflareEnv, owner: string, baseUrl: string, value: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(JSON.stringify(['mail-ai-v1', owner, baseUrl])) }, await encryptionKey(env), encoder.encode(value));
  return `v1.${btoa(String.fromCharCode(...iv))}.${btoa(String.fromCharCode(...new Uint8Array(ciphertext)))}`;
}
async function decrypt(env: CloudflareEnv, owner: string, baseUrl: string, value: string) {
  try {
    const parts = value.split('.');
    if (parts.length !== 3 || parts[0] !== 'v1' || value.length > 8192) throw unavailable();
    const iv = Uint8Array.from(atob(parts[1]), (c) => c.charCodeAt(0));
    const bytes = Uint8Array.from(atob(parts[2]), (c) => c.charCodeAt(0));
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(JSON.stringify(['mail-ai-v1', owner, baseUrl])) }, await encryptionKey(env), bytes);
    const key = new TextDecoder().decode(plain);
    if (!validKey(key)) throw unavailable();
    return key;
  } catch { throw unavailable(); }
}

function parseSettings(value: unknown): MailAiSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const v = value as Record<string, unknown>;
  if (typeof v.enabled !== 'boolean' || typeof v.baseUrl !== 'string' || typeof v.model !== 'string' ||
    typeof v.apiFormat !== 'string' || !(mailAiApiFormats as readonly string[]).includes(v.apiFormat) ||
    typeof v.timeoutMs !== 'number' || !Number.isInteger(v.timeoutMs) || v.timeoutMs < 100 || v.timeoutMs > 30000 ||
    typeof v.maxInputChars !== 'number' || !Number.isInteger(v.maxInputChars) || v.maxInputChars < 256 || v.maxInputChars > 32000) throw invalid();
  const baseUrl = v.baseUrl.trim() ? parseAiBaseUrl(v.baseUrl.trim()) : '';
  const model = v.model.trim();
  if (baseUrl === null || v.baseUrl.length > 2048 || model.length > 128 || /[\r\n]/u.test(model) || (v.enabled && (!baseUrl || !model))) throw invalid();
  return { enabled: v.enabled, baseUrl, model, apiFormat: v.apiFormat as MailAiSettings['apiFormat'], timeoutMs: v.timeoutMs, maxInputChars: v.maxInputChars };
}
async function readSaved(env: CloudflareEnv, owner: string): Promise<SavedSettings | null> {
  const row = await env.DB.prepare("SELECT json_extract(settings_json, '$.mailAi') AS settings FROM workspace_settings WHERE user_id = ?").bind(owner).first<{ settings: string | null }>();
  if (!row?.settings) return null;
  try {
    const v = JSON.parse(row.settings);
    const settings = parseSettings(v);
    if (typeof v.revision !== 'string' || !v.revision || (v.encryptedKey !== null && typeof v.encryptedKey !== 'string')) throw invalid();
    return { ...settings, revision: v.revision, encryptedKey: v.encryptedKey };
  } catch { throw new ApiError(503, 'AI_SETTINGS_INVALID', 'Saved AI settings are invalid.'); }
}
function defaults(env: CloudflareEnv): MailAiSettings {
  const positive = (value: string | undefined, fallback: number, min: number, max: number) => value && /^\d+$/u.test(value) && Number(value) >= min && Number(value) <= max ? Number(value) : fallback;
  return { enabled: parseBoolean(env.AI_ENABLED), baseUrl: parseAiBaseUrl(env.AI_BASE_URL) ?? '', model: env.AI_MODEL?.trim().slice(0, 128) ?? '',
    apiFormat: env.AI_API_FORMAT === 'responses' ? 'responses' : 'chat-completions', timeoutMs: positive(env.AI_TIMEOUT_MS, 15000, 100, 30000), maxInputChars: positive(env.AI_MAX_INPUT_CHARS, 16000, 256, 32000) };
}
function view(env: CloudflareEnv, saved: SavedSettings | null): MailAiSettingsView {
  const settings = saved ?? defaults(env);
  return { settings: { enabled: settings.enabled, baseUrl: settings.baseUrl, model: settings.model, apiFormat: settings.apiFormat, timeoutMs: settings.timeoutMs, maxInputChars: settings.maxInputChars },
    hasApiKey: saved ? Boolean(saved.encryptedKey) : validKey(env.AI_API_KEY), canSave: canEncrypt(env), revision: saved?.revision ?? '', source: saved ? 'workspace' : 'server' };
}

export async function requireAiSettingsOwner(env: CloudflareEnv, owner: string) {
  const row = await env.DB.prepare('SELECT user_id FROM workspace_owner WHERE singleton = 1').first<{ user_id: string }>();
  if (row?.user_id !== owner) throw new ApiError(403, 'OWNER_REQUIRED', 'Only the Owner can manage AI settings.');
}
export async function readMailAiSettings(env: CloudflareEnv, owner: string) { return view(env, await readSaved(env, owner)); }

export async function saveMailAiSettings(env: CloudflareEnv, owner: string, value: unknown): Promise<MailAiSettingsView> {
  if (!canEncrypt(env)) throw unavailable();
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const v = value as Record<string, unknown>;
  const keys = ['enabled', 'baseUrl', 'model', 'apiFormat', 'timeoutMs', 'maxInputChars', 'apiKey', 'clearApiKey', 'revision'];
  if (Object.keys(v).some((k) => !keys.includes(k)) || typeof v.revision !== 'string' || v.revision.length > 128 ||
    (v.apiKey !== undefined && v.apiKey !== '' && !validKey(v.apiKey)) || (v.clearApiKey !== undefined && typeof v.clearApiKey !== 'boolean') ||
    (v.clearApiKey && v.apiKey)) throw invalid();
  const settings = parseSettings(v);
  const current = await readSaved(env, owner);
  if ((current?.revision ?? '') !== v.revision) throw new ApiError(409, 'AI_SETTINGS_CONFLICT', 'AI settings changed. Reload before saving.');
  const previous = current ?? defaults(env);
  const hasPreviousKey = current ? Boolean(current.encryptedKey) : validKey(env.AI_API_KEY);
  if (settings.baseUrl !== previous.baseUrl && hasPreviousKey && !v.clearApiKey && !v.apiKey) throw new ApiError(400, 'AI_KEY_REENTRY_REQUIRED', 'Re-enter the API key when changing the endpoint.');
  let apiKey: string | null = null;
  if (!v.clearApiKey) apiKey = v.apiKey ? v.apiKey as string : current?.encryptedKey ? await decrypt(env, owner, current.baseUrl, current.encryptedKey) : !current && validKey(env.AI_API_KEY) ? env.AI_API_KEY : null;
  if (settings.enabled && !apiKey) throw new ApiError(400, 'AI_KEY_REQUIRED', 'An API key is required to enable AI.');
  const saved: SavedSettings = { ...settings, revision: crypto.randomUUID(), encryptedKey: apiKey ? await encrypt(env, owner, settings.baseUrl, apiKey) : null };
  const timestamp = new Date().toISOString();
  const row = await env.DB.prepare(`INSERT INTO workspace_settings (user_id, theme, settings_json, created_at, updated_at)
    VALUES (?, 'system', json_object('mailAi', json(?)), ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET settings_json = json_set(workspace_settings.settings_json, '$.mailAi', json(?)), updated_at = ?
    WHERE COALESCE(json_extract(workspace_settings.settings_json, '$.mailAi.revision'), '') = ? RETURNING user_id`)
    .bind(owner, JSON.stringify(saved), timestamp, timestamp, JSON.stringify(saved), timestamp, v.revision).first<{ user_id: string }>();
  if (!row) throw new ApiError(409, 'AI_SETTINGS_CONFLICT', 'AI settings changed. Reload before saving.');
  return view(env, saved);
}

export async function resolveWorkspaceMailAiConfiguration(env: CloudflareEnv, owner: string): Promise<MailAiConfiguration> {
  const saved = await readSaved(env, owner);
  if (!saved) return resolveMailAiConfiguration(env);
  if (!saved.enabled) return { status: 'disabled', config: null };
  const apiKey = saved.encryptedKey ? await decrypt(env, owner, saved.baseUrl, saved.encryptedKey) : '';
  return resolveMailAiConfiguration({ ...env, AI_ENABLED: 'true', AI_PROVIDER: 'openai-compatible', AI_BASE_URL: saved.baseUrl, AI_MODEL: saved.model,
    AI_API_FORMAT: saved.apiFormat, AI_TIMEOUT_MS: String(saved.timeoutMs), AI_MAX_INPUT_CHARS: String(saved.maxInputChars), AI_API_KEY: apiKey });
}
