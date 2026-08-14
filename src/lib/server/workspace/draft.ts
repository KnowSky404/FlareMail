import type { CloudflareEnv } from '$lib/server/cloudflare';
import { getMailboxMetrics } from '$lib/server/db/mailbox';
import { findOwnedDraft, insertDraft, overwriteDraft, updateDraftIfVersion } from '$lib/server/db/drafts';
import { createDraftMessage, mapDraftRow, serializeDraftForInsert, type ComposeInput, type WorkspaceContext } from '$lib/server/workspace/shared';

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

export async function saveWorkspaceDraft(env: CloudflareEnv | undefined, session: WorkspaceContext, input: ComposeInput) {
  if (session.storage !== 'd1' || !env?.DB) throw new Error('工作区存储未配置，无法保存草稿。');
  const requestedId = input.saveAsCopy ? undefined : input.draftId;
  const currentRow = requestedId ? await findOwnedDraft(env.DB, session.userId, requestedId) : null;
  if (requestedId && !currentRow) throw new DraftNotFoundError();

  const timestamp = new Date().toISOString();
  const draft = createDraftMessage({ id: requestedId, from: session.profile, toEmail: input.toEmail, cc: input.cc,
    subject: input.subject, body: input.body, starred: Boolean(currentRow?.is_starred), updatedAt: timestamp,
    messageId: input.messageId, inReplyTo: input.inReplyTo, references: input.references });
  const serialized = serializeDraftForInsert(session.userId, { ...input, draftId: draft.id }, draft.starred);
  serialized.createdAt = currentRow?.created_at ?? timestamp;
  serialized.updatedAt = timestamp;

  if (!currentRow) {
    await env.DB.batch([insertDraft(env.DB, serialized)]);
  } else {
    const statement = input.overwrite
      ? overwriteDraft(env.DB, serialized)
      : input.expectedUpdatedAt ? updateDraftIfVersion(env.DB, { ...serialized, expectedUpdatedAt: input.expectedUpdatedAt }) : null;
    if (!statement) throw new DraftConflictError(mapDraftRow(currentRow, session.profile));
    const result = await statement.run();
    if (result.meta?.changes === 0) {
      const latest = await findOwnedDraft(env.DB, session.userId, requestedId!);
      if (!latest) throw new DraftNotFoundError();
      throw new DraftConflictError(mapDraftRow(latest, session.profile));
    }
  }

  return { message: draft, metrics: await getMailboxMetrics(env.DB, session.userId) };
}
