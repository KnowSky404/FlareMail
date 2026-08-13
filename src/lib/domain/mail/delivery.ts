import type { DeliveryEventType, DeliveryState, DeliveryStatus } from './types';

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
  return ['queued', 'submitting', 'submitted', 'delayed', 'failed'].includes(status);
}

export const DELIVERY_STATUSES = Object.freeze(Object.keys(statusRank) as DeliveryStatus[]);
export const DELIVERY_EVENT_STATUSES = Object.freeze({ ...eventStatus });

export const getNextDeliveryStatus = transitionDeliveryStatus;
export const reduceDeliveryEvent = applyDeliveryEvent;
