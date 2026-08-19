import type { DeliveryEventType, DeliveryResultKind, DeliveryState, DeliveryStatus } from './types';

const engagementEvents = new Set<DeliveryEventType>(['email.opened', 'email.clicked']);

const statusRank: Record<DeliveryStatus, number> = {
  draft: 0,
  queued: 1,
  submitting: 2,
  submitted: 3,
  sent: 4,
  delayed: 4,
  bounced: 5,
  failed: 5,
  complained: 6,
  suppressed: 6,
  delivered: 7
};

const eventStatus: Partial<Record<DeliveryEventType, DeliveryStatus>> = {
  submission: 'submitted',
  'email.sent': 'sent',
  'email.delivered': 'delivered',
  'email.delivery_delayed': 'delayed',
  'email.bounced': 'bounced',
  'email.failed': 'failed',
  'email.complained': 'complained',
  'email.suppressed': 'suppressed'
};

/** The provider's same-key safety window for an outbound request. */
export const DELIVERY_IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;

const retryableStatuses = new Set<DeliveryStatus>(['submitting', 'delayed', 'failed']);
const retryBlockedResultKinds = new Set<DeliveryResultKind>(['accepted', 'queued']);

export type DeliveryRetryEligibilityCode =
  | 'eligible'
  | 'status_not_retryable'
  | 'result_not_retryable'
  | 'idempotency_key_missing'
  | 'attempt_age_missing'
  | 'attempt_age_invalid'
  | 'idempotency_window_expired';

export interface DeliveryRetryEligibilityInput {
  status: DeliveryStatus;
  resultKind?: DeliveryResultKind | null;
  idempotencyKey?: string | null;
  attemptStartedAt?: string | null;
  now?: string | number | Date;
}

export interface DeliveryRetryEligibility {
  eligible: boolean;
  code: DeliveryRetryEligibilityCode;
  reason: string;
}

const ineligible = (code: Exclude<DeliveryRetryEligibilityCode, 'eligible'>, reason: string): DeliveryRetryEligibility => ({
  eligible: false,
  code,
  reason
});

const timestamp = (value: string | number | Date | undefined) => {
  if (value instanceof Date) return value.valueOf();
  if (typeof value === 'number') return value;
  return value === undefined ? Date.now() : Date.parse(value);
};

/**
 * Decide whether reusing a persisted provider idempotency key is safe.
 *
 * This helper intentionally has no framework, database, or provider imports so
 * callers such as UI and server code can share the same status/result rules.
 * Ownership and persisted-key-to-message matching remain server concerns.
 */
export function getDeliveryRetryEligibility(input: DeliveryRetryEligibilityInput): DeliveryRetryEligibility {
  if (!retryableStatuses.has(input.status)) {
    return ineligible('status_not_retryable', `Delivery status '${input.status}' does not allow an ordinary retry.`);
  }
  if (input.resultKind && retryBlockedResultKinds.has(input.resultKind)) {
    return ineligible('result_not_retryable', `Delivery result '${input.resultKind}' indicates the provider already accepted or queued the message.`);
  }
  if (input.resultKind && !['temporary_failure', 'permanent_failure', 'rate_limited'].includes(input.resultKind)) {
    return ineligible('result_not_retryable', `Delivery result '${input.resultKind}' is not retryable.`);
  }
  if (!input.idempotencyKey?.trim()) {
    return ineligible('idempotency_key_missing', 'The persisted provider idempotency key is missing.');
  }
  if (!input.attemptStartedAt) {
    return ineligible('attempt_age_missing', 'The persisted delivery attempt age is unavailable.');
  }

  const startedAt = timestamp(input.attemptStartedAt);
  const now = timestamp(input.now);
  if (!Number.isFinite(startedAt) || !Number.isFinite(now) || startedAt > now) {
    return ineligible('attempt_age_invalid', 'The persisted delivery attempt age is invalid.');
  }
  if (now - startedAt >= DELIVERY_IDEMPOTENCY_WINDOW_MS) {
    return ineligible('idempotency_window_expired', 'The provider idempotency window has expired.');
  }
  return { eligible: true, code: 'eligible', reason: 'The delivery can be retried with its persisted idempotency key.' };
}

/** Status transitions never move backwards, including late webhook delivery. */
export function canTransitionDeliveryStatus(from: DeliveryStatus, to: DeliveryStatus): boolean {
  return statusRank[to] >= statusRank[from];
}

export function transitionDeliveryStatus(from: DeliveryStatus, to: DeliveryStatus): DeliveryStatus {
  if (isDeliveryTerminal(from) && from !== to) return from;
  return canTransitionDeliveryStatus(from, to) ? to : from;
}

export interface DeliveryEventUpdate {
  type: DeliveryEventType;
  createdAt?: string;
  error?: string | null;
  deliveredAt?: string | null;
  providerMessageId?: string | null;
}

/** Apply a provider event while preserving the existing state for engagement and unknown events. */
export function applyDeliveryEvent(state: DeliveryState, event: DeliveryEventUpdate): DeliveryState {
  const nextStatus = eventStatus[event.type];
  const status = nextStatus ? transitionDeliveryStatus(state.status, nextStatus) : state.status;
  const next: DeliveryState = {
    ...state,
    status,
    lastEvent: event.type,
    lastEventAt: event.createdAt ?? state.lastEventAt,
    providerMessageId: event.providerMessageId ?? state.providerMessageId
  };

  // opened/clicked and unknown future events are retained by the event log, but
  // cannot erase delivery facts such as deliveredAt or a terminal failure.
  if (event.type === 'email.delivered' && status === 'delivered') {
    next.deliveredAt = event.deliveredAt ?? event.createdAt ?? state.deliveredAt;
  }
  if (event.error && !engagementEvents.has(event.type)) next.error = event.error;
  return next;
}

export function isDeliveryTerminal(status: DeliveryStatus): boolean {
  return ['delivered', 'bounced', 'failed', 'complained', 'suppressed'].includes(status);
}

export function isDeliveryRetryable(status: DeliveryStatus): boolean {
  return retryableStatuses.has(status);
}

export const DELIVERY_STATUSES = Object.freeze(Object.keys(statusRank) as DeliveryStatus[]);
export const DELIVERY_EVENT_STATUSES = Object.freeze({ ...eventStatus });

export const getNextDeliveryStatus = transitionDeliveryStatus;
export const reduceDeliveryEvent = applyDeliveryEvent;
