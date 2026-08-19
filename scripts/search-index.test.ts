import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  parseSearchIndexArgs,
  prepareSearchExportSql,
  rebuildSearchIndexSql,
  restoreSearchExportSql,
  verifySearchIndexSql
} from './search-index';

describe('search index operations', () => {
  test('defaults to read-only local verification and gates mutations', () => {
    expect(parseSearchIndexArgs([])).toMatchObject({ mode: 'verify', remote: false, apply: false, config: 'wrangler.toml' });
    expect(() => parseSearchIndexArgs(['--mode', 'rebuild'])).toThrow('requires explicit --apply');
    expect(parseSearchIndexArgs(['--mode', 'rebuild', '--remote', '--apply'])).toMatchObject({
      mode: 'rebuild', remote: true, apply: true, config: 'wrangler.deploy.toml'
    });
  });

  test('repairs projections and recreates the export-safe virtual layer', () => {
    const db = new Database(':memory:');
    db.exec(readFileSync(resolve(import.meta.dir, '../schema.sql'), 'utf8'));
    db.exec(`INSERT INTO workspace_messages
      (id, user_id, folder, from_name, from_email, to_name, to_email, subject, preview, body, sent_at)
      VALUES ('message-1', 'user-1', 'sent', 'Alice', 'alice@example.test', 'Bob', 'bob@example.test', 'Repair target', '', 'searchable body', '2026-08-19T00:00:00.000Z');`);
    db.exec(`DELETE FROM workspace_search_documents WHERE entity_kind = 'message' AND entity_id = 'message-1';`);
    const before = db.query(verifySearchIndexSql).get() as Record<string, number>;
    expect(before.missing_documents).toBe(1);
    db.exec(rebuildSearchIndexSql);
    expect(db.query(`SELECT rowid FROM workspace_search_fts WHERE workspace_search_fts MATCH 'searchable'`).all()).toHaveLength(1);
    db.exec(prepareSearchExportSql);
    expect(db.query(`SELECT name FROM sqlite_master WHERE name = 'workspace_search_fts'`).get()).toBeNull();
    expect(db.query(`SELECT COUNT(*) AS count FROM workspace_search_documents`).get()).toEqual({ count: 1 });
    db.exec(restoreSearchExportSql);
    expect(db.query(`SELECT rowid FROM workspace_search_fts WHERE workspace_search_fts MATCH 'searchable'`).all()).toHaveLength(1);
  });
});
