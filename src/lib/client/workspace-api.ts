import { requestJson } from './api';
import type {
  ComposeInput,
  DeliveryStatus,
  DeliveryDetail,
  InboundMessageDetail,
  LoginInput,
  MailFolder,
  MailboxMutationAction,
  MailboxMutationResult,
  MailboxSection,
  MailMessage,
  MailboxPage,
  MessagePatch,
  UserProfile,
  WorkspacePayload
} from '$lib/domain/mail';

export type WorkspaceSnapshotPage = MailboxPage & {
  cursor: string | null;
  status: DeliveryStatus | null;
};

export type WorkspaceSnapshot = WorkspacePayload & {
  activeFolder: MailboxSection;
  activePage: WorkspaceSnapshotPage;
  mailboxPages: Partial<Record<MailboxSection, WorkspaceSnapshotPage>>;
};

export type SessionResponse = {
  ok: boolean;
  authenticated: boolean;
  workspace: WorkspaceSnapshot | null;
  error?: string;
};

export type WorkspaceResponse = { ok: boolean; workspace?: WorkspacePayload; error?: string; profile?: UserProfile; metrics?: WorkspacePayload['metrics'] };

export type MessageResponse = { ok: boolean; message: MailMessage; metrics: WorkspacePayload['metrics']; error?: string };
export type DeleteResponse = WorkspaceResponse & { removedId: string; folder: MailFolder };

export function fetchInboundDetail(messageId: string, signal?: AbortSignal) {
  return requestJson<{ ok: boolean; detail: InboundMessageDetail; error?: string }>(
    `/api/workspace/messages/${encodeURIComponent(messageId)}/detail`,
    { signal }
  );
}

export function fetchDeliveryDetail(messageId: string, signal?: AbortSignal) {
  return requestJson<{ ok: boolean; detail: DeliveryDetail; error?: string }>(
    `/api/workspace/messages/${encodeURIComponent(messageId)}/delivery`,
    { signal }
  );
}

export function fetchMailboxPage(params: URLSearchParams, signal?: AbortSignal) {
  return requestJson<{ page: WorkspaceSnapshotPage }>(`/api/workspace/mailbox?${params}`, { signal });
}

export function createSession(input: LoginInput) {
  return requestJson<SessionResponse>('/api/workspace/session', {
    method: 'POST',
    body: JSON.stringify(input)
  });
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
    body: JSON.stringify(input)
  });
}

export function submitMessage(input: ComposeInput, idempotencyKey?: string) {
  return requestJson<MessageResponse>('/api/workspace/messages', {
    method: 'POST',
    headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
    body: JSON.stringify(input)
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

export function mutateMailbox(action: MailboxMutationAction, messageIds: string[], threadKeys: string[] = []) {
  return requestJson<{ result: MailboxMutationResult }>('/api/workspace/mailbox/mutate', {
    method: 'POST',
    body: JSON.stringify({ action, ids: messageIds, threadKeys })
  });
}

export function deleteMessage(messageId: string) {
  return requestJson<DeleteResponse>(
    `/api/workspace/messages/${encodeURIComponent(messageId)}`,
    { method: 'DELETE' }
  );
}
