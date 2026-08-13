import type { DeliveryResultKind, DeliveryStatus } from '$lib/domain/mail';

/**
 * Compatibility state used by webhook reconciliation serializers. Provider
 * submission is implemented exclusively by outbound/gateway.ts.
 */
export interface OutboundDeliveryState {
  status: DeliveryStatus;
  attempts: number;
  deliveredAt: string | null;
  lastError: string;
  provider: string;
  providerMessageId: string | null;
  resultKind: DeliveryResultKind;
  remoteStatus: number | null;
  responsePreview: string;
}

export * from './outbound/gateway';
export * from './outbound/provider';
