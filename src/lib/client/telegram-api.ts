import { requestJson } from './api';

export type TelegramDeliveryStatus = 'pending' | 'processing' | 'retryable' | 'sent' | 'failed' | 'unknown_delivery' | 'cancelled';

export interface TelegramDeliverySummary {
  id: string;
  status: TelegramDeliveryStatus;
  attempts: number;
  maxAttempts: number;
  subject: string;
  receivedAt: string;
  lastErrorCode: string | null;
  createdAt: string;
  completedAt: string | null;
  manualRetryWarning: boolean;
}

export interface TelegramSettingsStatus {
  globalEnabled: boolean;
  configReady: boolean;
  schemaReady: boolean;
  botUsername: string | null;
  timezone: string;
  userBound: boolean;
  userEnabled: boolean;
  binding: {
    state: 'candidate' | 'active' | 'revoked';
    enabled: boolean;
    privacyMode: boolean;
    summaryEnabled: boolean;
    telegramUsername: string | null;
    telegramDisplayName: string;
    candidateExpiresAt: string | null;
    boundAt: string | null;
    confirmedAt: string | null;
    lastSentAt: string | null;
    lastErrorCode: string | null;
    lastErrorAt: string | null;
  } | null;
  recentDeliveries: TelegramDeliverySummary[];
}

const settingsPath = '/api/workspace/notifications/telegram';

export function fetchTelegramSettings(signal?: AbortSignal) {
  return requestJson<TelegramSettingsStatus>(`${settingsPath}/settings`, { signal });
}

export function createTelegramBinding() {
  return requestJson<{ state: 'pending'; expiresAt: string; deepLink: string }>(`${settingsPath}/bind`, { method: 'POST' });
}

export function confirmTelegramBinding() {
  return requestJson<TelegramSettingsStatus>(`${settingsPath}/confirm`, { method: 'POST' });
}

export function updateTelegramSettings(input: { enabled?: boolean; privacyMode?: boolean; summaryEnabled?: boolean }) {
  return requestJson<{ settings: { enabled: boolean; privacyMode: boolean; summaryEnabled: boolean } | null }>(`${settingsPath}/settings`, {
    method: 'PATCH',
    body: JSON.stringify(input)
  });
}

export function sendTelegramTest() {
  return requestJson<{ sent: true }>(`${settingsPath}/test`, { method: 'POST' });
}

export function unbindTelegram() {
  return requestJson<TelegramSettingsStatus>(`${settingsPath}/unbind`, { method: 'POST' });
}

export function fetchTelegramDeliveries(signal?: AbortSignal) {
  return requestJson<{ deliveries: TelegramDeliverySummary[] }>(`${settingsPath}/deliveries`, { signal });
}

export function retryTelegramDelivery(id: string) {
  return requestJson<{ queued: true; warning: 'unknown_delivery' | null }>(`${settingsPath}/deliveries/${encodeURIComponent(id)}/retry`, { method: 'POST' });
}
