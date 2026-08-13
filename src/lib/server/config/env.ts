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
    | 'fake_services_in_production';
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

function asBoolean(value: unknown): boolean {
  return value === true || (typeof value === 'string' && /^(1|true|yes|on)$/iu.test(value.trim()));
}

function parseOrigin(value: string | null): { value: string | null; invalid: boolean } {
  if (!value) return { value: null, invalid: false };
  try {
    const parsed = new URL(value);
    if (!/^https?:$/u.test(parsed.protocol)) return { value: null, invalid: true };
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
  const hasOutboundFrom = Boolean(asString(environment.OUTBOUND_FROM_EMAIL));
  const fakeServicesExplicit = asBoolean(environment.ALLOW_FAKE_SERVICES) ||
    asBoolean(environment.DEV_FAKE_SERVICES) || asBoolean(environment.USE_FAKE_SERVICES);
  const diagnostics: EnvironmentDiagnostic[] = [];
  const error = (code: EnvironmentDiagnostic['code'], message: string) => diagnostics.push({ code, severity: 'error', message });

  if (rawEnvValue && !APP_ENV_VALUES.includes(rawEnvValue.toLowerCase() as AppEnv)) {
    error('invalid_app_env', 'APP_ENV must be development, preview, test, or production.');
  }
  if (origin.invalid) error('invalid_app_origin', 'APP_ORIGIN must be an http(s) origin.');
  if (appEnv === 'production' && !origin.value) error('missing_app_origin', 'Production requires APP_ORIGIN.');
  if (appEnv === 'production' && !hasD1) error('missing_d1', 'Production requires a D1 binding.');
  if (appEnv === 'production' && !hasR2) error('missing_r2', 'Production requires an R2 binding.');
  if (appEnv === 'production' && !hasResendApiKey) error('missing_resend_api_key', 'Production requires a Resend API key.');
  if (appEnv === 'production' && !hasResendWebhookSecret) error('missing_resend_webhook_secret', 'Production requires a Resend webhook secret.');
  if (appEnv === 'production' && !hasOutboundFrom) error('missing_outbound_from', 'Production requires OUTBOUND_FROM_EMAIL.');
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
