import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dir, '../../../..');
const migrationsDirectory = join(repositoryRoot, 'migrations');
const legacyFixture = join(repositoryRoot, 'tests/fixtures/legacy-schema.sql');
const latestSchema = join(repositoryRoot, 'schema.sql');

const migrationFiles = readdirSync(migrationsDirectory)
  .filter((file) => /^\d{4}_.+\.sql$/.test(file))
  .sort();

function applyMigrations(db: Database) {
  // Wrangler records applied migrations and executes each file once. Keeping
  // that small bit of orchestration in the test catches accidental attempts
  // to make ALTER TABLE files replayable (SQLite has no ADD COLUMN IF NOT
  // EXISTS), while still exercising every statement in the real files.
  db.exec('CREATE TABLE IF NOT EXISTS _test_migrations (name TEXT PRIMARY KEY)');
  for (const file of migrationFiles) {
    const alreadyApplied = db
      .query('SELECT 1 AS applied FROM _test_migrations WHERE name = ?')
      .get(file) as { applied?: number } | null;
    if (alreadyApplied?.applied) continue;
    db.exec(readFileSync(join(migrationsDirectory, file), 'utf8'));
    db.query('INSERT INTO _test_migrations (name) VALUES (?)').run(file);
  }
}

function applyMigrationsThrough(db: Database, lastFile: string) {
  db.exec('CREATE TABLE IF NOT EXISTS _test_migrations (name TEXT PRIMARY KEY)');
  for (const file of migrationFiles) {
    db.exec(readFileSync(join(migrationsDirectory, file), 'utf8'));
    db.query('INSERT INTO _test_migrations (name) VALUES (?)').run(file);
    if (file === lastFile) break;
  }
}

function tableColumns(db: Database, table: string) {
  return new Set(
    (db.query(`PRAGMA table_info("${table.replaceAll('"', '""')}")`).all() as Array<{ name: string }>)
      .map((column) => column.name)
  );
}

function tableCount(db: Database, table: string) {
  const row = db.query(`SELECT COUNT(*) AS count FROM "${table}"`).get() as { count: number };
  return row.count;
}

function indexNames(db: Database, table: string) {
  return new Set(
    (db.query(`PRAGMA index_list("${table}")`).all() as Array<{ name: string }>)
      .map((index) => index.name)
      .filter((name) => !name.startsWith('sqlite_'))
  );
}

function createDatabase() {
  return new Database(':memory:');
}

describe('versioned D1 migrations', () => {
  test('keeps schema.sql aligned with the versioned migration result', () => {
    const migrated = createDatabase();
    const snapshot = createDatabase();
    applyMigrations(migrated);
    snapshot.exec(readFileSync(latestSchema, 'utf8'));

    const objects = (db: Database) => (db.query(`
      SELECT type, name FROM sqlite_master
      WHERE type IN ('table', 'index')
        AND name NOT LIKE 'sqlite_%'
        AND name <> '_test_migrations'
      ORDER BY type, name
    `).all());
    expect(objects(snapshot)).toEqual(objects(migrated));

    const tables = (objects(snapshot) as Array<{ type: string; name: string }>)
      .filter(({ type }) => type === 'table')
      .map(({ name }) => name);
    for (const table of tables) {
      const columns = (db: Database) => (db.query(`PRAGMA table_info("${table}")`).all() as Array<Record<string, unknown>>)
        .map(({ cid: _cid, ...column }) => column)
        .sort((left, right) => String(left.name).localeCompare(String(right.name)));
      expect(columns(snapshot)).toEqual(columns(migrated));
    }

    const indexes = (objects(snapshot) as Array<{ type: string; name: string }>)
      .filter(({ type }) => type === 'index')
      .map(({ name }) => name);
    for (const index of indexes) {
      const columns = (db: Database) => (db.query(`PRAGMA index_info("${index}")`).all() as Array<Record<string, unknown>>)
        .map(({ cid: _cid, ...column }) => column);
      expect(columns(snapshot)).toEqual(columns(migrated));
    }
  });

  test('builds the latest schema from an empty database', () => {
    const db = createDatabase();
    applyMigrations(db);

    expect(migrationFiles).toEqual([
      '0001_baseline.sql',
      '0002_mail_contracts.sql',
      '0003_auth_and_settings.sql',
      '0004_delivery_states.sql',
      '0005_operational_indexes.sql',
      '0006_inbound_ownership.sql',
      '0007_outbound_contracts.sql',
      '0008_login_rate_limits.sql',
      '0009_inbound_ingest_claims.sql',
      '0010_mailbox_archive_and_bulk.sql',
      '0011_recipient_arrays.sql',
      '0012_body_objects.sql',
      '0013_trash.sql',
      '0014_inbound_metadata.sql',
      '0015_search_fts.sql',
      '0016_outbound_attachments.sql',
      '0017_r2_cleanup_queue_reliability.sql',
      '0018_outbound_rate_limits.sql'
    ]);

    expect(tableColumns(db, 'email_messages')).toEqual(
      new Set([
        'id', 'message_id', 'from', 'to', 'subject', 'timestamp', 'snippet', 'raw_key', 'raw_size', 'created_at',
        'in_reply_to', 'references', 'thread_key', 'direction', 'text_body', 'html_body', 'cc', 'dedupe_key',
        'provider_message_id', 'idempotency_key', 'owner_user_id', 'body_object_id', 'to_json', 'cc_json',
        'reply_to_json', 'return_path', 'delivered_to', 'headers_json', 'authentication_results_json'
      ])
    );
    expect(tableColumns(db, 'workspace_messages')).toEqual(
      new Set([
        'id', 'user_id', 'folder', 'from_name', 'from_email', 'to_name', 'to_email', 'subject', 'preview', 'body',
        'sent_at', 'labels_json', 'is_read', 'is_starred', 'created_at', 'updated_at', 'message_id', 'in_reply_to',
        'references', 'thread_key', 'direction', 'text_body', 'html_body', 'cc', 'to_json', 'cc_json', 'bcc_json', 'dedupe_key', 'provider_message_id',
        'idempotency_key', 'archived_at', 'deleted_at', 'body_object_id'
      ])
    );
    expect(tableColumns(db, 'workspace_users')).toEqual(
      new Set([
        'id', 'login_email', 'name', 'role', 'email', 'company', 'location', 'timezone', 'forwarding_enabled',
        'signature', 'incoming_sequence', 'created_at', 'updated_at', 'credential_hash', 'credential_salt',
        'credential_iterations', 'credential_updated_at'
      ])
    );
    expect(tableColumns(db, 'workspace_drafts')).toEqual(
      new Set([
        'id', 'user_id', 'to_email', 'cc', 'to_json', 'cc_json', 'bcc_json', 'subject', 'body', 'is_starred', 'created_at', 'updated_at',
        'message_id', 'in_reply_to', 'references', 'thread_key', 'idempotency_key', 'body_object_id', 'deleted_at', 'attachment_revision'
      ])
    );
    expect(tableColumns(db, 'workspace_search_documents')).toEqual(new Set([
      'id', 'user_id', 'entity_kind', 'entity_id', 'from_text', 'to_text', 'cc_text',
      'subject_text', 'body_text', 'labels_text', 'indexed_at'
    ]));
    expect(tableColumns(db, 'workspace_search_fts')).toEqual(new Set([
      'from_text', 'to_text', 'cc_text', 'subject_text', 'body_text', 'labels_text'
    ]));
    expect(tableColumns(db, 'workspace_sessions')).toEqual(
      new Set(['id', 'user_id', 'created_at', 'updated_at', 'token_hash', 'expires_at', 'revoked_at', 'last_seen_at'])
    );
    expect(tableColumns(db, 'workspace_delivery_statuses')).toEqual(
      new Set([
        'message_id', 'user_id', 'status', 'attempts', 'idempotency_key', 'provider', 'provider_message_id',
        'last_error', 'submitted_at', 'sent_at', 'delivered_at', 'last_event', 'last_event_at', 'created_at',
        'updated_at'
      ])
    );
    expect(tableColumns(db, 'workspace_delivery_attempts')).toEqual(
      new Set([
        'id', 'message_id', 'user_id', 'attempt_number', 'idempotency_key', 'provider', 'provider_message_id',
        'status', 'error', 'started_at', 'completed_at', 'created_at'
      ])
    );
    expect(tableColumns(db, 'workspace_attachments')).toEqual(
      new Set([
        'id', 'user_id', 'message_id', 'filename', 'content_type', 'size', 'inline', 'content_id', 'r2_key', 'created_at',
        'relation_type', 'state', 'sha256', 'disposition', 'updated_at', 'delete_after'
      ])
    );
    expect(tableColumns(db, 'workspace_r2_cleanup_queue')).toEqual(new Set([
      'id', 'owner_user_id', 'entity_id', 'r2_key', 'reason', 'status', 'attempt_count', 'max_attempts',
      'next_attempt_at', 'claim_token', 'lease_expires_at', 'last_error', 'completed_at', 'object_kind', 'source_id',
      'source_owner_user_id', 'source_entity_id', 'created_at', 'updated_at'
    ]));
    expect(tableColumns(db, 'workspace_settings')).toEqual(
      new Set(['user_id', 'theme', 'settings_json', 'created_at', 'updated_at'])
    );
    expect(tableColumns(db, 'workspace_login_rate_limits')).toEqual(
      new Set(['identity_hash', 'attempt_count', 'window_started_at', 'reset_at', 'updated_at'])
    );
    expect(tableColumns(db, 'workspace_outbound_rate_limits')).toEqual(
      new Set(['user_id', 'attempt_count', 'window_started_at', 'reset_at', 'updated_at'])
    );
    expect(tableColumns(db, 'workspace_inbound_ingest_claims')).toEqual(
      new Set(['dedupe_key', 'storage_id', 'claim_token', 'raw_key', 'status', 'created_at', 'updated_at', 'completed_at'])
    );
    expect(tableColumns(db, 'workspace_email_states')).toEqual(
      new Set(['id', 'user_id', 'email_message_id', 'is_read', 'is_starred', 'deleted_at', 'archived_at', 'created_at', 'updated_at'])
    );
    expect(db.query('SELECT schema_name, schema_version FROM workspace_schema_metadata').all()).toEqual([
      { schema_name: 'flaremail', schema_version: 18 }
    ]);

    expect(indexNames(db, 'email_messages')).toEqual(
      new Set([
        'idx_email_messages_timestamp', 'idx_email_messages_from', 'idx_email_messages_to',
        'idx_email_messages_message_id', 'idx_email_messages_thread_key', 'idx_email_messages_dedupe_key',
        'idx_email_messages_provider_message_id', 'idx_email_messages_recipient_cursor', 'idx_email_messages_owner_cursor'
      ])
    );
    expect(indexNames(db, 'workspace_delivery_statuses')).toEqual(
      new Set([
        'idx_workspace_delivery_statuses_idempotency_key',
        'idx_workspace_delivery_statuses_provider_message_id',
        'idx_workspace_delivery_statuses_user_status'
      ])
    );
    expect(indexNames(db, 'workspace_messages')).toContain('idx_workspace_messages_user_folder_archived');
    expect(indexNames(db, 'workspace_messages')).toContain('idx_workspace_messages_user_trash');
    expect(indexNames(db, 'workspace_email_states')).toContain('idx_workspace_email_states_user_archived');
    expect(indexNames(db, 'workspace_email_states')).toContain('idx_workspace_email_states_user_trash');
    expect(indexNames(db, 'workspace_drafts')).toContain('idx_workspace_drafts_user_trash');
    expect(indexNames(db, 'workspace_search_documents')).toContain('idx_workspace_search_documents_owner');
    expect(indexNames(db, 'workspace_attachments')).toEqual(
      new Set([
        'idx_workspace_attachments_user_message', 'idx_workspace_attachments_content_id',
        'idx_workspace_attachments_user_relation', 'idx_workspace_attachments_cleanup'
      ])
    );
    expect(tableColumns(db, 'mail_body_objects')).toEqual(new Set([
      'id', 'owner_user_id', 'entity_type', 'entity_id', 'r2_key', 'size_bytes', 'sha256',
      'text_bytes', 'html_bytes', 'state', 'created_at', 'updated_at', 'delete_after'
    ]));
    expect(indexNames(db, 'workspace_login_rate_limits')).toEqual(
      new Set(['idx_workspace_login_rate_limits_reset_at'])
    );
    expect(indexNames(db, 'workspace_outbound_rate_limits')).toEqual(
      new Set(['idx_workspace_outbound_rate_limits_reset_at'])
    );

    // The complete state CHECK and idempotency/dedupe uniqueness are real D1
    // constraints, not just names documented in a migration.
    db.query(
      `INSERT INTO workspace_delivery_statuses (message_id, user_id, status, idempotency_key)
       VALUES ('m1', 'u1', 'submitted', 'idem-1')`
    ).run();
    expect(() => db.query(
      `INSERT INTO workspace_delivery_statuses (message_id, user_id, status, idempotency_key)
       VALUES ('m2', 'u1', 'not-a-state', 'idem-2')`
    ).run()).toThrow();
    expect(() => db.query(
      `INSERT INTO workspace_delivery_statuses (message_id, user_id, status, idempotency_key)
       VALUES ('m3', 'u1', 'queued', 'idem-1')`
    ).run()).toThrow();

    db.query(
      `INSERT INTO email_messages (id, "from", "to", "timestamp", raw_key, dedupe_key)
       VALUES ('e1', 'a@example.test', 'b@example.test', '2026-08-13T00:00:00Z', 'raw/e1', 'dedupe-1')`
    ).run();
    expect(() => db.query(
      `INSERT INTO email_messages (id, "from", "to", "timestamp", raw_key, dedupe_key)
       VALUES ('e2', 'a@example.test', 'b@example.test', '2026-08-13T00:00:00Z', 'raw/e2', 'dedupe-1')`
    ).run()).toThrow();
  });

  test('quarantines unverifiable legacy cleanup rows during migration', () => {
    const db = createDatabase();
    applyMigrationsThrough(db, '0016_outbound_attachments.sql');
    db.query(`INSERT INTO workspace_r2_cleanup_queue (id, owner_user_id, entity_id, r2_key, reason, created_at, updated_at) VALUES ('legacy-job', 'owner-1', 'message-1', 'sent/att-1', 'trash_delete', '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z')`).run();
    db.exec(readFileSync(join(migrationsDirectory, '0017_r2_cleanup_queue_reliability.sql'), 'utf8'));
    expect(db.query(`SELECT status, object_kind, attempt_count, next_attempt_at, last_error FROM workspace_r2_cleanup_queue WHERE id = 'legacy-job'`).get())
      .toEqual({ status: 'manual_review', object_kind: 'legacy', attempt_count: 0, next_attempt_at: '2026-08-20T00:00:00.000Z', last_error: 'invalid_key_scope' });
  });

  test('adds the schema to a legacy database without losing rows or values', () => {
    const db = createDatabase();
    db.exec(readFileSync(legacyFixture, 'utf8'));

    const before = Object.fromEntries([
      'email_messages', 'workspace_users', 'workspace_sessions', 'workspace_messages', 'workspace_drafts',
      'workspace_email_states', 'workspace_outbound_statuses', 'workspace_outbound_receipts', 'workspace_outbound_events'
    ].map((table) => [table, tableCount(db, table)]));

    applyMigrations(db);

    for (const [table, count] of Object.entries(before)) {
      expect(tableCount(db, table)).toBe(count);
    }

    const inbound = db.query(
      `SELECT message_id, thread_key, dedupe_key, direction, text_body, html_body, owner_user_id,
        to_json, reply_to_json, headers_json, authentication_results_json
       FROM email_messages WHERE id = 'legacy-email-1'`
    ).get() as Record<string, string | null>;
    expect(inbound).toMatchObject({
      message_id: '<legacy-1@example.test>',
      thread_key: 'rfc:<legacy-1@example.test>',
      dedupe_key: 'rfc:<legacy-1@example.test>:to:admin@example.test',
      direction: 'inbound',
      text_body: 'Legacy body',
      html_body: '',
      owner_user_id: 'legacy-user-1',
      to_json: '[{"name":"","email":"admin@example.test"}]',
      reply_to_json: '[]',
      headers_json: '[]',
      authentication_results_json: '[]'
    });

    const workspaceInbound = db.query(
      `SELECT direction, text_body, thread_key, dedupe_key
       FROM workspace_messages WHERE id = 'legacy-message-1'`
    ).get() as Record<string, string>;
    expect(workspaceInbound).toMatchObject({
      direction: 'inbound', text_body: 'Legacy body', thread_key: 'legacy:legacy-message-1', dedupe_key: 'legacy:legacy-message-1'
    });

    expect(db.query(`SELECT to_json FROM workspace_messages WHERE id = 'legacy-message-2'`).get()).toEqual({
      to_json: '[{"name":"","email":"recipient@example.test"}]'
    });
    expect(db.query(`SELECT to_json FROM workspace_drafts WHERE id = 'legacy-draft-1'`).get()).toEqual({
      to_json: '[{"name":"","email":"recipient@example.test"}]'
    });
    expect(db.query(`SELECT entity_kind, entity_id FROM workspace_search_documents ORDER BY entity_kind, entity_id`).all())
      .toEqual([
        { entity_kind: 'draft', entity_id: 'legacy-draft-1' },
        { entity_kind: 'inbound', entity_id: 'legacy-email-1' },
        { entity_kind: 'message', entity_id: 'legacy-message-1' },
        { entity_kind: 'message', entity_id: 'legacy-message-2' }
      ]);
    expect(db.query(`SELECT COUNT(*) AS count FROM workspace_search_fts WHERE workspace_search_fts MATCH 'legacy'`).get())
      .toEqual({ count: 3 });

    const session = db.query(
      `SELECT token_hash, expires_at, last_seen_at FROM workspace_sessions WHERE id = 'legacy-session-1'`
    ).get() as Record<string, string | null>;
    expect(session.token_hash).toBeNull();
    expect(session.expires_at).toBe('2026-09-11 11:00:00');
    expect(session.last_seen_at).toBe('2026-08-12T11:00:00.000Z');
    expect(tableCount(db, 'workspace_settings')).toBe(1);
    expect(db.query(`SELECT theme FROM workspace_settings WHERE user_id = 'legacy-user-1'`).get()).toEqual({ theme: 'system' });

    const delivery = db.query(
      `SELECT status, attempts, provider, provider_message_id, last_event
       FROM workspace_delivery_statuses WHERE message_id = 'legacy-message-2'`
    ).get();
    expect(delivery).toEqual({ status: 'sent', attempts: 2, provider: 'legacy-provider', provider_message_id: 'provider-legacy-1', last_event: 'submission' });
    expect(tableCount(db, 'workspace_delivery_attempts')).toBe(1);

    // The runner skips files recorded as applied, so a second invocation is
    // idempotent and does not duplicate settings, statuses or attempt rows.
    const afterFirstRun = {
      settings: tableCount(db, 'workspace_settings'),
      delivery: tableCount(db, 'workspace_delivery_statuses'),
      attempts: tableCount(db, 'workspace_delivery_attempts')
    };
    applyMigrations(db);
    expect({
      settings: tableCount(db, 'workspace_settings'),
      delivery: tableCount(db, 'workspace_delivery_statuses'),
      attempts: tableCount(db, 'workspace_delivery_attempts')
    }).toEqual(afterFirstRun);
  });
});
