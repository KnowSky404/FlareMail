import type { MailLabelMessageKind, MailMessage, MailUserLabel } from '$lib/domain/mail';
import { fromInboundMessageId } from '$lib/domain/mail';
import { ApiError } from '$lib/server/http/api';

const maxLabels = 100;
const maxBulkLabelTargets = 100;

function normalizedName(value: unknown): { name: string; key: string } {
  if (typeof value !== 'string') throw new ApiError(400, 'INVALID_LABEL_NAME', '请输入标签名称。');
  const name = value.normalize('NFC').trim().replace(/\s+/gu, ' ');
  if (!name || [...name].length > 48 || new TextEncoder().encode(name).length > 96 || /[\p{Cc}\p{Cf}]/u.test(name)) {
    throw new ApiError(400, 'INVALID_LABEL_NAME', '标签名称须为 1 至 48 个字符，且不能包含控制字符。');
  }
  return { name, key: name.toLocaleLowerCase('und') };
}

export async function listMailLabels(db: D1Database, ownerId: string): Promise<MailUserLabel[]> {
  const result = await db.prepare('SELECT id, name FROM mail_labels WHERE owner_user_id = ? ORDER BY name_key, id')
    .bind(ownerId).all<MailUserLabel>();
  return result.results ?? [];
}

export async function requireMailLabel(db: D1Database, ownerId: string, labelId: string): Promise<MailUserLabel> {
  const label = await db.prepare('SELECT id, name FROM mail_labels WHERE owner_user_id = ? AND id = ?')
    .bind(ownerId, labelId).first<MailUserLabel>();
  if (!label) throw new ApiError(404, 'MAIL_LABEL_NOT_FOUND', '标签不存在。');
  return label;
}

export async function createMailLabel(db: D1Database, ownerId: string, input: unknown): Promise<MailUserLabel> {
  const { name, key } = normalizedName(input);
  const existing = await db.prepare('SELECT id FROM mail_labels WHERE owner_user_id = ? AND name_key = ?')
    .bind(ownerId, key).first<{ id: string }>();
  if (existing) throw new ApiError(409, 'MAIL_LABEL_EXISTS', '已有同名标签。');
  const count = await db.prepare('SELECT COUNT(*) AS total FROM mail_labels WHERE owner_user_id = ?')
    .bind(ownerId).first<{ total: number }>();
  if ((count?.total ?? 0) >= maxLabels) throw new ApiError(409, 'MAIL_LABEL_LIMIT', '最多创建 100 个标签。');
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.prepare(`INSERT INTO mail_labels (id, owner_user_id, name, name_key, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(owner_user_id, name_key) DO NOTHING`)
    .bind(id, ownerId, name, key, now, now).run();
  const created = await db.prepare('SELECT id, name FROM mail_labels WHERE owner_user_id = ? AND id = ?')
    .bind(ownerId, id).first<MailUserLabel>();
  if (!created) throw new ApiError(409, 'MAIL_LABEL_EXISTS', '已有同名标签。');
  return created;
}

export async function renameMailLabel(db: D1Database, ownerId: string, labelId: string, input: unknown): Promise<MailUserLabel> {
  await requireMailLabel(db, ownerId, labelId);
  const { name, key } = normalizedName(input);
  const duplicate = await db.prepare('SELECT id FROM mail_labels WHERE owner_user_id = ? AND name_key = ? AND id <> ?')
    .bind(ownerId, key, labelId).first<{ id: string }>();
  if (duplicate) throw new ApiError(409, 'MAIL_LABEL_EXISTS', '已有同名标签。');
  await db.prepare(`UPDATE mail_labels SET name = ?, name_key = ?, updated_at = ?
    WHERE owner_user_id = ? AND id = ? AND NOT EXISTS (
      SELECT 1 FROM mail_labels AS other WHERE other.owner_user_id = ? AND other.name_key = ? AND other.id <> ?
    )`).bind(name, key, new Date().toISOString(), ownerId, labelId, ownerId, key, labelId).run();
  const renamed = await requireMailLabel(db, ownerId, labelId);
  if (renamed.name !== name) throw new ApiError(409, 'MAIL_LABEL_EXISTS', '已有同名标签。');
  return renamed;
}

export async function deleteMailLabel(db: D1Database, ownerId: string, labelId: string): Promise<void> {
  await requireMailLabel(db, ownerId, labelId);
  await db.batch([
    db.prepare('DELETE FROM mail_message_labels WHERE owner_user_id = ? AND label_id = ?').bind(ownerId, labelId),
    db.prepare('DELETE FROM mail_labels WHERE owner_user_id = ? AND id = ?').bind(ownerId, labelId)
  ]);
}

export interface LabelTarget { kind: MailLabelMessageKind; id: string; }

function validLabelTarget(value: unknown): value is LabelTarget {
  return typeof value === 'object' && value !== null && !Array.isArray(value) &&
    'kind' in value && ['workspace', 'draft', 'inbound'].includes(String(value.kind)) &&
    'id' in value && typeof value.id === 'string' && /^[A-Za-z0-9:._-]{1,256}$/u.test(value.id);
}

/** Applies one label to an explicitly selected, bounded set of Owner-owned messages. */
export async function setManyMailMessageLabels(
  db: D1Database, ownerId: string, labelId: string, input: unknown, enabled: boolean
): Promise<number> {
  if (!Array.isArray(input) || input.length === 0 || input.length > maxBulkLabelTargets ||
    !input.every(validLabelTarget)) {
    throw new ApiError(400, 'INVALID_LABEL_TARGETS', '请选择 1 至 100 封有效邮件。');
  }
  const targets = [...new Map(input.map((target: LabelTarget) => [`${target.kind}:${target.id}`, target])).values()];
  await requireMailLabel(db, ownerId, labelId);

  for (const kind of ['workspace', 'draft', 'inbound'] as const) {
    const ids = targets.filter((target) => target.kind === kind).map((target) => target.id);
    if (!ids.length) continue;
    const table = kind === 'inbound' ? 'email_messages' : kind === 'draft' ? 'workspace_drafts' : 'workspace_messages';
    const ownerColumn = kind === 'inbound' ? 'owner_user_id' : 'user_id';
    const availability = kind === 'inbound'
      ? `NOT EXISTS (SELECT 1 FROM workspace_email_states AS state
          WHERE state.user_id = ? AND state.email_message_id = ${table}.id AND state.deleted_at IS NOT NULL)`
      : 'deleted_at IS NULL';
    const rows = await db.prepare(`SELECT id FROM ${table} WHERE ${ownerColumn} = ?
      AND id IN (${ids.map(() => '?').join(', ')}) AND ${availability}`)
      .bind(ownerId, ...ids, ...(kind === 'inbound' ? [ownerId] : []))
      .all<{ id: string }>();
    if ((rows.results ?? []).length !== ids.length) {
      throw new ApiError(404, 'MAILBOX_MESSAGE_NOT_FOUND', '所选邮件不存在或不属于当前工作区。');
    }
  }

  const now = new Date().toISOString();
  const statements = targets.map((target) => {
    if (!enabled) {
      return db.prepare(`DELETE FROM mail_message_labels
        WHERE owner_user_id = ? AND label_id = ? AND message_kind = ? AND message_id = ?`)
        .bind(ownerId, labelId, target.kind, target.id);
    }
    const table = target.kind === 'inbound' ? 'email_messages' : target.kind === 'draft' ? 'workspace_drafts' : 'workspace_messages';
    const ownerColumn = target.kind === 'inbound' ? 'owner_user_id' : 'user_id';
    const availability = target.kind === 'inbound'
      ? `NOT EXISTS (SELECT 1 FROM workspace_email_states AS state
          WHERE state.user_id = ? AND state.email_message_id = ${table}.id AND state.deleted_at IS NOT NULL)`
      : 'deleted_at IS NULL';
    return db.prepare(`INSERT INTO mail_message_labels (owner_user_id, label_id, message_kind, message_id, created_at)
      SELECT ?, ?, ?, id, ? FROM ${table}
      WHERE ${ownerColumn} = ? AND id = ? AND ${availability} ON CONFLICT DO NOTHING`)
      .bind(ownerId, labelId, target.kind, now, ownerId, target.id, ...(target.kind === 'inbound' ? [ownerId] : []));
  });
  await db.batch(statements);
  return targets.length;
}

function targetForMessage(message: MailMessage): LabelTarget {
  return message.source === 'inbound'
    ? { kind: 'inbound', id: fromInboundMessageId(message.id) }
    : { kind: message.folder === 'drafts' ? 'draft' : 'workspace', id: message.id };
}

export async function attachMailLabels(db: D1Database, ownerId: string, messages: MailMessage[]): Promise<void> {
  if (!messages.length) return;
  const targets = messages.map(targetForMessage);
  const clauses = targets.map(() => '(message_kind = ? AND message_id = ?)').join(' OR ');
  const rows = await db.prepare(`SELECT ml.message_kind, ml.message_id, l.id, l.name
    FROM mail_message_labels AS ml JOIN mail_labels AS l
      ON l.owner_user_id = ml.owner_user_id AND l.id = ml.label_id
    WHERE ml.owner_user_id = ? AND (${clauses}) ORDER BY l.name_key, l.id`)
    .bind(ownerId, ...targets.flatMap((target) => [target.kind, target.id]))
    .all<{ message_kind: MailLabelMessageKind; message_id: string; id: string; name: string }>();
  const byTarget = new Map<string, MailUserLabel[]>();
  for (const row of rows.results ?? []) {
    const key = `${row.message_kind}:${row.message_id}`;
    const labels = byTarget.get(key) ?? [];
    labels.push({ id: row.id, name: row.name });
    byTarget.set(key, labels);
  }
  messages.forEach((message, index) => {
    const target = targets[index];
    message.userLabels = byTarget.get(`${target.kind}:${target.id}`) ?? [];
  });
}

export async function setMailMessageLabel(
  db: D1Database, ownerId: string, labelId: string, target: LabelTarget, enabled: boolean
): Promise<MailUserLabel[]> {
  if (!validLabelTarget(target)) {
    throw new ApiError(400, 'INVALID_LABEL_TARGET', '邮件标识无效。');
  }
  await requireMailLabel(db, ownerId, labelId);
  const table = target.kind === 'inbound' ? 'email_messages' : target.kind === 'draft' ? 'workspace_drafts' : 'workspace_messages';
  const ownerColumn = target.kind === 'inbound' ? 'owner_user_id' : 'user_id';
  const available = target.kind === 'inbound'
    ? `NOT EXISTS (SELECT 1 FROM workspace_email_states AS state
        WHERE state.user_id = ? AND state.email_message_id = ${table}.id AND state.deleted_at IS NOT NULL)`
    : 'deleted_at IS NULL';
  const owned = await db.prepare(`SELECT id FROM ${table} WHERE ${ownerColumn} = ? AND id = ? AND ${available}`)
    .bind(ownerId, target.id, ...(target.kind === 'inbound' ? [ownerId] : [])).first<{ id: string }>();
  if (!owned) throw new ApiError(404, 'MAILBOX_MESSAGE_NOT_FOUND', '邮件不存在。');
  if (enabled) {
    await db.prepare(`INSERT INTO mail_message_labels (owner_user_id, label_id, message_kind, message_id, created_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`)
      .bind(ownerId, labelId, target.kind, target.id, new Date().toISOString()).run();
  } else {
    await db.prepare(`DELETE FROM mail_message_labels WHERE owner_user_id = ? AND label_id = ? AND message_kind = ? AND message_id = ?`)
      .bind(ownerId, labelId, target.kind, target.id).run();
  }
  const rows = await db.prepare(`SELECT l.id, l.name FROM mail_message_labels AS ml
    JOIN mail_labels AS l ON l.owner_user_id = ml.owner_user_id AND l.id = ml.label_id
    WHERE ml.owner_user_id = ? AND ml.message_kind = ? AND ml.message_id = ? ORDER BY l.name_key, l.id`)
    .bind(ownerId, target.kind, target.id).all<MailUserLabel>();
  return rows.results ?? [];
}
