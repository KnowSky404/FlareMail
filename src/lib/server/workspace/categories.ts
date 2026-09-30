import {
  fromInboundMessageId,
  isInboxCategoryFilter,
  isInboundMessageId,
  isMailInboxCategory,
  resolveInboxCategory,
  type MailboxCategoryMutationRequest,
  type MailboxCategoryMutationResult,
  type MailboxCategoryMutationScope
} from '$lib/domain/mail';
import type { CloudflareEnv } from '$lib/server/cloudflare';
import { inboundScopeSql, listOwnedMailboxMutationRows, workspaceScopeSql } from '$lib/server/db/messages';
import { mailboxIdentityFilterExists } from '$lib/server/db/mail-identities';
import { ApiError } from '$lib/server/http/api';
import type { WorkspaceContext } from './shared';

export async function changeMailboxCategories(
  env: CloudflareEnv,
  workspace: WorkspaceContext,
  input: MailboxCategoryMutationRequest
): Promise<MailboxCategoryMutationResult> {
  if (!input || (input.category !== null && !isMailInboxCategory(input.category))) {
    throw new ApiError(400, 'INVALID_INBOX_CATEGORY', '请选择有效的收件箱分类，或恢复自动分类。');
  }
  if (!Array.isArray(input.ids) || input.ids.length < 1 || input.ids.length > 100 ||
    input.ids.some((id) => typeof id !== 'string' || !/^[A-Za-z0-9:._-]{1,256}$/u.test(id))) {
    throw new ApiError(400, 'INVALID_CATEGORY_SELECTION', '请选择 1 到 100 封收件箱邮件。');
  }
  const supplied = input.scope;
  if (!supplied || typeof supplied !== 'object' || supplied.section !== 'inbox' ||
    !Object.prototype.hasOwnProperty.call(supplied, 'identityFilter') ||
    (supplied.identityFilter !== null && (typeof supplied.identityFilter !== 'object' ||
      !['domain', 'address'].includes(supplied.identityFilter.kind) ||
      typeof supplied.identityFilter.id !== 'string' || !/^[A-Za-z0-9:._-]{1,128}$/u.test(supplied.identityFilter.id))) ||
    (supplied.category !== undefined && !isInboxCategoryFilter(supplied.category))) {
    throw new ApiError(400, 'INVALID_MAILBOX_SCOPE', '分类操作必须声明当前收件箱和地址筛选范围。');
  }
  const scope: MailboxCategoryMutationScope = {
    section: 'inbox', identityFilter: supplied.identityFilter, category: supplied.category ?? 'all'
  };
  if (scope.identityFilter && !(await mailboxIdentityFilterExists(env.DB, workspace.userId, scope.identityFilter))) {
    throw new ApiError(404, 'MAIL_IDENTITY_NOT_FOUND', '所选邮件身份不存在或不属于当前工作区。');
  }
  const ids = [...new Set(input.ids)];
  // Leave room for owner and scope bindings within D1's statement parameter limit.
  const selected = [];
  for (let index = 0; index < ids.length; index += 80) {
    selected.push(...await listOwnedMailboxMutationRows(env.DB, workspace.userId, ids.slice(index, index + 80), scope));
  }
  if (selected.length !== ids.length) {
    throw new ApiError(404, 'MAILBOX_MESSAGE_NOT_FOUND', '所选邮件不存在或不属于声明的收件箱范围。');
  }
  // Validate the entire selection before writing. D1 applies this batch atomically.
  const timestamp = new Date().toISOString();
  const workspaceIds = ids.filter((id) => !isInboundMessageId(id));
  const inboundIds = ids.filter(isInboundMessageId).map(fromInboundMessageId);
  const statements: D1PreparedStatement[] = [];
  for (const [source, selectedIds] of [['workspace', workspaceIds], ['inbound', inboundIds]] as const) {
    for (let index = 0; index < selectedIds.length; index += 80) {
      const chunk = selectedIds.slice(index, index + 80);
      const placeholders = chunk.map(() => '?').join(', ');
      if (source === 'workspace') {
        const clause = workspaceScopeSql('m', scope);
        statements.push(env.DB.prepare(`UPDATE workspace_messages AS m SET inbox_category = ?, updated_at = ?
          WHERE m.user_id = ? AND m.deleted_at IS NULL AND m.id IN (${placeholders})${clause.sql}`)
          .bind(input.category, timestamp, workspace.userId, ...chunk, ...clause.bindings));
      } else {
        const clause = inboundScopeSql('e', 'state', scope);
        statements.push(env.DB.prepare(`UPDATE email_messages SET inbox_category = ?
          WHERE owner_user_id = ? AND id IN (
            SELECT e.id FROM email_messages AS e
            LEFT JOIN workspace_email_states AS state ON state.user_id = e.owner_user_id AND state.email_message_id = e.id
            WHERE e.owner_user_id = ? AND state.deleted_at IS NULL AND e.id IN (${placeholders})${clause.sql}
          )`).bind(input.category, workspace.userId, workspace.userId, ...chunk, ...clause.bindings));
      }
    }
  }
  await env.DB.batch(statements);

  const summaries: MailboxCategoryMutationResult['summaries'] = [];
  // Bounded metadata reads: never load message bodies or alter sender identities.
  for (const [source, selectedIds] of [['workspace', workspaceIds], ['inbound', inboundIds]] as const) {
    if (!selectedIds.length) continue;
    const sql = source === 'workspace'
      ? `SELECT id, from_email AS sender, subject, inbox_category FROM workspace_messages WHERE user_id = ?`
      : `SELECT 'email:' || id AS id, "from" AS sender, subject, inbox_category FROM email_messages WHERE owner_user_id = ?`;
    for (let index = 0; index < selectedIds.length; index += 80) {
      const chunk = selectedIds.slice(index, index + 80);
      const rows = await env.DB.prepare(`${sql} AND id IN (${chunk.map(() => '?').join(', ')})`)
        .bind(workspace.userId, ...chunk).all<{
          id: string; sender: string; subject: string; inbox_category: typeof input.category;
        }>();
      summaries.push(...(rows.results ?? []).map((row) => ({
        id: row.id,
        inboxCategory: resolveInboxCategory(row.sender, row.subject, row.inbox_category),
        inboxCategoryOverride: row.inbox_category
      })));
    }
  }
  return { summaries, scope };
}
