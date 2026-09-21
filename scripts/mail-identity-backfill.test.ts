import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  applyMailIdentityBackfillPlan,
  buildMailIdentityBackfillCandidatesSql,
  buildMailIdentityBackfillConflictCountsSql,
  buildMailIdentityBackfillInspectSql,
  buildMailIdentityBackfillTargetSql,
  buildMailIdentityBackfillUpdateSql,
  createMailIdentityBackfillPlan,
  parseMailIdentityBackfillArguments,
  validateMailIdentityBackfillPlan,
  verifyMailIdentityBackfillPlan,
  type MailIdentityBackfillRecord,
  type MailIdentityBackfillStore,
  type MailIdentityBackfillTarget
} from './mail-identity-backfill-core';
import { FLAREMAIL_SCHEMA_VERSION } from '../src/lib/server/db/schema-version';

const repositoryRoot = resolve(import.meta.dir, '..');
const schemaPath = join(repositoryRoot, 'schema.sql');
const legacyFixturePath = join(repositoryRoot, 'tests/fixtures/legacy-schema.sql');
const migrationsDirectory = join(repositoryRoot, 'migrations');
const target: MailIdentityBackfillTarget = {
  ownerUserId: 'owner-1',
  addressId: 'address-1',
  addressEmail: 'person@example.test',
  domainId: 'domain-1',
  domainName: 'example.test'
};

function addOwner(db: Database, id: string, name: string) {
  db.query('INSERT INTO workspace_users (id, name, role) VALUES (?, ?, ?)').run(id, name, 'owner');
}

function addTarget(db: Database, value = target) {
  db.query('INSERT INTO workspace_owner (singleton, user_id) VALUES (1, ?)').run(value.ownerUserId);
  db.query(`INSERT INTO mail_domains (id, owner_user_id, domain_name, cloudflare_zone_id, worker_name)
    VALUES (?, ?, ?, ?, 'flaremail-worker')`).run(value.domainId, value.ownerUserId, value.domainName, 'zone-1');
  db.query(`INSERT INTO mail_addresses (id, owner_user_id, domain_id, email, local_part)
    VALUES (?, ?, ?, ?, 'person')`).run(value.addressId, value.ownerUserId, value.domainId, value.addressEmail);
}

function addInbound(db: Database, input: {
  id: string;
  ownerUserId?: string | null;
  envelopeTo?: string;
  status?: 'legacy-unmapped' | 'unregistered' | 'managed';
  domainId?: string | null;
  addressId?: string | null;
  timestamp?: string;
}) {
  const ownerUserId = input.ownerUserId === undefined ? target.ownerUserId : input.ownerUserId;
  const envelopeTo = input.envelopeTo ?? target.addressEmail;
  const status = input.status ?? 'legacy-unmapped';
  const domainId = input.domainId ?? null;
  const addressId = input.addressId ?? null;
  const timestamp = input.timestamp ?? '2022-04-05T06:07:08.000Z';
  db.query(`INSERT INTO email_messages (
    id, "from", "to", subject, "timestamp", snippet, raw_key, raw_size, dedupe_key,
    owner_user_id, body_object_id, direction, text_body, mail_domain_id, mail_address_id,
    recipient_status, created_at
  ) VALUES (?, 'sender@example.net', ?, 'Original subject', ?, 'Original snippet', ?, 123, ?, ?, ?, 'inbound',
    'envelope history needle', ?, ?, ?, '2022-04-05T06:07:09.000Z')`).run(
    input.id, envelopeTo, timestamp, `raw/${input.id}.eml`, `legacy:${input.id}`,
    ownerUserId, `body-${input.id}`, domainId, addressId, status
  );
}

function createDatabase() {
  const db = new Database(':memory:');
  db.exec(readFileSync(schemaPath, 'utf8'));
  db.query(`INSERT INTO workspace_schema_metadata (schema_name, schema_version, updated_at)
    VALUES ('flaremail', ?, '2026-09-21T00:00:00.000Z')`).run(FLAREMAIL_SCHEMA_VERSION);
  addOwner(db, 'owner-1', 'Stable Owner');
  addOwner(db, 'owner-2', 'Other historical owner');
  addTarget(db);
  return db;
}

function sqliteStore(db: Database): MailIdentityBackfillStore {
  return {
    executionTarget: { mode: 'local', database: 'flaremail-db', config: 'wrangler.toml', persistTo: '/tmp/flaremail-test-copy' },
    async getSchemaVersion() {
      return (db.query("SELECT schema_version FROM workspace_schema_metadata WHERE schema_name = 'flaremail'").get() as { schema_version: number }).schema_version;
    },
    async getTarget(ownerUserId, addressId) {
      const row = db.query(buildMailIdentityBackfillTargetSql(ownerUserId, addressId)).get() as Record<string, unknown> | null;
      if (!row || row.owner_user_id !== ownerUserId || row.workspace_user_id !== ownerUserId ||
          row.address_owner_user_id !== ownerUserId || row.domain_owner_user_id !== ownerUserId) return null;
      return {
        ownerUserId,
        addressId: String(row.address_id),
        addressEmail: String(row.address_email),
        domainId: String(row.joined_domain_id),
        domainName: String(row.domain_name)
      };
    },
    async findCandidates(value, afterId, limit) {
      return db.query(buildMailIdentityBackfillCandidatesSql(value, afterId, limit)).all().map((row) => {
        const record = row as Record<string, unknown>;
        return {
          messageId: String(record.id),
          ownerUserId: String(record.owner_user_id),
          envelopeTo: String(record.envelope_to),
          direction: 'inbound' as const,
          timestamp: String(record.message_timestamp),
          createdAt: String(record.created_at),
          mailDomainId: typeof record.mail_domain_id === 'string' ? record.mail_domain_id : null,
          mailAddressId: null,
          recipientStatus: String(record.recipient_status) as MailIdentityBackfillRecord['recipientStatus']
        };
      });
    },
    async getConflictCounts(value) {
      const row = db.query(buildConflictSql(value)).get() as Record<string, number>;
      return {
        unowned: row.unowned,
        otherOwner: row.other_owner,
        mappedToOtherAddress: row.mapped_to_other_address,
        domainMismatch: row.domain_mismatch,
        stateMismatch: row.state_mismatch,
        alreadyMapped: row.already_mapped
      };
    },
    async countUnmappedOutbound(ownerUserId) {
      return (db.query("SELECT COUNT(*) AS count FROM workspace_messages WHERE user_id = ? AND folder = 'sent' AND sender_address_id IS NULL").get(ownerUserId) as { count: number }).count;
    },
    async countDraftsWithoutSender(ownerUserId) {
      return (db.query('SELECT COUNT(*) AS count FROM workspace_drafts WHERE user_id = ? AND deleted_at IS NULL AND sender_address_id IS NULL').get(ownerUserId) as { count: number }).count;
    },
    async inspect(records) {
      if (!records.length) return [];
      const rows = db.query(buildMailIdentityBackfillInspectSql(records)).all() as Array<Record<string, unknown>>;
      return rows.map((row) => ({
        messageId: String(row.id),
        ownerUserId: String(row.owner_user_id),
        envelopeTo: String(row.envelope_to),
        direction: 'inbound' as const,
        timestamp: String(row.message_timestamp),
        createdAt: String(row.created_at),
        mailDomainId: typeof row.mail_domain_id === 'string' ? row.mail_domain_id : null,
        mailAddressId: typeof row.mail_address_id === 'string' ? row.mail_address_id : null,
        recipientStatus: String(row.recipient_status) as 'legacy-unmapped' | 'unregistered' | 'managed',
        searchProjectionOwnerUserId: typeof row.search_projection_owner_user_id === 'string' ? row.search_projection_owner_user_id : null,
        searchProjectionAddressId: typeof row.search_projection_address_id === 'string' ? row.search_projection_address_id : null
      }));
    },
    async applyUpdate(value, records) {
      db.exec(buildMailIdentityBackfillUpdateSql(value, records));
    }
  };
}

function buildConflictSql(value: MailIdentityBackfillTarget) {
  // Use the production builder so fixture execution covers the exact SQL used by the CLI.
  return buildMailIdentityBackfillConflictCountsSql(value);
}

function insertOutboundAndDraft(db: Database) {
  db.query(`INSERT INTO workspace_messages (
    id, user_id, folder, from_name, from_email, to_name, to_email, sent_at, direction, text_body
  ) VALUES ('sent-legacy', 'owner-1', 'sent', 'Old', 'person@example.test', 'Recipient', 'x@example.net',
    '2022-04-05T06:07:08.000Z', 'outbound', 'old sent body')`).run();
  db.query(`INSERT INTO workspace_drafts (id, user_id, from_email, subject, body)
    VALUES ('draft-legacy', 'owner-1', 'person@example.test', 'Keep this', 'Draft body')`).run();
}

describe('local historical mail identity backfill', () => {
  test('uses only trusted inbound envelope rows and preserves history, ownership, search, and local objects', async () => {
    const db = createDatabase();
    addInbound(db, { id: 'a-legacy' });
    addInbound(db, { id: 'b-collected', ownerUserId: 'owner-1', status: 'unregistered', domainId: 'domain-1', envelopeTo: 'Person@Example.Test' });
    addInbound(db, { id: 'c-unowned', ownerUserId: null });
    addInbound(db, { id: 'd-other-owner', ownerUserId: 'owner-2' });
    addInbound(db, { id: 'e-wrong-domain', domainId: 'domain-other' });
    addInbound(db, { id: 'f-other-address', status: 'managed', domainId: 'domain-1', addressId: 'address-other' });
    addInbound(db, { id: 'g-unregistered-no-domain', status: 'unregistered' });
    addInbound(db, { id: 'h-other-envelope', envelopeTo: 'elsewhere@example.test' });
    addInbound(db, { id: 'i-already-mapped', status: 'managed', domainId: 'domain-1', addressId: 'address-1' });
    db.query(`INSERT INTO workspace_email_states (id, user_id, email_message_id, is_read, is_starred, deleted_at)
      VALUES ('state-a', 'owner-1', 'a-legacy', 1, 1, '2022-05-01T00:00:00.000Z')`).run();
    db.query(`INSERT INTO workspace_attachments (id, user_id, message_id, filename, size, r2_key)
      VALUES ('attachment-a', 'owner-1', 'a-legacy', 'keep.txt', 12, 'inbound/2022-04-05/a/file.bin')`).run();
    db.query(`INSERT INTO mail_body_objects (id, owner_user_id, entity_type, entity_id, r2_key, size_bytes, sha256, created_at, updated_at)
      VALUES ('body-a-legacy', 'owner-1', 'email_message', 'a-legacy', 'body/v1/a-legacy', 123, 'sha256-test', '2022-04-05T00:00:00.000Z', '2022-04-05T00:00:00.000Z')`).run();
    insertOutboundAndDraft(db);

    const original = db.query(`SELECT id, "from", "to", subject, "timestamp", snippet, raw_key, raw_size,
      dedupe_key, owner_user_id, body_object_id, text_body, html_body, cc, created_at
      FROM email_messages WHERE id = 'a-legacy'`).get();
    const store = sqliteStore(db);
    const plan = await createMailIdentityBackfillPlan(store, {
      ownerUserId: 'owner-1', addressId: 'address-1', now: new Date('2026-09-21T10:00:00.000Z')
    });

    expect(plan.selection).toMatchObject({ sourceField: 'email_messages."to"', plannedCount: 2, hasMore: false });
    expect(plan.records.map((record) => record.messageId)).toEqual(['a-legacy', 'b-collected']);
    expect(plan.conflicts).toMatchObject({ unowned: 1, otherOwner: 1, domainMismatch: 1, stateMismatch: 1, alreadyMapped: 1 });
    expect(plan.excluded).toMatchObject({ outboundUnmappedCount: 1, draftsWithoutSenderCount: 1 });
    expect(plan.effects).toMatchObject({ changesOwner: false, changesOutboundMessages: false, changesDrafts: false, writesR2: false, sendsMailOrNotifications: false });
    expect(plan.records.every((record) => record.direction === 'inbound' && record.ownerUserId === 'owner-1')).toBe(true);

    const applied = await applyMailIdentityBackfillPlan(store, plan, plan.digest, new Date('2026-09-21T11:00:00.000Z'));
    expect(applied).toMatchObject({ status: 'complete', appliedAfter: 2, pendingAfter: 0, mutationAttempted: true });
    expect(db.query(`SELECT id, "from", "to", subject, "timestamp", snippet, raw_key, raw_size,
      dedupe_key, owner_user_id, body_object_id, text_body, html_body, cc, created_at,
      mail_domain_id, mail_address_id, recipient_status FROM email_messages WHERE id = 'a-legacy'`).get())
      .toMatchObject({ ...original as Record<string, unknown>, mail_domain_id: 'domain-1', mail_address_id: 'address-1', recipient_status: 'managed' });
    expect(db.query('SELECT is_read, is_starred, deleted_at FROM workspace_email_states WHERE id = ?').get('state-a'))
      .toEqual({ is_read: 1, is_starred: 1, deleted_at: '2022-05-01T00:00:00.000Z' });
    expect(db.query('SELECT r2_key FROM workspace_attachments WHERE id = ?').get('attachment-a'))
      .toEqual({ r2_key: 'inbound/2022-04-05/a/file.bin' });
    expect(db.query('SELECT r2_key FROM mail_body_objects WHERE id = ?').get('body-a-legacy'))
      .toEqual({ r2_key: 'body/v1/a-legacy' });
    expect(db.query('SELECT sender_address_id, from_email, text_body FROM workspace_messages WHERE id = ?').get('sent-legacy'))
      .toEqual({ sender_address_id: null, from_email: 'person@example.test', text_body: 'old sent body' });
    expect(db.query('SELECT sender_address_id, from_email, body FROM workspace_drafts WHERE id = ?').get('draft-legacy'))
      .toEqual({ sender_address_id: null, from_email: 'person@example.test', body: 'Draft body' });
    expect(db.query(`SELECT user_id, mail_address_id FROM workspace_search_documents WHERE entity_kind = 'inbound' AND entity_id = 'a-legacy'`).get())
      .toEqual({ user_id: 'owner-1', mail_address_id: 'address-1' });
    expect(db.query(`SELECT COUNT(*) AS count FROM workspace_search_fts WHERE workspace_search_fts MATCH 'envelope'`).get())
      .toEqual({ count: 8 });
    expect((await verifyMailIdentityBackfillPlan(store, plan)).status).toBe('complete');
    expect((await applyMailIdentityBackfillPlan(store, plan, plan.digest, new Date('2026-09-21T11:05:00.000Z'))).appliedBefore).toBe(2);
    db.close();
  });

  test('batches with a stable ID checkpoint and rejects non-explicit or remote CLI modes', async () => {
    const db = createDatabase();
    addInbound(db, { id: 'a-one' });
    addInbound(db, { id: 'b-two' });
    addInbound(db, { id: 'c-three' });
    const store = sqliteStore(db);
    const candidateSql = buildMailIdentityBackfillCandidatesSql(target, null, 3);
    expect(candidateSql).toContain('e."to"');
    expect(candidateSql).not.toContain('from_email');
    expect(candidateSql).not.toContain('delivered_to');
    expect(candidateSql).not.toContain('to_json');
    const first = await createMailIdentityBackfillPlan(store, { ownerUserId: 'owner-1', addressId: 'address-1', limit: 2 });
    expect(first.selection).toMatchObject({ plannedCount: 2, hasMore: true, nextAfterId: 'b-two' });
    const second = await createMailIdentityBackfillPlan(store, { ownerUserId: 'owner-1', addressId: 'address-1', limit: 2, afterId: first.selection.nextAfterId! });
    expect(second.records.map((record) => record.messageId)).toEqual(['c-three']);

    expect(parseMailIdentityBackfillArguments(['plan', '--owner-id', 'owner-1', '--address-id', 'address-1', '--persist-to', '/tmp/local-copy', '--out', '/tmp/backfill.json']))
      .toMatchObject({ command: 'plan', applyConfirmed: false, limit: 100 });
    expect(() => parseMailIdentityBackfillArguments(['plan', '--remote'])).toThrow('local-only');
    expect(() => parseMailIdentityBackfillArguments(['apply', '--persist-to', '/tmp/local-copy', '--plan', '/tmp/p.json', '--confirm', 'a'.repeat(64)]))
      .toThrow('explicit --apply');
    expect(() => parseMailIdentityBackfillArguments(['plan', '--owner-id', 'owner-1', '--address-id', 'address-1', '--persist-to', '/tmp/local-copy', '--out', '/tmp/p.json', '--limit', '101']))
      .toThrow('cannot exceed');
    const wrongCopy = { ...store, executionTarget: { ...store.executionTarget, persistTo: '/tmp/other-local-copy' } };
    await expect(verifyMailIdentityBackfillPlan(wrongCopy, first)).rejects.toThrow('persistence path or config changed');
    db.close();
  });

  test('blocks the whole batch before mutation when a planned row changed and rejects expired or altered plans', async () => {
    const db = createDatabase();
    addInbound(db, { id: 'a-one' });
    addInbound(db, { id: 'b-two' });
    const store = sqliteStore(db);
    const plan = await createMailIdentityBackfillPlan(store, { ownerUserId: 'owner-1', addressId: 'address-1' });
    db.query(`UPDATE email_messages SET recipient_status = 'unregistered', mail_domain_id = 'domain-1' WHERE id = 'a-one'`).run();

    const blocked = await applyMailIdentityBackfillPlan(store, plan, plan.digest);
    expect(blocked).toMatchObject({ status: 'blocked', mutationAttempted: false, appliedAfter: 0, pendingAfter: 1, conflictCount: 1 });
    expect(db.query('SELECT mail_address_id FROM email_messages WHERE id = ?').get('b-two')).toEqual({ mail_address_id: null });
    expect(() => validateMailIdentityBackfillPlan({ ...plan, records: [] })).toThrow(/invalid|digest/u);
    await expect(applyMailIdentityBackfillPlan(store, plan, plan.digest, new Date(Date.parse(plan.expiresAt) + 1))).rejects.toThrow('expired');
    db.close();
  });

  test('reports uncertain partial apply and safely resumes the same idempotent plan', async () => {
    const db = createDatabase();
    addInbound(db, { id: 'a-one' });
    addInbound(db, { id: 'b-two' });
    const store = sqliteStore(db);
    const plan = await createMailIdentityBackfillPlan(store, { ownerUserId: 'owner-1', addressId: 'address-1' });
    const uncertainStore: MailIdentityBackfillStore = {
      ...store,
      async applyUpdate(value, records) {
        await store.applyUpdate(value, [records[0]!]);
        throw new Error('simulated client disconnect after local commit');
      }
    };

    const partial = await applyMailIdentityBackfillPlan(uncertainStore, plan, plan.digest);
    expect(partial).toMatchObject({ status: 'partial', mutationAttempted: true, mutationErrorCode: 'local_apply_failed', appliedAfter: 1, pendingAfter: 1 });
    const resumed = await applyMailIdentityBackfillPlan(store, plan, plan.digest);
    expect(resumed).toMatchObject({ status: 'complete', appliedBefore: 1, appliedAfter: 2, pendingAfter: 0 });
    db.close();
  });

  test('uses the legacy trusted envelope from a pre-0023 fixture after the append-only migrations', async () => {
    const db = new Database(':memory:');
    db.exec(readFileSync(legacyFixturePath, 'utf8'));
    const migrations = readdirSync(migrationsDirectory).filter((name) => /^\d{4}_.+\.sql$/u.test(name)).sort();
    for (const migration of migrations) db.exec(readFileSync(join(migrationsDirectory, migration), 'utf8'));
    db.query(`INSERT INTO mail_domains (id, owner_user_id, domain_name, cloudflare_zone_id, worker_name)
      VALUES ('legacy-domain', 'legacy-user-1', 'example.test', 'zone-legacy', 'flaremail-worker')`).run();
    db.query(`INSERT INTO mail_addresses (id, owner_user_id, domain_id, email, local_part)
      VALUES ('legacy-address', 'legacy-user-1', 'legacy-domain', 'admin@example.test', 'admin')`).run();
    const legacyTarget: MailIdentityBackfillTarget = {
      ownerUserId: 'legacy-user-1', addressId: 'legacy-address', addressEmail: 'admin@example.test',
      domainId: 'legacy-domain', domainName: 'example.test'
    };
    const store = sqliteStoreForLegacy(db, legacyTarget);
    const plan = await createMailIdentityBackfillPlan(store, { ownerUserId: 'legacy-user-1', addressId: 'legacy-address' });
    expect(plan.records.map((record) => record.messageId)).toContain('legacy-email-1');
    const result = await applyMailIdentityBackfillPlan(store, plan, plan.digest);
    expect(result.status).toBe('complete');
    expect(db.query(`SELECT id, "to", owner_user_id, mail_domain_id, mail_address_id, recipient_status FROM email_messages WHERE id = 'legacy-email-1'`).get())
      .toMatchObject({ id: 'legacy-email-1', to: 'admin@example.test', owner_user_id: 'legacy-user-1', mail_domain_id: 'legacy-domain', mail_address_id: 'legacy-address', recipient_status: 'managed' });
    db.close();
  });
});

function sqliteStoreForLegacy(db: Database, legacyTarget: MailIdentityBackfillTarget): MailIdentityBackfillStore {
  const base = sqliteStore(db);
  return {
    ...base,
    async getTarget(ownerUserId, addressId) {
      if (ownerUserId !== legacyTarget.ownerUserId || addressId !== legacyTarget.addressId) return null;
      const owner = db.query('SELECT user_id FROM workspace_owner WHERE singleton = 1').get() as { user_id: string };
      const user = db.query('SELECT id FROM workspace_users WHERE id = ?').get(ownerUserId) as { id: string } | null;
      if (owner.user_id !== ownerUserId || user?.id !== ownerUserId) return null;
      return legacyTarget;
    }
  };
}
