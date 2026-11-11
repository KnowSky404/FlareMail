import { afterEach, describe, expect, test } from 'bun:test';
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { prepareBodyObject } from '$lib/server/body';
import { insertBodyObject } from '$lib/server/db/body';
import type { CloudflareEnv } from '$lib/server/cloudflare';
import type { WorkspaceContext } from '$lib/server/workspace/shared';
import { workspaceMailAi } from '$lib/server/workspace/ai';
import { claimMailAi, consumeMailAiQuota, finishMailAi, readMailAi } from '$lib/server/db/mail-ai';
import { GET, POST } from '../../../routes/api/workspace/messages/[id]/ai/+server';
import type { MailAiProvider } from './provider';

class Statement {
  values: SQLQueryBindings[] = [];
  constructor(private db: Database, private sql: string) {}
  bind(...values: unknown[]) { this.values = values as SQLQueryBindings[]; return this; }
  async first<T>() { return this.db.query(this.sql).get(...this.values) as T | null; }
  async run() { const result = this.db.query(this.sql).run(...this.values); return { meta: { changes: Number(result.changes) } }; }
}
const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const session = (userId = 'owner'): WorkspaceContext => ({ id: 'session', userId, storage: 'd1', incomingSequence: 0, createdAt: '', updatedAt: '',
  profile: { name: 'Owner', role: 'Owner', email: 'owner@example.test', company: '', location: '', timezone: 'UTC', forwardingEnabled: false, signature: '' } });
function setup() {
  const sqlite = new Database(':memory:'); databases.push(sqlite);
  sqlite.exec(readFileSync(new URL('../../../../schema.sql', import.meta.url), 'utf8'));
  sqlite.exec(`INSERT INTO email_messages (id, "from", "to", subject, timestamp, snippet, raw_key, owner_user_id, text_body)
    VALUES ('mail', 'Sender <sender@example.test>', 'owner@example.test', 'Meeting', '2026-11-11', '', 'raw/mail', 'owner', 'Meet on November 12.');`);
  const db = { prepare: (sql: string) => new Statement(sqlite, sql) } as unknown as D1Database;
  const env = { DB: db, AI_ENABLED: 'true', AI_BASE_URL: 'https://maas.vendor.com/v1', AI_API_KEY: 'fake-secret', AI_MODEL: 'fake-model' } as CloudflareEnv;
  let calls = 0;
  const provider: MailAiProvider = { analyze: async (input) => { calls++; return {
    summary: input.language === 'en' ? 'A meeting invitation.' : '会议邀请。', keyPoints: [], actionItems: [], dates: ['November 12'], language: input.language,
    suggestion: { category: 'updates', confidence: 0.8, reason: 'Meeting update' }
  }; } };
  const analyze = (regenerate = false) => workspaceMailAi(env, session(), 'email:mail', { language: 'en', analyze: true, regenerate }, provider);
  const get = () => workspaceMailAi(env, session(), 'email:mail', { language: 'en' }, provider);
  const key = { owner: 'owner', kind: 'inbound' as const, id: 'mail' };
  const cooldown = () => sqlite.exec('UPDATE mail_ai_analyses SET updated_at = 0, lease_until = 0');
  return { sqlite, env, db, provider, analyze, get, key, cooldown, calls: () => calls };
}

describe('mail AI persistence and ownership', () => {
  test('GET never calls provider; generation persists and later requests reuse cache without changing categories', async () => {
    const f = setup();
    expect((await f.get()).status).toBe('empty'); expect(f.calls()).toBe(0);
    expect((await f.analyze()).status).toBe('ready');
    expect((await f.get()).analysis?.summary).toBe('A meeting invitation.');
    await f.analyze(); expect(f.calls()).toBe(1);
    expect(f.sqlite.query('SELECT inbox_category FROM email_messages').get()).toEqual({ inbox_category: null });
    f.sqlite.exec("UPDATE email_messages SET inbox_category = 'social'");
    f.cooldown(); await f.analyze(true);
    expect(f.calls()).toBe(2);
    expect(f.sqlite.query('SELECT inbox_category FROM email_messages').get()).toEqual({ inbox_category: 'social' });
  });
  test('configuration missing or disabled makes no external request', async () => {
    const f = setup();
    f.sqlite.exec("UPDATE email_messages SET body_object_id = 'missing-canonical'");
    f.env.AI_ENABLED = 'false'; expect((await f.analyze()).status).toBe('disabled');
    f.env.AI_ENABLED = 'true'; delete f.env.AI_API_KEY; expect((await f.analyze()).status).toBe('unconfigured');
    expect(f.calls()).toBe(0);
  });
  test('rejects other Owners, trash, quarantine, blocked senders and missing messages', async () => {
    const f = setup();
    await expect(workspaceMailAi(f.env, session('other'), 'email:mail', { language: 'en', analyze: true }, f.provider)).rejects.toMatchObject({ status: 404 });
    f.sqlite.exec("INSERT INTO workspace_email_states (id, user_id, email_message_id, quarantined_at) VALUES ('state','owner','mail','now')");
    await expect(f.analyze()).rejects.toMatchObject({ code: 'AI_MESSAGE_UNSUPPORTED' });
    f.sqlite.exec("UPDATE workspace_email_states SET quarantined_at = NULL, deleted_at = 'now'");
    await expect(f.analyze()).rejects.toMatchObject({ status: 404 });
    f.sqlite.exec('DELETE FROM workspace_email_states');
    f.sqlite.exec("INSERT INTO blocked_senders VALUES ('owner', 'sender@example.test', 'now')");
    await expect(f.analyze()).rejects.toMatchObject({ code: 'AI_MESSAGE_UNSUPPORTED' });
    expect(f.calls()).toBe(0);
  });
  test('invalidates model, language, content (including truncated tails) and input coverage', async () => {
    const f = setup(); await f.analyze();
    f.env.AI_API_FORMAT = 'responses'; expect((await f.get()).analysis).toBeNull();
    f.cooldown(); await f.analyze();
    f.env.AI_MODEL = 'new-model'; expect((await f.get()).analysis).toBeNull();
    f.cooldown(); await f.analyze();
    expect((await workspaceMailAi(f.env, session(), 'email:mail', { language: 'zh-CN' }, f.provider)).analysis).toBeNull();
    f.sqlite.query('UPDATE email_messages SET text_body = ?').run('November 12. ' + 'a'.repeat(20000));
    expect((await f.get()).analysis).toBeNull(); f.cooldown(); await f.analyze();
    f.sqlite.query('UPDATE email_messages SET text_body = text_body || ?').run('tail changed');
    expect((await f.get()).analysis).toBeNull(); f.cooldown(); await f.analyze();
    f.env.AI_MAX_INPUT_CHARS = '8000'; expect((await f.get()).analysis).toBeNull();
  });
  test('empty text fails; HTML-only email is analyzed as safe plain text', async () => {
    const f = setup(); f.sqlite.exec("UPDATE email_messages SET text_body = ''");
    await expect(f.analyze()).rejects.toMatchObject({ code: 'AI_BODY_EMPTY' });
    f.sqlite.exec("UPDATE email_messages SET html_body = '<script>secret</script><p>November 12.</p>'");
    expect((await f.analyze()).status).toBe('ready');
  });
  test('two concurrent requests make one billable call and leases recover after interruption', async () => {
    const f = setup();
    const settled = await Promise.allSettled([f.analyze(), f.analyze()]);
    expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1); expect(f.calls()).toBe(1);
    f.cooldown();
    const token = await claimMailAi(f.db, f.key, 'new', 'model', true, 100000);
    expect(token).not.toBeNull();
    expect(await claimMailAi(f.db, f.key, 'new', 'model', true, 100001)).toBeNull();
    const next = await claimMailAi(f.db, f.key, 'new', 'model', true, 160001);
    expect(next).not.toBeNull();
    expect((await finishMailAi(f.db, f.key, token!, '{}')).meta.changes).toBe(0);
  });
  test('provider failure releases claim; explicit retry recovers after cooldown', async () => {
    const f = setup();
    await expect(workspaceMailAi(f.env, session(), 'email:mail', { language: 'en', analyze: true }, { analyze: async () => { throw new Error('fake failure'); } })).rejects.toThrow();
    expect((await readMailAi(f.db, f.key))?.status).toBe('failed');
    f.cooldown(); expect((await f.analyze()).status).toBe('ready');
  });
  test('permanent deletion cleans cache and in-flight results cannot resurrect it; soft delete and archive retain it', async () => {
    const f = setup(); await f.analyze();
    f.sqlite.exec("INSERT INTO workspace_email_states (id,user_id,email_message_id,deleted_at,archived_at) VALUES ('state','owner','mail','now','now')");
    expect(await readMailAi(f.db, f.key)).not.toBeNull();
    f.sqlite.exec('DELETE FROM workspace_email_states'); f.cooldown();
    await expect(workspaceMailAi(f.env, session(), 'email:mail', { language: 'en', analyze: true, regenerate: true }, { analyze: async (input) => {
      f.sqlite.exec("DELETE FROM email_messages WHERE id = 'mail'"); return f.provider.analyze(input);
    } })).rejects.toMatchObject({ status: 404 });
    expect(await readMailAi(f.db, f.key)).toBeNull();
    expect(await claimMailAi(f.db, f.key, 'missing', 'model', true)).toBeNull();
  });
  test('atomic claims reject newly blocked canonical senders for either source', async () => {
    const f = setup();
    f.sqlite.exec(`INSERT INTO workspace_messages (id,user_id,folder,from_name,from_email,to_name,to_email,subject,preview,body,sent_at,labels_json,is_read,is_starred,created_at,updated_at)
      VALUES ('workspace','owner','inbox','Sender','Sender <sender@example.test>','Owner','owner@example.test','','','body','now','[]',0,0,'now','now')`);
    f.sqlite.exec("INSERT INTO blocked_senders VALUES ('owner','sender@example.test','now')");
    expect(await claimMailAi(f.db, f.key, 'hash', 'model', false)).toBeNull();
    expect(await claimMailAi(f.db, { ...f.key, kind: 'workspace', id: 'workspace' }, 'hash', 'model', false)).toBeNull();
  });
  test('limits hourly cost independently of mail delivery limits', async () => {
    const f = setup();
    for (let i = 0; i < 30; i++) expect(await consumeMailAiQuota(f.db, 'owner', 10000 + i)).toBe(true);
    expect(await consumeMailAiQuota(f.db, 'owner', 11000)).toBe(false);
    expect(await consumeMailAiQuota(f.db, 'other', 11000)).toBe(true);
    expect(await consumeMailAiQuota(f.db, 'owner', 3610001)).toBe(true);
  });
});

function event(env: CloudflareEnv, payload?: unknown, authenticated = true) {
  const url = new URL('https://mail.test/api/workspace/messages/email:mail/ai?language=en');
  return { url, params: { id: 'email:mail' }, platform: { env }, locals: { workspaceSession: authenticated ? session() : null },
    request: new Request(url, payload === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }) } as never;
}
test('AI routes enforce auth, no-store, bounded input and reject caller-supplied body/model/URL', async () => {
  const f = setup();
  expect((await GET(event(f.env, undefined, false))).status).toBe(401);
  const response = await GET(event(f.env)); expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toContain('no-store');
  expect(JSON.stringify(await response.json())).not.toContain('fake-secret');
  for (const payload of [{ language: 'en', body: 'other mail' }, { language: 'en', model: 'other' }, { language: 'en', baseUrl: 'https://evil.com' }, { language: 'xx' }, { language: ['en'] }, { language: { toString: 'en' } }, { language: 'en', regenerate: 'yes' }, null]) {
    expect((await POST(event(f.env, payload))).status).toBe(400);
  }
  expect(f.calls()).toBe(0);
});

test('workspace inbox analyses retain identity, reject sent/drafts, and retain archived cache', async () => {
  const f = setup();
  f.sqlite.exec(`INSERT INTO workspace_messages (id,user_id,folder,from_name,from_email,to_name,to_email,subject,preview,body,text_body,sent_at,labels_json,is_read,is_starred,created_at,updated_at)
    VALUES ('workspace','owner','inbox','Sender','sender@example.test','Owner','owner@example.test','Meeting','','Meet on November 12.','Meet on November 12.','now','[]',0,0,'now','now')`);
  const analyze = () => workspaceMailAi(f.env, session(), 'workspace', { language: 'en', analyze: true }, f.provider);
  expect((await analyze()).status).toBe('ready');
  f.sqlite.exec("UPDATE workspace_messages SET archived_at = 'now'");
  await analyze(); expect(f.calls()).toBe(1);
  expect(f.sqlite.query('SELECT from_email, to_email, inbox_category FROM workspace_messages').get()).toEqual({ from_email: 'sender@example.test', to_email: 'owner@example.test', inbox_category: null });
  f.sqlite.exec("UPDATE workspace_messages SET folder = 'sent', archived_at = NULL");
  await expect(analyze()).rejects.toMatchObject({ code: 'AI_MESSAGE_UNSUPPORTED' });
  await expect(workspaceMailAi(f.env, session(), 'missing-draft', { language: 'en', analyze: true }, f.provider)).rejects.toMatchObject({ status: 404 });
  f.sqlite.exec("DELETE FROM workspace_messages WHERE id = 'workspace'");
  expect(await readMailAi(f.db, { owner: 'owner', kind: 'workspace', id: 'workspace' })).toBeNull();
});

test('R2 canonical body verification, full-content cache identity and safe missing/corrupt failures', async () => {
  const f = setup();
  async function attach(text: string) {
    const object = await prepareBodyObject('email_message', 'mail', text, '', { force: true });
    if (!object) throw new Error('Expected canonical object');
    await insertBodyObject(f.db, { id: object.id, owner_user_id: 'owner', entity_type: 'email_message', entity_id: 'mail', r2_key: object.key,
      size_bytes: object.sizeBytes, sha256: object.sha256, text_bytes: object.textBytes, html_bytes: object.htmlBytes, createdAt: new Date().toISOString() }).run();
    f.sqlite.query('UPDATE email_messages SET body_object_id = ?').run(object.id);
    f.env.BUCKET = { get: async () => ({ size: object.sizeBytes, arrayBuffer: async () => object.bytes.buffer }) } as unknown as R2Bucket;
    return object;
  }
  await attach('November 12. ' + 'a'.repeat(20000));
  expect((await f.analyze()).truncated).toBe(true);
  expect((await f.get()).status).toBe('ready'); expect(f.calls()).toBe(1);
  await attach('November 12. ' + 'a'.repeat(20000) + 'changed tail');
  expect((await f.get()).status).toBe('empty');
  f.cooldown(); await f.analyze(); expect(f.calls()).toBe(2);
  f.env.BUCKET = { get: async () => null } as unknown as R2Bucket;
  await expect(f.get()).rejects.toMatchObject({ code: 'AI_BODY_UNAVAILABLE' });
  f.env.BUCKET = { get: async () => ({ size: 1, arrayBuffer: async () => new Uint8Array([0]).buffer }) } as unknown as R2Bucket;
  await expect(f.get()).rejects.toMatchObject({ code: 'AI_BODY_UNAVAILABLE' });
  delete (f.env as Partial<CloudflareEnv>).BUCKET;
  await expect(f.get()).rejects.toMatchObject({ code: 'AI_BODY_UNAVAILABLE' });
  expect(f.calls()).toBe(2);
});

test('body or subject changes during a provider call cannot publish stale results', async () => {
  for (const change of ["UPDATE email_messages SET text_body = 'New November 12 content'", "UPDATE email_messages SET subject = 'Changed subject'"]) {
    const f = setup();
    await expect(workspaceMailAi(f.env, session(), 'email:mail', { language: 'en', analyze: true }, { analyze: async (input) => {
      f.sqlite.exec(change); return f.provider.analyze(input);
    } })).rejects.toMatchObject({ code: 'AI_CONTENT_CHANGED' });
    expect((await readMailAi(f.db, f.key))?.status).toBe('failed');
  }
});

test('Owner deletion cleans analyses and generation quotas', async () => {
  const f = setup();
  f.sqlite.exec(`INSERT INTO workspace_users (id,login_email,name,role,email,company,location,timezone,forwarding_enabled,signature,incoming_sequence)
    VALUES ('owner','owner@example.test','Owner','Owner','owner@example.test','','','UTC',0,'',0)`);
  await f.analyze();
  f.sqlite.exec("DELETE FROM workspace_users WHERE id = 'owner'");
  expect(await readMailAi(f.db, f.key)).toBeNull();
  expect(f.sqlite.query('SELECT COUNT(*) AS n FROM mail_ai_rate_limits').get()).toEqual({ n: 0 });
});
