import { isMailHealthFresh, type MailHealthState } from '$lib/domain/mail/health';
import { mailSenderSendBlockReason } from '$lib/domain/mail/sender-readiness';

export type DomainCapabilityState = 'ready' | 'catch_all_verified' | 'needs_check' | 'not_ready';

export interface DomainCapabilityAddress {
  lifecycleStatus: 'active' | 'disabled' | 'deleted';
  routingState: string;
  receiveEnabled: boolean;
  sendEnabled: boolean;
}

export interface DomainCapabilityInput {
  enabled: boolean;
  cloudflareHealth: MailHealthState;
  catchAllCollects: boolean;
  catchAllCheckedAt: string | null;
  catchAllProductionVerified: boolean;
  resendStatus: 'unknown' | 'pending' | 'verified' | 'failed';
  resendSendingStatus: 'unknown' | 'enabled' | 'disabled';
  resendCheckedAt: string | null;
  resendCheckFailed: boolean;
  addresses: readonly DomainCapabilityAddress[];
}

/** A dashboard summary of configured routes and the app's send gate, not a delivery probe. */
export function summarizeDomainCapabilities(input: DomainCapabilityInput, nowMs = Date.now()): {
  receiving: DomainCapabilityState;
  sending: DomainCapabilityState;
} {
  const hasExactRoute = input.addresses.some((address) =>
    address.lifecycleStatus === 'active' && address.receiveEnabled &&
    (address.routingState === 'active' || address.routingState === 'imported')
  );
  const exactReady = hasExactRoute && input.cloudflareHealth === 'fresh';
  const catchAllReady = input.catchAllCollects && isMailHealthFresh(input.catchAllCheckedAt, nowMs) &&
    (input.catchAllProductionVerified || input.cloudflareHealth === 'fresh');
  let receiving: DomainCapabilityState = 'not_ready';
  if (input.enabled && (input.catchAllCollects || hasExactRoute)) {
    if (catchAllReady && input.catchAllProductionVerified) receiving = 'catch_all_verified';
    else receiving = exactReady || catchAllReady ? 'ready' : 'needs_check';
  }

  const sendReasons = input.addresses.map((address) => mailSenderSendBlockReason({
    lifecycleStatus: address.lifecycleStatus,
    sendEnabled: address.sendEnabled,
    domainEnabled: input.enabled,
    resendStatus: input.resendStatus,
    resendSendingStatus: input.resendSendingStatus,
    resendCheckedAt: input.resendCheckedAt,
    resendCheckFailed: input.resendCheckFailed
  }, nowMs));
  const sending = sendReasons.some((reason) => reason === null)
    ? 'ready'
    : sendReasons.some((reason) => reason === 'provider_check_failed' || reason === 'provider_check_stale')
      ? 'needs_check'
      : 'not_ready';

  return { receiving, sending };
}
