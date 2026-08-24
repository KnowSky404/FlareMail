import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  classifyCleanupKey,
  cleanupBackoffMs,
  createCleanupEnqueueStatement,
  drainCleanupQueue,
  getCleanupReport
} from './r2-cleanup';

class Statement {
  private values: SQLQueryBindings[] = [];
  constructor(private readonly db: Database, private readonly sql: string, private readonly lostFinalize = false) {}
  bind(...values: unknown[]) { this.values = values as SQLQueryBindings[]; return this as unknown as D1PreparedStatement; }
  async first<T>() { return (this.db.query(this.sql).get(...this.values) as T | null) ?? null; }
  async all<T>() { return { results: this.db.query(this.sql).all(...this.values) as T[] }; }
  async run() {
    if (this.lostFinalize && this.sql.includes("SET status = 'completed'")) return { meta: { changes: 0 } } as D1Result;
    const result = this.db.query(this.sql).run(...this.values);
    return { meta: { changes: Number(result.changes) } } as D1Result;
  }
}

class D1 {
  constructor(readonly db: Database, readonly lostFinalize = false) {}
  prepare(sql: string) { return new Statement(this.db, sql, this.lostFinalize) as unknown as D1PreparedStatement; }
}

class Bucket {
  readonly deleted: string[] = [];
  fail = false;
  async delete(key: string) {
    if (this.fail) throw new Error('temporary R2 failure');
    this.deleted.push(key);
  }
}

const canonicalKey = 'outbound/v1/2026-08-20/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222.bin';
const mismatchedCanonicalKey = 'outbound/v1/2026-08-20/11111111-1111-4111-8111-111111111111/44444444-4444-4444-8444-444444444444.bin';
const databases: Database[] = [];

function fixture() {
  const db = new Database(':memory:');
  databases.push(db);
  db.exec(readFileSync(resolve(import.meta.dir, '../../../../schema.sql'), 'utf8'));
  return db;
}

afterEach(() => { while (databases.length) databases.pop()?.close(); });

describe('R2 cleanup queue', () => {
  test('classifies managed key shapes and quarantines legacy keys', () => {
    expect(classifyCleanupKey('inbound/2026-08-20/abc/message.eml')).toBe('raw');
    expect(classifyCleanupKey('inbound/2026-08-20/abc/attachments/att/file.txt')).toBe('attachment');
    expect(classifyCleanupKey(canonicalKey)).toBe('attachment');
    expect(classifyCleanupKey('body/v1/workspace_message/message/object-' + 'a'.repeat(64) + '.json')).toBe('body');
    expect(classifyCleanupKey('sent/att-1')).toBe('legacy');
    expect(classifyCleanupKey('x'.repeat(1025))).toBe('legacy');
    expect(classifyCleanupKey('a/b/c/d/e/f/g/h/i')).toBe('legacy');
    expect(cleanupBackoffMs(1)).toBe(30_000);
    expect(cleanupBackoffMs(100)).toBe(6 * 60 * 60 * 1000);
  });

  test('claims concurrently at most once and completes missing objects idempotently', async () => {
    const db = fixture();
    const d1 = new D1(db);
    await createCleanupEnqueueStatement(d1 as never, { id: 'job-1', ownerUserId: 'owner-1', entityId: 'message-1', sourceId: '11111111-1111-4111-8111-111111111111', sourceOwnerUserId: 'owner-1', sourceEntityId: 'message-1', r2Key: canonicalKey, now: '2026-08-20T00:00:00.000Z' }).run();
    const bucket = new Bucket();
    const env = { DB: d1, BUCKET: bucket } as never;
    const [first, second] = await Promise.all([
      drainCleanupQueue(env, d1 as never, { now: new Date('2026-08-20T00:00:01.000Z'), limit: 1, apply: true }),
      drainCleanupQueue(env, d1 as never, { now: new Date('2026-08-20T00:00:01.000Z'), limit: 1, apply: true })
    ]);
    expect(first.claimed + second.claimed).toBe(1);
    expect(first.completed + second.completed).toBe(1);
    expect(bucket.deleted).toEqual([canonicalKey]);
    expect(db.query(`SELECT status, attempt_count FROM workspace_r2_cleanup_queue WHERE id = 'job-1'`).get()).toEqual({ status: 'completed', attempt_count: 1 });
  });

  test('defaults to report-only and quarantines an outbound relation mismatch', async () => {
    const db = fixture();
    const d1 = new D1(db);
    await createCleanupEnqueueStatement(d1 as never, { id: 'job-valid-dry', ownerUserId: 'owner-1', entityId: 'message-1', sourceId: '11111111-1111-4111-8111-111111111111', sourceOwnerUserId: 'owner-1', sourceEntityId: 'message-1', r2Key: canonicalKey, now: '2026-08-20T00:00:00.000Z' }).run();
    await createCleanupEnqueueStatement(d1 as never, { id: 'job-dry', ownerUserId: 'owner-1', entityId: 'message-1', sourceId: 'wrong-attachment', sourceOwnerUserId: 'owner-1', sourceEntityId: 'other-message', r2Key: mismatchedCanonicalKey, now: '2026-08-20T00:00:00.000Z' }).run();
    const bucket = new Bucket();
    const dry = await drainCleanupQueue({ DB: d1, BUCKET: bucket } as never, d1 as never, { now: new Date('2026-08-20T00:00:01.000Z') });
    expect(dry.selected).toBe(1);
    expect(bucket.deleted).toEqual([]);
    expect(db.query(`SELECT status, object_kind, last_error FROM workspace_r2_cleanup_queue WHERE id = 'job-dry'`).get()).toEqual({ status: 'manual_review', object_kind: 'legacy', last_error: 'invalid_key_scope' });
  });

  test('quarantines an outbound source owned by another user', async () => {
    const db = fixture();
    const d1 = new D1(db);
    await createCleanupEnqueueStatement(d1 as never, {
      id: 'job-owner-mismatch', ownerUserId: 'owner-1', entityId: 'message-1',
      sourceId: '11111111-1111-4111-8111-111111111111', sourceOwnerUserId: 'other-owner', sourceEntityId: 'message-1',
      r2Key: canonicalKey, now: '2026-08-20T00:00:00.000Z'
    }).run();
    expect(db.query(`SELECT status, object_kind, last_error FROM workspace_r2_cleanup_queue WHERE id = 'job-owner-mismatch'`).get())
      .toEqual({ status: 'manual_review', object_kind: 'legacy', last_error: 'invalid_key_scope' });
  });

  test('backs off temporary failures and supports a completed replay without deleting twice', async () => {
    const db = fixture();
    const d1 = new D1(db);
    await createCleanupEnqueueStatement(d1 as never, {
      id: 'job-retry', ownerUserId: 'owner-1', entityId: 'message-1',
      sourceId: '11111111-1111-4111-8111-111111111111', sourceOwnerUserId: 'owner-1', sourceEntityId: 'message-1',
      r2Key: canonicalKey, maxAttempts: 2, now: '2026-08-20T00:00:00.000Z'
    }).run();
    const bucket = new Bucket();
    bucket.fail = true;
    const failed = await drainCleanupQueue({ DB: d1, BUCKET: bucket } as never, d1 as never, {
      now: new Date('2026-08-20T00:00:01.000Z'), apply: true
    });
    expect(failed.retryable).toBe(1);
    expect(db.query(`SELECT status, attempt_count, next_attempt_at FROM workspace_r2_cleanup_queue WHERE id = 'job-retry'`).get())
      .toEqual({ status: 'retryable', attempt_count: 1, next_attempt_at: '2026-08-20T00:00:31.000Z' });
    db.query(`UPDATE workspace_r2_cleanup_queue SET next_attempt_at = '1970-01-01T00:00:00.000Z' WHERE id = 'job-retry'`).run();
    bucket.fail = false;
    const completed = await drainCleanupQueue({ DB: d1, BUCKET: bucket } as never, d1 as never, {
      now: new Date('2026-08-20T00:01:00.000Z'), apply: true
    });
    expect(completed.completed).toBe(1);
    const replay = await drainCleanupQueue({ DB: d1, BUCKET: bucket } as never, d1 as never, {
      now: new Date('2026-08-20T00:02:00.000Z'), apply: true
    });
    expect(replay.selected).toBe(0);
    expect(bucket.deleted).toEqual([canonicalKey]);
    expect(db.query(`SELECT status, attempt_count FROM workspace_r2_cleanup_queue WHERE id = 'job-retry'`).get())
      .toEqual({ status: 'completed', attempt_count: 2 });
  });

  test('moves a permanently failing job to manual review at max attempts', async () => {
    const db = fixture();
    const d1 = new D1(db);
    await createCleanupEnqueueStatement(d1 as never, { id: 'job-poison', ownerUserId: 'owner-1', entityId: 'message-1', sourceId: '11111111-1111-4111-8111-111111111111', sourceOwnerUserId: 'owner-1', sourceEntityId: 'message-1', r2Key: canonicalKey, maxAttempts: 1, now: '2026-08-20T00:00:00.000Z' }).run();
    const bucket = new Bucket(); bucket.fail = true;
    const result = await drainCleanupQueue({ DB: d1, BUCKET: bucket } as never, d1 as never, { now: new Date('2026-08-20T00:00:01.000Z'), apply: true });
    expect(result.manualReview).toBe(1);
    expect(db.query(`SELECT status, last_error, attempt_count FROM workspace_r2_cleanup_queue WHERE id = 'job-poison'`).get()).toEqual({ status: 'manual_review', last_error: 'r2_delete_failed', attempt_count: 1 });
  });

  test('keeps a lost finalize claim recoverable and never claims legacy anomalies', async () => {
    const db = fixture();
    const d1 = new D1(db, true);
    await createCleanupEnqueueStatement(d1 as never, { id: 'job-lost', ownerUserId: 'owner-1', entityId: 'message-1', sourceId: '11111111-1111-4111-8111-111111111111', sourceOwnerUserId: 'owner-1', sourceEntityId: 'message-1', r2Key: canonicalKey, now: '2026-08-20T00:00:00.000Z' }).run();
    await createCleanupEnqueueStatement(d1 as never, { id: 'job-legacy', ownerUserId: 'owner-1', entityId: 'message-1', sourceId: 'unknown', sourceOwnerUserId: 'owner-1', sourceEntityId: 'message-1', r2Key: 'sent/att-1', now: '2026-08-20T00:00:00.000Z' }).run();
    const bucket = new Bucket();
    const result = await drainCleanupQueue({ DB: d1, BUCKET: bucket } as never, d1 as never, { now: new Date('2026-08-20T00:00:01.000Z'), apply: true });
    expect(result.lostClaim).toBe(1);
    expect(bucket.deleted).toEqual([canonicalKey]);
    expect(db.query(`SELECT status FROM workspace_r2_cleanup_queue WHERE id = 'job-lost'`).get()).toEqual({ status: 'processing' });
    const report = await getCleanupReport(d1 as never, new Date('2026-08-20T00:00:01.000Z'));
    expect(report.legacy).toBe(1);
    expect(report.processing).toBe(1);
  });

  test('recovers an expired lease before claiming the next attempt', async () => {
    const db = fixture();
    const d1 = new D1(db);
    await createCleanupEnqueueStatement(d1 as never, { id: 'job-stale', ownerUserId: 'owner-1', entityId: 'message-1', sourceId: '11111111-1111-4111-8111-111111111111', sourceOwnerUserId: 'owner-1', sourceEntityId: 'message-1', r2Key: canonicalKey, now: '2026-08-20T00:00:00.000Z' }).run();
    db.query(`UPDATE workspace_r2_cleanup_queue SET status = 'processing', attempt_count = 1, claim_token = 'old-token', lease_expires_at = '2026-08-20T00:00:01.000Z' WHERE id = 'job-stale'`).run();
    const result = await drainCleanupQueue({ DB: d1, BUCKET: new Bucket() } as never, d1 as never, { now: new Date('2026-08-20T00:01:00.000Z'), apply: true });
    expect(result.completed).toBe(1);
    expect(db.query(`SELECT status, attempt_count, last_error FROM workspace_r2_cleanup_queue WHERE id = 'job-stale'`).get()).toEqual({ status: 'completed', attempt_count: 2, last_error: null });
  });
});
