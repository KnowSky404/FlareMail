import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { FLAREMAIL_SCHEMA_VERSION } from '$lib/server/db/schema-version';
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
const repositoryRoot = resolve(import.meta.dir, '../../../..');
const migrationsDirectory = join(repositoryRoot, 'migrations');

function applyMigrations(database: Database) {
  for (const file of readdirSync(migrationsDirectory).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort()) {
    database.exec(readFileSync(join(migrationsDirectory, file), 'utf8'));
  }
}

async function health(database: Database) {
  return GET(event({ APP_ENV: 'test', DB: new D1(database), BUCKET: {} }));
}

describe('/api/health readiness', () => {
  test('rejects an empty or partially migrated database', async () => {
    const empty = new Database(':memory:');
    expect((await GET(event({ APP_ENV: 'test', DB: new D1(empty) }))).status).toBe(503);
    const partial = new Database(':memory:');
    partial.exec(readFileSync(new URL('../../../../schema.sql', import.meta.url), 'utf8'));
    expect((await GET(event({ APP_ENV: 'test', DB: new D1(partial) }))).status).toBe(503);
  });

  test('accepts the schema produced by all ordered migrations', async () => {
    const database = new Database(':memory:');
    applyMigrations(database);
    const response = await health(database);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expect.objectContaining({ ok: true, version: 'development' }));
    expect((database.query(`SELECT schema_version FROM workspace_schema_metadata WHERE schema_name = 'flaremail'`).get() as { schema_version: number }).schema_version)
      .toBe(FLAREMAIL_SCHEMA_VERSION);
  });

  test.each([FLAREMAIL_SCHEMA_VERSION - 1, FLAREMAIL_SCHEMA_VERSION + 1])(
    'rejects schema version %i',
    async (schemaVersion) => {
      const database = new Database(':memory:');
      applyMigrations(database);
      database.query(`UPDATE workspace_schema_metadata SET schema_version = ? WHERE schema_name = 'flaremail'`).run(schemaVersion);
      expect((await health(database)).status).toBe(503);
    }
  );

  test('rejects missing metadata and missing required tables without leaking details', async () => {
    for (const statement of [
      'DELETE FROM workspace_schema_metadata',
      'DROP TABLE workspace_delivery_attempts'
    ]) {
      const database = new Database(':memory:');
      applyMigrations(database);
      database.exec(statement);
      const response = await health(database);
      expect(response.status).toBe(503);
      const body = await response.json() as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(['ok', 'timestamp', 'version']);
      expect(JSON.stringify(body).toLowerCase()).not.toContain('sqlite');
      database.close();
    }
  });

  test('returns 503 without D1 and does not expose schema details', async () => {
    const response = await GET(event({ APP_ENV: 'test' }));
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain('sqlite');
  });
});
