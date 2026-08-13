import type { CloudflareEnv } from '$lib/server/cloudflare';
import { getWorkspaceCapabilities, hasWorkspaceCoreTables } from '$lib/server/db/capabilities';
import { upsertDraft } from '$lib/server/db/drafts';
import { touchSession } from '$lib/server/db/sessions';
import { createDraftMessage, serializeDraftForInsert, serializeWorkspace, type ComposeInput, type WorkspaceSession } from '$lib/server/workspace/shared';
import { refreshD1Session } from '$lib/server/workspace/mailbox';

export async function saveWorkspaceDraft(env: CloudflareEnv | undefined, session: WorkspaceSession, input: ComposeInput) {
  const currentDraft = input.draftId ? session.mailbox.drafts.find((message) => message.id === input.draftId) ?? null : null;
  const draft = createDraftMessage({ id: input.draftId, from: session.profile, toEmail: input.toEmail, cc: input.cc,
    subject: input.subject, body: input.body, starred: currentDraft?.starred ?? false });
  if (session.storage === 'd1' && await hasWorkspaceCoreTables(env)) {
    const capabilities = await getWorkspaceCapabilities(env);
    if (!capabilities.drafts) throw new Error('草稿表尚未迁移，请先执行最新的 D1 schema。');
    const payload = serializeDraftForInsert(session.userId, { ...input, draftId: draft.id }, draft.starred);
    const timestamp = new Date().toISOString();
    await env!.DB.batch([upsertDraft(env!.DB, payload), touchSession(env!.DB, session.id, timestamp)]);
    const nextSession = await refreshD1Session(env, session.id);
    if (!nextSession) throw new Error('保存草稿后无法重新加载工作区。');
    return { message: nextSession.mailbox.drafts.find((item) => item.id === draft.id) ?? draft, workspace: serializeWorkspace(nextSession) };
  }
  throw new Error('工作区存储未配置，无法保存草稿。');
}
