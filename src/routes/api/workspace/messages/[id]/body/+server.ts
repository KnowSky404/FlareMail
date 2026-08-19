import type { RequestHandler } from './$types';
import { findBodyObject } from '$lib/server/db/body';
import { readBodyObject } from '$lib/server/body';
import { findOwnedDraft } from '$lib/server/db/drafts';
import { findOwnedWorkspaceMessage } from '$lib/server/db/messages';
import { ApiError, apiSuccess, requirePathParam, withApiHandler } from '$lib/server/http/api';
import { getRequestEnv, requireWorkspaceSession } from '$lib/server/workspace-api';

export const GET: RequestHandler = withApiHandler(async (event) => {
  const session = requireWorkspaceSession(event);
  const env = getRequestEnv(event);
  if (!env?.DB) throw new ApiError(503, 'BODY_STORAGE_UNAVAILABLE', '正文存储服务暂不可用。');
  const id = requirePathParam(event, 'id');
  const message = await findOwnedWorkspaceMessage(env.DB, session.userId, id);
  const draft = message ? null : await findOwnedDraft(env.DB, session.userId, id);
  if (!message && !draft) throw new ApiError(404, 'MESSAGE_NOT_FOUND', '邮件不存在。');
  const pointer = message?.body_object_id ?? draft?.body_object_id ?? null;
  if (!pointer) return apiSuccess(event, { body: message?.body ?? draft?.body ?? '' });
  if (!env.BUCKET) throw new ApiError(503, 'BODY_STORAGE_UNAVAILABLE', '正文存储服务暂不可用。');
  const object = await findBodyObject(env.DB, pointer, session.userId, message ? 'workspace_message' : 'draft', id);
  if (!object) throw new ApiError(404, 'BODY_OBJECT_NOT_FOUND', '正文对象不存在。');
  let body;
  try { body = await readBodyObject(env.BUCKET, object.r2_key, object.size_bytes, object.sha256); }
  catch { throw new ApiError(409, 'BODY_OBJECT_INTEGRITY', '正文完整性校验失败。'); }
  // Raw HTML is intentionally not exposed through the general body API. The
  // HTML reader uses a separately sanitized, sandboxed representation.
  return apiSuccess(event, { body: body.textBody });
});
