import { isValidResendWebhookSecret } from '$lib/server/resend-webhook';

export const APP_ENV_VALUES = ['development', 'preview', 'test', 'production'] as const;
export type AppEnv = (typeof APP_ENV_VALUES)[number];
export const AUTH_MODES = ['local', 'cloudflare-access'] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

export interface RuntimeConfig {
  appEnv: AppEnv;
  authMode: AuthMode;
  accessIssuer: string | null;
  accessAudience: string | null;
  accessJwksUrl: string | null;
  accessAllowedSubject: string | null;
  accessOwnerUserId: string | null;
  outboundProvider: string | null;
  hasD1: boolean;
  hasR2: boolean;
  hasResendApiKey: boolean;
  hasTelegramBotToken: boolean;
  hasTelegramWebhookSecret: boolean;
  telegramEnabled: boolean;
  telegramConfigured: boolean;
  telegramBotUsername: string | null;
  appBaseUrl: string | null;
  fakeServicesExplicit: boolean;
  diagnostics: EnvironmentDiagnostic[];
}

export interface EnvironmentDiagnostic {
  code:
    | 'invalid_app_env'
    | 'invalid_auth_mode'
    | 'missing_access_issuer'
    | 'invalid_access_issuer'
    | 'missing_access_audience'
    | 'invalid_access_audience'
    | 'missing_access_jwks_url'
    | 'invalid_access_jwks_url'
    | 'missing_access_allowed_subject'
    | 'invalid_access_allowed_subject'
    | 'missing_access_owner_user_id'
    | 'invalid_access_owner_user_id'
    | 'missing_d1'
    | 'missing_r2'
    | 'missing_resend_api_key'
    | 'missing_resend_webhook_secret'
    | 'missing_outbound_from'
    | 'conflicting_outbound_from'
    | 'missing_outbound_provider'
    | 'invalid_outbound_provider'
    | 'fake_services_not_explicit'
    | 'fake_services_in_production'
    | 'invalid_boolean'
    | 'invalid_email'
    | 'invalid_webhook_secret'
    | 'invalid_resend_api_base_url'
    | 'missing_telegram_bot_token'
    | 'missing_telegram_bot_username'
    | 'missing_app_base_url'
    | 'invalid_telegram_bot_token'
    | 'invalid_telegram_webhook_secret'
    | 'invalid_telegram_bot_username'
    | 'invalid_app_base_url';
  severity: 'error' | 'warning';
  message: string;
}

export interface EnvironmentValidation {
  ok: boolean;
  config: RuntimeConfig;
  errors: EnvironmentDiagnostic[];
  warnings: EnvironmentDiagnostic[];
}

type RawEnvironment = Record<string, unknown>;

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

const TELEGRAM_USERNAME_PATTERN = /^[A-Za-z0-9_]{5,32}$/u;
const CLOUDFLARE_ACCESS_ISSUER_HOST = /(?:^|\.)cloudflareaccess\.com$/iu;

export function parseAuthMode(value: unknown): AuthMode | null {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) return 'local';
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return AUTH_MODES.includes(normalized as AuthMode) ? normalized as AuthMode : null;
}

export function parseAccessIssuer(value: unknown): string | null {
  const raw = asString(value);
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname !== '/' ||
      parsed.search || parsed.hash || !CLOUDFLARE_ACCESS_ISSUER_HOST.test(parsed.hostname) || parsed.port) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

export function parseAccessJwksUrl(value: unknown, issuer: string | null): string | null {
  const raw = asString(value);
  if (!raw || !issuer) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:' || parsed.origin !== issuer || parsed.pathname !== '/cdn-cgi/access/certs' ||
      parsed.username || parsed.password || parsed.search || parsed.hash || parsed.port) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

export function parseTrustedAppBaseUrl(value: unknown, appEnv: AppEnv): string | null {
  const raw = asString(value);
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    const localHttp = appEnv !== 'production' && appEnv !== 'preview' && parsed.protocol === 'http:' &&
      (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '[::1]');
    if ((!['https:'].includes(parsed.protocol) && !localHttp) || parsed.pathname !== '/' ||
      parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

export function isValidTelegramBotToken(value: unknown): value is string {
  return typeof value === 'string' && /^[^\s:]{3,64}:[A-Za-z0-9_-]{16,256}$/u.test(value.trim());
}

export function isValidTelegramWebhookSecret(value: unknown): value is string {
  return typeof value === 'string' && value.trim() === value && /^[A-Za-z0-9_-]{16,256}$/u.test(value);
}

export function resolveOutboundFromEmail(
  environment: { OUTBOUND_FROM_EMAIL?: unknown; MAIL_FROM?: unknown } | undefined
): string | null {
  const preferred = asString(environment?.OUTBOUND_FROM_EMAIL);
  const legacy = asString(environment?.MAIL_FROM);
  if (preferred && legacy && preferred.toLowerCase() !== legacy.toLowerCase()) return null;
  return preferred ?? legacy;
}

export function parseBoolean(value: unknown, fallback = false): boolean {
  if (value === true || (typeof value === 'string' && value.trim().toLowerCase() === 'true')) return true;
  if (value === false || (typeof value === 'string' && value.trim().toLowerCase() === 'false')) return false;
  return fallback;
}

export function parseAppEnv(value: unknown): AppEnv {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) return 'development';
  if (typeof value === 'string' && APP_ENV_VALUES.includes(value.trim().toLowerCase() as AppEnv)) {
    return value.trim().toLowerCase() as AppEnv;
  }
  throw new RangeError('APP_ENV must be development, preview, test, or production.');
}

/**
 * Parse bindings and non-secret configuration without returning any secret
 * values. The diagnostics contain codes and safe messages only.
 */
export function validateEnvironment(environment: RawEnvironment = {}): EnvironmentValidation {
  const rawEnvValue = asString(environment.APP_ENV);
  let appEnv: AppEnv;
  try {
    appEnv = parseAppEnv(rawEnvValue);
  } catch {
    // Keep diagnostics available to callers instead of failing while
    // constructing them. An invalid value is still an error below.
    appEnv = 'development';
  }
  const provider = asString(environment.OUTBOUND_PROVIDER);
  const hasD1 = Boolean(environment.DB);
  const hasR2 = Boolean(environment.BUCKET);
  const hasResendApiKey = Boolean(asString(environment.RESEND_API_KEY));
  const hasResendWebhookSecret = Boolean(asString(environment.RESEND_WEBHOOK_SECRET));
  const hasTelegramBotToken = Boolean(asString(environment.TELEGRAM_BOT_TOKEN));
  const hasTelegramWebhookSecret = Boolean(asString(environment.TELEGRAM_WEBHOOK_SECRET));
  const telegramEnabled = parseBoolean(environment.TELEGRAM_ENABLED);
  const telegramBotUsername = asString(environment.TELEGRAM_BOT_USERNAME);
  const hasTelegramBotUsername = Boolean(telegramBotUsername);
  const appBaseUrl = parseTrustedAppBaseUrl(environment.APP_BASE_URL, appEnv);
  const outboundFrom = asString(environment.OUTBOUND_FROM_EMAIL);
  const mailFrom = asString(environment.MAIL_FROM);
  const effectiveOutboundFrom = resolveOutboundFromEmail(environment);
  const autoReplyEnabled = parseBoolean(environment.AUTO_REPLY_ENABLED);
  const notificationsEnabled = parseBoolean(environment.INBOUND_NOTIFICATION_ENABLED);
  const systemOutboundEnabled = autoReplyEnabled || notificationsEnabled;
  const fakeServicesExplicit = parseBoolean(environment.ALLOW_FAKE_SERVICES) ||
    parseBoolean(environment.DEV_FAKE_SERVICES) || parseBoolean(environment.USE_FAKE_SERVICES);
  const diagnostics: EnvironmentDiagnostic[] = [];
  const error = (code: EnvironmentDiagnostic['code'], message: string) => diagnostics.push({ code, severity: 'error', message });
  const warning = (code: EnvironmentDiagnostic['code'], message: string) => diagnostics.push({ code, severity: 'warning', message });
  const isEmail = (value: string | null) => Boolean(value && /^[^\s@\r\n]+@[^\s@\r\n]+\.[^\s@\r\n]+$/u.test(value) && value.length <= 254);

  if (rawEnvValue && !APP_ENV_VALUES.includes(rawEnvValue.toLowerCase() as AppEnv)) {
    error('invalid_app_env', 'APP_ENV must be development, preview, test, or production.');
  }
  const rawAuthMode = asString(environment.AUTH_MODE);
  const authMode = parseAuthMode(rawAuthMode);
  if (!authMode) error('invalid_auth_mode', 'AUTH_MODE must be local or cloudflare-access.');
  const accessIssuer = parseAccessIssuer(environment.ACCESS_ISSUER);
  const rawAccessAudience = asString(environment.ACCESS_AUDIENCE);
  const accessAudience = rawAccessAudience && rawAccessAudience.length <= 256 && !/\s/u.test(rawAccessAudience)
    ? rawAccessAudience
    : null;
  const accessJwksUrl = parseAccessJwksUrl(environment.ACCESS_JWKS_URL, accessIssuer);
  const rawAccessAllowedSubject = asString(environment.ACCESS_ALLOWED_SUBJECT);
  const accessAllowedSubject = rawAccessAllowedSubject && rawAccessAllowedSubject.length <= 256 && !/\s/u.test(rawAccessAllowedSubject)
    ? rawAccessAllowedSubject
    : null;
  const rawAccessOwnerUserId = asString(environment.ACCESS_OWNER_USER_ID);
  const accessOwnerUserId = rawAccessOwnerUserId && rawAccessOwnerUserId.length <= 128 && !/\s/u.test(rawAccessOwnerUserId)
    ? rawAccessOwnerUserId
    : null;
  if (authMode === 'cloudflare-access') {
    if (!asString(environment.ACCESS_ISSUER)) error('missing_access_issuer', 'ACCESS_ISSUER is required in cloudflare-access mode.');
    else if (!accessIssuer) error('invalid_access_issuer', 'ACCESS_ISSUER must be a Cloudflare Access team HTTPS origin.');
    if (!rawAccessAudience) error('missing_access_audience', 'ACCESS_AUDIENCE is required in cloudflare-access mode.');
    else if (!accessAudience) error('invalid_access_audience', 'ACCESS_AUDIENCE must be a single non-empty value of at most 256 characters.');
    if (!asString(environment.ACCESS_JWKS_URL)) error('missing_access_jwks_url', 'ACCESS_JWKS_URL is required in cloudflare-access mode.');
    else if (!accessJwksUrl) error('invalid_access_jwks_url', 'ACCESS_JWKS_URL must be the trusted issuer /cdn-cgi/access/certs endpoint.');
    if (!rawAccessAllowedSubject) error('missing_access_allowed_subject', 'ACCESS_ALLOWED_SUBJECT is required in cloudflare-access mode.');
    else if (!accessAllowedSubject) error('invalid_access_allowed_subject', 'ACCESS_ALLOWED_SUBJECT must be a single non-empty subject value.');
    if (!rawAccessOwnerUserId) error('missing_access_owner_user_id', 'ACCESS_OWNER_USER_ID is required in cloudflare-access mode.');
    else if (!accessOwnerUserId) error('invalid_access_owner_user_id', 'ACCESS_OWNER_USER_ID must be a single non-empty Owner ID.');
  }
  if (appEnv === 'production' && !hasD1) error('missing_d1', 'Production requires a D1 binding.');
  if (appEnv === 'production' && !hasR2) error('missing_r2', 'Production requires an R2 binding.');
  if (outboundFrom && mailFrom && outboundFrom.toLowerCase() !== mailFrom.toLowerCase()) {
    (systemOutboundEnabled ? error : warning)(
      'conflicting_outbound_from',
      'OUTBOUND_FROM_EMAIL and MAIL_FROM conflict; managed workspace senders are unaffected.'
    );
  }
  if (systemOutboundEnabled && !effectiveOutboundFrom) {
    error('missing_outbound_from', 'Configure OUTBOUND_FROM_EMAIL for automatic replies and inbound notification email.');
  } else if (effectiveOutboundFrom && !isEmail(effectiveOutboundFrom)) {
    (systemOutboundEnabled ? error : warning)('invalid_email', 'The configured system notification sender must be a valid email address.');
  }
  if (telegramEnabled) {
    if (!hasTelegramBotToken) error('missing_telegram_bot_token', 'TELEGRAM_BOT_TOKEN is required when Telegram notifications are enabled.');
    if (!hasTelegramBotUsername) error('missing_telegram_bot_username', 'TELEGRAM_BOT_USERNAME is required when Telegram notifications are enabled.');
    if (!asString(environment.APP_BASE_URL)) error('missing_app_base_url', 'APP_BASE_URL is required when Telegram notifications are enabled.');
    if (hasTelegramBotToken && !isValidTelegramBotToken(environment.TELEGRAM_BOT_TOKEN)) error('invalid_telegram_bot_token', 'TELEGRAM_BOT_TOKEN has an invalid format.');
    if (hasTelegramWebhookSecret && !isValidTelegramWebhookSecret(environment.TELEGRAM_WEBHOOK_SECRET)) error('invalid_telegram_webhook_secret', 'TELEGRAM_WEBHOOK_SECRET has an invalid format.');
    if (telegramBotUsername && !TELEGRAM_USERNAME_PATTERN.test(telegramBotUsername)) error('invalid_telegram_bot_username', 'TELEGRAM_BOT_USERNAME has an invalid format.');
    if (asString(environment.APP_BASE_URL) && !appBaseUrl) error('invalid_app_base_url', 'APP_BASE_URL must be a credential-free HTTPS origin.');
  }
  const notificationEmail = asString(environment.NOTIFICATION_EMAIL);
  if (notificationsEnabled && !notificationEmail) error('invalid_email', 'NOTIFICATION_EMAIL is required when notifications are enabled.');
  if (notificationsEnabled && notificationEmail && !isEmail(notificationEmail)) error('invalid_email', 'NOTIFICATION_EMAIL must be a valid email address.');
  if (provider && !['demo', 'fake', 'resend'].includes(provider.toLowerCase())) {
    error('invalid_outbound_provider', 'OUTBOUND_PROVIDER is not supported.');
  }
  if (appEnv === 'production' && provider && provider.toLowerCase() !== 'resend') {
    error('invalid_outbound_provider', 'Production requires OUTBOUND_PROVIDER=resend.');
  }
  if (provider && /^(demo|fake)$/iu.test(provider) && appEnv === 'production') {
    error('fake_services_in_production', 'Fake outbound services are disabled in production.');
  } else if (provider && /^(demo|fake)$/iu.test(provider) && !['development', 'test'].includes(appEnv)) {
    error('fake_services_not_explicit', 'Fake outbound services are only available in development or test.');
  } else if (provider && /^(demo|fake)$/iu.test(provider) && !fakeServicesExplicit) {
    error('fake_services_not_explicit', 'Fake outbound services require ALLOW_FAKE_SERVICES=true (or an equivalent explicit flag).');
  }
  for (const name of ['AUTO_REPLY_ENABLED', 'INBOUND_NOTIFICATION_ENABLED', 'TELEGRAM_ENABLED', 'ALLOW_FAKE_SERVICES', 'DEV_FAKE_SERVICES', 'USE_FAKE_SERVICES']) {
    const raw = environment[name];
    if (raw !== undefined && raw !== null && typeof raw !== 'boolean' && !['true', 'false'].includes(String(raw).trim().toLowerCase())) {
      error('invalid_boolean', `${name} must be true or false.`);
    }
  }
  const webhookSecret = asString(environment.RESEND_WEBHOOK_SECRET);
  if (appEnv === 'production' && webhookSecret && (!webhookSecret.startsWith('whsec_') || !isValidResendWebhookSecret(webhookSecret))) {
    error('invalid_webhook_secret', 'RESEND_WEBHOOK_SECRET has an invalid format.');
  }
  const baseUrl = asString(environment.RESEND_API_BASE_URL);
  if (baseUrl) {
    try {
      const parsed = new URL(baseUrl);
      const official = parsed.protocol === 'https:' && parsed.origin === 'https://api.resend.com' && parsed.pathname === '/' && !parsed.username && !parsed.password && !parsed.search && !parsed.hash;
      if (appEnv === 'production' && !official) error('invalid_resend_api_base_url', 'Production must use the official Resend HTTPS origin.');
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') {
        error('invalid_resend_api_base_url', 'RESEND_API_BASE_URL must be a credential-free HTTPS origin.');
      }
    } catch {
      error('invalid_resend_api_base_url', 'RESEND_API_BASE_URL is invalid.');
    }
  }

  const config: RuntimeConfig = {
    appEnv,
    authMode: authMode ?? 'local',
    accessIssuer,
    accessAudience,
    accessJwksUrl,
    accessAllowedSubject,
    accessOwnerUserId,
    outboundProvider: provider,
    hasD1,
    hasR2,
    hasResendApiKey,
    hasTelegramBotToken,
    hasTelegramWebhookSecret,
    telegramEnabled,
    telegramConfigured: telegramEnabled && hasTelegramBotToken && Boolean(telegramBotUsername && appBaseUrl) &&
      isValidTelegramBotToken(environment.TELEGRAM_BOT_TOKEN) &&
      (!hasTelegramWebhookSecret || isValidTelegramWebhookSecret(environment.TELEGRAM_WEBHOOK_SECRET)) &&
      Boolean(telegramBotUsername && TELEGRAM_USERNAME_PATTERN.test(telegramBotUsername)),
    telegramBotUsername,
    appBaseUrl,
    fakeServicesExplicit,
    diagnostics
  };
  return {
    ok: diagnostics.every((diagnostic) => diagnostic.severity !== 'error'),
    config,
    errors: diagnostics.filter((diagnostic) => diagnostic.severity === 'error'),
    warnings: diagnostics.filter((diagnostic) => diagnostic.severity === 'warning')
  };
}

export function parseEnvironment(environment: RawEnvironment = {}): RuntimeConfig {
  return validateEnvironment(environment).config;
}

export const getEnvironmentDiagnostics = validateEnvironment;
export const validateEnv = validateEnvironment;

/** Fail closed when a runtime is about to start with invalid configuration. */
export function assertValidEnvironment(environment: RawEnvironment = {}): RuntimeConfig {
  const validation = validateEnvironment(environment);
  if (!validation.ok) {
    throw new Error(`Invalid runtime environment: ${validation.errors.map(({ code }) => code).join(', ')}.`);
  }
  return validation.config;
}

export const requireProductionEnvironment = assertValidEnvironment;
