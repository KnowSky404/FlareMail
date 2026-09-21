import { describe, expect, test } from 'bun:test';
import { mailSenderSendBlockReason, type MailSenderReadinessInput } from './sender-readiness';

const readySender: MailSenderReadinessInput = {
  lifecycleStatus: 'active',
  sendEnabled: true,
  domainEnabled: true,
  resendStatus: 'verified',
  resendSendingStatus: 'enabled',
  resendCheckedAt: '2026-09-21T11:00:00.000Z',
  resendCheckFailed: false
};
const now = Date.parse('2026-09-21T12:00:00.000Z');

describe('mail sender readiness reason', () => {
  test('matches the send gate for address and domain state', () => {
    expect(mailSenderSendBlockReason({ ...readySender, lifecycleStatus: 'deleted' }, now)).toBe('address_deleted');
    expect(mailSenderSendBlockReason({ ...readySender, lifecycleStatus: 'disabled' }, now)).toBe('address_disabled');
    expect(mailSenderSendBlockReason({ ...readySender, sendEnabled: false }, now)).toBe('address_disabled');
    expect(mailSenderSendBlockReason({ ...readySender, domainEnabled: false }, now)).toBe('domain_disabled');
  });

  test('distinguishes provider verification, provider sending, and freshness failures', () => {
    expect(mailSenderSendBlockReason({ ...readySender, resendStatus: 'pending' }, now)).toBe('provider_unverified');
    expect(mailSenderSendBlockReason({ ...readySender, resendSendingStatus: 'disabled' }, now)).toBe('provider_sending_disabled');
    expect(mailSenderSendBlockReason({ ...readySender, resendCheckedAt: '2026-09-20T11:00:00.000Z' }, now)).toBe('provider_check_stale');
    expect(mailSenderSendBlockReason({ ...readySender, resendCheckedAt: '2026-09-20T11:00:00.000Z', resendCheckFailed: true }, now))
      .toBe('provider_check_failed');
  });

  test('keeps a sender usable while its previous verification is fresh after a failed refresh', () => {
    expect(mailSenderSendBlockReason({ ...readySender, resendCheckFailed: true }, now)).toBeNull();
  });
});
