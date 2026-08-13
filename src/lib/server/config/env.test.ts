import { describe, expect, test } from 'bun:test';
import { parseAppEnv, parseEnvironment, validateEnvironment } from './env';

const bindings = { DB: {}, BUCKET: {}, APP_ORIGIN: 'https://mail.example.test', RESEND_API_KEY: 'placeholder', RESEND_WEBHOOK_SECRET: 'placeholder', OUTBOUND_FROM_EMAIL: 'mail@example.test' };

describe('runtime environment validation', () => {
  test('parses supported app environments and safe default', () => {
    expect(parseAppEnv('production')).toBe('production');
    expect(parseAppEnv('PREVIEW')).toBe('preview');
    expect(() => parseAppEnv('unknown')).toThrow();
  });

  test('reports production bindings independently without secret values', () => {
    const result = validateEnvironment({ APP_ENV: 'production', APP_ORIGIN: 'https://mail.example.test' });
    expect(result.ok).toBe(false);
    expect(result.errors.map(({ code }) => code)).toEqual(expect.arrayContaining(['missing_d1', 'missing_r2', 'missing_resend_api_key', 'missing_resend_webhook_secret', 'missing_outbound_from', 'missing_outbound_provider']));
    expect(JSON.stringify(validateEnvironment({
      ...bindings,
      APP_ENV: 'production',
      OUTBOUND_PROVIDER: 'resend',
      RESEND_WEBHOOK_SECRET: 'super-private-hook-value'
    }))).not.toContain('super-private-hook-value');
  });

  test('requires an explicit Resend provider in production', () => {
    expect(validateEnvironment({ ...bindings, APP_ENV: 'production' }).errors.map(({ code }) => code)).toContain('missing_outbound_provider');
    expect(validateEnvironment({ ...bindings, APP_ENV: 'production', OUTBOUND_PROVIDER: 'cloudflare' }).errors.map(({ code }) => code)).toContain('invalid_outbound_provider');
    expect(validateEnvironment({ ...bindings, APP_ENV: 'production', OUTBOUND_PROVIDER: 'resend' }).ok).toBe(true);
    expect(validateEnvironment({ APP_ENV: 'development', OUTBOUND_PROVIDER: 'unknown' }).errors.map(({ code }) => code)).toContain('invalid_outbound_provider');
  });

  test('requires an explicit opt-in for fake development services', () => {
    expect(parseEnvironment({ ...bindings, APP_ENV: 'development', OUTBOUND_PROVIDER: 'demo' }).fakeServicesExplicit).toBe(false);
    expect(validateEnvironment({ ...bindings, APP_ENV: 'development', OUTBOUND_PROVIDER: 'demo' }).errors[0]?.code).toBe('fake_services_not_explicit');
    expect(validateEnvironment({ ...bindings, APP_ENV: 'development', OUTBOUND_PROVIDER: 'demo', ALLOW_FAKE_SERVICES: 'true' }).ok).toBe(true);
    expect(validateEnvironment({ ...bindings, APP_ENV: 'preview', OUTBOUND_PROVIDER: 'demo', ALLOW_FAKE_SERVICES: 'true' }).errors[0]?.code).toBe('fake_services_not_explicit');
    expect(validateEnvironment({ ...bindings, APP_ENV: 'production', OUTBOUND_PROVIDER: 'fake' }).errors.map(({ code }) => code)).toContain('fake_services_in_production');
  });
});
