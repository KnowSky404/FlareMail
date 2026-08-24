/**
 * Compatibility facade for the workspace server API.
 *
 * Route imports intentionally remain stable while implementation is split into
 * repositories (D1 statements) and services (memory/D1 orchestration).
 */
export type {
  ComposeInput,
  DeliveryDetail,
  DeliveryEvent,
  DeliveryEventType,
  DeliveryResultKind,
  DeliveryStatus,
  MailFolder,
  MailboxFilter,
  MailboxPage,
  MailboxState,
  MailMessage,
  MessagePatch,
  UserProfile,
  WorkspacePayload
} from '$lib/server/workspace/shared';
export type { WorkspaceContext, WorkspaceSession } from '$lib/server/workspace/shared';

export { loadMailboxPage, loadWorkspaceSnapshot, mutateWorkspaceMailbox, serializeWorkspace } from '$lib/server/workspace/mailbox';
export {
  authenticateWorkspaceUser,
  clearSessionCookieOptions,
  destroyWorkspaceSession,
  getWorkspaceSessionCookieName,
  getWorkspaceSession,
  isSecureSessionRequest,
  legacyWorkspaceSessionCookie,
  sessionCookieOptions,
  secureWorkspaceSessionCookie,
  WorkspaceAuthUnavailableError,
  workspaceSessionCookieNames,
  workspaceSessionCookie
} from '$lib/server/workspace/session';
export { updateWorkspaceProfile } from '$lib/server/workspace/profile';
export { saveWorkspaceDraft } from '$lib/server/workspace/draft';
export { OutboundRateLimitError, sendWorkspaceMessage, retryWorkspaceMessageDelivery } from '$lib/server/workspace/outbound';
export { patchWorkspaceMessage, deleteWorkspaceMessage } from '$lib/server/workspace/message';
export { getWorkspaceMessageDeliveryDetail, applyResendDeliveryWebhook } from '$lib/server/workspace/delivery';
