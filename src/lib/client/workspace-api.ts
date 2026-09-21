import {
  ClientApiError,
  isAccessLoginUrl,
  isJsonContentType,
  isHtmlContentType,
  requestJson,
  requestNetworkError,
  type RequestJsonPolicy
} from './api';
import { isClientAuthExpired, markClientAuthExpired } from './auth-session';
import type {
  ComposeInput,
  DeliveryDetail,
  InboundMessageDetail,
  LoginInput,
  MailFolder,
  MailboxMutationAction,
  MailboxMutationScope,
  MailboxMutationResult,
  MailboxMetricsScope,
  MailMessage,
  MailboxPage,
  MessagePatch,
  TrashListResult,
  UserProfile,
  WorkspacePayload,
  WorkspaceSnapshot
} from '$lib/domain/mail';

export type SessionResponse = {
  ok: boolean;
  authenticated: boolean;
  authMode?: 'local' | 'cloudflare-access';
  authConfigured?: boolean;
  logoutUrl?: string;
  workspace: WorkspaceSnapshot | null;
  error?: string;
};

export type WorkspaceResponse = { ok: boolean; workspace?: WorkspacePayload; error?: string; profile?: UserProfile; metrics?: WorkspacePayload['metrics'] };

export type MessageResponse = {
  ok: boolean;
  message: MailMessage;
  metrics: WorkspacePayload['metrics'];
  metricsScope: MailboxMetricsScope;
  bodyRevision?: string | null;
  html?: string;
  attachments?: NonNullable<ComposeInput['attachments']>;
  attachmentRevision?: number;
  error?: string;
};
export type DeleteResponse = {
  removedId: string;
  folder: MailFolder;
  metrics: WorkspacePayload['metrics'];
  metricsScope: MailboxMetricsScope;
};
export type RestoreTrashResponse = { restoredId: string; originalFolder: import('$lib/domain/mail').MailboxSection; idempotent: boolean; metrics: WorkspacePayload['metrics'] };
export type PermanentDeleteResponse = { deletedId: string; idempotent: boolean; cleanupPending?: boolean; metrics: WorkspacePayload['metrics'] };
export type DraftAttachmentResponse = {
  attachments: NonNullable<ComposeInput['attachments']>;
  attachmentRevision: number;
  draftUpdatedAt: string;
};

function serverComposeInput(input: ComposeInput) {
  const { forwardAttachmentCandidates: _clientOnly, ...payload } = input;
  return payload;
}

async function sha256Hex(file: File) {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

type AttachmentUploadErrorPayload = {
  error?: { code?: string; message?: string; details?: Record<string, unknown> };
  requestId?: string;
};

function uploadError(xhr: XMLHttpRequest) {
  const contentType = (() => {
    try { return xhr.getResponseHeader('content-type'); } catch { return null; }
  })();
  const accessLoginRedirect = isAccessLoginUrl(xhr.responseURL) && isHtmlContentType(contentType);
  if (accessLoginRedirect || (xhr.status === 401 && !isJsonContentType(contentType))) {
    markClientAuthExpired(accessLoginRedirect ? 'access-login-redirect' : 'access-edge');
    return new ClientApiError(401, 'AUTH_SESSION_EXPIRED', '登录状态已失效。当前编辑内容仍保留；请重新认证后手动继续。');
  }

  let payload: AttachmentUploadErrorPayload | null = null;
  try {
    if (xhr.response && typeof xhr.response === 'object') payload = xhr.response as AttachmentUploadErrorPayload;
  } catch {
    payload = null;
  }

  if (xhr.status === 401 && ['ACCESS_REQUIRED', 'AUTHENTICATION_REQUIRED'].includes(payload?.error?.code ?? '')) {
    markClientAuthExpired('worker-session');
    return new ClientApiError(401, 'AUTH_SESSION_EXPIRED', '登录状态已失效。当前编辑内容仍保留；请重新认证后手动继续。');
  }

  return new ClientApiError(
    xhr.status,
    payload?.error?.code ?? 'ATTACHMENT_UPLOAD_FAILED',
    payload?.error?.message ?? '附件上传失败。',
    payload?.requestId,
    undefined,
    payload?.error?.details
  );
}

/** XHR is used only because fetch does not expose browser upload progress. */
export function uploadDraftAttachment(
  draftId: string,
  attachmentId: string,
  file: File,
  attachmentRevision: number,
  onProgress: (percent: number) => void
) {
  let xhr: XMLHttpRequest | null = null;
  let cancelled = false;
  const promise = (async () => {
    if (isClientAuthExpired()) {
      throw new ClientApiError(401, 'AUTH_SESSION_EXPIRED', '登录状态已失效。当前编辑内容仍保留；请重新认证后手动继续。');
    }
    const checksum = await sha256Hex(file);
    if (cancelled) throw new ClientApiError(499, 'ATTACHMENT_UPLOAD_CANCELLED', '附件上传已取消。');
    const params = new URLSearchParams({
      filename: file.name,
      size: String(file.size),
      attachmentRevision: String(attachmentRevision)
    });
    return await new Promise<DraftAttachmentResponse>((resolve, reject) => {
      xhr = new XMLHttpRequest();
      xhr.open('PUT', `/api/workspace/drafts/${encodeURIComponent(draftId)}/attachments/${encodeURIComponent(attachmentId)}?${params}`);
      xhr.responseType = 'json';
      xhr.setRequestHeader('content-type', file.type || 'application/octet-stream');
      xhr.setRequestHeader('x-requested-with', 'XMLHttpRequest');
      xhr.setRequestHeader('x-flaremail-sha256', checksum);
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) onProgress(Math.min(99, Math.round(event.loaded / event.total * 100)));
      };
      xhr.onload = () => {
        const payload = xhr?.response as { ok?: boolean; data?: DraftAttachmentResponse } | null;
        if (xhr && xhr.status >= 200 && xhr.status < 300 && payload?.data) {
          onProgress(100);
          resolve(payload.data);
        } else if (xhr) reject(uploadError(xhr));
      };
      xhr.onerror = () => reject(requestNetworkError());
      xhr.onabort = () => reject(new ClientApiError(499, 'ATTACHMENT_UPLOAD_CANCELLED', '附件上传已取消。'));
      xhr.send(file);
    });
  })();
  return {
    promise,
    cancel: () => {
      cancelled = true;
      xhr?.abort();
    }
  };
}

export function renameDraftAttachment(
  draftId: string,
  attachmentId: string,
  filename: string,
  attachmentRevision: number
) {
  return requestJson<DraftAttachmentResponse>(
    `/api/workspace/drafts/${encodeURIComponent(draftId)}/attachments/${encodeURIComponent(attachmentId)}`,
    { method: 'PATCH', body: JSON.stringify({ filename, attachmentRevision }) }
  );
}

export function deleteDraftAttachment(draftId: string, attachmentId: string, attachmentRevision: number) {
  const params = new URLSearchParams({ attachmentRevision: String(attachmentRevision) });
  return requestJson<DraftAttachmentResponse>(
    `/api/workspace/drafts/${encodeURIComponent(draftId)}/attachments/${encodeURIComponent(attachmentId)}?${params}`,
    { method: 'DELETE' }
  );
}

export function fetchInboundDetail(messageId: string, signal?: AbortSignal) {
  return requestJson<{ ok: boolean; detail: InboundMessageDetail; error?: string }>(
    `/api/workspace/messages/${encodeURIComponent(messageId)}/detail`,
    { signal }
  );
}

export function fetchWorkspaceMessage(messageId: string, signal?: AbortSignal) {
  return requestJson<MessageResponse>(
    `/api/workspace/messages/${encodeURIComponent(messageId)}`,
    { signal }
  );
}

export function fetchDeliveryDetail(messageId: string, signal?: AbortSignal) {
  return requestJson<{ ok: boolean; detail: DeliveryDetail; error?: string }>(
    `/api/workspace/messages/${encodeURIComponent(messageId)}/delivery`,
    { signal }
  );
}

export function fetchMessageBody(messageId: string, signal?: AbortSignal) {
  return requestJson<{ body: string; attachments: NonNullable<ComposeInput['attachments']> }>(
    `/api/workspace/messages/${encodeURIComponent(messageId)}/body`,
    { signal }
  );
}

export function fetchDraftDetail(draftId: string, signal?: AbortSignal) {
  return requestJson<{
    message: MailMessage;
    html?: string;
    bodyRevision: string | null;
    attachments: NonNullable<ComposeInput['attachments']>;
    attachmentRevision: number;
  }>(
    `/api/workspace/drafts/${encodeURIComponent(draftId)}`,
    { signal }
  );
}

export function fetchMailboxPage(params: URLSearchParams, signal?: AbortSignal) {
  return requestJson<{ page: MailboxPage }>(`/api/workspace/mailbox?${params}`, { signal });
}

export function createSession(input: LoginInput) {
  return requestJson<SessionResponse>('/api/workspace/session', {
    method: 'POST',
    body: JSON.stringify(input)
  });
}

export function fetchWorkspaceSession(policy: RequestJsonPolicy = {}) {
  return requestJson<SessionResponse>('/api/workspace/session', {}, policy);
}

export function deleteSession() {
  return requestJson<SessionResponse>('/api/workspace/session', { method: 'DELETE' });
}

export function updateProfile(profile: UserProfile) {
  return requestJson<WorkspaceResponse>('/api/workspace/profile', {
    method: 'PUT',
    body: JSON.stringify(profile)
  });
}

export function persistDraft(input: ComposeInput) {
  return requestJson<MessageResponse>('/api/workspace/drafts', {
    method: 'POST',
    body: JSON.stringify(serverComposeInput(input))
  });
}

export function submitMessage(input: ComposeInput, idempotencyKey?: string) {
  return requestJson<MessageResponse>('/api/send', {
    method: 'POST',
    headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
    body: JSON.stringify(serverComposeInput(input))
  });
}

export function retryDelivery(messageId: string) {
  return requestJson<MessageResponse>(
    `/api/workspace/messages/${encodeURIComponent(messageId)}/retry`,
    { method: 'POST' }
  );
}

export function updateMessageFlags(messageId: string, patch: MessagePatch) {
  return requestJson<MessageResponse>(
    `/api/workspace/messages/${encodeURIComponent(messageId)}/flags`,
    { method: 'PATCH', body: JSON.stringify(patch) }
  );
}

export function mutateMailbox(
  action: MailboxMutationAction,
  messageIds: string[],
  threadKeys: string[],
  scope: MailboxMutationScope
) {
  return requestJson<{ result: MailboxMutationResult }>('/api/workspace/mailbox/mutate', {
    method: 'POST',
    body: JSON.stringify({ action, ids: messageIds, threadKeys, scope })
  });
}

export function deleteMessage(messageId: string) {
  return requestJson<DeleteResponse>(
    `/api/workspace/messages/${encodeURIComponent(messageId)}`,
    { method: 'DELETE' }
  );
}

export function fetchTrash(signal?: AbortSignal) {
  return requestJson<TrashListResult>('/api/workspace/trash?limit=500', { signal });
}

export function restoreTrashItem(messageId: string) {
  return requestJson<RestoreTrashResponse>(
    `/api/workspace/trash/${encodeURIComponent(messageId)}`,
    { method: 'POST' }
  );
}

export function permanentlyDeleteTrashItem(messageId: string) {
  return requestJson<PermanentDeleteResponse>(
    `/api/workspace/trash/${encodeURIComponent(messageId)}`,
    { method: 'DELETE' }
  );
}

export function emptyTrash() {
  return requestJson<{ deleted: number; metrics: WorkspacePayload['metrics'] }>('/api/workspace/trash', {
    method: 'POST',
    body: JSON.stringify({ action: 'empty' })
  });
}
