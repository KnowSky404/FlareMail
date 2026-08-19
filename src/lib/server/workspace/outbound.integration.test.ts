import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { FakeOutboundGateway, OutboundGatewayError } from '$lib/server/outbound/gateway';
import { retryWorkspaceMessageDelivery, sendWorkspaceMessage } from './outbound';
import { getWorkspaceMessageDeliveryDetail } from './delivery';
import type { WorkspaceSession } from './shared';

class TestStatement {
  private values: SQLQueryBindings[] = [];
  constructor(private readonly database: Database, private readonly sql: string) {}
  bind(...values: unknown[]) { this.values = values as SQLQueryBindings[]; return this as unknown as D1PreparedStatement; }
  async first<T>() { return (this.database.query(this.sql).get(...this.values) as T | null) ?? null; }
  async all<T>() { return { success: true, results: this.database.query(this.sql).all(...this.values) as T[] }; }
  async run<T>() { this.database.query(this.sql).run(...this.values); return { success: true, results: [] as T[] }; }
}

class TestD1 {
  constructor(readonly database: Database) {}
  prepare(sql: string) { return new TestStatement(this.database, sql) as unknown as D1PreparedStatement; }
  async batch(statements: D1PreparedStatement[]) {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }
}

const setup = () => {
  const database = new Database(':memory:');
  database.exec(readFileSync(new URL('../../../../schema.sql', import.meta.url), 'utf8'));
  database.query(`INSERT INTO workspace_schema_metadata (schema_name, schema_version, updated_at)
    VALUES ('flaremail', 11, '2026-08-19T00:00:00.000Z')`).run();
  database.query(`INSERT INTO workspace_users
    (id, login_email, name, role, email, company, location, timezone, forwarding_enabled, signature, incoming_sequence)
    VALUES ('user-1', 'owner@example.test', 'Owner', 'Owner', 'owner@example.test', '', '', 'UTC', 0, '-- Owner', 0)`).run();
  database.query(`INSERT INTO workspace_sessions (id, user_id) VALUES ('session-1', 'user-1')`).run();
  const DB = new TestD1(database) as unknown as D1Database;
  const env = {
    DB,
    BUCKET: {} as R2Bucket,
    APP_ENV: 'test',
    ALLOW_FAKE_SERVICES: 'true',
    OUTBOUND_PROVIDER: 'fake',
    OUTBOUND_FROM_EMAIL: 'mail@example.test',
    OUTBOUND_FROM_NAME: 'FlareMail'
  } as const;
  const session: WorkspaceSession = {
    id: 'session-1', userId: 'user-1', profile: { name: 'Owner', role: 'Owner', email: 'owner@example.test',
      company: '', location: '', timezone: 'UTC', forwardingEnabled: false, signature: '-- Owner' },
    mailbox: { inbox: [], sent: [], drafts: [] }, incomingSequence: 0,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), storage: 'd1'
  };
  return { database, env, session };
};

describe('outbound workspace persistence', () => {
  test('persists before submission, returns submitted and deduplicates double-clicks', async () => {
    const { database, env, session } = setup();
    const gateway = new FakeOutboundGateway({ providerMessageId: 're_test_1' });
    const input = { to: [{ name: 'Alice', email: 'ALICE@example.net' }, 'second@example.net'],
      cc: [{ name: 'Copy', email: 'copy@example.net' }, { name: 'Duplicate', email: 'alice@example.net' }],
      bcc: ['blind@example.net', 'copy@example.net'], subject: 'Re: Contract', body: 'Reply',
      inReplyTo: '<original@example.net>', references: '<root@example.net> <original@example.net>' };

    const first = await sendWorkspaceMessage(env, session, input, { requestId: 'compose-1', gateway });
    expect(first.message.deliveryStatus).toBe('submitted');
    expect(first.message.deliveredAt).toBeNull();
    expect(first.message.messageId).toMatch(/^<sent-live-/);
    expect(gateway.sent).toHaveLength(1);
    expect(gateway.sent[0]).toMatchObject({
      idempotencyKey: 'flaremail:send:user-1:compose-1',
      from: 'FlareMail <mail@example.test>',
      to: ['Alice <alice@example.net>', 'second@example.net'],
      cc: ['Copy <copy@example.net>'],
      bcc: ['blind@example.net'],
      replyTo: ['mail@example.test'],
      headers: { 'In-Reply-To': '<original@example.net>', References: '<root@example.net> <original@example.net>' }
    });

    const duplicate = await sendWorkspaceMessage(env, session, input, { requestId: 'compose-1', gateway });
    const duplicateSession = session;
    expect(duplicate.message.id).toBe(first.message.id);
    expect(gateway.sent).toHaveLength(1);
    expect(database.query('SELECT COUNT(*) AS count FROM workspace_messages').get()).toEqual({ count: 1 });

    expect(database.query(`SELECT status, attempts, provider_message_id, delivered_at FROM workspace_delivery_statuses`).get())
      .toEqual({ status: 'submitted', attempts: 1, provider_message_id: 're_test_1', delivered_at: null });
    expect((await getWorkspaceMessageDeliveryDetail(env, duplicateSession, first.message.id))?.events[0]?.providerMessageId)
      .toBe('re_test_1');

    const envWithoutProvider = { ...env, OUTBOUND_PROVIDER: undefined };
    const replayWhileUnconfigured = await sendWorkspaceMessage(envWithoutProvider, duplicateSession, input, { requestId: 'compose-1' });
    expect(replayWhileUnconfigured.message.id).toBe(first.message.id);

    await expect(retryWorkspaceMessageDelivery(env, session, first.message.id, { gateway: new FakeOutboundGateway() }))
      .rejects.toMatchObject({ code: 'DELIVERY_NOT_RETRYABLE', reason: 'status_not_retryable' });
  });

  test('does not reveal or retry a message owned by another user', async () => {
    const { env, session } = setup();
    const sent = await sendWorkspaceMessage(env, session, { toEmail: 'alice@example.net', subject: 'Private', body: 'Body' }, {
      requestId: 'private', gateway: new FakeOutboundGateway({ providerMessageId: 're_private' })
    });
    const otherSession = { ...session, userId: 'user-2' };
    expect(await retryWorkspaceMessageDelivery(env, otherSession, sent.message.id, { gateway: new FakeOutboundGateway() })).toBeNull();
  });

  test('rejects a message whose persisted message and delivery keys diverge', async () => {
    const { env, database, session } = setup();
    const sent = await sendWorkspaceMessage(env, session, { toEmail: 'alice@example.net', subject: 'Key', body: 'Body' }, {
      requestId: 'key-mismatch', gateway: new FakeOutboundGateway({ error: new OutboundGatewayError('network_unknown', 'outcome unknown') })
    });
    database.query(`UPDATE workspace_messages SET idempotency_key = 'flaremail:send:user-1:tampered' WHERE id = ?`).run(sent.message.id);
    await expect(retryWorkspaceMessageDelivery(env, session, sent.message.id, { gateway: new FakeOutboundGateway() }))
      .rejects.toMatchObject({ code: 'DELIVERY_NOT_RETRYABLE', reason: 'message_idempotency_key_mismatch' });
  });

  test('requires a client idempotency key when no persisted draft identifies the logical send', async () => {
    const { env, session } = setup();
    await expect(sendWorkspaceMessage(env, session, { toEmail: 'alice@example.net', subject: 'Hello', body: 'Body' }, {
      gateway: new FakeOutboundGateway()
    })).rejects.toMatchObject({ kind: 'client_error' });
  });

  test('keeps an unknown network outcome in submitting state for same-key retry', async () => {
    const { database, env, session } = setup();
    const gateway = new FakeOutboundGateway({ error: new OutboundGatewayError('network_unknown', 'outcome unknown') });
    const result = await sendWorkspaceMessage(env, session,
      { toEmail: 'alice@example.net', subject: 'Hello', body: 'Body' },
      { requestId: 'compose-unknown', gateway });
    expect(result.message.deliveryStatus).toBe('submitting');
    expect(result.message.deliveryResultKind).toBe('temporary_failure');
    expect(database.query(`SELECT status, completed_at FROM workspace_delivery_attempts`).get())
      .toEqual({ status: 'submitting', completed_at: null });

    const retryGateway = new FakeOutboundGateway({ providerMessageId: 're_after_unknown' });
    const retried = await retryWorkspaceMessageDelivery(env, session, result.message.id, { gateway: retryGateway });
    expect(retried?.message.deliveryStatus).toBe('submitted');
    expect(retryGateway.sent[0]?.idempotencyKey).toBe('flaremail:send:user-1:compose-unknown');
    expect(database.query(`SELECT status, attempts, provider_message_id FROM workspace_delivery_statuses`).get())
      .toEqual({ status: 'submitted', attempts: 2, provider_message_id: 're_after_unknown' });
  });

  test('refuses ordinary retry after the provider idempotency window expires', async () => {
    const { env, database, session } = setup();
    const first = await sendWorkspaceMessage(env, session, { toEmail: 'alice@example.net', subject: 'Old', body: 'Body' }, {
      requestId: 'expired', gateway: new FakeOutboundGateway({ error: new OutboundGatewayError('network_unknown', 'outcome unknown') })
    });
    database.query(`UPDATE workspace_delivery_attempts SET started_at = ?, created_at = ? WHERE message_id = ?`).run('2026-08-12T00:00:00.000Z', '2026-08-12T00:00:00.000Z', first.message.id);
    await expect(retryWorkspaceMessageDelivery(env, session, first.message.id, { gateway: new FakeOutboundGateway() }))
      .rejects.toMatchObject({ kind: 'idempotency_expired' });
  });
});
