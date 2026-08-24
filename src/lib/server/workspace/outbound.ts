import type { CloudflareEnv } from '$lib/server/cloudflare';
import { getWorkspaceCapabilities, hasWorkspaceCoreTables } from '$lib/server/db/capabilities';
import { deleteDraft, findOwnedDraft } from '$lib/server/db/drafts';
import { assertDraftAttachmentSet, listAttachmentsForEntity, transferDraftAttachmentsToMessage, type StoredAttachmentRow } from '$lib/server/db/attachments';
import { deleteBodyObjectRow, insertBodyObject, markBodyObjectDeletePending, findBodyObject } from '$lib/server/db/body';
import {
  findDeliveryStatus,
  finishDeliveryAttempt,
  insertDeliveryAttempt,
  insertOutboundEvent,
  upsertOutboundReceipt,
  upsertOutboundStatus,
  type DeliveryStatusPayload
} from '$lib/server/db/deliveries';
import { findMessageByIdempotencyKey, findOwnedWorkspaceMessage, insertMessage } from '$lib/server/db/messages';
import {
  MAX_OUTBOUND_ATTACHMENT_BYTES,
  MAX_OUTBOUND_ATTACHMENT_COUNT,
  MAX_OUTBOUND_ATTACHMENT_TOTAL_BYTES,
  OutboundGatewayError,
  isOutboundGatewayError,
  type OutboundMailGateway,
  type OutboundMailAttachment,
  type OutboundMailInput
} from '$lib/server/outbound/gateway';
import { consumeOutboundSend } from '$lib/server/outbound/rate-limit';
import { createOutboundGateway, outboundProviderName } from '$lib/server/outbound/provider';
import {
  createSentMessage,
  mapDraftRow,
  nowIso,
  serializeMessageForInsert,
  serializeOutboundEventInsert,
  mapWorkspaceMessageRow,
  type ComposeInput,
  type DeliveryResultKind,
  type DeliveryStatus,
  type MailMessage,
  type WorkspaceContext
} from '$lib/server/workspace/shared';
import { parseAddressList, serializeAddress, type MailAddress } from '$lib/domain/mail';
import { getMailboxMetrics } from '$lib/server/db/mailbox';
import { prepareBodyObject, projectBody, putBodyObject, readBodyObject, type CanonicalBody } from '$lib/server/body';
import {
  assertPersistedDeliveryRetryable,
  DeliveryNotRetryableError,
  reconcilePendingResendEvents
} from '$lib/server/workspace/delivery';
import { DraftBodyReloadRequiredError, DraftConflictError } from '$lib/server/workspace/draft';
import { sanitizeComposeInput } from '$lib/server/workspace/compose-body';
import { resolveOutboundFromEmail } from '$lib/server/config/env';

export interface OutboundSubmissionOptions {
  requestId?: string | null;
  gateway?: OutboundMailGateway;
}

export class OutboundRateLimitError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super(`Outbound send rate limit exceeded. Retry in ${retryAfterSeconds} seconds.`);
    this.name = 'OutboundRateLimitError';
  }
}

const safeRequestId = (value: string | null | undefined) => value?.trim().match(/^[A-Za-z0-9._:-]{1,128}$/u)?.[0];
const headerValue = (value: string | null | undefined) => value?.replace(/[\r\n]+/g, ' ').trim() || undefined;
const isUniqueConstraintError = (error: unknown) => error instanceof Error && /unique constraint|constraint failed/iu.test(error.message);

const sender = (env: CloudflareEnv | undefined, message: MailMessage) => {
  const email = resolveOutboundFromEmail(env) || message.fromEmail.trim();
  const name = headerValue(env?.OUTBOUND_FROM_NAME || message.fromName);
  return name ? `${name} <${email}>` : email;
};

const localMessageId = (id: string, env: CloudflareEnv | undefined, fallbackEmail: string) => {
  const domain = (resolveOutboundFromEmail(env) || fallbackEmail).split('@')[1]?.trim() || 'flaremail.invalid';
  return `<${id.replace(/[^A-Za-z0-9._-]/g, '-')}@${domain}>`;
};

const threadKey = (message: MailMessage) => {
  const value = headerValue(message.references)?.split(/\s+/)[0] || headerValue(message.inReplyTo) || headerValue(message.messageId);
  return value ? `rfc:${value.replace(/^<|>$/g, '').toLowerCase()}` : null;
};

const providerRecipients = (addresses: readonly MailAddress[]) => addresses.map(serializeAddress);
const optionalProviderRecipients = (addresses: readonly MailAddress[]) => addresses.length ? providerRecipients(addresses) : undefined;

const hex = (buffer: ArrayBuffer) => [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');

async function loadOutboundAttachments(
  env: CloudflareEnv,
  userId: string,
  relationType: 'draft' | 'message',
  entityId: string
): Promise<{ rows: StoredAttachmentRow[]; provider: OutboundMailAttachment[] }> {
  if (!env.BUCKET) throw new OutboundGatewayError('configuration', 'Outbound attachment storage is unavailable.', { retryable: false });
  const rows = await listAttachmentsForEntity(env.DB, userId, relationType, entityId, { includeNonReady: true });
  if (rows.some((row) => row.state === 'uploading' || row.state === 'failed')) {
    throw new OutboundGatewayError('client_error', 'Wait for every attachment upload to finish before sending.', { retryable: false });
  }
  const readyRows = rows.filter((row) => row.state === 'ready');
  if (readyRows.length > MAX_OUTBOUND_ATTACHMENT_COUNT) {
    throw new OutboundGatewayError('configuration', 'Outbound attachment metadata exceeds the supported count.', { retryable: false });
  }
  let declaredTotalBytes = 0;
  for (const row of readyRows) {
    if (!Number.isSafeInteger(row.size) || row.size < 0 || row.size > MAX_OUTBOUND_ATTACHMENT_BYTES) {
      throw new OutboundGatewayError('configuration', 'Outbound attachment metadata exceeds the supported size.', { retryable: false });
    }
    declaredTotalBytes += row.size;
    if (!Number.isSafeInteger(declaredTotalBytes) || declaredTotalBytes > MAX_OUTBOUND_ATTACHMENT_TOTAL_BYTES) {
      throw new OutboundGatewayError('configuration', 'Outbound attachment metadata exceeds the supported total size.', { retryable: false });
    }
  }
  const provider: OutboundMailAttachment[] = [];
  for (const row of readyRows) {
    if (!row.sha256) throw new OutboundGatewayError('configuration', 'Outbound attachment metadata is incomplete.', { retryable: false });
    const object = await env.BUCKET.get(row.r2_key);
    if (!object || object.size !== row.size || object.size > MAX_OUTBOUND_ATTACHMENT_BYTES) {
      throw new OutboundGatewayError('configuration', 'Outbound attachment integrity verification failed.', { retryable: false });
    }
    const bytes = new Uint8Array(await object.arrayBuffer());
    const digest = hex(await crypto.subtle.digest('SHA-256', bytes));
    if (digest !== row.sha256) {
      throw new OutboundGatewayError('configuration', 'Outbound attachment integrity verification failed.', { retryable: false });
    }
    provider.push({
      filename: row.filename,
      bytes,
      contentType: row.content_type,
      contentId: row.content_id ?? undefined,
      disposition: row.disposition
    });
  }
  return { rows: readyRows, provider };
}

const gatewayInput = (
  env: CloudflareEnv | undefined,
  message: MailMessage,
  idempotencyKey: string,
  body?: CanonicalBody,
  attachments?: OutboundMailAttachment[]
): OutboundMailInput => ({
  idempotencyKey,
  from: sender(env, message),
  to: providerRecipients(message.toAddresses ?? parseAddressList(message.toEmail)),
  cc: optionalProviderRecipients(message.ccAddresses ?? parseAddressList(message.cc ?? '')),
  bcc: optionalProviderRecipients(message.bccAddresses ?? parseAddressList(message.bcc ?? '')),
  subject: message.subject,
  text: body?.textBody ?? message.body,
  html: body?.htmlBody || undefined,
  replyTo: resolveOutboundFromEmail(env) ? [resolveOutboundFromEmail(env)!] : [message.fromEmail.trim()],
  headers: Object.fromEntries([
    ['Message-ID', headerValue(message.messageId)],
    ['In-Reply-To', headerValue(message.inReplyTo)],
    ['References', headerValue(message.references)]
  ].filter((entry): entry is [string, string] => Boolean(entry[1]))),
  tags: [{ name: 'flaremail_kind', value: 'workspace' }],
  attachments: attachments?.length ? attachments : undefined
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
  session: WorkspaceContext; messageId: string; idempotencyKey: string; provider: string; status: DeliveryStatus;
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

async function refreshedResult(env: CloudflareEnv, session: WorkspaceContext, messageId: string) {
  const row = await findOwnedWorkspaceMessage(env.DB, session.userId, messageId);
  if (!row) throw new Error('Persisted outbound message is missing from the workspace.');
  const delivery = await findDeliveryStatus(env.DB, session.userId, messageId);
  const message = mapWorkspaceMessageRow(row, delivery ? {
    message_id: messageId, status: delivery.status, attempts: delivery.attempts, delivered_at: delivery.delivered_at,
    last_error: delivery.last_error, provider_message_id: delivery.provider_message_id, provider: delivery.provider,
    result_kind: delivery.result_kind, remote_status: delivery.remote_status, response_preview: delivery.response_preview ?? '', last_event: delivery.last_event, last_event_at: delivery.last_event_at
  } : undefined);
  return { message, metrics: await getMailboxMetrics(env.DB, session.userId) };
}

async function submitPersistedMessage(
  env: CloudflareEnv,
  session: WorkspaceContext,
  message: MailMessage,
  idempotencyKey: string,
  attempts: number,
  gateway: OutboundMailGateway,
  provider: string,
  body?: CanonicalBody,
  attachments?: OutboundMailAttachment[]
) {
  const startedAt = nowIso();
  const attemptNumber = attempts + 1;
  const d1StartedAt = Date.now();
  await env.DB.batch([
    upsertOutboundStatus(env.DB, statusPayload({ session, messageId: message.id, idempotencyKey, provider,
      status: 'submitting', attempts: attemptNumber, remoteTimestamp: startedAt })),
    insertDeliveryAttempt(env.DB, { id: crypto.randomUUID(), messageId: message.id, userId: session.userId,
      attemptNumber, idempotencyKey, provider, providerMessageId: null, status: 'submitting', error: null,
      startedAt, completedAt: null, createdAt: startedAt })
  ]);
  console.log(JSON.stringify({ event: 'outbound_phase', phase: 'd1_attempt_persist', durationMs: Date.now() - d1StartedAt }));

  try {
    const result = await gateway.send(gatewayInput(env, message, idempotencyKey, body, attachments));
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
  session: WorkspaceContext,
  input: ComposeInput,
  options: OutboundSubmissionOptions = {}
) {
  if (session.storage !== 'd1' || !env || !(await hasWorkspaceCoreTables(env))) {
    throw new Error('Workspace storage is unavailable for outbound email.');
  }
  const capabilities = await getWorkspaceCapabilities(env);
  if (!capabilities.outboundStatuses) throw new Error('The delivery schema is not migrated.');
  const composeInput = sanitizeComposeInput(input);
  const draftId = composeInput.draftId?.trim() || undefined;
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
  const rateLimit = await consumeOutboundSend(env.DB, session.userId);
  if (!rateLimit.allowed) throw new OutboundRateLimitError(rateLimit.retryAfterSeconds);
  const gateway = options.gateway ?? createOutboundGateway(env);
  const provider = options.gateway ? 'injected' : outboundProviderName(env);

  const existingDraft = draftId && capabilities.drafts ? await findOwnedDraft(env.DB, session.userId, draftId) : null;
  const draftAttachments = existingDraft
    ? await loadOutboundAttachments(env, session.userId, 'draft', existingDraft.id)
    : { rows: [], provider: [] };
  const attachmentRevision = Number(existingDraft?.attachment_revision ?? 0);
  if (
    existingDraft
    && (draftAttachments.rows.length > 0 || composeInput.attachmentRevision !== undefined)
    && composeInput.attachmentRevision !== attachmentRevision
  ) {
    throw new DraftConflictError(mapDraftRow(existingDraft, session.profile));
  }
  let canonicalBody: CanonicalBody = { version: 1, textBody: composeInput.body, htmlBody: composeInput.html ?? '' };
  if (existingDraft?.body_object_id) {
    const requestedBodyRevision = composeInput.bodyRevision?.trim() || null;
    if (requestedBodyRevision && requestedBodyRevision !== existingDraft.body_object_id) {
      throw new DraftConflictError(mapDraftRow(existingDraft, session.profile));
    }
    if (!requestedBodyRevision && composeInput.body !== existingDraft.body) {
      throw new DraftBodyReloadRequiredError();
    }
    if (!requestedBodyRevision) {
      if (!env.BUCKET) throw new Error('BODY_STORAGE_UNAVAILABLE');
      const draftObject = await findBodyObject(env.DB, existingDraft.body_object_id, session.userId, 'draft', draftId);
      if (!draftObject) throw new Error('BODY_OBJECT_NOT_FOUND');
      canonicalBody = await readBodyObject(env.BUCKET, draftObject.r2_key, draftObject.size_bytes, draftObject.sha256);
    }
  }

  const message = createSentMessage({ id: messageId, from: session.profile, to: composeInput.to, toEmail: composeInput.toEmail, subject: composeInput.subject,
    body: canonicalBody.textBody, html: canonicalBody.htmlBody, cc: composeInput.cc, bcc: composeInput.bcc, messageId: composeInput.messageId || localMessageId(messageId, env, session.profile.email),
    inReplyTo: composeInput.inReplyTo, references: composeInput.references, deliveryStatus: 'submitting', deliveryAttempts: 0 });
  message.threadKey = threadKey(message);
  if (draftAttachments.rows.length) message.labels = [...message.labels, 'Attachment'];
  const timestamp = nowIso();
  const bodyObject = await prepareBodyObject('workspace_message', message.id, canonicalBody.textBody, canonicalBody.htmlBody, { force: Boolean(canonicalBody.htmlBody.trim()) });
  if (bodyObject && !env.BUCKET) throw new Error('BODY_STORAGE_UNAVAILABLE');
  if (bodyObject) await putBodyObject(env.BUCKET, bodyObject);
  const projected = projectBody(canonicalBody.textBody, canonicalBody.htmlBody, message.preview);
  const serialized = serializeMessageForInsert(session.userId, { ...message, body: bodyObject ? projected.textBody : canonicalBody.textBody, preview: projected.snippet }, idempotencyKey);
  serialized.bodyObjectId = bodyObject?.id ?? null;
  const statements: D1PreparedStatement[] = [];
  if (existingDraft) {
    statements.push(assertDraftAttachmentSet(env.DB, {
      userId: session.userId,
      draftId: existingDraft.id,
      expectedRevision: attachmentRevision,
      attachmentIds: draftAttachments.rows.map((row) => row.id)
    }));
  }
  if (existingDraft?.body_object_id && existingDraft.body_object_id !== bodyObject?.id) {
    statements.push(markBodyObjectDeletePending(env.DB, existingDraft.body_object_id, new Date(Date.now() + 86_400_000).toISOString(), timestamp));
  }
  if (bodyObject) statements.push(insertBodyObject(env.DB, {
    id: bodyObject.id, owner_user_id: session.userId, entity_type: 'workspace_message', entity_id: message.id,
    r2_key: bodyObject.key, size_bytes: bodyObject.sizeBytes, sha256: bodyObject.sha256,
    text_bytes: bodyObject.textBytes, html_bytes: bodyObject.htmlBytes, createdAt: timestamp
  }));
  statements.push(insertMessage(env.DB, serialized));
  if (existingDraft && draftAttachments.rows.length) {
    statements.push(transferDraftAttachmentsToMessage(env.DB, {
      userId: session.userId,
      draftId: existingDraft.id,
      messageId: message.id,
      attachmentIds: draftAttachments.rows.map((row) => row.id),
      expectedRevision: attachmentRevision,
      updatedAt: timestamp
    }));
  }
  if (draftId && capabilities.drafts) statements.push(deleteDraft(env.DB, session.userId, draftId));
  try {
    await env.DB.batch(statements);
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      const concurrent = await findMessageByIdempotencyKey(env.DB, session.userId, idempotencyKey);
      if (concurrent) {
        if (bodyObject) {
          await deleteBodyObjectRow(env.DB, bodyObject.id).run().catch(() => undefined);
          await env.BUCKET.delete(bodyObject.key).catch(() => undefined);
        }
        return refreshedResult(env, session, concurrent.id);
      }
    }
    if (bodyObject) {
      await deleteBodyObjectRow(env.DB, bodyObject.id).run().catch(() => undefined);
      await env.BUCKET.delete(bodyObject.key).catch(() => undefined);
    }
    if (existingDraft) {
      const latest = await findOwnedDraft(env.DB, session.userId, existingDraft.id);
      if (latest && Number(latest.attachment_revision ?? 0) !== attachmentRevision) {
        throw new DraftConflictError(mapDraftRow(latest, session.profile));
      }
    }
    throw error;
  }

  await submitPersistedMessage(
    env,
    session,
    message,
    idempotencyKey,
    0,
    gateway,
    provider,
    bodyObject?.body,
    draftAttachments.provider
  );
  return refreshedResult(env, session, message.id);
}

export async function retryWorkspaceMessageDelivery(
  env: CloudflareEnv | undefined,
  session: WorkspaceContext,
  messageId: string,
  options: Pick<OutboundSubmissionOptions, 'gateway'> = {}
) {
  if (session.storage !== 'd1' || !env || !(await hasWorkspaceCoreTables(env))) {
    throw new Error('Workspace storage is unavailable for outbound retry.');
  }
  const row = await findOwnedWorkspaceMessage(env.DB, session.userId, messageId);
  if (!row) return null;
  const message = mapWorkspaceMessageRow(row);
  if (message.folder !== 'sent' || message.source !== 'workspace') return null;
  const delivery = await findDeliveryStatus(env.DB, session.userId, messageId);
  if (!delivery) {
    throw new DeliveryNotRetryableError('delivery_state_missing', 'The persisted delivery state is missing.');
  }
  try {
    assertPersistedDeliveryRetryable({
      status: delivery.status,
      resultKind: delivery.result_kind,
      attempts: delivery.attempts,
      idempotencyKey: delivery.idempotency_key,
      messageIdempotencyKey: row.idempotency_key,
      attemptStartedAt: delivery.attempt_started_at ?? delivery.last_event_at
    });
  } catch (error) {
    if (error instanceof DeliveryNotRetryableError && error.reason === 'idempotency_window_expired') {
      throw new OutboundGatewayError('idempotency_expired', 'Provider idempotency window expired; review the provider dashboard before resending.', { retryable: false });
    }
    throw error;
  }
  const rateLimit = await consumeOutboundSend(env.DB, session.userId);
  if (!rateLimit.allowed) throw new OutboundRateLimitError(rateLimit.retryAfterSeconds);
  const gateway = options.gateway ?? createOutboundGateway(env);
  const provider = options.gateway ? delivery.provider || 'injected' : outboundProviderName(env);
  let body: CanonicalBody | undefined;
  if (row.body_object_id) {
    if (!env.BUCKET) throw new Error('BODY_STORAGE_UNAVAILABLE');
    const object = await findBodyObject(env.DB, row.body_object_id, session.userId, 'workspace_message', messageId);
    if (!object) throw new Error('BODY_OBJECT_NOT_FOUND');
    body = await readBodyObject(env.BUCKET, object.r2_key, object.size_bytes, object.sha256);
  }
  const attachments = await loadOutboundAttachments(env, session.userId, 'message', messageId);
  await submitPersistedMessage(
    env,
    session,
    message,
    delivery.idempotency_key,
    delivery.attempts,
    gateway,
    provider,
    body,
    attachments.provider
  );
  return refreshedResult(env, session, message.id);
}
