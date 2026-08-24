import type { RequestHandler } from './$types';
import {
  ApiError,
  apiSuccess,
  readJsonBody,
  requirePathParam,
  withApiHandler
} from '$lib/server/http/api';
import { getRequestEnv, requireWorkspaceMailboxSession } from '$lib/server/workspace-api';
import {
  DraftAttachmentError,
  removeDraftAttachment,
  updateDraftAttachmentName,
  uploadDraftAttachment
} from '$lib/server/workspace/attachment';

function integerParam(url: URL, name: string) {
  const raw = url.searchParams.get(name);
  const value = raw === null ? Number.NaN : Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ApiError(400, 'ATTACHMENT_VALIDATION_FAILED', `附件参数 ${name} 无效。`);
  }
  return value;
}

function mapAttachmentError(error: unknown): never {
  if (error instanceof DraftAttachmentError) {
    throw new ApiError(error.status, error.code, error.message);
  }
  throw error;
}

export const PUT: RequestHandler = withApiHandler(async (event) => {
  const session = await requireWorkspaceMailboxSession(event);
  const size = integerParam(event.url, 'size');
  const contentLength = event.request.headers.get('content-length');
  if (contentLength !== null && Number(contentLength) !== size) {
    throw new ApiError(400, 'ATTACHMENT_VALIDATION_FAILED', '附件大小与请求正文不一致。');
  }
  try {
    const result = await uploadDraftAttachment(getRequestEnv(event), session, {
      draftId: requirePathParam(event, 'id'),
      attachmentId: requirePathParam(event, 'attachmentId'),
      filename: event.url.searchParams.get('filename') ?? '',
      contentType: event.request.headers.get('content-type'),
      size,
      sha256: event.request.headers.get('x-flaremail-sha256') ?? '',
      attachmentRevision: integerParam(event.url, 'attachmentRevision'),
      body: event.request.body
    });
    return apiSuccess(event, result);
  } catch (error) {
    mapAttachmentError(error);
  }
});

export const PATCH: RequestHandler = withApiHandler(async (event) => {
  const session = await requireWorkspaceMailboxSession(event);
  const payload = await readJsonBody<{ filename?: unknown; attachmentRevision?: unknown }>(event, { maxBytes: 8 * 1024 });
  if (typeof payload.filename !== 'string' || !Number.isSafeInteger(payload.attachmentRevision) || Number(payload.attachmentRevision) < 0) {
    throw new ApiError(400, 'ATTACHMENT_VALIDATION_FAILED', '附件重命名参数无效。');
  }
  try {
    return apiSuccess(event, await updateDraftAttachmentName(getRequestEnv(event), session, {
      draftId: requirePathParam(event, 'id'),
      attachmentId: requirePathParam(event, 'attachmentId'),
      filename: payload.filename,
      attachmentRevision: Number(payload.attachmentRevision)
    }));
  } catch (error) {
    mapAttachmentError(error);
  }
});

export const DELETE: RequestHandler = withApiHandler(async (event) => {
  const session = await requireWorkspaceMailboxSession(event);
  try {
    return apiSuccess(event, await removeDraftAttachment(getRequestEnv(event), session, {
      draftId: requirePathParam(event, 'id'),
      attachmentId: requirePathParam(event, 'attachmentId'),
      attachmentRevision: integerParam(event.url, 'attachmentRevision')
    }));
  } catch (error) {
    mapAttachmentError(error);
  }
});
