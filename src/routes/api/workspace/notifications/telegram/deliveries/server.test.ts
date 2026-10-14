import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { FLAREMAIL_SCHEMA_VERSION } from '$lib/server/db/schema-version';
import { GET } from './+server';
import type { WorkspaceContext } from '$lib/server/workspace/shared';

class Statement {
  private values: unknown[] = [];
  constructor(private readonly db: Database, private readonly sql: string) {}
  bind(...values: unknown[]) { this.values = values; return this as unknown as D1PreparedStatement; }
  first<T>() { return Promise.resolve((this.db.query(this.sql).get(...this.values as never[]) as T | null) ?? null); }
  all<T>() { return Promise.resolve({ success: true, results: this.db.query(this.sql).all(...this.values as never[]) as T[] }); }
  run<T>() { const result = this.db.query(this.sql).run(...this.values as never[]); return Promise.resolve({ success: true, results: [] as T[], meta: { changes: Number(result.changes ?? 0) } }); }
}

class D1 {
  constructor(readonly db: Database) {}
  prepare(sql: string) { return new Statement(this.db, sql) as unknown as D1PreparedStatement; }
}

const session: WorkspaceContext = {
  id: 'session-1', userId: 'user-1', storage: 'd1', incomingSequence: 0,
  createdAt: '', updatedAt: '',
  profile: { name: 'Owner', role: '', email: 'owner@example.test', company: '', location: '', timezone: 'UTC', forwardingEnabled: false, signature: '' }
};

function fixture() {
  const db = new Database(':memory:');
  db.exec(readFileSync(new URL('../../../../../../../schema.sql', import.meta.url), 'utf8'));
  db.query(`INSERT INTO workspace_schema_metadata (schema_name, schema_version, updated_at)
    VALUES ('flaremail', ?, '2026-09-09T00:00:00.000Z')`).run(FLAREMAIL_SCHEMA_VERSION);
  const DB = new D1(db);
  const event = {
    request: new Request('https://mail.example.test/api/workspace/notifications/telegram/settings'),
    url: new URL('https://mail.example.test/api/workspace/notifications/telegram/settings'),
    params: {},
    locals: { workspaceSession: session },
    platform: { env: { DB, BUCKET: {}, TELEGRAM_ENABLED: 'false', APP_ENV: 'test', OUTBOUND_PROVIDER: 'demo', ALLOW_FAKE_SERVICES: 'true' } }
  };
  return { db, event: event as never };
}

describe('Telegram history API', () => {
  test('returns bounded owned pages with cursor metadata and authenticated error paths', async () => {
    const { db, event } = fixture();
    const typed = event as unknown as { url: URL; locals: { workspaceSession?: WorkspaceContext }; platform: { env: { DB?: D1 } } };
    for (const [id, owner] of [['one', 'user-1'], ['two', 'user-1'], ['foreign', 'user-2']]) {
      db.query(`INSERT INTO email_messages (id, owner_user_id, "from", "to", "timestamp", raw_key) VALUES (?, ?, 'sender@example.test', 'owner@example.test', '2026-09-09T00:00:00Z', '')`).run(id!, owner!);
      db.query(`INSERT INTO workspace_telegram_deliveries (id, owner_user_id, email_message_id, binding_id, authorization_version, status, next_attempt_at, created_at, updated_at) VALUES (?, ?, ?, 'binding', 1, 'sent', '2026-09-09T00:00:00Z', '2026-09-09T00:00:00Z', '2026-09-09T00:00:00Z')`).run(id!, owner!, id!);
    }
    typed.url = new URL('https://mail.example.test/api/workspace/notifications/telegram/deliveries?limit=1');
    const first = await GET(event);
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toContain('no-store');
    const { data } = await first.json() as { data: { nextCursor: string; hasMore: boolean; deliveries: Array<{ id: string }> } };
    expect(data.deliveries.map((row) => row.id)).toEqual(['two']);
    expect(data.hasMore).toBe(true);
    typed.url.searchParams.set('cursor', data.nextCursor);
    const second = await GET(event);
    const next = await second.json() as { data: { nextCursor: null; hasMore: boolean; deliveries: Array<{ id: string }> } };
    expect(next.data.deliveries.map((row) => row.id)).toEqual(['one']);
    expect(next.data.hasMore).toBe(false); expect(next.data.nextCursor).toBeNull();
    typed.url.searchParams.set('cursor', 'bad');
    expect((await GET(event)).status).toBe(400);
    typed.url.searchParams.delete('cursor'); typed.url.searchParams.set('limit', '51');
    expect((await GET(event)).status).toBe(400);
    typed.url.searchParams.set('limit', '1');
    typed.locals.workspaceSession = undefined;
    expect((await GET(event)).status).toBe(401);
    typed.locals.workspaceSession = session; typed.platform.env.DB = undefined;
    expect((await GET(event)).status).toBe(503);
    db.close();
  });
});
