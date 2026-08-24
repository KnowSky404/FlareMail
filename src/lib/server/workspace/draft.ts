import type { CloudflareEnv } from '$lib/server/cloudflare';
import { getMailboxMetrics } from '$lib/server/db/mailbox';
import { deleteBodyObjectRow, findBodyObject, insertBodyObject, markBodyObjectDeletePending } from '$lib/server/db/body';
import { prepareBodyObject, projectBody, putBodyObject, readBodyObject } from '$lib/server/body';
import { findOwnedDraft, insertDraft, overwriteDraft, updateDraftIfVersion } from '$lib/server/db/drafts';
import { createDraftMessage, mapDraftRow, serializeDraftForInsert, type ComposeInput, type WorkspaceContext } from '$lib/server/workspace/shared';
import { draftAttachmentSnapshot } from '$lib/server/workspace/attachment';
import { sanitizeComposeInput } from '$lib/server/workspace/compose-body';

export class DraftConflictError extends Error {
  readonly code = 'DRAFT_CONFLICT';
  constructor(readonly current: ReturnType<typeof createDraftMessage>) {
    super('服务器版本已更新。');
    this.name = 'DraftConflictError';
  }
}

export class DraftNotFoundError extends Error {
  readonly code = 'DRAFT_NOT_FOUND';
  constructor() {
    super('草稿不存在或已被删除。');
    this.name = 'DraftNotFoundError';
  }
}

export class DraftBodyReloadRequiredError extends Error {
  readonly code = 'DRAFT_BODY_RELOAD_REQUIRED';
  constructor() {
    super('草稿正文已分层存储，请重新载入完整正文后再编辑。');
    this.name = 'DraftBodyReloadRequiredError';
  }
}

export async function saveWorkspaceDraft(env: CloudflareEnv | undefined, session: WorkspaceContext, input: ComposeInput) {
  if (session.storage !== 'd1' || !env?.DB) throw new Error('工作区存储未配置，无法保存草稿。');
  const normalizedInput = sanitizeComposeInput(input);
  const requestedId = normalizedInput.saveAsCopy ? undefined : normalizedInput.draftId;
  const currentRow = requestedId ? await findOwnedDraft(env.DB, session.userId, requestedId) : null;
  if (requestedId && !currentRow) throw new DraftNotFoundError();
  if (
    currentRow
    && normalizedInput.attachmentRevision !== undefined
    && Number(currentRow.attachment_revision ?? 0) !== normalizedInput.attachmentRevision
    && !normalizedInput.overwrite
  ) {
    throw new DraftConflictError(mapDraftRow(currentRow, session.profile));
  }
  const currentBodyRevision = currentRow?.body_object_id ?? null;
  const requestedBodyRevision = normalizedInput.bodyRevision?.trim() || null;
  const preserveCanonicalBody = Boolean(
    currentBodyRevision && !requestedBodyRevision && normalizedInput.body === currentRow?.body
    && (!normalizedInput.html || !normalizedInput.html.trim())
  );
  if (currentBodyRevision && requestedBodyRevision && requestedBodyRevision !== currentBodyRevision && !normalizedInput.overwrite) {
    throw new DraftConflictError(mapDraftRow(currentRow!, session.profile));
  }
  if (currentBodyRevision && !requestedBodyRevision && !preserveCanonicalBody) {
    throw new DraftBodyReloadRequiredError();
  }

  const now = new Date().toISOString();
  const timestamp = currentRow && now <= currentRow.updated_at
    ? new Date(Date.parse(currentRow.updated_at) + 1).toISOString()
    : now;
  const draft = createDraftMessage({ id: requestedId, from: session.profile, to: normalizedInput.to, toEmail: normalizedInput.toEmail, cc: normalizedInput.cc, bcc: normalizedInput.bcc,
    subject: normalizedInput.subject, body: normalizedInput.body, html: normalizedInput.html, starred: Boolean(currentRow?.is_starred), updatedAt: timestamp,
    messageId: normalizedInput.messageId, inReplyTo: normalizedInput.inReplyTo, references: normalizedInput.references });
  const serialized = serializeDraftForInsert(session.userId, draft);
  serialized.createdAt = currentRow?.created_at ?? timestamp;
  serialized.updatedAt = timestamp;
  let responseHtml = draft.html ?? '';
  if (preserveCanonicalBody && currentBodyRevision) {
    if (env.BUCKET && typeof env.BUCKET.get === 'function') {
      const currentObject = await findBodyObject(env.DB, currentBodyRevision, session.userId, 'draft', draft.id);
      if (!currentObject) throw new Error('BODY_OBJECT_NOT_FOUND');
      responseHtml = (await readBodyObject(env.BUCKET, currentObject.r2_key, currentObject.size_bytes, currentObject.sha256)).htmlBody;
      draft.html = responseHtml;
    }
  }
  const bodyObject = preserveCanonicalBody ? null : await prepareBodyObject('draft', draft.id, draft.body, draft.html ?? '', { force: Boolean(draft.html?.trim()) });
  if (bodyObject && !env.BUCKET) throw new Error('BODY_STORAGE_UNAVAILABLE');
  if (bodyObject) await putBodyObject(env.BUCKET, bodyObject);
  const projection = projectBody(draft.body);
  serialized.body = preserveCanonicalBody ? currentRow!.body : bodyObject ? projection.textBody : draft.body;
  serialized.bodyObjectId = preserveCanonicalBody ? currentBodyRevision : bodyObject?.id ?? null;
  const cleanupAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const newBodyStatement = bodyObject ? insertBodyObject(env.DB, {
    id: bodyObject.id, owner_user_id: session.userId, entity_type: 'draft', entity_id: draft.id,
    r2_key: bodyObject.key, size_bytes: bodyObject.sizeBytes, sha256: bodyObject.sha256,
    text_bytes: bodyObject.textBytes, html_bytes: bodyObject.htmlBytes, createdAt: timestamp
  }) : null;

  if (!currentRow) {
    const statements = newBodyStatement ? [newBodyStatement, insertDraft(env.DB, serialized)] : [insertDraft(env.DB, serialized)];
    try { await env.DB.batch(statements); } catch (error) {
      if (bodyObject) {
        await deleteBodyObjectRow(env.DB, bodyObject.id).run().catch(() => undefined);
        await env.BUCKET.delete(bodyObject.key).catch(() => undefined);
      }
      throw error;
    }
  } else {
    const statement = normalizedInput.overwrite
      ? overwriteDraft(env.DB, serialized)
      : normalizedInput.expectedUpdatedAt ? updateDraftIfVersion(env.DB, { ...serialized, expectedUpdatedAt: normalizedInput.expectedUpdatedAt }) : null;
    if (!statement) throw new DraftConflictError(mapDraftRow(currentRow, session.profile));
    if (!normalizedInput.overwrite && normalizedInput.expectedUpdatedAt) {
      // The CAS is deliberately executed before any pointer/cleanup mutation.
      // A conflict therefore leaves both the old pointer and its R2 metadata untouched.
      if (newBodyStatement) {
        try { await newBodyStatement.run(); } catch (error) {
          if (bodyObject) await env.BUCKET.delete(bodyObject.key).catch(() => undefined);
          throw error;
        }
      }
      const result = await statement.run();
      if (result.meta?.changes === 0) {
        if (bodyObject) {
          await deleteBodyObjectRow(env.DB, bodyObject.id).run().catch(() => undefined);
          await env.BUCKET.delete(bodyObject.key).catch(() => undefined);
        }
        const latest = await findOwnedDraft(env.DB, session.userId, requestedId!);
        if (!latest) throw new DraftNotFoundError();
        throw new DraftConflictError(mapDraftRow(latest, session.profile));
      }
      if (currentRow.body_object_id && currentRow.body_object_id !== serialized.bodyObjectId) {
        // The new pointer is already durable. Cleanup failure must not turn a
        // successful save into a retryable client error; maintenance can
        // safely recover the superseded object later.
        await markBodyObjectDeletePending(env.DB, currentRow.body_object_id, cleanupAt, timestamp).run().catch(() => undefined);
      }
    } else {
      const statements = [
        ...(currentRow.body_object_id && currentRow.body_object_id !== serialized.bodyObjectId ? [markBodyObjectDeletePending(env.DB, currentRow.body_object_id, cleanupAt, timestamp)] : []),
        ...(newBodyStatement ? [newBodyStatement] : []),
        statement
      ];
      try { await env.DB.batch(statements); } catch (error) {
        if (bodyObject) {
          await deleteBodyObjectRow(env.DB, bodyObject.id).run().catch(() => undefined);
          await env.BUCKET.delete(bodyObject.key).catch(() => undefined);
        }
        throw error;
      }
    }
  }

  const attachmentSnapshot = await draftAttachmentSnapshot(env.DB, session.userId, draft.id);
  return {
    message: draft,
    html: responseHtml,
    metrics: await getMailboxMetrics(env.DB, session.userId),
    bodyRevision: serialized.bodyObjectId,
    attachments: attachmentSnapshot.attachments,
    attachmentRevision: attachmentSnapshot.attachmentRevision
  };
}
