import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { GET, POST, DELETE } from './+server';
import { GET as QUARANTINE } from '../quarantine/+server';
import { GET as LEGACY_MESSAGES } from '../../messages/+server';
import { POST as RELEASE } from '../quarantine/[id]/+server';

class Statement {
  private values: SQLQueryBindings[] = [];
  constructor(private db: Database, private sql: string) {}
  bind(...values: unknown[]) { this.values = values as SQLQueryBindings[]; return this as unknown as D1PreparedStatement; }
  async first<T>() { return this.db.query(this.sql).get(...this.values) as T | null; }
  async all<T>() { return { results: this.db.query(this.sql).all(...this.values) as T[] }; }
  async run() { const result = this.db.query(this.sql).run(...this.values); return { meta: { changes: Number(result.changes) } }; }
}

function fixture() {
  const db = new Database(':memory:');
  db.exec(readFileSync(new URL('../../../../../schema.sql', import.meta.url), 'utf8'));
  const env = { DB: { prepare: (sql: string) => new Statement(db, sql) as unknown as D1PreparedStatement } };
  function event(method: string, body?: unknown, userId = 'owner') {
    const url = new URL('https://flaremail.test/api/workspace/blocked-senders');
    return {
      url, params: { id: 'message-1' }, platform: { env },
      locals: { workspaceSession: userId ? { userId, storage: 'd1' } : null },
      request: new Request(url, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) })
    } as never;
  }
  return { db, event };
}

describe('blocked sender and quarantine APIs', () => {
  test('require a session and validate input', async () => {
    const { db, event } = fixture();
    expect((await GET(event('GET', undefined, ''))).status).toBe(401);
    expect((await POST(event('POST', { email: 'invalid' }))).status).toBe(400);
    expect((await QUARANTINE(event('GET', undefined, ''))).status).toBe(401);
    const invalid = event('GET') as unknown as { url: URL };
    invalid.url.searchParams.set('direction', 'invalid');
    expect((await QUARANTINE(invalid as never)).status).toBe(400);
    expect((await RELEASE(event('POST', undefined, ''))).status).toBe(401);
    db.close();
  });

  test('manages owner-scoped rules and releases only owned quarantine', async () => {
    const { db, event } = fixture();
    expect((await POST(event('POST', { email: ' Sender@Example.com ' }))).status).toBe(200);
    expect((await GET(event('GET'))).status).toBe(200);
    expect(await (await GET(event('GET', undefined, 'other'))).json()).toMatchObject({ data: { senders: [] } });
    db.exec(`INSERT INTO email_messages (id, owner_user_id, "from", "to", subject, "timestamp", raw_key)
      VALUES ('message-1', 'owner', 'sender@example.com', 'owner@example.com', 'test', '2026-11-01T00:00:00.000Z', 'raw');
      INSERT INTO workspace_email_states (id, user_id, email_message_id, quarantined_at)
      VALUES ('state-1', 'owner', 'message-1', '2026-11-01T00:00:00.000Z');`);
    expect((await RELEASE(event('POST', undefined, 'other'))).status).toBe(404);
    expect(await (await LEGACY_MESSAGES(event('GET'))).json()).toMatchObject({ messages: [] });
    expect(await (await QUARANTINE(event('GET'))).json()).toMatchObject({ data: { items: [{ id: 'message-1' }] } });
    expect((await RELEASE(event('POST'))).status).toBe(200);
    expect(await (await LEGACY_MESSAGES(event('GET'))).json()).toMatchObject({ messages: [{ id: 'message-1' }] });
    expect(await (await QUARANTINE(event('GET'))).json()).toMatchObject({ data: { items: [] } });
    expect((await DELETE(event('DELETE', { email: 'sender@example.com' }))).status).toBe(200);
    expect(await (await GET(event('GET'))).json()).toMatchObject({ data: { senders: [] } });
    db.close();
  });
});
