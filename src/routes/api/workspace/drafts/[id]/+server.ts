import type { RequestHandler } from './$types';
import { readBodyObject } from '$lib/server/body';
import { findBodyObject } from '$lib/server/db/body';
import { findOwnedDraft } from '$lib/server/db/drafts';
import { ApiError, apiSuccess, requirePathParam, withApiHandler } from '$lib/server/http/api';
import { mapDraftRow } from '$lib/server/workspace/shared';
import { getRequestEnv, requireWorkspaceSession } from '$lib/server/workspace-api';
import { draftAttachmentSnapshot } from '$lib/server/workspace/attachment';

export const GET: RequestHandler = withApiHandler(async (event) => {
  const session = requireWorkspaceSession(event);
  const env = getRequestEnv(event);
  if (!env?.DB) throw new ApiError(503, 'DRAFT_STORAGE_UNAVAILABLE', '草稿存储服务暂不可用。');

  const id = requirePathParam(event, 'id');
  const row = await findOwnedDraft(env.DB, session.userId, id);
  if (!row) throw new ApiError(404, 'DRAFT_NOT_FOUND', '草稿不存在或已被删除。');

  const message = mapDraftRow(row, session.profile);
  if (row.body_object_id) {
    if (!env.BUCKET) throw new ApiError(503, 'BODY_STORAGE_UNAVAILABLE', '正文存储服务暂不可用。');
    const object = await findBodyObject(env.DB, row.body_object_id, session.userId, 'draft', id);
    if (!object) throw new ApiError(404, 'BODY_OBJECT_NOT_FOUND', '草稿正文对象不存在。');
    try {
      message.body = (await readBodyObject(env.BUCKET, object.r2_key, object.size_bytes, object.sha256)).textBody;
    } catch {
      throw new ApiError(409, 'BODY_OBJECT_INTEGRITY', '草稿正文完整性校验失败。');
    }
  }

  const attachmentSnapshot = await draftAttachmentSnapshot(env.DB, session.userId, id);
  return apiSuccess(event, {
    message,
    bodyRevision: row.body_object_id ?? null,
    attachments: attachmentSnapshot.attachments,
    attachmentRevision: attachmentSnapshot.attachmentRevision
  });
});
