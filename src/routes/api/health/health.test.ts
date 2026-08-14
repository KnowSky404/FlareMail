import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { GET } from './+server';

class Statement {
  private values: SQLQueryBindings[] = [];
  constructor(private readonly db: Database, private readonly sql: string) {}
  bind(...values: unknown[]) { this.values = values as SQLQueryBindings[]; return this as unknown as D1PreparedStatement; }
  async all<T>() { return { results: this.db.query(this.sql).all(...this.values) as T[] }; }
  async first<T>() { return (this.db.query(this.sql).get(...this.values) as T | null) ?? null; }
}

class D1 {
  constructor(readonly db: Database) {}
  prepare(sql: string) { return new Statement(this.db, sql) as unknown as D1PreparedStatement; }
}

const event = (env: unknown) => ({ platform: { env } }) as never;

describe('/api/health readiness', () => {
  test('rejects an empty or partially migrated database', async () => {
    const empty = new Database(':memory:');
    expect((await GET(event({ APP_ENV: 'test', DB: new D1(empty) }))).status).toBe(503);
    const partial = new Database(':memory:');
    partial.exec(readFileSync(new URL('../../../../schema.sql', import.meta.url), 'utf8'));
    expect((await GET(event({ APP_ENV: 'test', DB: new D1(partial) }))).status).toBe(503);
  });

  test('accepts the latest schema only when project metadata is present', async () => {
    const database = new Database(':memory:');
    database.exec(readFileSync(new URL('../../../../schema.sql', import.meta.url), 'utf8'));
    database.query(`INSERT INTO workspace_schema_metadata (schema_name, schema_version, updated_at) VALUES ('flaremail', 9, '2026-08-14T00:00:00.000Z')`).run();
    const response = await GET(event({ APP_ENV: 'test', DB: new D1(database), BUCKET: {} }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expect.objectContaining({ ok: true }));
  });

  test('returns 503 without D1 and does not expose schema details', async () => {
    const response = await GET(event({ APP_ENV: 'test' }));
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain('sqlite');
  });
});
