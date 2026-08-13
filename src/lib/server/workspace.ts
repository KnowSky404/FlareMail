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
  MailboxState,
  MailMessage,
  MessagePatch,
  UserProfile,
  WorkspacePayload
} from '$lib/server/workspace/shared';
export type { WorkspaceSession } from '$lib/server/workspace/shared';

export { serializeWorkspace } from '$lib/server/workspace/mailbox';
export {
  authenticateWorkspaceUser,
  clearSessionCookieOptions,
  destroyWorkspaceSession,
  getWorkspaceSession,
  sessionCookieOptions,
  workspaceSessionCookie
} from '$lib/server/workspace/session';
export { updateWorkspaceProfile } from '$lib/server/workspace/profile';
export { saveWorkspaceDraft } from '$lib/server/workspace/draft';
export { sendWorkspaceMessage, retryWorkspaceMessageDelivery } from '$lib/server/workspace/outbound';
export { patchWorkspaceMessage, deleteWorkspaceMessage } from '$lib/server/workspace/message';
export { getWorkspaceMessageDeliveryDetail, applyResendDeliveryWebhook } from '$lib/server/workspace/delivery';
