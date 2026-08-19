import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import type { CloudflareEnv } from '$lib/server/cloudflare';
import { FLAREMAIL_SCHEMA_VERSION } from './schema-version';
import { getWorkspaceCapabilities, hasWorkspaceCoreTables } from './capabilities';

class Statement {
  private values: SQLQueryBindings[] = [];
  constructor(private readonly database: Database, private readonly sql: string) {}
  bind(...values: unknown[]) { this.values = values as SQLQueryBindings[]; return this as unknown as D1PreparedStatement; }
  async first<T>() { return (this.database.query(this.sql).get(...this.values) as T | null) ?? null; }
}

const envFor = (database: Database) => ({
  DB: { prepare: (sql: string) => new Statement(database, sql) as unknown as D1PreparedStatement } as D1Database
}) as CloudflareEnv;

describe('workspace schema capabilities', () => {
  test('fails closed for missing and stale schema metadata', async () => {
    const missing = new Database(':memory:');
    expect(await hasWorkspaceCoreTables(envFor(missing))).toBe(false);
    expect((await getWorkspaceCapabilities(envFor(missing))).recipientArrays).toBe(false);

    const stale = new Database(':memory:');
    stale.exec('CREATE TABLE workspace_schema_metadata (schema_name TEXT PRIMARY KEY, schema_version INTEGER NOT NULL)');
    stale.query('INSERT INTO workspace_schema_metadata VALUES (?, ?)').run('flaremail', FLAREMAIL_SCHEMA_VERSION - 1);
    expect(await hasWorkspaceCoreTables(envFor(stale))).toBe(false);
  });

  test('enables capabilities only for the exact application schema', async () => {
    const current = new Database(':memory:');
    current.exec('CREATE TABLE workspace_schema_metadata (schema_name TEXT PRIMARY KEY, schema_version INTEGER NOT NULL)');
    current.query('INSERT INTO workspace_schema_metadata VALUES (?, ?)').run('flaremail', FLAREMAIL_SCHEMA_VERSION);
    expect(await hasWorkspaceCoreTables(envFor(current))).toBe(true);
    expect(await getWorkspaceCapabilities(envFor(current))).toEqual({
      drafts: true,
      inboundStates: true,
      outboundStatuses: true,
      outboundReceipts: true,
      outboundEvents: true,
      recipientArrays: true
    });
  });
});
