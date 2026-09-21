import { isMailHealthFresh } from './health';
import type { MailSenderSendBlockReason } from './types';

export interface MailSenderReadinessInput {
  lifecycleStatus: 'active' | 'disabled' | 'deleted';
  sendEnabled: boolean;
  domainEnabled: boolean;
  resendStatus: 'unknown' | 'pending' | 'verified' | 'failed';
  resendSendingStatus: 'unknown' | 'enabled' | 'disabled';
  resendCheckedAt: string | null;
  resendCheckFailed: boolean;
}

/** Mirrors the send gate while keeping provider refresh failures distinct from stale health. */
export function mailSenderSendBlockReason(
  sender: MailSenderReadinessInput,
  nowMs = Date.now()
): MailSenderSendBlockReason | null {
  if (sender.lifecycleStatus === 'deleted') return 'address_deleted';
  if (sender.lifecycleStatus !== 'active' || !sender.sendEnabled) return 'address_disabled';
  if (!sender.domainEnabled) return 'domain_disabled';
  if (sender.resendStatus !== 'verified') return 'provider_unverified';
  if (sender.resendSendingStatus === 'disabled') return 'provider_sending_disabled';
  if (sender.resendSendingStatus !== 'enabled') return 'provider_unverified';
  if (!isMailHealthFresh(sender.resendCheckedAt, nowMs)) {
    return sender.resendCheckFailed ? 'provider_check_failed' : 'provider_check_stale';
  }
  return null;
}
