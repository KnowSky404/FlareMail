import { expect, test } from 'bun:test';
import type { CloudflareEnv } from '$lib/server/cloudflare';
import { prepareBodyObject } from '$lib/server/body';
import { getMcpMessage, rfcThreadKey, searchMail } from './mail';
import { openMcpTestDatabase } from './d1.test-fixture';

const actor = {
  owner: 'owner',
  profile: { name: 'Owner', role: 'Owner', email: 'owner@example.test',
    company: '', location: '', timezone: 'UTC', forwardingEnabled: false, signature: '' }
};

test('scopes paginated search and direct reads to visible owner mail and limits exported text', async () => {
  using fixture = openMcpTestDatabase();
  const { db, database } = fixture;
  const ts = '2026-11-26T10:00:00.000Z';
  const workspace = database.query(`
    INSERT INTO workspace_messages
      (id, user_id, folder, from_name, from_email, to_name, to_email, subject, body, sent_at, deleted_at, archived_at, message_id, thread_key)
    VALUES (?, ?, ?, 'Sender', 'sender@example.test', 'Owner', 'owner@example.test', '续费 reminder', 'inline body', ?, ?, ?, ?, ?)`);
  workspace.run('A-sent', 'owner', 'sent', ts, null, null, '<thread@example.test>', 'rfc:thread@example.test');
  workspace.run('Z-archive', 'owner', 'inbox', ts, null, ts, '<thread@example.test>', 'rfc:<thread@example.test>');
  workspace.run('lost', 'owner', 'inbox', ts, ts, null, null, null);
  workspace.run('other-mail', 'other', 'inbox', ts, null, null, null, null);

  const inbound = database.query(`
    INSERT INTO email_messages (id, owner_user_id, "from", "to", subject, "timestamp", text_body, html_body,
      raw_key, to_json, cc_json, message_id, in_reply_to, thread_key)
    VALUES (?, 'owner', 'Sender <sender@example.test>', 'delivery@example.test', '续费 reminder', ?, '', ?,
      'raw/demo.eml', '[{"name":"MIME","email":"mime@example.test"}]', '[{"name":"Copy","email":"cc@example.test"}]',
      '<child@example.test>', '<thread@example.test>', 'rfc:thread@example.test')`);
  inbound.run('visible', ts, '<p>Allowed text</p><script>hiddenScript()</script><img src="https://invalid.test/example.png">');
  inbound.run('quarantined', ts, '<p>hidden</p>');
  database.exec(`UPDATE email_messages SET cc = 'Legacy Copy <cc@example.test>', cc_json = '[]' WHERE id = 'visible'`);
  database.query(`INSERT INTO workspace_email_states (id, user_id, email_message_id, quarantined_at)
    VALUES ('state-1', 'owner', 'quarantined', ?)`).run(ts);
  database.exec(`INSERT INTO workspace_drafts (id, user_id, subject, body)
    VALUES ('draft', 'owner', '续费 reminder', 'draft text'), ('deleted-draft', 'owner', '续费 reminder', 'draft text');`);
  database.query("UPDATE workspace_drafts SET deleted_at = ? WHERE id = 'deleted-draft'").run(ts);

  const body = (await prepareBodyObject('workspace_message', 'A-sent', '安全'.repeat(16_000), '', { force: true }))!;
  database.query(`INSERT INTO mail_body_objects
    (id, owner_user_id, entity_type, entity_id, r2_key, size_bytes, sha256, text_bytes, html_bytes, created_at, updated_at)
    VALUES (?, 'owner', 'workspace_message', 'A-sent', ?, ?, ?, ?, 0, ?, ?)`)
    .run(body.id, body.key, body.sizeBytes, body.sha256, body.textBytes, ts, ts);
  database.query("UPDATE workspace_messages SET body_object_id = ? WHERE id = 'A-sent'").run(body.id);
  const reads: string[] = [];
  const env = { DB: db, BUCKET: {
    get: async (key: string) => {
      reads.push(key);
      return key === body.key ? { size: body.sizeBytes, arrayBuffer: async () => body.bytes.buffer } : null;
    }
  } as R2Bucket } satisfies CloudflareEnv;
  const signal = new AbortController().signal;

  const first = await searchMail(env, actor, { query: '续费', limit: 1 });
  expect(first.messages.map((item) => item.id)).toEqual(['email:visible']);
  expect(first.messages[0]?.envelopeRecipient).toBe('delivery@example.test');
  expect(first.messages[0]?.toAddresses).toEqual([{ name: 'MIME', email: 'mime@example.test' }]);
  expect(first.messages[0]?.ccAddresses?.[0]?.email).toBe('cc@example.test');
  const next = await searchMail(env, actor, { query: '续费', limit: 2, cursor: first.nextCursor! });
  expect(next.messages.map((item) => item.id)).toEqual(['Z-archive', 'A-sent']);
  expect(next.nextCursor).toBeNull();
  expect(await searchMail(env, actor, { query: 'from:sender', envelopeRecipient: 'delivery@example.test' }))
    .toMatchObject({ messages: [{ id: 'email:visible' }] });
  await expect(searchMail(env, actor, { query: 'other', cursor: first.nextCursor! })).rejects.toMatchObject({ status: 400 });
  expect((await searchMail(env, actor, { folder: 'drafts' })).messages.map(({ id }) => id)).toEqual(['draft']);
  expect(reads).toEqual([]);

  expect(await getMcpMessage(env, actor, 'email:visible', { signal })).toMatchObject({ body: 'Allowed text', truncated: false,
    message: { ccAddresses: [{ name: 'Legacy Copy', email: 'cc@example.test' }] } });
  expect(await getMcpMessage(env, actor, 'A-sent', { signal })).toMatchObject({ body: '安全'.repeat(4096), truncated: true });
  expect(reads).toEqual([body.key]);
  expect(rfcThreadKey(first.messages[0]!)).toBe('rfc:thread@example.test');
  workspace.run('stale-rfc', 'owner', 'inbox', ts, null, null, '<unrelated@example.test>', 'rfc:thread@example.test');
  const thread = await searchMail(env, actor, {}, 'rfc:thread@example.test');
  expect(thread.messages.map(({ id }) => id)).toEqual(['email:visible', 'Z-archive', 'A-sent']);
  const threadFirst = await searchMail(env, actor, { limit: 1 }, 'rfc:thread@example.test');
  expect(threadFirst.messages.map(({ id }) => id)).toEqual(['email:visible']);
  expect(threadFirst.nextCursor).toBeString();
  const threadNext = await searchMail(env, actor, { limit: 1, cursor: threadFirst.nextCursor! }, 'rfc:thread@example.test');
  expect(threadNext.messages.map(({ id }) => id)).toEqual(['Z-archive']);

  for (const id of ['email:quarantined', 'lost', 'other-mail', 'draft']) {
    await expect(getMcpMessage(env, actor, id, { signal })).rejects.toMatchObject({ status: 404 });
  }
  await expect(getMcpMessage(env, actor, 'deleted-draft', { includeDraft: true, signal })).rejects.toMatchObject({ status: 404 });
  const flags = database.query("SELECT is_read, is_starred, archived_at, deleted_at FROM workspace_messages WHERE id = 'A-sent'").get();
  expect(flags).toEqual({ is_read: 0, is_starred: 0, archived_at: null, deleted_at: null });
  expect(database.query("SELECT COUNT(*) AS count FROM workspace_email_states WHERE email_message_id = 'visible'").get()).toEqual({ count: 0 });
});
