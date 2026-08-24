export type BodyEntityType = 'email_message' | 'workspace_message' | 'draft';

export interface BodyObjectRow {
  id: string;
  owner_user_id: string | null;
  entity_type: BodyEntityType;
  entity_id: string;
  r2_key: string;
  size_bytes: number;
  sha256: string;
  text_bytes: number;
  html_bytes: number;
  state: 'active' | 'delete_pending' | 'deleted';
  created_at: string;
  updated_at: string;
  delete_after: string | null;
}

export function insertBodyObject(db: D1Database, object: Omit<BodyObjectRow, 'created_at' | 'updated_at' | 'delete_after' | 'state'> & { createdAt: string }) {
  return db.prepare(`
    INSERT INTO mail_body_objects (id, owner_user_id, entity_type, entity_id, r2_key, size_bytes, sha256, text_bytes, html_bytes, state, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
  `).bind(object.id, object.owner_user_id, object.entity_type, object.entity_id, object.r2_key, object.size_bytes, object.sha256,
    object.text_bytes, object.html_bytes, object.createdAt, object.createdAt);
}

export async function findBodyObject(db: D1Database, id: string, userId?: string, entityType?: BodyEntityType, entityId?: string) {
  const conditions = ['id = ?', "state = 'active'"];
  const values: unknown[] = [id];
  if (userId) { conditions.push('owner_user_id = ?'); values.push(userId); }
  if (entityType) { conditions.push('entity_type = ?'); values.push(entityType); }
  if (entityId) { conditions.push('entity_id = ?'); values.push(entityId); }
  return db.prepare(`SELECT id, owner_user_id, entity_type, entity_id, r2_key, size_bytes, sha256, text_bytes, html_bytes, state, created_at, updated_at, delete_after FROM mail_body_objects WHERE ${conditions.join(' AND ')}`)
    .bind(...values).first<BodyObjectRow>();
}

export function markBodyObjectDeletePending(db: D1Database, id: string, deleteAfter: string, updatedAt: string) {
  return db.prepare(`UPDATE mail_body_objects SET state = 'delete_pending', delete_after = ?, updated_at = ? WHERE id = ? AND state = 'active'`)
    .bind(deleteAfter, updatedAt, id);
}

export function deleteBodyObjectRow(db: D1Database, id: string) {
  return db.prepare(`DELETE FROM mail_body_objects WHERE id = ?`).bind(id);
}
