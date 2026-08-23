import { describe, expect, test } from 'bun:test';
import { assertValidEnvironment, parseAppEnv, parseEnvironment, resolveOutboundFromEmail, validateEnvironment } from './env';

const bindings = {
  DB: {},
  BUCKET: {},
  APP_ORIGIN: 'https://mail.example.test',
  RESEND_API_KEY: 'placeholder',
  RESEND_WEBHOOK_SECRET: `whsec_${btoa(String.fromCharCode(...new Uint8Array(32).fill(7)))}`,
  OUTBOUND_FROM_EMAIL: 'mail@example.test',
  OUTBOUND_PROVIDER: 'resend'
};

describe('runtime environment validation', () => {
  test('parses supported app environments and safe default', () => {
    expect(parseAppEnv('production')).toBe('production');
    expect(parseAppEnv('PREVIEW')).toBe('preview');
    expect(() => parseAppEnv('unknown')).toThrow();
  });

  test('fails closed for every required production dependency independently', () => {
    const requiredProductionInputs = [
      ['DB', 'missing_d1'],
      ['BUCKET', 'missing_r2'],
      ['RESEND_API_KEY', 'missing_resend_api_key'],
      ['RESEND_WEBHOOK_SECRET', 'missing_resend_webhook_secret'],
      ['OUTBOUND_FROM_EMAIL', 'missing_outbound_from'],
      ['APP_ORIGIN', 'missing_app_origin']
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

  test('requires an explicit Resend provider in production', () => {
    const withoutProvider: Record<string, unknown> = { ...bindings, APP_ENV: 'production' };
    delete withoutProvider.OUTBOUND_PROVIDER;
    expect(validateEnvironment(withoutProvider).errors.map(({ code }) => code)).toContain('missing_outbound_provider');
    expect(validateEnvironment({ ...bindings, APP_ENV: 'production', OUTBOUND_PROVIDER: 'cloudflare' }).errors.map(({ code }) => code)).toContain('invalid_outbound_provider');
    expect(validateEnvironment({ ...bindings, APP_ENV: 'production' }).ok).toBe(true);
    expect(validateEnvironment({ APP_ENV: 'development', OUTBOUND_PROVIDER: 'unknown' }).errors.map(({ code }) => code)).toContain('invalid_outbound_provider');
  });

  test('accepts MAIL_FROM as a legacy sender alias and rejects conflicting values', () => {
    const aliasOnly = { ...bindings, APP_ENV: 'production', MAIL_FROM: 'mail@example.test' };
    delete (aliasOnly as Record<string, unknown>).OUTBOUND_FROM_EMAIL;
    expect(validateEnvironment(aliasOnly).ok).toBe(true);
    expect(resolveOutboundFromEmail(aliasOnly)).toBe('mail@example.test');
    expect(validateEnvironment({ ...bindings, APP_ENV: 'production', MAIL_FROM: 'other@example.test' }).errors.map(({ code }) => code))
      .toContain('conflicting_outbound_from');
    expect(resolveOutboundFromEmail({ ...bindings, MAIL_FROM: 'other@example.test' })).toBeNull();
    expect(validateEnvironment({ ...bindings, APP_ENV: 'production', MAIL_FROM: 'not-an-email' }).errors.map(({ code }) => code))
      .toContain('conflicting_outbound_from');
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

  test('rejects insecure or decorated production origins and unsafe provider settings', () => {
    expect(validateEnvironment({ ...bindings, APP_ENV: 'production', OUTBOUND_PROVIDER: 'resend', APP_ORIGIN: 'http://mail.example.test' }).errors.map(({ code }) => code)).toContain('invalid_app_origin');
    expect(validateEnvironment({ ...bindings, APP_ENV: 'production', OUTBOUND_PROVIDER: 'resend', APP_ORIGIN: 'https://user:pass@mail.example.test/?x=1' }).errors.map(({ code }) => code)).toContain('invalid_app_origin');
    expect(validateEnvironment({ ...bindings, APP_ENV: 'production', OUTBOUND_PROVIDER: 'resend', RESEND_WEBHOOK_SECRET: 'placeholder' }).errors.map(({ code }) => code)).toContain('invalid_webhook_secret');
    expect(validateEnvironment({ ...bindings, APP_ENV: 'production', OUTBOUND_PROVIDER: 'resend', RESEND_API_BASE_URL: 'https://resend.example.test' }).errors.map(({ code }) => code)).toContain('invalid_resend_api_base_url');
    expect(validateEnvironment({ ...bindings, APP_ENV: 'production', OUTBOUND_PROVIDER: 'resend', INBOUND_NOTIFICATION_ENABLED: 'yes' }).errors.map(({ code }) => code)).toContain('invalid_boolean');
  });
});
