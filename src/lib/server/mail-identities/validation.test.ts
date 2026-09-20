import { describe, expect, test } from 'bun:test';
import {
  MailIdentityValidationError,
  normalizeAddressSignature,
  normalizeCloudflareZoneId,
  normalizeDisplayName,
  normalizeEmailWorkerName,
  normalizeMailDomain,
  normalizeManagedAddress
} from './validation';

describe('managed mail identity validation', () => {
  test('normalizes configured domains to lower-case ASCII DNS names', () => {
    expect(normalizeMailDomain('  Mail.Example.Test. ')).toBe('mail.example.test');
    expect(normalizeMailDomain('münich.example')).toBe('xn--mnich-kva.example');
    expect(() => normalizeMailDomain('https://example.test/path')).toThrow(MailIdentityValidationError);
    expect(() => normalizeMailDomain('127.0.0.1')).toThrow(MailIdentityValidationError);
  });

  test('validates zone IDs and trusted Worker names', () => {
    expect(normalizeCloudflareZoneId('A'.repeat(32))).toBe('a'.repeat(32));
    expect(() => normalizeCloudflareZoneId('zone-id')).toThrow(MailIdentityValidationError);
    expect(normalizeEmailWorkerName('flaremail-worker_1')).toBe('flaremail-worker_1');
    expect(() => normalizeEmailWorkerName('https://attacker.example')).toThrow(MailIdentityValidationError);
  });

  test('accepts a full address or local part only for its explicitly configured domain', () => {
    expect(normalizeManagedAddress('Sales+alerts', 'Example.Test')).toEqual({
      email: 'sales+alerts@example.test',
      localPart: 'sales+alerts'
    });
    expect(normalizeManagedAddress('support@EXAMPLE.TEST', 'example.test').email).toBe('support@example.test');
    expect(() => normalizeManagedAddress('support@other.test', 'example.test')).toThrow(
      expect.objectContaining({ code: 'address_domain_mismatch' })
    );
    expect(() => normalizeManagedAddress('dots..invalid', 'example.test')).toThrow(MailIdentityValidationError);
    const longDomain = ['b'.repeat(60), 'c'.repeat(60), 'd'.repeat(60), 'test'].join('.');
    expect(() => normalizeManagedAddress('a', longDomain)).toThrow(
      expect.objectContaining({ code: 'address_too_long' })
    );
  });

  test('bounds display names and signatures without adding newline header injection', () => {
    expect(normalizeDisplayName('FlareMail Owner')).toBe('FlareMail Owner');
    expect(() => normalizeDisplayName('Name\r\nBcc: victim@example.test')).toThrow(MailIdentityValidationError);
    expect(normalizeAddressSignature('First\r\nSecond')).toBe('First\nSecond');
    expect(() => normalizeAddressSignature('x'.repeat(16 * 1024 + 1))).toThrow(MailIdentityValidationError);
  });
});
