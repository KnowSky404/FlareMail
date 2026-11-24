import type { DeliveryAttentionKind, DeliveryAttentionState } from '$lib/domain/mail';
import type { SystemHealth } from '$lib/domain/runtime-state';
import type { MessageKey } from '$lib/i18n';

export const attentionKindLabel = {
  delayed: 'mail.statusDelayed',
  failed: 'mail.statusFailed',
  bounced: 'mail.statusBounced',
  complained: 'mail.statusComplained',
  suppressed: 'mail.statusSuppressed',
  stale_submitting: 'attention.staleSubmitting'
} satisfies Record<DeliveryAttentionKind, MessageKey>;

export const attentionStateLabel = {
  open: 'attention.pending',
  acknowledged: 'attention.acknowledged',
  resolved: 'attention.resolved',
  superseded: 'attention.superseded'
} satisfies Record<DeliveryAttentionState, MessageKey>;

export const systemHealthLabel = {
  ready: 'attention.systemReady',
  degraded: 'attention.systemDegraded',
  checking: 'attention.systemChecking',
  unknown: 'attention.systemUnknown'
} satisfies Record<SystemHealth, MessageKey>;
