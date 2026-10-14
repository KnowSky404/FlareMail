import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { GET, POST } from './+server';
import { DELETE as PERMANENT_DELETE, POST as RESTORE } from './[id]/+server';
import { DELETE as MOVE } from '../messages/[id]/+server';
import type { WorkspaceContext } from '$lib/server/workspace/shared';

class Statement {
  private values: SQLQueryBindings[] = [];
  constructor(private readonly db: Database, private readonly sql: string) {}
  bind(...values: unknown[]) { this.values = values as SQLQueryBindings[]; return this as unknown as D1PreparedStatement; }
  async first<T>() { return (this.db.query(this.sql).get(...this.values) as T | null) ?? null; }
  async all<T>() { return { results: this.db.query(this.sql).all(...this.values) as T[] }; }
  async run() { const result = this.db.query(this.sql).run(...this.values); return { meta: { changes: Number(result.changes) } }; }
}
class D1 {
  constructor(readonly db: Database) {}
  prepare(sql: string) { return new Statement(this.db, sql) as unknown as D1PreparedStatement; }
  async batch(statements: D1PreparedStatement[]) { for (const statement of statements) await (statement as unknown as Statement).run(); return []; }
}
class Bucket { readonly objects = new Set<string>(); async delete(key: string) { this.objects.delete(key); } }

const databases: Database[] = [];
const session: WorkspaceContext = { id: 'session', userId: 'user-1', storage: 'd1', incomingSequence: 0, createdAt: '', updatedAt: '', profile: { name: 'User', role: '', email: 'user@example.test', company: '', location: '', timezone: 'UTC', forwardingEnabled: false, signature: '' } };

function event(method: string, path: string, env: { DB: D1; BUCKET: Bucket }, body?: unknown) {
  const id = path.includes('/trash/') || path.includes('/messages/') ? path.slice(path.lastIndexOf('/') + 1) : undefined;
  return {
    request: new Request(`https://flaremail.test${path}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }),
    url: new URL(`https://flaremail.test${path}`),
    params: id ? { id } : {},
    locals: { workspaceSession: session },
    platform: { env }
  } as never;
}

function fixture() {
  const db = new Database(':memory:'); databases.push(db); db.exec(readFileSync(resolve(import.meta.dir, '../../../../../schema.sql'), 'utf8'));
  db.query(`INSERT INTO workspace_messages (id, user_id, folder, from_name, from_email, to_name, to_email, subject, preview, body, sent_at, deleted_at) VALUES ('m-1', 'user-1', 'sent', 'User', 'user@example.test', 'Bob', 'bob@example.test', 'Subject', 'Preview', 'Body', '2026-08-19T00:00:00Z', '2026-08-19T01:00:00Z')`).run();
  const DB = new D1(db); const BUCKET = new Bucket(); return { db, env: { DB, BUCKET } };
}

afterEach(() => { while (databases.length) databases.pop()?.close(); });

describe('trash API', () => {
  test('lists, restores and permanently deletes through typed endpoints', async () => {
    const { db, env } = fixture();
    const listed = await GET(event('GET', '/api/workspace/trash', env));
    expect(listed.status).toBe(200);
    expect((await listed.json() as { data: { items: Array<{ id: string }> } }).data.items[0]?.id).toBe('m-1');

    const restored = await RESTORE(event('POST', '/api/workspace/trash/m-1', env));
    expect(restored.status).toBe(200);
    expect(db.query(`SELECT deleted_at FROM workspace_messages WHERE id = 'm-1'`).get()).toEqual({ deleted_at: null });
    expect((await MOVE(event('DELETE', '/api/workspace/messages/m-1', env))).status).toBe(200);
    expect((await PERMANENT_DELETE(event('DELETE', '/api/workspace/trash/m-1', env))).status).toBe(200);
    expect(db.query(`SELECT COUNT(*) AS count FROM workspace_messages WHERE id = 'm-1'`).get()).toEqual({ count: 0 });
    expect((await POST(event('POST', '/api/workspace/trash', env, { action: 'empty' }))).status).toBe(200);
  });
});

test('paginates more than 500 mixed trash records without gaps, including tied timestamps and IDs', async () => {
  const { db, env } = fixture();
  db.query('DELETE FROM workspace_messages').run();
  const time = '2026-08-19T01:00:00.000Z';
  const workspace = db.query(`INSERT INTO workspace_messages (id, user_id, folder, from_name, from_email, to_name, to_email, subject, preview, body, sent_at, deleted_at) VALUES (?, 'user-1', 'sent', 'User', 'user@example.test', 'Bob', 'bob@example.test', 'Subject', 'Preview', '', ?, ?)`);
  const draft = db.query(`INSERT INTO workspace_drafts (id, user_id, to_email, subject, body, created_at, updated_at, deleted_at) VALUES (?, 'user-1', 'bob@example.test', 'Draft', '', ?, ?, ?)`);
  const inbound = db.query(`INSERT INTO email_messages (id, owner_user_id, "from", "to", "timestamp", raw_key) VALUES (?, 'user-1', 'bob@example.test', 'user@example.test', ?, '')`);
  const state = db.query(`INSERT INTO workspace_email_states (id, user_id, email_message_id, deleted_at) VALUES (?, 'user-1', ?, ?)`);
  for (let i = 0; i < 201; i++) {
    const id = `item-${String(i).padStart(4, '0')}`;
    workspace.run(id, time, time); draft.run(id, time, time, time); inbound.run(id, time); state.run(`state-${id}`, id, time);
  }
  workspace.run('foreign', time, time);
  db.query(`UPDATE workspace_messages SET user_id = 'other-owner' WHERE id = 'foreign'`).run();
  const keys: string[] = [];
  let cursor: string | null = null;
  do {
    const response = await GET(event('GET', `/api/workspace/trash?limit=40${cursor ? `&cursor=${cursor}` : ''}`, env));
    expect(response.status).toBe(200);
    const { data } = await response.json() as { data: { items: Array<{ kind: string; id: string }>; nextCursor: string | null; hasMore: boolean } };
    expect(data.items.length).toBeLessThanOrEqual(40);
    keys.push(...data.items.map((item) => `${item.kind}:${item.id}`));
    expect(data.hasMore).toBe(data.nextCursor !== null);
    cursor = data.nextCursor;
  } while (cursor);
  expect(keys).toHaveLength(603);
  expect(new Set(keys).size).toBe(603);
  expect(keys.some((key) => key.includes('foreign'))).toBe(false);
});

test('trash cursor survives deletion of its boundary and rejects invalid and foreign cursors', async () => {
  const { db, env } = fixture();
  db.query(`INSERT INTO workspace_messages (id, user_id, folder, from_name, from_email, to_name, to_email, subject, preview, body, sent_at, deleted_at) VALUES ('m-0', 'user-1', 'sent', 'User', 'user@example.test', 'Bob', 'bob@example.test', '', '', '', '2026-08-19T00:00:00Z', '2026-08-19T01:00:00Z')`).run();
  const response = await GET(event('GET', '/api/workspace/trash?limit=1', env));
  const { data } = await response.json() as { data: { nextCursor: string } };
  db.query(`DELETE FROM workspace_messages WHERE id = 'm-1'`).run();
  const next = await GET(event('GET', `/api/workspace/trash?limit=1&cursor=${data.nextCursor}`, env));
  expect(next.status).toBe(200);
  expect((await next.json() as { data: { items: Array<{ id: string }> } }).data.items[0]?.id).toBe('m-0');
  expect((await GET(event('GET', '/api/workspace/trash?cursor=invalid', env))).status).toBe(400);
  const foreign = event('GET', `/api/workspace/trash?cursor=${data.nextCursor}`, env) as { locals: { workspaceSession: WorkspaceContext } };
  foreign.locals.workspaceSession = { ...session, userId: 'other-owner' };
  expect((await GET(foreign as never)).status).toBe(400);
  expect((await GET(event('GET', '/api/workspace/trash?limit=0', env))).status).toBe(400);
  const unauthenticated = event('GET', '/api/workspace/trash', env) as { locals: Record<string, unknown> };
  unauthenticated.locals = {};
  expect((await GET(unauthenticated as never)).status).toBe(401);
});
