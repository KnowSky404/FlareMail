import type {
  DeliveryAttentionAction, DeliveryAttentionItem, DeliveryAttentionKind,
  DeliveryAttentionNotice, DeliveryAttentionPage, DeliveryAttentionState, DeliveryAttentionSummary
} from '$lib/domain/mail';
import { ApiError } from '$lib/server/http/api';
import { decodeListCursor, encodeListCursor } from '$lib/server/workspace/list-cursor';

const now = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
const visible = `m.folder = 'sent' AND m.deleted_at IS NULL`;
const messageJoin = `JOIN workspace_messages m ON m.id = a.message_id AND m.user_id = a.user_id AND ${visible}`;

// During retry the previous incident stays actionable until the new attempt itself stalls.
const replacingRetry = (alias: string) => `
  SELECT stale.eligible_at FROM workspace_delivery_attention stale INDEXED BY workspace_delivery_attention_message
  WHERE stale.message_id = ${alias}.message_id AND stale.user_id = ${alias}.user_id
    AND stale.closed_at IS NULL AND stale.eligible_at <= ${now}
    AND (stale.kind = 'stale_submitting' OR (${alias}.delayed_provider_message_id IS NOT NULL
      AND stale.kind IN ('delayed', 'failed') AND stale.delayed_provider_message_id IS NULL))
    AND stale.attempt_number > ${alias}.attempt_number ORDER BY stale.attempt_number LIMIT 1`;
const active = (alias: string) => `${alias}.closed_at IS NULL AND ${alias}.eligible_at <= ${now}
  AND NOT EXISTS (${replacingRetry(alias)})`;
const itemColumns = `a.id, a.version, a.message_id AS messageId, a.kind, a.state,
  a.eligible_at AS occurredAt, a.acknowledged_at AS acknowledgedAt, a.closed_at AS closedAt`;

const pending = `a.state = 'open' AND ${active('a')}`;

export const pendingDeliveryAttentionMessageIds = `SELECT DISTINCT a.message_id
  FROM workspace_delivery_attention a INDEXED BY workspace_delivery_attention_pending
  WHERE a.user_id = ? AND ${pending}`;

export function pendingDeliveryAttentionPredicate(messageAlias: string) {
  return `EXISTS (SELECT 1 FROM workspace_delivery_attention a INDEXED BY workspace_delivery_attention_message
    WHERE a.message_id = ${messageAlias}.id AND a.user_id = ${messageAlias}.user_id AND ${pending})`;
}

type SummaryRow = { pendingCount: number; version: number; asOf: string };

function summaryStatement(db: D1Database, userId: string, includeChanges = false) {
  return db.prepare(`SELECT COUNT(*) AS pendingCount, COALESCE(MAX(a.version), 0) AS version, ${now} AS asOf
    ${includeChanges ? ', changes() AS changed' : ''}
    FROM workspace_delivery_attention a ${messageJoin}
    WHERE a.user_id = ? AND a.state = 'open' AND ${active('a')}`).bind(userId);
}

function summary(row: SummaryRow): DeliveryAttentionSummary {
  return { pendingCount: row.pendingCount, snapshot: { version: row.version, asOf: row.asOf } };
}

export async function getDeliveryAttentionSummary(db: D1Database, userId: string) {
  return summary((await summaryStatement(db, userId).first<SummaryRow>())!);
}

export function currentDeliveryAttentionStatement(db: D1Database, userId: string, messageId: string) {
  return db.prepare(`SELECT ${itemColumns} FROM workspace_delivery_attention a INDEXED BY workspace_delivery_attention_message ${messageJoin}
    WHERE a.message_id = ? AND a.user_id = ? AND ${active('a')} LIMIT 1`)
    .bind(messageId, userId);
}

export async function findCurrentDeliveryAttention(db: D1Database, userId: string, messageId: string) {
  return currentDeliveryAttentionStatement(db, userId, messageId).first<DeliveryAttentionItem>();
}

export async function listDeliveryAttention(db: D1Database, userId: string, query: {
  view: 'pending' | 'history';
  kind: DeliveryAttentionKind | null;
  cursor: string | null;
  limit: number;
}): Promise<DeliveryAttentionPage> {
  const { view, kind, limit } = query;
  const context = `${view}:${kind ?? 'all'}`;
  const cursor = decodeListCursor(query.cursor, 'attention', userId, context);
  if (cursor && (!/^\d{1,16}$/u.test(cursor.id) || !Number.isSafeInteger(Number(cursor.id)))) {
    throw new ApiError(400, 'INVALID_CURSOR', '分页游标无效，请从第一页重新读取。');
  }
  const pending = view === 'pending';
  const shadowed = `EXISTS (${replacingRetry('a')})`;
  const columns = pending ? itemColumns : `a.id, a.version, a.message_id AS messageId, a.kind, a.eligible_at AS occurredAt,
    a.acknowledged_at AS acknowledgedAt,
    CASE WHEN a.closed_at IS NULL AND ${shadowed} THEN 'superseded' ELSE a.state END AS state,
    COALESCE(a.closed_at, (${replacingRetry('a')})) AS closedAt`;
  const items = db.prepare(`SELECT ${columns}, substr(m.subject, 1, 240) AS subject, substr(m.from_email, 1, 254) AS sender
    FROM workspace_delivery_attention a ${messageJoin}
    WHERE a.user_id = ?
      AND ${pending ? `a.state = 'open' AND ${active('a')}`
        : `a.eligible_at <= ${now} AND (a.state <> 'open' OR ${shadowed})`}
      ${kind ? 'AND a.kind = ?' : ''}
      ${cursor ? 'AND (a.eligible_at, a.id) < (?, ?)' : ''}
    ORDER BY a.eligible_at DESC, a.id DESC LIMIT ?`)
    .bind(userId, ...(kind ? [kind] : []), ...(cursor ? [cursor.timestamp, Number(cursor.id)] : []), limit + 1);
  const [page, count] = await db.batch([items, summaryStatement(db, userId)]);
  const notices = (page.results as DeliveryAttentionNotice[]).slice(0, limit);
  const last = notices.at(-1);
  return {
    notices,
    nextCursor: last && page.results.length > limit
      ? encodeListCursor({ scope: 'attention', context, owner: userId, timestamp: last.occurredAt, id: String(last.id) })
      : null,
    summary: summary(count.results[0] as SummaryRow)
  };
}

export async function changeDeliveryAttention(db: D1Database, userId: string, action: DeliveryAttentionAction) {
  const acknowledge = `SET state = 'acknowledged', acknowledged_at = ${now}`;
  if (action.action === 'acknowledge_all') {
    const update = db.prepare(`UPDATE workspace_delivery_attention ${acknowledge} WHERE id IN (
      SELECT a.id FROM workspace_delivery_attention a ${messageJoin}
      WHERE a.user_id = ?1 AND a.state = 'open' AND ${active('a')}
        AND a.version <= ?2 AND a.eligible_at <= ?3 AND ?3 <= ${now})`)
      .bind(userId, action.snapshot.version, action.snapshot.asOf);
    const [, count] = await db.batch([update, summaryStatement(db, userId, true)]);
    const row = count.results[0] as SummaryRow & { changed: number };
    const current = summary(row);
    if (action.snapshot.asOf > current.snapshot.asOf) {
      throw new ApiError(400, 'INVALID_ATTENTION_REQUEST', '投递异常参数无效。');
    }
    return { changed: row.changed, summary: current };
  }
  const { id, version } = action.incident;
  const reopening = action.action === 'reopen';
  const update = db.prepare(`UPDATE workspace_delivery_attention
    ${reopening ? "SET state = 'open'" : acknowledge} WHERE id IN (
      SELECT a.id FROM workspace_delivery_attention a ${messageJoin}
      WHERE a.id = ? AND a.user_id = ? AND a.version = ? AND a.state = ? AND ${active('a')}) RETURNING id`)
    .bind(id, userId, version, reopening ? 'acknowledged' : 'open');
  const find = db.prepare(`SELECT a.version, a.state, CASE WHEN ${active('a')} THEN 1 ELSE 0 END AS active
    FROM workspace_delivery_attention a ${messageJoin} WHERE a.id = ? AND a.user_id = ?`).bind(id, userId);
  const [result, selected, count] = await db.batch([update, find, summaryStatement(db, userId)]);
  const current = selected.results[0] as { version: number; state: DeliveryAttentionState; active: number } | undefined;
  if (!current) throw new ApiError(404, 'ATTENTION_NOT_FOUND', '没有找到这条投递异常。');
  if (!result.results.length && (reopening || !current.active || current.version !== version || current.state !== 'acknowledged')) {
    throw new ApiError(409, 'ATTENTION_CHANGED', '投递异常已发生变化，请刷新后重试。');
  }
  return { changed: result.results.length, summary: summary(count.results[0] as SummaryRow) };
}
