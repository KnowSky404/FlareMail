import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { FakeOutboundGateway, MAX_OUTBOUND_ATTACHMENT_BYTES, OutboundGatewayError } from '$lib/server/outbound/gateway';
import { recordAcceptedResponseOnWebhookReceipt } from '$lib/server/db/deliveries';
import { FLAREMAIL_SCHEMA_VERSION } from '$lib/server/db/schema-version';
import { retryWorkspaceMessageDelivery, sendWorkspaceMessage } from './outbound';
import { applyResendDeliveryWebhook, getWorkspaceMessageDeliveryDetail, reconcileDeferredResendEvents } from './delivery';
import { saveWorkspaceDraft, DraftBodyReloadRequiredError, DraftConflictError } from './draft';
import type { WorkspaceSession } from './shared';
import { createMailLabel, setMailMessageLabel } from '$lib/server/db/labels';

class TestStatement {
  private values: SQLQueryBindings[] = [];
  constructor(private readonly database: Database, private readonly sql: string) {}
  bind(...values: unknown[]) { this.values = values as SQLQueryBindings[]; return this as unknown as D1PreparedStatement; }
  async first<T>() { return (this.database.query(this.sql).get(...this.values) as T | null) ?? null; }
  async all<T>() { return { success: true, results: this.database.query(this.sql).all(...this.values) as T[] }; }
  execute() {
    const query = this.database.query(this.sql);
    if (/^\s*(?:SELECT|WITH)\b|\bRETURNING id\b/iu.test(this.sql)) return { success: true, results: query.all(...this.values) };
    const result = query.run(...this.values);
    return { success: true, results: [], meta: { changes: result.changes } };
  }
  async run() { return this.execute(); }
}

class TestD1 {
  beforePrepare?: (sql: string) => void;
  constructor(readonly database: Database) {}
  prepare(sql: string) {
    this.beforePrepare?.(sql);
    return new TestStatement(this.database, sql) as unknown as D1PreparedStatement;
  }
  async batch(statements: D1PreparedStatement[]) {
    return this.database.transaction(() =>
      statements.map((statement) => (statement as unknown as TestStatement).execute()))();
  }
}

class TestBucket {
  readonly objects = new Map<string, Uint8Array>();
  async put(key: string, value: Uint8Array) { this.objects.set(key, new Uint8Array(value)); }
  async get(key: string) {
    const value = this.objects.get(key);
    if (!value) return null;
    return {
      size: value.byteLength,
      arrayBuffer: async () => value.slice().buffer
    } as unknown as R2ObjectBody;
  }
  async delete(key: string) { this.objects.delete(key); }
}

const setup = () => {
  const database = new Database(':memory:');
  database.exec(readFileSync(new URL('../../../../schema.sql', import.meta.url), 'utf8'));
  database.query(`INSERT INTO workspace_schema_metadata (schema_name, schema_version, updated_at)
    VALUES ('flaremail', ?, '2026-08-19T00:00:00.000Z')`).run(FLAREMAIL_SCHEMA_VERSION);
  database.query(`INSERT INTO workspace_users
    (id, login_email, name, role, email, company, location, timezone, forwarding_enabled, signature, incoming_sequence)
    VALUES ('user-1', 'owner@example.test', 'Owner', 'Owner', 'owner@example.test', '', '', 'UTC', 0, '-- Owner', 0)`).run();
  const senderCheckAt = new Date().toISOString();
  database.query(`INSERT INTO mail_domains (
      id, owner_user_id, domain_name, cloudflare_zone_id, worker_name, enabled,
      resend_status, resend_sending_status, resend_checked_at
    ) VALUES ('domain-1', 'user-1', 'example.test', 'zone-1', 'flaremail', 1, 'verified', 'enabled', ?)`)
    .run(senderCheckAt);
  database.query(`INSERT INTO mail_addresses (
      id, owner_user_id, domain_id, email, local_part, display_name, signature,
      receive_enabled, send_enabled, lifecycle_status, routing_state, routing_owner, is_default_sender
    ) VALUES ('address-1', 'user-1', 'domain-1', 'mail@example.test', 'mail', 'FlareMail', '-- Owner',
      1, 1, 'active', 'active', 'flaremail', 1)`)
    .run();
  database.query(`INSERT INTO workspace_sessions (id, user_id) VALUES ('session-1', 'user-1')`).run();
  const DB = new TestD1(database) as unknown as D1Database;
  const BUCKET = new TestBucket() as unknown as R2Bucket;
  const env = {
    DB,
    BUCKET,
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
  test('queues early events in the acceptance transaction when inline replay fails', async () => {
    const { env, database, session } = setup();
    const d1 = env.DB as unknown as TestD1;
    const gateway = new FakeOutboundGateway({ providerMessageId: 're_early' });
    const sent = await sendWorkspaceMessage(env, session, { toEmail: 'alice@example.net', subject: 'Early event', body: 'Body' }, {
      requestId: 'early-event',
      gateway: {
        async send(input) {
          await applyResendDeliveryWebhook(env, 'early-delivered', {
            type: 'email.delivered', created_at: new Date().toISOString(), data: { email_id: 're_early' }
          });
          d1.beforePrepare = (sql) => {
            if (sql.includes('AS was_deferred') && sql.includes('WHERE provider_message_id = ?')) throw new Error('transient read failure');
          };
          return gateway.send(input);
        }
      }
    });
    d1.beforePrepare = undefined;
    await reconcileDeferredResendEvents(env);
    expect(await getWorkspaceMessageDeliveryDetail(env, session, sent.message.id)).toMatchObject({ status: 'delivered' });
    database.close();
  });

  test('an older completion records its attempt without overwriting the newer outcome', async () => {
    const { env, database, session } = setup();
    const address = { toEmail: 'alice@example.net', subject: 'Overlapping retries', body: 'Body' };
    const initial = new FakeOutboundGateway({ error: new OutboundGatewayError('network_unknown', 'unknown outcome') });
    const sent = await sendWorkspaceMessage(env, session, address, { requestId: 'overlapping-retry', gateway: initial });
    const original = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const older = retryWorkspaceMessageDelivery(env, session, sent.message.id, { gateway: {
      async send() {
        original.resolve();
        await resume.promise;
        throw new OutboundGatewayError('network_unknown', 'older timeout');
      }
    } });
    await original.promise;
    try {
      const newer = await retryWorkspaceMessageDelivery(env, session, sent.message.id, { gateway:
        new FakeOutboundGateway({ error: new OutboundGatewayError('rate_limited', 'newer throttle') })
      });
      expect(newer?.message).toMatchObject({
        deliveryStatus: 'delayed', deliveryAttempts: 3, deliveryIdempotencyKey: expect.any(String),
        deliveryAttemptStartedAt: expect.any(String)
      });
    } finally {
      resume.resolve();
      await older;
    }
    expect(database.query('SELECT status, attempts FROM workspace_delivery_statuses WHERE message_id = ?').get(sent.message.id))
      .toEqual({ status: 'delayed', attempts: 3 });
    expect(database.query('SELECT result_kind FROM workspace_outbound_receipts WHERE message_id = ?').get(sent.message.id))
      .toEqual({ result_kind: 'rate_limited' });
    expect(database.query('SELECT error FROM workspace_delivery_attempts WHERE message_id = ? AND attempt_number = 2').get(sent.message.id))
      .toEqual({ error: 'older timeout' });
    database.close();
  });

  test('a late first acceptance attaches the provider ID without restoring an older attempt', async () => {
    const { env, database, session } = setup();
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const providerMessageId = 're_late_first';
    const first = sendWorkspaceMessage(env, session, { toEmail: 'alice@example.net', subject: 'Late first acceptance', body: 'Body' }, {
      requestId: 'late-first-acceptance',
      gateway: { async send() {
        started.resolve();
        await finish.promise;
        return { status: 'submitted', providerMessageId, remoteStatus: 200 };
      } }
    });
    await started.promise;
    const message = database.query<{ id: string }, []>('SELECT id FROM workspace_messages').get()!;
    try {
      await retryWorkspaceMessageDelivery(env, session, message.id, { gateway:
        new FakeOutboundGateway({ error: new OutboundGatewayError('network_unknown', 'retry timeout') })
      });
    } finally {
      finish.resolve();
      await first;
    }
    const delivery = () => database.query('SELECT status, attempts, provider_message_id FROM workspace_delivery_statuses WHERE message_id = ?').get(message.id);
    expect(delivery()).toEqual({ status: 'submitting', attempts: 2, provider_message_id: providerMessageId });
    await applyResendDeliveryWebhook(env, 'late-first-delivered', {
      type: 'email.delivered', created_at: new Date().toISOString(), data: { email_id: providerMessageId }
    });
    expect(delivery()).toEqual({ status: 'delivered', attempts: 2, provider_message_id: providerMessageId });
    database.close();
  });

  test('attaches events for a superseded attempt without affecting the current provider receipt', async () => {
    const { env, database, session } = setup();
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const providerMessageId = 're_older_attempt';
    const older = sendWorkspaceMessage(env, session, { toEmail: 'alice@example.net', subject: 'Superseded attempt', body: 'Body' }, {
      requestId: 'superseded-attempt',
      gateway: { async send() {
        started.resolve();
        await finish.promise;
        return { status: 'submitted', providerMessageId, remoteStatus: 200 };
      } }
    });
    await started.promise;
    const message = database.query<{ id: string }, []>('SELECT id FROM workspace_messages').get()!;
    try {
      await applyResendDeliveryWebhook(env, 'older-bounce', {
        type: 'email.bounced', created_at: new Date().toISOString(), data: { email_id: providerMessageId }
      });
      await retryWorkspaceMessageDelivery(env, session, message.id, {
        gateway: new FakeOutboundGateway({ providerMessageId: 're_newer_attempt' })
      });
    } finally {
      finish.resolve();
      await older;
    }
    await applyResendDeliveryWebhook(env, 'older-delivered', {
      type: 'email.delivered', created_at: new Date().toISOString(), data: { email_id: providerMessageId }
    });
    await reconcileDeferredResendEvents(env);
    const receipt = await getWorkspaceMessageDeliveryDetail(env, session, message.id);
    expect(receipt).toMatchObject({ status: 'submitted', resultKind: 'accepted', attention: null });
    expect(receipt?.events.map(({ id }) => id)).toEqual(expect.arrayContaining(['older-bounce', 'older-delivered']));
    database.close();
  });

  test('transfers persisted labels when a draft is sent', async () => {
    const { env, database, session } = setup();
    const draft = await saveWorkspaceDraft(env, session, { toEmail: 'alice@example.net', subject: 'Labeled', body: 'Body' });
    const label = await createMailLabel(env.DB, session.userId, 'Follow up');
    await setMailMessageLabel(env.DB, session.userId, label.id, { kind: 'draft', id: draft.message.id }, true);
    const sent = await sendWorkspaceMessage(env, session, {
      draftId: draft.message.id, toEmail: 'alice@example.net', subject: 'Labeled', body: 'Body'
    }, { gateway: new FakeOutboundGateway() });
    expect(sent.message.id).toBe(draft.message.id);
    expect(database.query(`SELECT message_kind, message_id FROM mail_message_labels WHERE owner_user_id = 'user-1'`).all())
      .toEqual([{ message_kind: 'workspace', message_id: sent.message.id }]);
  });
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
      headers: { 'In-Reply-To': '<original@example.net>', References: '<root@example.net> <original@example.net>' }
    });
    expect(gateway.sent[0]?.replyTo).toBeUndefined();

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

  test('authorizes a selected managed address and ignores the legacy global sender', async () => {
    const { database, env, session } = setup();
    database.query(`INSERT INTO mail_addresses (
        id, owner_user_id, domain_id, email, local_part, display_name, signature,
        receive_enabled, send_enabled, lifecycle_status, routing_state, routing_owner
      ) VALUES ('address-2', 'user-1', 'domain-1', 'support@example.test', 'support', 'Support', '-- Support team',
        1, 1, 'active', 'active', 'flaremail')`).run();
    const gateway = new FakeOutboundGateway({ providerMessageId: 're_selected_sender' });
    const sent = await sendWorkspaceMessage({ ...env, OUTBOUND_FROM_EMAIL: 'legacy@another.test', OUTBOUND_FROM_NAME: 'Legacy' }, session, {
      senderAddressId: 'address-2', toEmail: 'alice@example.net', subject: 'Selected From', body: 'Hello'
    }, { requestId: 'selected-from', gateway });

    expect(gateway.sent[0]?.from).toBe('Support <support@example.test>');
    expect(gateway.sent[0]?.text).toBe('Hello\n\n-- Support team');
    expect(gateway.sent[0]?.replyTo).toBeUndefined();
    expect(gateway.sent[0]?.headers?.['Message-ID']).toMatch(/@example\.test>$/u);
    expect(sent.message).toMatchObject({ senderAddressId: 'address-2', fromName: 'Support', fromEmail: 'support@example.test' });
    expect(database.query(`SELECT sender_address_id, from_name, from_email, reply_to_json FROM workspace_messages WHERE id = ?`)
      .get(sent.message.id)).toEqual({
      sender_address_id: 'address-2', from_name: 'Support', from_email: 'support@example.test', reply_to_json: '[]'
    });

    await expect(sendWorkspaceMessage(env, session, {
      senderAddressId: 'another-owner-address', toEmail: 'alice@example.net', subject: 'Spoofed From', body: 'No'
    }, { requestId: 'spoofed-from', gateway: new FakeOutboundGateway() }))
      .rejects.toMatchObject({ code: 'OUTBOUND_SENDER_NOT_SELECTED' });
    expect(database.query(`SELECT COUNT(*) AS count FROM workspace_messages`).get()).toEqual({ count: 1 });
  });

  test('requires an explicit sender when the workspace has no default', async () => {
    const { database, env, session } = setup();
    database.query(`UPDATE mail_addresses SET is_default_sender = 0 WHERE id = 'address-1'`).run();
    await expect(sendWorkspaceMessage(env, session, {
      senderAddressId: null, toEmail: 'alice@example.net', subject: 'No sender', body: 'No'
    }, { requestId: 'no-sender', gateway: new FakeOutboundGateway() }))
      .rejects.toMatchObject({ code: 'OUTBOUND_SENDER_NOT_SELECTED' });
    expect(database.query(`SELECT COUNT(*) AS count FROM workspace_messages`).get()).toEqual({ count: 0 });
  });

  test('sanitizes HTML-only payloads before provider submission and blocks remote images', async () => {
    const { env, session } = setup();
    const gateway = new FakeOutboundGateway({ providerMessageId: 're_html_1' });
    await sendWorkspaceMessage(env, session, {
      toEmail: 'alice@example.net', subject: 'HTML', body: '',
      html: '<p>Hello <a href="https://example.com">portal</a></p><script>alert(1)</script><img src="https://tracker.example/pixel">'
    }, { requestId: 'html-1', gateway });
    expect(gateway.sent[0]?.text).toBe('Hello portal\n\n-- Owner');
    expect(gateway.sent[0]?.html).toBe('<p>Hello <a href="https://example.com" target="_blank" rel="noopener noreferrer">portal</a></p><br><br>-- Owner');
    expect(gateway.sent[0]?.html).not.toContain('fm-link-target');
    expect(gateway.sent[0]?.html).not.toContain('tracker.example');
  });

  test('does not reveal or retry a message owned by another user', async () => {
    const { env, session } = setup();
    const sent = await sendWorkspaceMessage(env, session, { toEmail: 'alice@example.net', subject: 'Private', body: 'Body' }, {
      requestId: 'private', gateway: new FakeOutboundGateway({ providerMessageId: 're_private' })
    });
    const otherSession = { ...session, userId: 'user-2' };
    expect(await retryWorkspaceMessageDelivery(env, otherSession, sent.message.id, { gateway: new FakeOutboundGateway() })).toBeNull();
  });

  test('replays a delay received before the first retry confirmed the provider ID', async () => {
    const { env, session, database } = setup();
    const sent = await sendWorkspaceMessage(env, session, { toEmail: 'alice@example.net', subject: 'Unknown outcome', body: 'Body' }, {
      requestId: 'unconfirmed-provider', gateway: new FakeOutboundGateway({ error: new OutboundGatewayError('network_unknown', 'outcome unknown') })
    });
    database.query("UPDATE workspace_delivery_attempts SET started_at = datetime('now', '-1 minute') WHERE message_id = ?").run(sent.message.id);
    const event = await applyResendDeliveryWebhook(env, 'svix-early-delay', {
      type: 'email.delivery_delayed', created_at: new Date(Date.now() - 5000).toISOString(), data: { email_id: 're_unknown' }
    });
    expect(event).toMatchObject({ matched: false });
    await retryWorkspaceMessageDelivery(env, session, sent.message.id, {
      gateway: new FakeOutboundGateway({ providerMessageId: 're_unknown' })
    });
    expect(await getWorkspaceMessageDeliveryDetail(env, session, sent.message.id)).toMatchObject({
      status: 'delayed', attention: { kind: 'delayed', state: 'open' }
    });
  });

  test.each(['rate_limited', 'timeout'] as const)('replays a deferred sent event for the prior delivery after retry %s', async (kind) => {
    const { env, session } = setup();
    const providerId = 're_rate_limit_prior';
    const sent = await sendWorkspaceMessage(env, session, { toEmail: 'alice@example.net', subject: 'Rate limit', body: 'Body' }, {
      requestId: 'rate-limit-replay', gateway: new FakeOutboundGateway({ providerMessageId: providerId })
    });
    await applyResendDeliveryWebhook(env, 'svix-rate-limit-delay', {
      type: 'email.delivery_delayed', created_at: new Date(Date.now() - 4000).toISOString(), data: { email_id: providerId }
    });
    const result = await retryWorkspaceMessageDelivery(env, session, sent.message.id, { gateway: {
      async send() {
        const deferred = await applyResendDeliveryWebhook(env, 'svix-rate-limit-sent', {
          type: 'email.sent', created_at: new Date(Date.now() - 1000).toISOString(), data: { email_id: providerId }
        });
        expect(deferred).toMatchObject({ matched: true, ignored: true });
        throw new OutboundGatewayError(kind, `retry ${kind}`);
      }
    } });
    expect(result?.message).toMatchObject({ deliveryStatus: 'sent', deliveryLastEvent: 'email.sent' });
    expect(await getWorkspaceMessageDeliveryDetail(env, session, sent.message.id)).toMatchObject({
      status: 'sent', lastEvent: 'email.sent', attention: { kind: 'delayed', state: 'open' }
    });
  });

  test.each(['email.sent', 'email.delivery_delayed'] as const)('preserves %s replayed while a same-ID retry is still returning', async (type) => {
    const { env, session, database } = setup();
    const providerId = 're_slow_retry';
    const initial = await sendWorkspaceMessage(env, session, { toEmail: 'alice@example.net', subject: 'Slow retry', body: 'Body' }, {
      requestId: 'slow-retry-replay', gateway: new FakeOutboundGateway({ providerMessageId: providerId })
    });
    const messageId = initial.message.id;
    await applyResendDeliveryWebhook(env, 'slow-original-delay', {
      type: 'email.delivery_delayed', created_at: new Date(Date.now() - 4000).toISOString(), data: { email_id: providerId }
    });
    const retry = await retryWorkspaceMessageDelivery(env, session, messageId, { gateway: {
      async send() {
        database.query('UPDATE workspace_delivery_attempts SET started_at = ? WHERE message_id = ? AND attempt_number = 2')
          .run(new Date(Date.now() - 16 * 60_000).toISOString(), messageId);
        const event = await applyResendDeliveryWebhook(env, 'slow-deferred-event', {
          type, created_at: new Date().toISOString(), data: { email_id: providerId }
        });
        expect(event).toMatchObject({ matched: true, ignored: true });
        await reconcileDeferredResendEvents(env);
        return { status: 'submitted', providerMessageId: providerId, remoteStatus: 200 };
      }
    } });
    expect(retry?.message).toMatchObject({ deliveryLastEvent: type, deliveryAttempts: 2 });
    expect(await getWorkspaceMessageDeliveryDetail(env, session, messageId)).toMatchObject({
      status: type === 'email.sent' ? 'sent' : 'delayed', lastEvent: type
    });
    expect(database.query('SELECT status, provider_message_id FROM workspace_delivery_attempts WHERE message_id = ? AND attempt_number = 2').get(messageId))
      .toEqual({ status: 'submitted', provider_message_id: providerId });
  });

  test('records the successful HTTP response without replacing a same-ID bounce during retry', async () => {
    const { env, database, session } = setup();
    const providerId = 're_terminal_during_retry';
    const first = await sendWorkspaceMessage(env, session, { toEmail: 'alice@example.net', subject: 'Terminal retry', body: 'Body' }, {
      requestId: 'terminal-during-retry', gateway: new FakeOutboundGateway({ providerMessageId: providerId })
    });
    const id = first.message.id;
    await applyResendDeliveryWebhook(env, 'terminal-retry-delay', {
      type: 'email.delivery_delayed', created_at: new Date().toISOString(), data: { email_id: providerId }
    });
    const limited = await retryWorkspaceMessageDelivery(env, session, id, { gateway: new FakeOutboundGateway({
      error: new OutboundGatewayError('rate_limited', 'Rate limited', { remoteStatus: 429 })
    }) });
    expect(limited?.message.deliveryRemoteStatus).toBe(429);

    const bounceAt = new Date().toISOString();
    const retried = await retryWorkspaceMessageDelivery(env, session, id, { gateway: {
      async send() {
        const event = await applyResendDeliveryWebhook(env, 'terminal-retry-bounce', {
          type: 'email.bounced', created_at: bounceAt, data: { email_id: providerId }
        });
        expect(event).toMatchObject({ matched: true, ignored: false });
        return { status: 'submitted', providerMessageId: providerId, remoteStatus: 200 };
      }
    } });
    expect(retried?.message).toMatchObject({
      deliveryStatus: 'bounced', deliveryResultKind: 'permanent_failure', deliveryLastEvent: 'email.bounced',
      deliveryLastEventAt: bounceAt, deliveryRemoteStatus: 200, deliveryAttempts: 3
    });

    const current = { messageId: id, userId: session.userId, provider: 'resend', providerMessageId: providerId, attempts: 3 };
    for (const mismatch of [{ attempts: 2 }, { provider: 'fake' }, { providerMessageId: 're_other' }, { userId: 'other-owner' }]) {
      const result = await recordAcceptedResponseOnWebhookReceipt(env.DB, { ...current, ...mismatch }, 202).run();
      expect(result.meta.changes).toBe(0);
    }

    const d1 = env.DB as unknown as TestD1;
    d1.beforePrepare = (sql) => {
      if (!sql.includes('INSERT INTO workspace_outbound_receipts')) return;
      d1.beforePrepare = undefined;
      database.query('UPDATE workspace_outbound_receipts SET remote_status = 202 WHERE message_id = ?').run(id);
    };
    const laterBounceAt = new Date(Date.parse(bounceAt) + 1_000).toISOString();
    await applyResendDeliveryWebhook(env, 'terminal-retry-bounce-update', {
      type: 'email.bounced', created_at: laterBounceAt, data: { email_id: providerId }
    });
    expect(database.query('SELECT remote_status, last_event_at FROM workspace_outbound_receipts WHERE message_id = ?').get(id))
      .toEqual({ remote_status: 202, last_event_at: laterBounceAt });
    database.close();
  });

  test('rejects a retry if a definitive failure commits before the attempt is claimed', async () => {
    const { env, session, database } = setup();
    const sent = await sendWorkspaceMessage(env, session, { toEmail: 'alice@example.net', subject: 'Concurrent failure', body: 'Body' }, {
      requestId: 'terminal-before-claim', gateway: new FakeOutboundGateway({ providerMessageId: 're_race' })
    });
    await applyResendDeliveryWebhook(env, 'svix-race-delay', {
      type: 'email.delivery_delayed', created_at: new Date().toISOString(), data: { email_id: 're_race' }
    });
    const d1 = env.DB as unknown as TestD1;
    d1.beforePrepare = (sql) => {
      if (!sql.includes('UPDATE workspace_delivery_statuses AS delivery')) return;
      d1.beforePrepare = undefined;
      database.query("UPDATE workspace_delivery_statuses SET status = 'failed', last_event = 'email.failed' WHERE message_id = ?").run(sent.message.id);
    };
    const retryGateway = new FakeOutboundGateway({ providerMessageId: 're_race' });
    await expect(retryWorkspaceMessageDelivery(env, session, sent.message.id, { gateway: retryGateway }))
      .rejects.toMatchObject({ code: 'DELIVERY_NOT_RETRYABLE', reason: 'status_not_retryable' });
    expect(retryGateway.sent).toEqual([]);
    expect(database.query('SELECT attempt_number FROM workspace_delivery_attempts WHERE message_id = ?').all(sent.message.id))
      .toEqual([{ attempt_number: 1 }]);
    expect(await getWorkspaceMessageDeliveryDetail(env, session, sent.message.id)).toMatchObject({
      status: 'failed', attention: { kind: 'failed', state: 'open' }
    });
  });

  test('keeps a definitive provider failure and rejects a same-key acceptance replay', async () => {
    const { env, session } = setup();
    const sent = await sendWorkspaceMessage(env, session, { toEmail: 'alice@example.net', subject: 'Provider failure', body: 'Body' }, {
      requestId: 'provider-failure', gateway: new FakeOutboundGateway({ providerMessageId: 're_failed' })
    });
    await applyResendDeliveryWebhook(env, 'svix-failed', {
      type: 'email.failed', created_at: new Date().toISOString(), data: { email_id: 're_failed' }
    });
    const retryGateway = new FakeOutboundGateway({ providerMessageId: 're_failed' });
    await expect(retryWorkspaceMessageDelivery(env, session, sent.message.id, { gateway: retryGateway }))
      .rejects.toMatchObject({ code: 'DELIVERY_NOT_RETRYABLE', reason: 'result_not_retryable' });
    expect(retryGateway.sent).toEqual([]);
    expect(await getWorkspaceMessageDeliveryDetail(env, session, sent.message.id)).toMatchObject({
      status: 'failed', lastEvent: 'email.failed', attention: { kind: 'failed', state: 'open' }
    });
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
    const gateway = { async send() {
      await Bun.sleep(20);
      throw new OutboundGatewayError('network_unknown', 'outcome unknown');
    } };
    const result = await sendWorkspaceMessage(env, session,
      { toEmail: 'alice@example.net', subject: 'Hello', body: 'Body' },
      { requestId: 'compose-unknown', gateway });
    expect(result.message.deliveryStatus).toBe('submitting');
    expect(result.message.deliveryResultKind).toBe('temporary_failure');
    expect(database.query(`SELECT status, completed_at FROM workspace_delivery_attempts`).get())
      .toEqual({ status: 'submitting', completed_at: null });
    const timing = database.query<{ startedAt: string; reportedAt: string; eligibleAt: string }, []>(`
      SELECT attempt.started_at AS startedAt, receipt.last_event_at AS reportedAt, attention.eligible_at AS eligibleAt
      FROM workspace_delivery_attempts attempt
      JOIN workspace_outbound_receipts receipt USING (message_id)
      JOIN workspace_delivery_attention attention USING (message_id)
    `).get()!;
    expect(Date.parse(timing.reportedAt)).toBeGreaterThan(Date.parse(timing.startedAt));
    expect(timing.eligibleAt).toBe(new Date(Date.parse(timing.startedAt) + 15 * 60_000).toISOString());
    database.query(`UPDATE mail_addresses SET is_default_sender = 0 WHERE id = 'address-1'`).run();
    database.query(`INSERT INTO mail_addresses (
        id, owner_user_id, domain_id, email, local_part, display_name, signature,
        receive_enabled, send_enabled, lifecycle_status, routing_state, routing_owner, is_default_sender
      ) VALUES ('address-2', 'user-1', 'domain-1', 'other@example.test', 'other', 'Other sender', '-- Changed signature',
        1, 1, 'active', 'active', 'flaremail', 1)`).run();

    const retryGateway = new FakeOutboundGateway({ providerMessageId: 're_after_unknown' });
    const retried = await retryWorkspaceMessageDelivery({ ...env, OUTBOUND_FROM_EMAIL: 'legacy@elsewhere.test', OUTBOUND_FROM_NAME: 'Legacy' }, session, result.message.id, { gateway: retryGateway });
    expect(retried?.message.deliveryStatus).toBe('submitted');
    expect(retryGateway.sent[0]?.idempotencyKey).toBe('flaremail:send:user-1:compose-unknown');
    expect(retryGateway.sent[0]?.from).toBe('FlareMail <mail@example.test>');
    expect(retryGateway.sent[0]?.text).toBe('Body\n\n-- Owner');
    expect(retryGateway.sent[0]?.replyTo).toBeUndefined();
    expect(database.query(`SELECT status, attempts, provider_message_id FROM workspace_delivery_statuses`).get())
      .toEqual({ status: 'submitted', attempts: 2, provider_message_id: 're_after_unknown' });
  });

  test('does not change a persisted delivery state when its original sender is disabled', async () => {
    const { database, env, session } = setup();
    const firstGateway = new FakeOutboundGateway({ error: new OutboundGatewayError('network_unknown', 'outcome unknown') });
    const sent = await sendWorkspaceMessage(env, session, { toEmail: 'alice@example.net', subject: 'Retry guard', body: 'Body' }, {
      requestId: 'retry-disabled-sender', gateway: firstGateway
    });
    database.query(`UPDATE mail_addresses SET send_enabled = 0, is_default_sender = 0 WHERE id = 'address-1'`).run();
    const retryGateway = new FakeOutboundGateway({ providerMessageId: 'must_not_submit' });

    await expect(retryWorkspaceMessageDelivery(env, session, sent.message.id, { gateway: retryGateway }))
      .rejects.toMatchObject({ code: 'OUTBOUND_SENDER_DISABLED' });
    expect(retryGateway.sent).toHaveLength(0);
    expect(database.query(`SELECT status, attempts FROM workspace_delivery_statuses WHERE message_id = ?`).get(sent.message.id))
      .toEqual({ status: 'submitting', attempts: 1 });
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

  test('sends a large draft from its canonical body and refuses edited projections', async () => {
    const { env, database, session } = setup();
    const large = 'canonical-tail😀'.repeat(30_000);
    const draft = await saveWorkspaceDraft(env, session, {
      toEmail: 'alice@example.net', subject: 'Large draft', body: large
    });
    const stored = database.query('SELECT body, body_object_id FROM workspace_drafts WHERE id = ?').get(draft.message.id) as {
      body: string; body_object_id: string;
    };
    expect(stored.body.length).toBeLessThan(large.length);

    const legacyGateway = new FakeOutboundGateway({ providerMessageId: 're_large_legacy' });
    await sendWorkspaceMessage(env, session, {
      draftId: draft.message.id,
      toEmail: 'alice@example.net',
      subject: 'Large draft',
      body: stored.body
    }, { gateway: legacyGateway });
    expect(legacyGateway.sent[0]?.text).toBe(`${large}\n\n-- Owner`);

    const second = await saveWorkspaceDraft(env, session, {
      toEmail: 'alice@example.net', subject: 'Large draft 2', body: large
    });
    const secondStored = database.query('SELECT body FROM workspace_drafts WHERE id = ?').get(second.message.id) as { body: string };
    await expect(sendWorkspaceMessage(env, session, {
      draftId: second.message.id,
      toEmail: 'alice@example.net',
      subject: 'Large draft 2',
      body: `${secondStored.body}edited without canonical load`
    }, { gateway: new FakeOutboundGateway() })).rejects.toBeInstanceOf(DraftBodyReloadRequiredError);
    expect(database.query('SELECT id FROM workspace_drafts WHERE id = ?').get(second.message.id)).not.toBeNull();

    const edited = `${large}\ncanonical edit`;
    const editedGateway = new FakeOutboundGateway({ providerMessageId: 're_large_edited' });
    await sendWorkspaceMessage(env, session, {
      draftId: second.message.id,
      bodyRevision: second.bodyRevision ?? undefined,
      toEmail: 'alice@example.net',
      subject: 'Large draft 2',
      body: edited
    }, { gateway: editedGateway });
    expect(editedGateway.sent[0]?.text).toBe(`${edited}\n\n-- Owner`);
  });

  test('atomically transfers verified draft attachments and reuses them on same-key retry', async () => {
    const { env, database, session } = setup();
    const draft = await saveWorkspaceDraft(env, session, {
      toEmail: 'alice@example.net', subject: 'Attached', body: 'See attachment.'
    });
    const attachmentId = '019d1234-5678-4abc-8def-0123456789ab';
    const key = `outbound/v1/2026-08-19/${attachmentId}/019d1234-5678-4abc-8def-1123456789ab.bin`;
    const attachmentBytes = new TextEncoder().encode('verified attachment');
    const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', attachmentBytes))]
      .map((byte) => byte.toString(16).padStart(2, '0')).join('');
    await env.BUCKET.put(key, attachmentBytes);
    database.query(`INSERT INTO workspace_attachments
      (id, user_id, message_id, filename, content_type, size, inline, content_id, r2_key, relation_type, state, sha256, disposition, updated_at)
      VALUES (?, 'user-1', ?, 'evidence.txt', 'text/plain', ?, 0, NULL, ?, 'draft', 'ready', ?, 'attachment', '2026-08-19T00:00:00.000Z')`)
      .run(attachmentId, draft.message.id, attachmentBytes.byteLength, key, sha256);
    database.query(`UPDATE workspace_drafts SET attachment_revision = 1 WHERE id = ?`).run(draft.message.id);

    await expect(sendWorkspaceMessage(env, session, {
      draftId: draft.message.id, attachmentRevision: 0, toEmail: 'alice@example.net', subject: 'Attached', body: 'See attachment.'
    }, { gateway: new FakeOutboundGateway() })).rejects.toBeInstanceOf(DraftConflictError);
    expect(database.query(`SELECT id FROM workspace_drafts WHERE id = ?`).get(draft.message.id)).not.toBeNull();

    const firstGateway = new FakeOutboundGateway({ error: new OutboundGatewayError('network_unknown', 'outcome unknown') });
    const sent = await sendWorkspaceMessage(env, session, {
      draftId: draft.message.id, attachmentRevision: 1, toEmail: 'alice@example.net', subject: 'Attached', body: 'See attachment.'
    }, { gateway: firstGateway });
    expect(firstGateway.sent[0]?.attachments?.[0]).toMatchObject({ filename: 'evidence.txt', contentType: 'text/plain' });
    expect([...firstGateway.sent[0]!.attachments![0]!.bytes]).toEqual([...attachmentBytes]);
    expect(sent.message.labels).toContain('Attachment');
    expect(database.query(`SELECT relation_type, message_id, state FROM workspace_attachments WHERE id = ?`).get(attachmentId))
      .toEqual({ relation_type: 'message', message_id: sent.message.id, state: 'ready' });
    expect(database.query(`SELECT id FROM workspace_drafts WHERE id = ?`).get(draft.message.id)).toBeNull();
    expect((env.BUCKET as unknown as TestBucket).objects.has(key)).toBe(true);

    const retryGateway = new FakeOutboundGateway({ providerMessageId: 're_attachment_retry' });
    const retried = await retryWorkspaceMessageDelivery(env, session, sent.message.id, { gateway: retryGateway });
    expect(retried?.message.deliveryStatus).toBe('submitted');
    expect([...retryGateway.sent[0]!.attachments![0]!.bytes]).toEqual([...attachmentBytes]);
    expect(retryGateway.sent[0]?.idempotencyKey).toBe(`flaremail:send:${sent.message.id}`);
  });

  test('rejects oversized persisted attachment metadata before reading R2 bytes', async () => {
    const { env, database, session } = setup();
    const draft = await saveWorkspaceDraft(env, session, {
      toEmail: 'alice@example.net', subject: 'Oversized attachment', body: 'Do not read the object.'
    });
    const attachmentId = '019d1234-5678-4abc-8def-4123456789ab';
    database.query(`INSERT INTO workspace_attachments
      (id, user_id, message_id, filename, content_type, size, inline, content_id, r2_key, relation_type, state, sha256, disposition, updated_at)
      VALUES (?, 'user-1', ?, 'oversized.bin', 'application/octet-stream', ?, 0, NULL, 'missing-oversized-object', 'draft', 'ready', ?, 'attachment', '2026-08-19T00:00:00.000Z')`)
      .run(attachmentId, draft.message.id, MAX_OUTBOUND_ATTACHMENT_BYTES + 1, '0'.repeat(64));
    database.query(`UPDATE workspace_drafts SET attachment_revision = 1 WHERE id = ?`).run(draft.message.id);

    await expect(sendWorkspaceMessage(env, session, {
      draftId: draft.message.id,
      attachmentRevision: 1,
      toEmail: 'alice@example.net',
      subject: 'Oversized attachment',
      body: 'Do not read the object.'
    }, { gateway: new FakeOutboundGateway() })).rejects.toMatchObject({ kind: 'configuration' });
    expect(database.query('SELECT COUNT(*) AS count FROM workspace_messages').get()).toEqual({ count: 0 });
  });

  test('sends without logically removed attachments while their cleanup pointer remains durable', async () => {
    const { env, database, session } = setup();
    const draft = await saveWorkspaceDraft(env, session, {
      toEmail: 'alice@example.net', subject: 'Removed attachment', body: 'No attachment remains.'
    });
    const attachmentId = '019d1234-5678-4abc-8def-2123456789ab';
    const key = `outbound/v1/2026-08-19/${attachmentId}/019d1234-5678-4abc-8def-3123456789ab.bin`;
    database.query(`INSERT INTO workspace_attachments
      (id, user_id, message_id, filename, content_type, size, inline, content_id, r2_key, relation_type, state, disposition, updated_at, delete_after)
      VALUES (?, 'user-1', ?, 'removed.txt', 'text/plain', 1, 0, NULL, ?, 'draft', 'delete_pending', 'attachment',
        '2026-08-19T00:00:00.000Z', '2026-08-20T00:00:00.000Z')`)
      .run(attachmentId, draft.message.id, key);
    database.query(`UPDATE workspace_drafts SET attachment_revision = 1 WHERE id = ?`).run(draft.message.id);
    const gateway = new FakeOutboundGateway({ providerMessageId: 're_without_removed' });

    const sent = await sendWorkspaceMessage(env, session, {
      draftId: draft.message.id,
      attachmentRevision: 1,
      toEmail: 'alice@example.net',
      subject: 'Removed attachment',
      body: 'No attachment remains.'
    }, { gateway });

    expect(gateway.sent[0]?.attachments).toBeUndefined();
    expect(sent.message.labels).not.toContain('Attachment');
    expect(database.query(`SELECT state, r2_key FROM workspace_attachments WHERE id = ?`).get(attachmentId))
      .toEqual({ state: 'delete_pending', r2_key: key });
  });
});
