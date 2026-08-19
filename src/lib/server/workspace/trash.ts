import type { CloudflareEnv } from '$lib/server/cloudflare';
import { ApiError } from '$lib/server/http/api';
import { mapDraftRow, mapInboundRow, mapWorkspaceMessageRow, type WorkspaceContext, type WorkspaceDraftRow, type WorkspaceInboundRow, type WorkspaceMessageRow } from '$lib/server/workspace/shared';
import type { MailMessage } from '$lib/domain/mail';

type TrashKind = 'workspace' | 'draft' | 'inbound';
type TrashRow = {
  id: string;
  kind: TrashKind;
  deletedAt: string;
  message: MailMessage;
  r2Keys: string[];
};

const inboundId = (id: string) => id.startsWith('email:') ? id.slice(6) : null;
const placeholders = (values: string[]) => values.map(() => '?').join(', ');

function requireD1(env: CloudflareEnv | undefined, session: WorkspaceContext) {
  if (!env?.DB || session.storage !== 'd1') throw new ApiError(503, 'WORKSPACE_UNAVAILABLE', '工作区存储暂不可用。');
  return env.DB;
}

async function findTrashRow(db: D1Database, userId: string, id: string, includeActive = false): Promise<TrashRow | null> {
  const emailId = inboundId(id);
  if (emailId !== null) {
    const row = await db.prepare(`
      SELECT e.id AS email_id, e."from", e."to", e.subject, e."timestamp", e.snippet,
        e.message_id, e.in_reply_to, e."references", e.thread_key, e.text_body, s.archived_at,
        s.deleted_at, COALESCE(s.is_read, 0) AS is_read, COALESCE(s.is_starred, 0) AS is_starred,
        e.raw_key, e.body_object_id
      FROM email_messages AS e
      LEFT JOIN workspace_email_states AS s ON s.user_id = ? AND s.email_message_id = e.id
      WHERE e.id = ? AND e.owner_user_id = ? ${includeActive ? '' : 'AND s.deleted_at IS NOT NULL'}
    `).bind(userId, emailId, userId).first<WorkspaceInboundRow & { deleted_at: string | null; raw_key: string; body_object_id: string | null }>();
    if (!row || (!includeActive && !row.deleted_at)) return null;
    const message = mapInboundRow(row, { name: '', role: '', email: row.to, company: '', location: '', timezone: '', forwardingEnabled: false, signature: '' });
    return { id, kind: 'inbound', deletedAt: row.deleted_at ?? '', message, r2Keys: row.raw_key ? [row.raw_key] : [] };
  }

  const workspace = await db.prepare(`
    SELECT id, folder, from_name, from_email, to_name, to_email, to_json, subject, preview, '' AS body,
      sent_at, labels_json, is_read, is_starred, message_id, in_reply_to, "references", thread_key,
      cc, cc_json, bcc_json, idempotency_key, archived_at, body_object_id, deleted_at
    FROM workspace_messages WHERE user_id = ? AND id = ? ${includeActive ? '' : 'AND deleted_at IS NOT NULL'}
  `).bind(userId, id).first<WorkspaceMessageRow>();
  if (workspace) {
    if (!workspace.deleted_at && !includeActive) return null;
    return { id, kind: 'workspace', deletedAt: workspace.deleted_at ?? '', message: mapWorkspaceMessageRow(workspace), r2Keys: [] };
  }

  const draft = await db.prepare(`
    SELECT id, to_email, cc, to_json, cc_json, bcc_json, subject, '' AS body, is_starred,
      created_at, updated_at, message_id, in_reply_to, "references", thread_key, idempotency_key,
      body_object_id, deleted_at
    FROM workspace_drafts WHERE user_id = ? AND id = ? ${includeActive ? '' : 'AND deleted_at IS NOT NULL'}
  `).bind(userId, id).first<WorkspaceDraftRow>();
  if (draft) {
    if (!draft.deleted_at && !includeActive) return null;
    return { id, kind: 'draft', deletedAt: draft.deleted_at ?? '', message: mapDraftRow(draft, { name: '', role: '', email: draft.to_email, company: '', location: '', timezone: '', forwardingEnabled: false, signature: '' }), r2Keys: [] };
  }
  return null;
}

async function resourceKeys(db: D1Database, userId: string, row: TrashRow) {
  const keys = [...row.r2Keys];
  const attachments = await db.prepare('SELECT r2_key FROM workspace_attachments WHERE user_id = ? AND message_id = ?')
    .bind(userId, row.kind === 'inbound' ? row.id.slice(6) : row.id).all<{ r2_key: string }>();
  keys.push(...(attachments.results ?? []).map((item) => item.r2_key));
  const body = await db.prepare('SELECT r2_key FROM mail_body_objects WHERE owner_user_id = ? AND entity_id = ?')
    .bind(userId, row.kind === 'inbound' ? row.id.slice(6) : row.id).all<{ r2_key: string }>();
  keys.push(...(body.results ?? []).map((item) => item.r2_key));
  return [...new Set(keys.filter(Boolean))];
}

async function optionalOwnedCleanupStatements(db: D1Database, userId: string, entityId: string) {
  const names = await db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('workspace_fts', 'workspace_labels', 'workspace_outbox')`).all<{ name: string }>();
  const statements: D1PreparedStatement[] = [];
  for (const { name } of names.results ?? []) {
    const columns = await db.prepare(`PRAGMA table_info("${name.replaceAll('"', '""')}")`).all<{ name: string }>();
    const columnNames = new Set((columns.results ?? []).map((column) => column.name));
    if (columnNames.has('user_id') && columnNames.has('message_id')) {
      statements.push(db.prepare(`DELETE FROM "${name.replaceAll('"', '""')}" WHERE user_id = ? AND message_id = ?`).bind(userId, entityId));
    }
  }
  return statements;
}

export async function listWorkspaceTrash(env: CloudflareEnv | undefined, session: WorkspaceContext, limit = 100) {
  const db = requireD1(env, session);
  const bounded = Math.max(1, Math.min(500, Math.trunc(limit)));
  const queryLimit = bounded + 1;
  const rows: TrashRow[] = [];
  const [messages, drafts, inbound] = await Promise.all([
    db.prepare(`SELECT id, folder, from_name, from_email, to_name, to_email, to_json, subject, '' AS body, sent_at, labels_json, is_read, is_starred, message_id, in_reply_to, "references", thread_key, cc, cc_json, bcc_json, idempotency_key, archived_at, body_object_id, deleted_at FROM workspace_messages WHERE user_id = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC, id DESC LIMIT ?`).bind(session.userId, queryLimit).all<WorkspaceMessageRow>(),
    db.prepare(`SELECT id, to_email, cc, to_json, cc_json, bcc_json, subject, '' AS body, is_starred, created_at, updated_at, message_id, in_reply_to, "references", thread_key, idempotency_key, body_object_id, deleted_at FROM workspace_drafts WHERE user_id = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC, id DESC LIMIT ?`).bind(session.userId, queryLimit).all<WorkspaceDraftRow>(),
    db.prepare(`SELECT e.id AS email_id, e."from", e."to", e.subject, e."timestamp", e.snippet, e.message_id, e.in_reply_to, e."references", e.thread_key, e.text_body, s.archived_at, s.deleted_at, COALESCE(s.is_read, 0) AS is_read, COALESCE(s.is_starred, 0) AS is_starred FROM email_messages AS e JOIN workspace_email_states AS s ON s.user_id = ? AND s.email_message_id = e.id WHERE e.owner_user_id = ? AND s.deleted_at IS NOT NULL ORDER BY s.deleted_at DESC, e.id DESC LIMIT ?`).bind(session.userId, session.userId, queryLimit).all<WorkspaceInboundRow & { deleted_at: string }>()
  ]);
  for (const row of messages.results ?? []) rows.push({ id: row.id, kind: 'workspace', deletedAt: row.deleted_at!, message: mapWorkspaceMessageRow(row), r2Keys: [] });
  for (const row of drafts.results ?? []) rows.push({ id: row.id, kind: 'draft', deletedAt: row.deleted_at!, message: mapDraftRow(row, session.profile), r2Keys: [] });
  for (const row of inbound.results ?? []) rows.push({ id: `email:${row.email_id}`, kind: 'inbound', deletedAt: row.deleted_at, message: mapInboundRow(row, session.profile), r2Keys: [] });
  rows.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt) || b.id.localeCompare(a.id));
  return {
    items: rows.slice(0, bounded).map(({ id, kind, deletedAt, message }) => ({ id, kind, deletedAt, originalFolder: message.archivedAt ? 'archive' : message.folder, message })),
    hasMore: rows.length > bounded
  };
}

export async function moveWorkspaceMessageToTrash(env: CloudflareEnv | undefined, session: WorkspaceContext, id: string) {
  const db = requireD1(env, session);
  const current = await findTrashRow(db, session.userId, id, true);
  if (!current) return null;
  if (current.deletedAt) return { trashedId: id, deletedAt: current.deletedAt, folder: current.message.folder, idempotent: true };
  const timestamp = new Date().toISOString();
  if (current.kind === 'inbound') {
    await db.prepare(`
      INSERT INTO workspace_email_states (id, user_id, email_message_id, is_read, is_starred, archived_at, deleted_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, email_message_id) DO UPDATE SET deleted_at = excluded.deleted_at, updated_at = excluded.updated_at
    `).bind(crypto.randomUUID(), session.userId, id.slice(6), current.message.read ? 1 : 0, current.message.starred ? 1 : 0, current.message.archivedAt ?? null, timestamp, timestamp, timestamp).run();
  } else {
    const table = current.kind === 'draft' ? 'workspace_drafts' : 'workspace_messages';
    await db.prepare(`UPDATE ${table} SET deleted_at = ?, updated_at = ? WHERE user_id = ? AND id = ? AND deleted_at IS NULL`).bind(timestamp, timestamp, session.userId, id).run();
  }
  return { trashedId: id, deletedAt: timestamp, folder: current.message.folder, idempotent: false };
}

export async function restoreWorkspaceTrash(env: CloudflareEnv | undefined, session: WorkspaceContext, id: string) {
  const db = requireD1(env, session);
  const current = await findTrashRow(db, session.userId, id);
  if (!current) {
    const active = await findTrashRow(db, session.userId, id, true);
    if (!active) return null;
    return {
      restoredId: id,
      originalFolder: active.message.archivedAt ? 'archive' : active.message.folder,
      idempotent: true
    };
  }
  if (current.kind === 'inbound') await db.prepare('UPDATE workspace_email_states SET deleted_at = NULL, updated_at = ? WHERE user_id = ? AND email_message_id = ? AND deleted_at IS NOT NULL').bind(new Date().toISOString(), session.userId, id.slice(6)).run();
  else {
    const table = current.kind === 'draft' ? 'workspace_drafts' : 'workspace_messages';
    await db.prepare(`UPDATE ${table} SET deleted_at = NULL, updated_at = ? WHERE user_id = ? AND id = ? AND deleted_at IS NOT NULL`).bind(new Date().toISOString(), session.userId, id).run();
  }
  return { restoredId: id, originalFolder: current.message.archivedAt ? 'archive' : current.message.folder, idempotent: false };
}

export async function permanentlyDeleteWorkspaceTrash(env: CloudflareEnv | undefined, session: WorkspaceContext, id: string) {
  const db = requireD1(env, session);
  const current = await findTrashRow(db, session.userId, id);
  if (!current) {
    const active = await findTrashRow(db, session.userId, id, true);
    if (active) throw new ApiError(409, 'TRASH_ITEM_NOT_TRASHED', '只能永久删除已移入回收站的项目。', undefined, undefined, false);
    return { deletedId: id, idempotent: true };
  }
  const keys = await resourceKeys(db, session.userId, current);
  if (keys.length && !env?.BUCKET) throw new ApiError(503, 'R2_UNAVAILABLE', '文件存储服务暂不可用。');
  for (const key of keys) await env!.BUCKET.delete(key);
  const entityId = current.kind === 'inbound' ? id.slice(6) : id;
  const statements = [
    db.prepare('DELETE FROM workspace_attachments WHERE user_id = ? AND message_id = ?').bind(session.userId, entityId),
    db.prepare('DELETE FROM mail_body_objects WHERE owner_user_id = ? AND entity_id = ?').bind(session.userId, entityId),
    db.prepare('DELETE FROM workspace_delivery_attempts WHERE user_id = ? AND message_id = ?').bind(session.userId, entityId),
    db.prepare('DELETE FROM workspace_delivery_statuses WHERE user_id = ? AND message_id = ?').bind(session.userId, entityId),
    db.prepare('DELETE FROM workspace_outbound_statuses WHERE user_id = ? AND message_id = ?').bind(session.userId, entityId),
    db.prepare('DELETE FROM workspace_outbound_receipts WHERE user_id = ? AND message_id = ?').bind(session.userId, entityId),
    db.prepare('DELETE FROM workspace_outbound_events WHERE user_id = ? AND message_id = ?').bind(session.userId, entityId)
  ];
  statements.push(...await optionalOwnedCleanupStatements(db, session.userId, entityId));
  if (current.kind === 'inbound') {
    statements.push(db.prepare('DELETE FROM workspace_email_states WHERE user_id = ? AND email_message_id = ?').bind(session.userId, entityId));
    statements.push(db.prepare('DELETE FROM email_messages WHERE owner_user_id = ? AND id = ?').bind(session.userId, entityId));
  } else if (current.kind === 'draft') statements.push(db.prepare('DELETE FROM workspace_drafts WHERE user_id = ? AND id = ?').bind(session.userId, id));
  else statements.push(db.prepare('DELETE FROM workspace_messages WHERE user_id = ? AND id = ?').bind(session.userId, id));
  await db.batch(statements);
  return { deletedId: id, idempotent: false };
}

export async function emptyWorkspaceTrash(env: CloudflareEnv | undefined, session: WorkspaceContext) {
  const db = requireD1(env, session);
  const result = await listWorkspaceTrash(env, session, 500);
  if (result.hasMore) throw new ApiError(413, 'TRASH_TOO_LARGE', '回收站项目过多，请分批清空。', undefined, undefined, false);
  let deleted = 0;
  for (const item of result.items) {
    await permanentlyDeleteWorkspaceTrash(env, session, item.id);
    deleted += 1;
  }
  void db;
  return { deleted };
}
