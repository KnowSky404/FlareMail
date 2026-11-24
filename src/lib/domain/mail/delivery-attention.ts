export const deliveryAttentionKinds = ['delayed', 'failed', 'bounced', 'complained', 'suppressed', 'stale_submitting'] as const;
export type DeliveryAttentionKind = typeof deliveryAttentionKinds[number];
export type DeliveryAttentionState = 'open' | 'acknowledged' | 'resolved' | 'superseded';

export interface DeliveryAttentionRef {
  id: number;
  version: number;
}

export interface DeliveryAttentionSnapshot {
  version: number;
  asOf: string;
}

export interface DeliveryAttentionSummary {
  pendingCount: number;
  snapshot: DeliveryAttentionSnapshot;
}

export interface DeliveryAttentionItem extends DeliveryAttentionRef {
  messageId: string;
  kind: DeliveryAttentionKind;
  state: DeliveryAttentionState;
  occurredAt: string;
  acknowledgedAt: string | null;
  closedAt: string | null;
}

export interface DeliveryAttentionNotice extends DeliveryAttentionItem {
  subject: string;
  sender: string;
}

export interface DeliveryAttentionPage {
  notices: DeliveryAttentionNotice[];
  nextCursor: string | null;
  summary: DeliveryAttentionSummary;
}

export type DeliveryAttentionAction =
  | { action: 'acknowledge' | 'reopen'; incident: DeliveryAttentionRef }
  | { action: 'acknowledge_all'; snapshot: DeliveryAttentionSnapshot };
