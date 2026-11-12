import type { CloudflareEnv } from '$lib/server/cloudflare';
import { toInboundMessageId } from '$lib/domain/mail';
import {
  claimTelegramDelivery,
  deferTelegramDelivery,
  reserveTelegramAiAttempt,
  isReservedTelegramAiAuthorized,
  cleanupTelegramState,
  hasTelegramTables,
  markTelegramCancelled,
  markTelegramExternalStarted,
  markTelegramFailure,
  markTelegramSent,
  markTelegramStaleUnknown,
  markTelegramUnknown,
  reserveTelegramDeliveryScope,
  setTelegramDeliveryCooldown
} from '$lib/server/db/telegram';
import { buildTelegramNotification } from './message';
import { TelegramApiError, sendTelegramMessage, type TelegramFetch } from './api';
import { resolveTelegramConfig } from './config';
import { workspaceMailAi } from '$lib/server/workspace/ai';
import { findUserById } from '$lib/server/db/users';
import { mapUserRowToProfile, type WorkspaceContext } from '$lib/server/workspace/shared';
import type { MailAiProvider } from '$lib/server/ai/provider';

export interface TelegramDispatchOptions {
  limit?: number;
  timeBudgetMs?: number;
  fetchImpl?: TelegramFetch;
  now?: () => number;
  cleanup?: boolean;
  aiProvider?: MailAiProvider;
}

const LEASE_MS = 45_000;
const BOT_INTERVAL_MS = 1_000;
const USER_INTERVAL_MS = 1_000;
const CHAT_INTERVAL_MS = 1_000;

function isoAfter(ms: number, baseMs = Date.now()) {
  return new Date(baseMs + Math.max(0, ms)).toISOString();
}

function retryDelayMs(attempts: number) {
  const exponent = Math.min(10, Math.max(0, attempts - 1));
  const base = Math.min(60 * 60 * 1000, 30_000 * (2 ** exponent));
  const jitter = Math.floor(Math.random() * Math.min(10_000, Math.max(1_000, base / 4)));
  return base + jitter;
}

async function reserveScopes(db: D1Database, userId: string, chatId: string, now: string) {
  const reservations = [
    ['bot', BOT_INTERVAL_MS],
    [`user:${userId}`, USER_INTERVAL_MS],
    [`chat:${chatId}`, CHAT_INTERVAL_MS]
  ] as const;
  for (const [scope, interval] of reservations) {
    if (!await reserveTelegramDeliveryScope(db, scope, now, new Date(Date.parse(now) + interval).toISOString())) return false;
  }
  return true;
}

async function markUnknownAfterFinalizationFailure(db: D1Database, deliveryId: string, claimToken: string, code: string) {
  try {
    await markTelegramUnknown(db, deliveryId, claimToken, code);
  } catch {
    console.error(JSON.stringify({ level: 'error', event: 'telegram_delivery_unknown_state_unpersisted', code: 'TELEGRAM_DELIVERY_FINALIZE_FAILED' }));
  }
}

export async function dispatchTelegramOutbox(env: CloudflareEnv, options: TelegramDispatchOptions = {}) {
  const config = resolveTelegramConfig(env);
  if (!config.ready || !env.DB || !await hasTelegramTables(env.DB)) return { processed: 0, sent: 0, failed: 0, retryable: 0, unknown: 0 };
  const started = (options.now ?? Date.now)();
  const limit = Math.max(1, Math.min(20, Math.trunc(options.limit ?? 5)));
  const budget = Math.max(250, Math.min(25_000, Math.trunc(options.timeBudgetMs ?? 20_000)));
  const result = { processed: 0, sent: 0, failed: 0, retryable: 0, unknown: 0 };
  const now = new Date(started).toISOString();
  if (options.cleanup) await cleanupTelegramState(env.DB, now).catch(() => undefined);
  await markTelegramStaleUnknown(env.DB, now);

  while (result.processed < limit && (options.now ?? Date.now)() - started < budget) {
    const current = new Date((options.now ?? Date.now)()).toISOString();
    const leaseUntil = Date.parse(current) + LEASE_MS;
    const claimed = await claimTelegramDelivery(env.DB, current, new Date(leaseUntil).toISOString());
    if (!claimed) break;
    result.processed += 1;

    let aiSummary: string | undefined;
    if (claimed.ai_summary_enabled === 1) {
      try {
        const user = await findUserById(env.DB, claimed.owner_user_id);
        if (user) {
          const session: WorkspaceContext = { id: '', userId: user.id, storage: 'd1',
            profile: mapUserRowToProfile(user), incomingSequence: user.incoming_sequence, createdAt: '', updatedAt: '' };
          const messageId = toInboundMessageId(claimed.email_message_id);
          const cached = await workspaceMailAi(env, session, messageId, {});
          if (cached.status === 'ready') aiSummary = cached.analysis?.summary;
          else if (claimed.ai_attempted === 0 && cached.status !== 'disabled' && cached.status !== 'unconfigured') {
            const remaining = budget - ((options.now ?? Date.now)() - started) - config.timeoutMs - 500;
            if (remaining < 1_000) {
              await deferTelegramDelivery(env.DB, claimed.id, claimed.claim_token, isoAfter(5_000, (options.now ?? Date.now)()));
              break;
            }
            if (await reserveTelegramAiAttempt(env.DB, claimed.id, claimed.claim_token, new Date((options.now ?? Date.now)()).toISOString())) {
              const timeoutMs = Math.floor(budget - ((options.now ?? Date.now)() - started) - config.timeoutMs - 500);
              if (timeoutMs > 0) {
                const analysis = await workspaceMailAi(env, session, messageId, { analyze: true, timeoutMs,
                  beforeAnalyze: () => isReservedTelegramAiAuthorized(env.DB, claimed.id, claimed.claim_token, new Date((options.now ?? Date.now)()).toISOString())
                }, options.aiProvider);
                if (analysis.status === 'ready') aiSummary = analysis.analysis?.summary;
              }
            }
          }
        }
      } catch {
        // AI is optional: keep the ordinary snippet and the Telegram send policy.
      }
    }
    const sendTime = (options.now ?? Date.now)();
    if (sendTime >= leaseUntil) continue;
    const sendNow = new Date(sendTime).toISOString();
    if (!await reserveScopes(env.DB, claimed.owner_user_id, claimed.telegram_chat_id, sendNow)) {
      try {
        await markTelegramFailure(env.DB, {
          deliveryId: claimed.id,
          claimToken: claimed.claim_token,
          status: 'retryable',
          errorCode: 'local_rate_limited',
          nextAttemptAt: isoAfter(5_000, sendTime)
        });
        result.retryable += 1;
      } catch {
        await markUnknownAfterFinalizationFailure(env.DB, claimed.id, claimed.claim_token, 'unknown_finalize_after_rate_limit');
        result.unknown += 1;
      }
      continue;
    }

    const sendSettings = await markTelegramExternalStarted(env.DB, claimed.id, claimed.claim_token, new Date((options.now ?? Date.now)()).toISOString());
    if (!sendSettings) {
      if ((options.now ?? Date.now)() < leaseUntil) {
        await markTelegramCancelled(env.DB, claimed.id, claimed.claim_token, 'binding_or_message_changed').catch(() => undefined);
      }
      continue;
    }
    const payload = buildTelegramNotification({
      appBaseUrl: config.appBaseUrl!,
      emailMessageId: claimed.email_message_id,
      from: claimed.from_address,
      to: claimed.to_address,
      subject: claimed.subject,
      receivedAt: claimed.received_at,
      attachmentCount: claimed.attachment_count,
      snippet: claimed.snippet,
      privacyMode: sendSettings.privacyMode,
      summaryEnabled: sendSettings.summaryEnabled,
      aiSummary: sendSettings.aiSummaryEnabled ? aiSummary : undefined,
      timezone: claimed.timezone
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort('telegram timeout'), config.timeoutMs);
    try {
      const sent = await sendTelegramMessage(env, {
        chatId: claimed.telegram_chat_id,
        text: payload.text,
        disableWebPagePreview: payload.disable_web_page_preview,
        replyMarkup: payload.reply_markup
      }, { fetchImpl: options.fetchImpl, signal: controller.signal });
      clearTimeout(timeout);
      try {
        await markTelegramSent(env.DB, { deliveryId: claimed.id, claimToken: claimed.claim_token, messageId: sent.messageId });
        result.sent += 1;
      } catch {
        await markUnknownAfterFinalizationFailure(env.DB, claimed.id, claimed.claim_token, 'unknown_finalize_after_send');
        result.unknown += 1;
      }
    } catch (error) {
      clearTimeout(timeout);
      if (error instanceof TelegramApiError && error.kind === 'rate_limited') {
        const retryAfter = Math.max(1, error.retryAfterSeconds ?? 60);
        const cooldownUntil = new Date((options.now ?? Date.now)() + retryAfter * 1000 + Math.floor(Math.random() * 1_000)).toISOString();
        await setTelegramDeliveryCooldown(env.DB, 'bot', cooldownUntil).catch(() => undefined);
        await setTelegramDeliveryCooldown(env.DB, `chat:${claimed.telegram_chat_id}`, cooldownUntil).catch(() => undefined);
        try {
          await markTelegramFailure(env.DB, {
            deliveryId: claimed.id,
            claimToken: claimed.claim_token,
            status: claimed.attempts >= claimed.max_attempts ? 'failed' : 'retryable',
            errorCode: 'telegram_rate_limited',
            nextAttemptAt: cooldownUntil
          });
          if (claimed.attempts >= claimed.max_attempts) result.failed += 1;
          else result.retryable += 1;
        } catch {
          await markUnknownAfterFinalizationFailure(env.DB, claimed.id, claimed.claim_token, 'unknown_finalize_after_429');
          result.unknown += 1;
        }
      } else if (error instanceof TelegramApiError && error.kind === 'permanent') {
        try {
          await markTelegramFailure(env.DB, { deliveryId: claimed.id, claimToken: claimed.claim_token, status: 'failed', errorCode: error.code });
          result.failed += 1;
        } catch {
          await markUnknownAfterFinalizationFailure(env.DB, claimed.id, claimed.claim_token, 'unknown_finalize_after_permanent');
          result.unknown += 1;
        }
      } else if (error instanceof TelegramApiError && error.kind === 'temporary') {
        try {
          const terminal = claimed.attempts >= claimed.max_attempts;
          const nextAttemptAt = isoAfter(retryDelayMs(claimed.attempts), (options.now ?? Date.now)());
          await setTelegramDeliveryCooldown(env.DB, 'bot', nextAttemptAt).catch(() => undefined);
          await markTelegramFailure(env.DB, {
            deliveryId: claimed.id,
            claimToken: claimed.claim_token,
            status: terminal ? 'failed' : 'retryable',
            errorCode: error.code,
            nextAttemptAt
          });
          if (terminal) result.failed += 1;
          else result.retryable += 1;
        } catch {
          await markUnknownAfterFinalizationFailure(env.DB, claimed.id, claimed.claim_token, 'unknown_finalize_after_temporary');
          result.unknown += 1;
        }
      } else if (error instanceof TelegramApiError && error.kind === 'configuration') {
        try {
          await markTelegramFailure(env.DB, { deliveryId: claimed.id, claimToken: claimed.claim_token, status: 'failed', errorCode: error.code });
          result.failed += 1;
        } catch {
          await markUnknownAfterFinalizationFailure(env.DB, claimed.id, claimed.claim_token, 'unknown_finalize_after_configuration');
          result.unknown += 1;
        }
      } else {
        await markUnknownAfterFinalizationFailure(env.DB, claimed.id, claimed.claim_token, 'unknown_transport');
        result.unknown += 1;
      }
    }
  }
  return result;
}
