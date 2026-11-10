import { isValidMailboxEmail, normalizeMailboxEmail } from '$lib/domain/mail/addresses';
import { ApiError } from '$lib/server/http/api';
import { decodeListCursor, encodeListCursor } from '$lib/server/workspace/list-cursor';

export async function isBlockedSender(db: D1Database, userId: string, sender: string) {
  if (!isValidMailboxEmail(sender)) return false;
  const row = await db.prepare('SELECT 1 AS found FROM blocked_senders WHERE owner_user_id = ? AND email = ?')
    .bind(userId, normalizeMailboxEmail(sender)).first<{ found: number }>();
  return Boolean(row);
}

export async function listBlockedSenders(db: D1Database, userId: string) {
  const result = await db.prepare('SELECT email, created_at AS createdAt FROM blocked_senders WHERE owner_user_id = ? ORDER BY email')
    .bind(userId).all<{ email: string; createdAt: string }>();
  return result.results ?? [];
}

export async function addBlockedSender(db: D1Database, userId: string, value: unknown) {
  if (typeof value !== 'string' || !isValidMailboxEmail(value)) {
    throw new ApiError(400, 'INVALID_BLOCKED_SENDER', '请输入有效的发件人邮箱地址。');
  }
  const email = normalizeMailboxEmail(value);
  await db.prepare('INSERT INTO blocked_senders (owner_user_id, email, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING')
    .bind(userId, email, new Date().toISOString()).run();
  return email;
}

export async function removeBlockedSender(db: D1Database, userId: string, email: string) {
  if (!isValidMailboxEmail(email)) throw new ApiError(400, 'INVALID_BLOCKED_SENDER', '请输入有效的发件人邮箱地址。');
  await db.prepare('DELETE FROM blocked_senders WHERE owner_user_id = ? AND email = ?')
    .bind(userId, normalizeMailboxEmail(email)).run();
}

export async function listQuarantinedMail(db: D1Database, userId: string, cursorValue: string | null, direction = 'next') {
  if (!['next', 'previous'].includes(direction) || (direction === 'previous' && !cursorValue)) {
    throw new ApiError(400, 'INVALID_CURSOR', '分页游标无效，请从第一页重新读取。');
  }
  const cursor = decodeListCursor(cursorValue, 'quarantine', userId);
  const previous = direction === 'previous';
  const limit = 20;
  const rows = await db.prepare(`
    SELECT e.id, e."from" AS sender, e.subject, e."timestamp" AS timestamp, s.quarantined_at AS quarantinedAt
    FROM workspace_email_states AS s JOIN email_messages AS e ON e.id = s.email_message_id
    WHERE s.user_id = ? AND e.owner_user_id = ? AND s.quarantined_at IS NOT NULL AND s.deleted_at IS NULL
      ${cursor ? `AND (s.quarantined_at, s.email_message_id) ${previous ? '>' : '<'} (?, ?)` : ''}
    ORDER BY s.quarantined_at ${previous ? 'ASC' : 'DESC'}, s.email_message_id ${previous ? 'ASC' : 'DESC'} LIMIT ?
  `).bind(userId, userId, ...(cursor ? [cursor.timestamp, cursor.id] : []), limit + 1)
    .all<{ id: string; sender: string; subject: string; timestamp: string; quarantinedAt: string }>();
  const fetched = rows.results ?? [];
  const items = fetched.slice(0, limit);
  if (previous) items.reverse();
  const first = items[0];
  const last = items.at(-1);
  const encode = (item: NonNullable<typeof first>) => encodeListCursor({ scope: 'quarantine', owner: userId, timestamp: item.quarantinedAt, id: item.id });
  return {
    items,
    previousCursor: first && (previous ? fetched.length > limit : Boolean(cursor)) ? encode(first) : null,
    nextCursor: last && (previous || fetched.length > limit) ? encode(last) : null
  };
}

export async function releaseQuarantinedMail(db: D1Database, userId: string, id: string) {
  const result = await db.prepare(`
    UPDATE workspace_email_states SET quarantined_at = NULL, archived_at = NULL, updated_at = ?
    WHERE user_id = ? AND email_message_id = ? AND quarantined_at IS NOT NULL AND deleted_at IS NULL
      AND EXISTS (SELECT 1 FROM email_messages WHERE id = ? AND owner_user_id = ?)
  `).bind(new Date().toISOString(), userId, id, id, userId).run();
  if (!result.meta?.changes) throw new ApiError(404, 'QUARANTINE_MESSAGE_NOT_FOUND', '隔离邮件不存在。');
}
