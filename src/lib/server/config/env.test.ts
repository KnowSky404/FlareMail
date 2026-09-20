import { describe, expect, test } from 'bun:test';
import { assertValidEnvironment, parseAccessIssuer, parseAccessJwksUrl, parseAppEnv, parseAuthMode, parseEnvironment, resolveOutboundFromEmail, validateEnvironment } from './env';

const bindings = {
  DB: {},
  BUCKET: {},
  RESEND_API_KEY: 'placeholder',
  RESEND_WEBHOOK_SECRET: `whsec_${btoa(String.fromCharCode(...new Uint8Array(32).fill(7)))}`,
  OUTBOUND_FROM_EMAIL: 'mail@example.test',
  OUTBOUND_PROVIDER: 'resend'
};

const accessConfiguration = {
  AUTH_MODE: 'cloudflare-access',
  ACCESS_ISSUER: 'https://flaremail-team.cloudflareaccess.com',
  ACCESS_AUDIENCE: '0123456789abcdef0123456789abcdef',
  ACCESS_JWKS_URL: 'https://flaremail-team.cloudflareaccess.com/cdn-cgi/access/certs',
  ACCESS_ALLOWED_SUBJECT: 'access-subject-1',
  ACCESS_OWNER_USER_ID: 'owner-1'
};

describe('runtime environment validation', () => {
  test('parses supported app environments and safe default', () => {
    expect(parseAppEnv('production')).toBe('production');
    expect(parseAppEnv('PREVIEW')).toBe('preview');
    expect(() => parseAppEnv('unknown')).toThrow();
  });

  test('parses explicit authentication modes and requires trusted Access configuration', () => {
    expect(parseAuthMode(undefined)).toBe('local');
    expect(parseAuthMode('LOCAL')).toBe('local');
    expect(parseAuthMode('cloudflare-access')).toBe('cloudflare-access');
    expect(parseAuthMode('automatic')).toBeNull();
    expect(parseAccessIssuer('https://flaremail-team.cloudflareaccess.com')).toBe('https://flaremail-team.cloudflareaccess.com');
    expect(parseAccessIssuer('https://attacker.example.test')).toBeNull();
    expect(parseAccessIssuer('https://flaremail-team.cloudflareaccess.com/path')).toBeNull();
    expect(parseAccessJwksUrl(accessConfiguration.ACCESS_JWKS_URL, accessConfiguration.ACCESS_ISSUER))
      .toBe(accessConfiguration.ACCESS_JWKS_URL);
    expect(parseAccessJwksUrl('https://attacker.example.test/cdn-cgi/access/certs', accessConfiguration.ACCESS_ISSUER)).toBeNull();
    expect(parseAccessJwksUrl('https://flaremail-team.cloudflareaccess.com/other', accessConfiguration.ACCESS_ISSUER)).toBeNull();

    expect(validateEnvironment({ ...accessConfiguration, APP_ENV: 'test' }).ok).toBe(true);
    expect(validateEnvironment({ AUTH_MODE: 'cloudflare-access' }).errors.map(({ code }) => code)).toEqual([
      'missing_access_issuer', 'missing_access_audience', 'missing_access_jwks_url',
      'missing_access_allowed_subject', 'missing_access_owner_user_id'
    ]);
    expect(validateEnvironment({ ...accessConfiguration, ACCESS_JWKS_URL: 'https://attacker.example.test/certs' })
      .errors.map(({ code }) => code)).toContain('invalid_access_jwks_url');
    expect(validateEnvironment({ AUTH_MODE: 'auto' }).errors.map(({ code }) => code)).toContain('invalid_auth_mode');
  });

  test('fails closed for required storage dependencies independently', () => {
    const requiredProductionInputs = [
      ['DB', 'missing_d1'],
      ['BUCKET', 'missing_r2']
    ] as const;

    for (const [input, diagnostic] of requiredProductionInputs) {
      const environment: Record<string, unknown> = { ...bindings, APP_ENV: 'production' };
      delete environment[input];
      const result = validateEnvironment(environment);
      expect(result.ok).toBe(false);
      expect(result.errors.map(({ code }) => code)).toContain(diagnostic);
      expect(() => assertValidEnvironment(environment)).toThrow(`Invalid runtime environment: ${diagnostic}.`);
    }

    expect(JSON.stringify(validateEnvironment({
      ...bindings,
      APP_ENV: 'production',
      RESEND_WEBHOOK_SECRET: 'super-private-hook-value'
    }))).not.toContain('super-private-hook-value');
  });

  test('keeps reading available when Resend sending is not configured', () => {
    const withoutProvider: Record<string, unknown> = { ...bindings, APP_ENV: 'production' };
    delete withoutProvider.OUTBOUND_PROVIDER;
    delete withoutProvider.RESEND_API_KEY;
    delete withoutProvider.OUTBOUND_FROM_EMAIL;
    expect(validateEnvironment(withoutProvider).ok).toBe(true);
    expect(validateEnvironment({ ...bindings, APP_ENV: 'production', OUTBOUND_PROVIDER: 'cloudflare' }).errors.map(({ code }) => code)).toContain('invalid_outbound_provider');
    expect(validateEnvironment({ ...bindings, APP_ENV: 'production' }).ok).toBe(true);
    expect(validateEnvironment({ APP_ENV: 'development', OUTBOUND_PROVIDER: 'unknown' }).errors.map(({ code }) => code)).toContain('invalid_outbound_provider');
  });

  test('keeps legacy sender aliases limited to system notifications', () => {
    const aliasOnly = { ...bindings, APP_ENV: 'production', MAIL_FROM: 'mail@example.test' };
    delete (aliasOnly as Record<string, unknown>).OUTBOUND_FROM_EMAIL;
    expect(validateEnvironment(aliasOnly).ok).toBe(true);
    expect(resolveOutboundFromEmail(aliasOnly)).toBe('mail@example.test');
    expect(validateEnvironment({ ...bindings, APP_ENV: 'production', MAIL_FROM: 'other@example.test' }).warnings.map(({ code }) => code))
      .toContain('conflicting_outbound_from');
    expect(resolveOutboundFromEmail({ ...bindings, MAIL_FROM: 'other@example.test' })).toBeNull();
    expect(validateEnvironment({ ...bindings, APP_ENV: 'production', MAIL_FROM: 'not-an-email' }).warnings.map(({ code }) => code))
      .toContain('conflicting_outbound_from');
    expect(validateEnvironment({ ...bindings, APP_ENV: 'production', MAIL_FROM: 'other@example.test', INBOUND_NOTIFICATION_ENABLED: 'true' }).errors.map(({ code }) => code))
      .toContain('conflicting_outbound_from');
    expect(validateEnvironment({ ...bindings, APP_ENV: 'production', OUTBOUND_FROM_EMAIL: undefined, AUTO_REPLY_ENABLED: 'true' }).errors.map(({ code }) => code))
      .toContain('missing_outbound_from');
  });

  test('requires an explicit opt-in for fake development and test services', () => {
    expect(parseEnvironment({ ...bindings, APP_ENV: 'development', OUTBOUND_PROVIDER: 'demo' }).fakeServicesExplicit).toBe(false);
    expect(validateEnvironment({ ...bindings, APP_ENV: 'development', OUTBOUND_PROVIDER: 'demo' }).errors[0]?.code).toBe('fake_services_not_explicit');
    expect(validateEnvironment({ ...bindings, APP_ENV: 'development', OUTBOUND_PROVIDER: 'demo', ALLOW_FAKE_SERVICES: 'true' }).ok).toBe(true);
    expect(validateEnvironment({ ...bindings, APP_ENV: 'test', OUTBOUND_PROVIDER: 'fake' }).errors[0]?.code).toBe('fake_services_not_explicit');
    expect(validateEnvironment({ ...bindings, APP_ENV: 'test', OUTBOUND_PROVIDER: 'fake', ALLOW_FAKE_SERVICES: 'true' }).ok).toBe(true);
    expect(validateEnvironment({ ...bindings, APP_ENV: 'preview', OUTBOUND_PROVIDER: 'demo', ALLOW_FAKE_SERVICES: 'true' }).errors[0]?.code).toBe('fake_services_not_explicit');
    expect(validateEnvironment({ ...bindings, APP_ENV: 'production', OUTBOUND_PROVIDER: 'fake' }).errors.map(({ code }) => code)).toContain('fake_services_in_production');
  });

  test('rejects unsafe provider settings', () => {
    expect(validateEnvironment({ ...bindings, APP_ENV: 'production', OUTBOUND_PROVIDER: 'resend', RESEND_WEBHOOK_SECRET: 'placeholder' }).errors.map(({ code }) => code)).toContain('invalid_webhook_secret');
    expect(validateEnvironment({ ...bindings, APP_ENV: 'production', OUTBOUND_PROVIDER: 'resend', RESEND_API_BASE_URL: 'https://resend.example.test' }).errors.map(({ code }) => code)).toContain('invalid_resend_api_base_url');
    expect(validateEnvironment({ ...bindings, APP_ENV: 'production', OUTBOUND_PROVIDER: 'resend', INBOUND_NOTIFICATION_ENABLED: 'yes' }).errors.map(({ code }) => code)).toContain('invalid_boolean');
  });
});
