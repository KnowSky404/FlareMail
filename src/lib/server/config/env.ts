export const APP_ENV_VALUES = ['development', 'preview', 'test', 'production'] as const;
export type AppEnv = (typeof APP_ENV_VALUES)[number];

export interface RuntimeConfig {
  appEnv: AppEnv;
  appOrigin: string | null;
  outboundProvider: string | null;
  hasD1: boolean;
  hasR2: boolean;
  hasResendApiKey: boolean;
  fakeServicesExplicit: boolean;
  diagnostics: EnvironmentDiagnostic[];
}

export interface EnvironmentDiagnostic {
  code:
    | 'invalid_app_env'
    | 'missing_app_origin'
    | 'invalid_app_origin'
    | 'missing_d1'
    | 'missing_r2'
    | 'missing_resend_api_key'
    | 'missing_resend_webhook_secret'
    | 'missing_outbound_from'
    | 'missing_outbound_provider'
    | 'invalid_outbound_provider'
    | 'fake_services_not_explicit'
    | 'fake_services_in_production'
    | 'invalid_boolean'
    | 'invalid_email'
    | 'invalid_webhook_secret'
    | 'invalid_resend_api_base_url';
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

export function parseBoolean(value: unknown, fallback = false): boolean {
  if (value === true || (typeof value === 'string' && value.trim().toLowerCase() === 'true')) return true;
  if (value === false || (typeof value === 'string' && value.trim().toLowerCase() === 'false')) return false;
  return fallback;
}

function parseOrigin(value: string | null): { value: string | null; invalid: boolean } {
  if (!value) return { value: null, invalid: false };
  try {
    const parsed = new URL(value);
    if (!/^https?:$/u.test(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') {
      return { value: null, invalid: true };
    }
    return { value: parsed.origin, invalid: false };
  } catch {
    return { value: null, invalid: true };
  }
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
  const origin = parseOrigin(asString(environment.APP_ORIGIN));
  const provider = asString(environment.OUTBOUND_PROVIDER);
  const hasD1 = Boolean(environment.DB);
  const hasR2 = Boolean(environment.BUCKET);
  const hasResendApiKey = Boolean(asString(environment.RESEND_API_KEY));
  const hasResendWebhookSecret = Boolean(asString(environment.RESEND_WEBHOOK_SECRET));
  const outboundFrom = asString(environment.OUTBOUND_FROM_EMAIL);
  const notificationsEnabled = parseBoolean(environment.INBOUND_NOTIFICATION_ENABLED);
  const fakeServicesExplicit = parseBoolean(environment.ALLOW_FAKE_SERVICES) ||
    parseBoolean(environment.DEV_FAKE_SERVICES) || parseBoolean(environment.USE_FAKE_SERVICES);
  const diagnostics: EnvironmentDiagnostic[] = [];
  const error = (code: EnvironmentDiagnostic['code'], message: string) => diagnostics.push({ code, severity: 'error', message });
  const isEmail = (value: string | null) => Boolean(value && /^[^\s@\r\n]+@[^\s@\r\n]+\.[^\s@\r\n]+$/u.test(value) && value.length <= 254);

  if (rawEnvValue && !APP_ENV_VALUES.includes(rawEnvValue.toLowerCase() as AppEnv)) {
    error('invalid_app_env', 'APP_ENV must be development, preview, test, or production.');
  }
  if (origin.invalid || (appEnv === 'production' && origin.value && new URL(origin.value).protocol !== 'https:')) {
    error('invalid_app_origin', 'APP_ORIGIN must be a credential-free HTTPS origin in production.');
  }
  if (appEnv === 'production' && !origin.value) error('missing_app_origin', 'Production requires APP_ORIGIN.');
  if (appEnv === 'production' && !hasD1) error('missing_d1', 'Production requires a D1 binding.');
  if (appEnv === 'production' && !hasR2) error('missing_r2', 'Production requires an R2 binding.');
  if (appEnv === 'production' && !hasResendApiKey) error('missing_resend_api_key', 'Production requires a Resend API key.');
  if (appEnv === 'production' && !hasResendWebhookSecret) error('missing_resend_webhook_secret', 'Production requires a Resend webhook secret.');
  if (appEnv === 'production' && !outboundFrom) error('missing_outbound_from', 'Production requires OUTBOUND_FROM_EMAIL.');
  if (appEnv === 'production' && outboundFrom && !isEmail(outboundFrom)) error('invalid_email', 'OUTBOUND_FROM_EMAIL must be a valid email address.');
  const notificationEmail = asString(environment.NOTIFICATION_EMAIL);
  if (notificationsEnabled && !notificationEmail) error('invalid_email', 'NOTIFICATION_EMAIL is required when notifications are enabled.');
  if (notificationsEnabled && notificationEmail && !isEmail(notificationEmail)) error('invalid_email', 'NOTIFICATION_EMAIL must be a valid email address.');
  if (appEnv === 'production' && !provider) error('missing_outbound_provider', 'Production requires OUTBOUND_PROVIDER=resend.');
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
  for (const name of ['AUTO_REPLY_ENABLED', 'INBOUND_NOTIFICATION_ENABLED', 'ALLOW_FAKE_SERVICES', 'DEV_FAKE_SERVICES', 'USE_FAKE_SERVICES']) {
    const raw = environment[name];
    if (raw !== undefined && raw !== null && typeof raw !== 'boolean' && !['true', 'false'].includes(String(raw).trim().toLowerCase())) {
      error('invalid_boolean', `${name} must be true or false.`);
    }
  }
  const webhookSecret = asString(environment.RESEND_WEBHOOK_SECRET);
  if (appEnv === 'production' && webhookSecret && !/^whsec_[A-Za-z0-9._-]{8,}$/u.test(webhookSecret)) {
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
    appOrigin: origin.value,
    outboundProvider: provider,
    hasD1,
    hasR2,
    hasResendApiKey,
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
