import type { DeliveryStatus, MailMessage } from '$lib/mock/mailbox';

export type OutboundDeliveryState = {
  status: DeliveryStatus;
  attempts: number;
  deliveredAt: string | null;
  lastError: string;
  providerMessageId: string | null;
};

const nowIso = () => new Date().toISOString();

const deliveryKeyword = (message: Pick<MailMessage, 'toEmail' | 'subject'>) =>
  `${message.toEmail} ${message.subject}`.toLowerCase();

const shouldQueueDelivery = (message: Pick<MailMessage, 'toEmail' | 'subject'>) => {
  const value = deliveryKeyword(message);
  return value.includes('+queue@') || value.includes('[queue]') || value.includes('hold@');
};

const shouldFailDelivery = (message: Pick<MailMessage, 'toEmail' | 'subject'>) => {
  const value = deliveryKeyword(message);
  return value.includes('+fail@') || value.includes('[fail]') || value.includes('bounce@');
};

const createSentDeliveryState = (attempts: number): OutboundDeliveryState => ({
  status: 'sent',
  attempts,
  deliveredAt: nowIso(),
  lastError: '',
  providerMessageId: `mock-send-${crypto.randomUUID()}`
});

const createFailedDeliveryState = (attempts: number): OutboundDeliveryState => ({
  status: 'failed',
  attempts,
  deliveredAt: null,
  lastError: '收件方服务器暂时拒绝了这次投递，请稍后重试。',
  providerMessageId: null
});

const createQueuedDeliveryState = (): OutboundDeliveryState => ({
  status: 'queued',
  attempts: 0,
  deliveredAt: null,
  lastError: '',
  providerMessageId: null
});

export function resolveInitialOutboundDelivery(message: Pick<MailMessage, 'toEmail' | 'subject'>) {
  if (shouldQueueDelivery(message)) {
    return createQueuedDeliveryState();
  }

  if (shouldFailDelivery(message)) {
    return createFailedDeliveryState(1);
  }

  return createSentDeliveryState(1);
}

export function resolveRetriedOutboundDelivery(
  message: Pick<MailMessage, 'toEmail' | 'subject'>,
  currentAttempts: number
) {
  if (shouldFailDelivery(message)) {
    return createFailedDeliveryState(currentAttempts + 1);
  }

  return createSentDeliveryState(currentAttempts + 1);
}
