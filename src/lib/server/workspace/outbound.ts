import type { CloudflareEnv } from '$lib/server/cloudflare';
import { getWorkspaceCapabilities, hasWorkspaceCoreTables } from '$lib/server/db/capabilities';
import { deleteDraft } from '$lib/server/db/drafts';
import {
  findDeliveryStatus,
  finishDeliveryAttempt,
  insertDeliveryAttempt,
  insertOutboundEvent,
  upsertOutboundReceipt,
  upsertOutboundStatus,
  type DeliveryStatusPayload
} from '$lib/server/db/deliveries';
import { findMessageByIdempotencyKey, insertMessage } from '$lib/server/db/messages';
import { touchSession } from '$lib/server/db/sessions';
import {
  OutboundGatewayError,
  isOutboundGatewayError,
  type OutboundMailGateway,
  type OutboundMailInput
} from '$lib/server/outbound/gateway';
import { createOutboundGateway, outboundProviderName } from '$lib/server/outbound/provider';
import {
  createSentMessage,
  findMessage,
  nowIso,
  serializeMessageForInsert,
  serializeOutboundEventInsert,
  serializeWorkspace,
  type ComposeInput,
  type DeliveryResultKind,
  type DeliveryStatus,
  type MailMessage,
  type WorkspaceSession
} from '$lib/server/workspace/shared';
import { refreshD1Session } from '$lib/server/workspace/mailbox';
import { reconcilePendingResendEvents } from '$lib/server/workspace/delivery';

export interface OutboundSubmissionOptions {
  requestId?: string | null;
  gateway?: OutboundMailGateway;
}

const addresses = (value: string | undefined) => (value ?? '').split(/[;,]/).map((item) => item.trim()).filter(Boolean);
const safeRequestId = (value: string | null | undefined) => value?.trim().match(/^[A-Za-z0-9._:-]{1,128}$/u)?.[0];
const headerValue = (value: string | null | undefined) => value?.replace(/[\r\n]+/g, ' ').trim() || undefined;
const isUniqueConstraintError = (error: unknown) => error instanceof Error && /unique constraint|constraint failed/iu.test(error.message);

const sender = (env: CloudflareEnv | undefined, message: MailMessage) => {
  const email = env?.OUTBOUND_FROM_EMAIL?.trim() || message.fromEmail.trim();
  const name = headerValue(env?.OUTBOUND_FROM_NAME || message.fromName);
  return name ? `${name} <${email}>` : email;
};

const localMessageId = (id: string, env: CloudflareEnv | undefined, fallbackEmail: string) => {
  const domain = (env?.OUTBOUND_FROM_EMAIL || fallbackEmail).split('@')[1]?.trim() || 'flaremail.invalid';
  return `<${id.replace(/[^A-Za-z0-9._-]/g, '-')}@${domain}>`;
};

const threadKey = (message: MailMessage) => {
  const value = headerValue(message.references)?.split(/\s+/)[0] || headerValue(message.inReplyTo) || headerValue(message.messageId);
  return value ? `rfc:${value.replace(/^<|>$/g, '').toLowerCase()}` : null;
};

const gatewayInput = (env: CloudflareEnv | undefined, message: MailMessage, idempotencyKey: string): OutboundMailInput => ({
  idempotencyKey,
  from: sender(env, message),
  to: [message.toEmail.trim()],
  cc: addresses(message.cc).length ? addresses(message.cc) : undefined,
  subject: message.subject,
  text: message.body,
  replyTo: env?.OUTBOUND_FROM_EMAIL?.trim() ? [env.OUTBOUND_FROM_EMAIL.trim()] : [message.fromEmail.trim()],
  headers: Object.fromEntries([
    ['Message-ID', headerValue(message.messageId)],
    ['In-Reply-To', headerValue(message.inReplyTo)],
    ['References', headerValue(message.references)]
  ].filter((entry): entry is [string, string] => Boolean(entry[1]))),
  tags: [{ name: 'flaremail_kind', value: 'workspace' }]
});

const resultKind = (status: DeliveryStatus, error?: OutboundGatewayError): DeliveryResultKind => {
  if (status === 'submitted') return 'accepted';
  if (error?.kind === 'rate_limited') return 'rate_limited';
  if (status === 'submitting' || status === 'delayed') return 'temporary_failure';
  return 'permanent_failure';
};

const failedStatus = (error: OutboundGatewayError): DeliveryStatus => {
  if (error.kind === 'timeout' || error.kind === 'network_unknown' || error.kind === 'concurrent') return 'submitting';
  if (error.retryable) return 'delayed';
  return 'failed';
};

function statusPayload(input: {
  session: WorkspaceSession; messageId: string; idempotencyKey: string; provider: string; status: DeliveryStatus;
  attempts: number; providerMessageId?: string | null; lastError?: string; remoteTimestamp: string;
}): DeliveryStatusPayload {
  return {
    messageId: input.messageId,
    userId: input.session.userId,
    status: input.status,
    attempts: input.attempts,
    idempotencyKey: input.idempotencyKey,
    provider: input.provider,
    providerMessageId: input.providerMessageId ?? null,
    lastError: input.lastError ?? '',
    submittedAt: input.status === 'submitted' ? input.remoteTimestamp : null,
    sentAt: null,
    deliveredAt: null,
    lastEvent: 'submission',
    lastEventAt: input.remoteTimestamp,
    createdAt: input.remoteTimestamp,
    updatedAt: input.remoteTimestamp
  };
}

async function refreshedResult(env: CloudflareEnv, session: WorkspaceSession, messageId: string) {
  const nextSession = await refreshD1Session(env, session.id);
  if (!nextSession) throw new Error('Unable to reload the workspace after outbound persistence.');
  const message = findMessage(nextSession, messageId);
  if (!message) throw new Error('Persisted outbound message is missing from the workspace.');
  return { message, workspace: serializeWorkspace(nextSession) };
}

async function submitPersistedMessage(
  env: CloudflareEnv,
  session: WorkspaceSession,
  message: MailMessage,
  idempotencyKey: string,
  attempts: number,
  gateway: OutboundMailGateway,
  provider: string
) {
  const startedAt = nowIso();
  const attemptNumber = attempts + 1;
  await env.DB.batch([
    upsertOutboundStatus(env.DB, statusPayload({ session, messageId: message.id, idempotencyKey, provider,
      status: 'submitting', attempts: attemptNumber, remoteTimestamp: startedAt })),
    insertDeliveryAttempt(env.DB, { id: crypto.randomUUID(), messageId: message.id, userId: session.userId,
      attemptNumber, idempotencyKey, provider, providerMessageId: null, status: 'submitting', error: null,
      startedAt, completedAt: null, createdAt: startedAt })
  ]);

  try {
    const result = await gateway.send(gatewayInput(env, message, idempotencyKey));
    const completedAt = nowIso();
    const state = statusPayload({ session, messageId: message.id, idempotencyKey, provider, status: 'submitted',
      attempts: attemptNumber, providerMessageId: result.providerMessageId, remoteTimestamp: completedAt });
    await env.DB.batch([
      upsertOutboundStatus(env.DB, state),
      finishDeliveryAttempt(env.DB, { messageId: message.id, attemptNumber, providerMessageId: result.providerMessageId,
        status: 'submitted', error: null, completedAt }),
      upsertOutboundReceipt(env.DB, { messageId: message.id, userId: session.userId, provider,
        resultKind: 'accepted', remoteStatus: result.remoteStatus, responsePreview: 'Provider accepted the message for delivery.',
        lastEvent: 'submission', lastEventAt: completedAt, createdAt: completedAt, updatedAt: completedAt }),
      insertOutboundEvent(env.DB, serializeOutboundEventInsert({ svixId: `local:${message.id}:submission:${attemptNumber}`,
        messageId: message.id, userId: session.userId, provider, providerMessageId: result.providerMessageId,
        eventType: 'submission', eventCreatedAt: completedAt, summary: 'Provider accepted the message for delivery.',
        payloadJson: JSON.stringify({ status: 'submitted', remoteStatus: result.remoteStatus }) }))
    ]);
    await reconcilePendingResendEvents(env, result.providerMessageId).catch(() => undefined);
  } catch (cause) {
    const error = isOutboundGatewayError(cause)
      ? cause
      : new OutboundGatewayError('network_unknown', 'Outbound request outcome is unknown.', { retryable: true });
    const completedAt = nowIso();
    const status = failedStatus(error);
    const completed = status === 'submitting' ? null : completedAt;
    await env.DB.batch([
      upsertOutboundStatus(env.DB, statusPayload({ session, messageId: message.id, idempotencyKey, provider,
        status, attempts: attemptNumber, lastError: error.message, remoteTimestamp: completedAt })),
      finishDeliveryAttempt(env.DB, { messageId: message.id, attemptNumber, providerMessageId: null,
        status, error: error.message, completedAt: completed }),
      upsertOutboundReceipt(env.DB, { messageId: message.id, userId: session.userId, provider,
        resultKind: resultKind(status, error), remoteStatus: error.remoteStatus, responsePreview: error.responsePreview,
        lastEvent: 'submission', lastEventAt: completedAt, createdAt: completedAt, updatedAt: completedAt }),
      insertOutboundEvent(env.DB, serializeOutboundEventInsert({ svixId: `local:${message.id}:submission:${attemptNumber}`,
        messageId: message.id, userId: session.userId, provider, eventType: 'submission', eventCreatedAt: completedAt,
        summary: error.message, payloadJson: JSON.stringify({ status, kind: error.kind, remoteStatus: error.remoteStatus }) }))
    ]);
    if (error.kind === 'configuration' || error.kind === 'idempotency_conflict') throw error;
  }
}

export async function sendWorkspaceMessage(
  env: CloudflareEnv | undefined,
  session: WorkspaceSession,
  input: ComposeInput,
  options: OutboundSubmissionOptions = {}
) {
  if (session.storage !== 'd1' || !env || !(await hasWorkspaceCoreTables(env))) {
    throw new Error('Workspace storage is unavailable for outbound email.');
  }
  const capabilities = await getWorkspaceCapabilities(env);
  if (!capabilities.outboundStatuses) throw new Error('The delivery schema is not migrated.');
  const draftId = input.draftId?.trim() || undefined;
  const messageId = draftId || `sent-live-${crypto.randomUUID()}`;
  const requestId = safeRequestId(options.requestId);
  if (!draftId && !requestId) {
    throw new OutboundGatewayError('client_error', 'A valid Idempotency-Key is required for a new outbound message.', { retryable: false });
  }
  const idempotencyKey = requestId ? `flaremail:send:${session.userId}:${requestId}` : `flaremail:send:${messageId}`;
  const existing = await findMessageByIdempotencyKey(env.DB, session.userId, idempotencyKey);
  if (existing) {
    const delivery = await findDeliveryStatus(env.DB, session.userId, existing.id);
    if (delivery?.provider_message_id) {
      await reconcilePendingResendEvents(env, delivery.provider_message_id).catch(() => undefined);
    }
    return refreshedResult(env, session, existing.id);
  }
  const gateway = options.gateway ?? createOutboundGateway(env);
  const provider = options.gateway ? 'injected' : outboundProviderName(env);

  const message = createSentMessage({ id: messageId, from: session.profile, toEmail: input.toEmail, subject: input.subject,
    body: input.body, cc: input.cc, messageId: input.messageId || localMessageId(messageId, env, session.profile.email),
    inReplyTo: input.inReplyTo, references: input.references, deliveryStatus: 'submitting', deliveryAttempts: 0 });
  message.threadKey = threadKey(message);
  const timestamp = nowIso();
  const statements = [insertMessage(env.DB, serializeMessageForInsert(session.userId, message, idempotencyKey)),
    touchSession(env.DB, session.id, timestamp)];
  if (draftId && capabilities.drafts) statements.unshift(deleteDraft(env.DB, session.userId, draftId));
  try {
    await env.DB.batch(statements);
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      const concurrent = await findMessageByIdempotencyKey(env.DB, session.userId, idempotencyKey);
      if (concurrent) return refreshedResult(env, session, concurrent.id);
    }
    throw error;
  }

  await submitPersistedMessage(env, session, message, idempotencyKey, 0, gateway, provider);
  return refreshedResult(env, session, message.id);
}

export async function retryWorkspaceMessageDelivery(
  env: CloudflareEnv | undefined,
  session: WorkspaceSession,
  messageId: string,
  options: Pick<OutboundSubmissionOptions, 'gateway'> = {}
) {
  const message = findMessage(session, messageId);
  if (!message || message.folder !== 'sent' || message.source !== 'workspace') return null;
  if (session.storage !== 'd1' || !env || !(await hasWorkspaceCoreTables(env))) {
    throw new Error('Workspace storage is unavailable for outbound retry.');
  }
  const delivery = await findDeliveryStatus(env.DB, session.userId, messageId);
  if (!delivery?.idempotency_key) throw new Error('The persisted idempotency key is missing.');
  if (!['failed', 'delayed', 'submitting'].includes(delivery.status)) return null;
  const gateway = options.gateway ?? createOutboundGateway(env);
  const provider = options.gateway ? delivery.provider || 'injected' : outboundProviderName(env);
  await submitPersistedMessage(env, session, message, delivery.idempotency_key, delivery.attempts, gateway, provider);
  return refreshedResult(env, session, message.id);
}
