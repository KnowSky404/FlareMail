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

describe('Telegram settings API', () => {
  test('returns deployment/user status with no-store and no cross-user identifier', async () => {
    const { event } = fixture();
    const response = await GET(event);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    const payload = await response.json() as { data: { globalEnabled: boolean; schemaReady: boolean; userBound: boolean; binding: unknown } };
    expect(payload.data).toMatchObject({ globalEnabled: false, schemaReady: true, userBound: false, binding: null });
    expect(JSON.stringify(payload)).not.toContain('chat');
  });
});
