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
import { readMailAiSettings, saveMailAiSettings } from './settings';

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


async function saveLanguages(env: CloudflareEnv, summaryLanguage: string, backgroundLanguage: 'zh-CN' | 'en') {
  env.AI_SETTINGS_KEY = 'a'.repeat(64);
  const view = await readMailAiSettings(env, 'owner');
  return saveMailAiSettings(env, 'owner', { ...view.settings, revision: view.revision, summaryLanguage, backgroundLanguage });
}

test('saved custom language overrides browser context and shares cache with background notifications', async () => {
  const f = setup();
  await saveLanguages(f.env, 'ZH-tw', 'en');
  const generated = await f.analyze();
  expect(generated).toMatchObject({ language: 'zh-TW', analysis: { language: 'zh-TW' } });
  expect(await workspaceMailAi(f.env, session(), 'email:mail', { language: 'zh-CN' }, f.provider)).toMatchObject({ status: 'ready', language: 'zh-TW' });
  expect(await workspaceMailAi(f.env, session(), 'email:mail', { analyze: true }, f.provider)).toMatchObject({ status: 'ready', language: 'zh-TW' });
  expect(f.calls()).toBe(1);
  const response = await GET(event(f.env));
  expect(await response.json()).toMatchObject({ data: { status: 'ready', language: 'zh-TW' } });
  await saveLanguages(f.env, 'ja', 'en');
  expect(await f.get()).toMatchObject({ status: 'empty', language: 'ja', analysis: null });
  expect(f.calls()).toBe(1);
});

test('automatic language follows web context, then saved background context, and invalidates only the resolved cache', async () => {
  const f = setup(); await saveLanguages(f.env, 'auto', 'en');
  await f.analyze();
  expect(await workspaceMailAi(f.env, session(), 'email:mail', {}, f.provider)).toMatchObject({ status: 'ready', language: 'en' });
  expect(await workspaceMailAi(f.env, session(), 'email:mail', { language: 'zh-CN' }, f.provider)).toMatchObject({ status: 'empty', language: 'zh-CN' });
  await saveLanguages(f.env, 'auto', 'zh-CN');
  expect(await workspaceMailAi(f.env, session(), 'email:mail', {}, f.provider)).toMatchObject({ status: 'empty', language: 'zh-CN' });
  expect(await f.get()).toMatchObject({ status: 'ready', language: 'en' });
  expect(f.calls()).toBe(1);
});

test('background analysis has a Chinese default without saved settings', async () => {
  const f = setup();
  expect(await workspaceMailAi(f.env, session(), 'email:mail', { analyze: true }, f.provider)).toMatchObject({ status: 'ready', language: 'zh-CN', analysis: { language: 'zh-CN' } });
});

test('dispatcher time budgets shorten provider timeout and reject invalid budgets without a call', async () => {
  const f = setup();
  for (const timeoutMs of [0, -1, 1.5, Infinity, NaN]) {
    await expect(workspaceMailAi(f.env, session(), 'email:mail', { analyze: true, timeoutMs }, f.provider)).rejects.toMatchObject({ code: 'AI_INVALID_REQUEST' });
  }
  expect(f.calls()).toBe(0);
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = ((_: unknown, init: RequestInit) => new Promise((_, reject) => {
    calls++;
    init.signal?.addEventListener('abort', () => reject(new Error('fake abort')));
  })) as typeof fetch;
  try {
    await expect(workspaceMailAi(f.env, session(), 'email:mail', { analyze: true, timeoutMs: 100 })).rejects.toMatchObject({ code: 'AI_TIMEOUT' });
    expect(calls).toBe(1);
    expect(await readMailAi(f.db, f.key)).toMatchObject({ status: 'failed', lease_until: 0 });
  } finally { globalThis.fetch = originalFetch; }
});


test.each([
  { enabled: false }, { summaryLanguage: 'ja' }, { model: 'replacement-model' },
  { baseUrl: 'https://other.vendor.com/v1', apiKey: 'replacement-key' },
  { apiFormat: 'responses' }, { maxInputChars: 256 }
])('settings changed during analysis discard the old result: %j', async (changed) => {
  const f = setup(); const saved = await saveLanguages(f.env, 'auto', 'en');
  await expect(workspaceMailAi(f.env, session(), 'email:mail', { language: 'en', analyze: true }, {
    analyze: async (input) => {
      const analysis = await f.provider.analyze(input);
      await saveMailAiSettings(f.env, 'owner', { ...saved.settings, revision: saved.revision, ...changed });
      return analysis;
    }
  })).rejects.toMatchObject({ code: 'AI_SETTINGS_CHANGED' });
  expect(await readMailAi(f.db, f.key)).toMatchObject({ status: 'failed', result_json: null, lease_until: 0 });
  expect(f.calls()).toBe(1);
});

test('a background language change during generation is checked using the actual request context', async () => {
  for (const webContext of [false, true]) {
    const f = setup(); await saveLanguages(f.env, 'auto', 'en');
    const pending = workspaceMailAi(f.env, session(), 'email:mail', { ...(webContext ? { language: 'en' as const } : {}), analyze: true }, {
      analyze: async (input) => {
        const analysis = await f.provider.analyze(input);
        await saveLanguages(f.env, 'auto', 'zh-CN');
        return analysis;
      }
    });
    if (webContext) expect(await pending).toMatchObject({ status: 'ready', language: 'en' });
    else await expect(pending).rejects.toMatchObject({ code: 'AI_SETTINGS_CHANGED' });
  }
});


test('authorization is checked immediately before generation and denial releases the claim without a provider call', async () => {
  const f = setup(); let checks = 0;
  await expect(workspaceMailAi(f.env, session(), 'email:mail', {
    language: 'en', analyze: true, beforeAnalyze: async () => { checks++; return false; }
  }, f.provider)).rejects.toMatchObject({ status: 409, code: 'AI_AUTHORIZATION_CHANGED' });
  expect(checks).toBe(1); expect(f.calls()).toBe(0);
  expect(await readMailAi(f.db, f.key)).toMatchObject({ status: 'failed', result_json: null, lease_until: 0 });
  f.cooldown();
  expect(await workspaceMailAi(f.env, session(), 'email:mail', {
    language: 'en', analyze: true, beforeAnalyze: async () => { checks++; return true; }
  }, f.provider)).toMatchObject({ status: 'ready' });
  expect(f.calls()).toBe(1); expect(checks).toBe(2);
  await workspaceMailAi(f.env, session(), 'email:mail', {
    language: 'en', analyze: true, beforeAnalyze: async () => { throw new Error('cache must not need a provider authorization hook'); }
  }, f.provider);
  expect(f.calls()).toBe(1);
});

test('authorization hook time is deducted before starting the provider', async () => {
  const f = setup(); let checks = 0;
  await expect(workspaceMailAi(f.env, session(), 'email:mail', {
    analyze: true, timeoutMs: 100, beforeAnalyze: async () => {
      checks++;
      await new Promise((resolve) => setTimeout(resolve, 110));
      return true;
    }
  }, f.provider)).rejects.toMatchObject({ code: 'AI_TIMEOUT' });
  expect(checks).toBe(1); expect(f.calls()).toBe(0);
  expect(await readMailAi(f.db, f.key)).toMatchObject({ status: 'failed', result_json: null, lease_until: 0 });
});

test.each([{ enabled: false }, { summaryLanguage: 'ja' }])('settings changed while preparing input prevent the provider call: %j', async (changed) => {
  const f = setup(); const saved = await saveLanguages(f.env, 'auto', 'en');
  const prepare = f.env.DB.prepare.bind(f.env.DB);
  let changedDuringInput = false;
  f.env.DB.prepare = (sql: string) => {
    const statement = prepare(sql);
    if (sql.includes('SELECT text_body, html_body, body_object_id FROM email_messages')) {
      const first = statement.first.bind(statement);
      statement.first = async <T>() => {
        const row = await first<T>();
        if (!changedDuringInput) {
          changedDuringInput = true;
          await saveMailAiSettings(f.env, 'owner', { ...saved.settings, revision: saved.revision, ...changed });
        }
        return row;
      };
    }
    return statement;
  };
  let authorizationChecks = 0;
  await expect(workspaceMailAi(f.env, session(), 'email:mail', {
    language: 'en', analyze: true, beforeAnalyze: async () => { authorizationChecks++; return true; }
  }, f.provider)).rejects.toMatchObject({ code: 'AI_SETTINGS_CHANGED' });
  expect(changedDuringInput).toBe(true); expect(f.calls()).toBe(0); expect(authorizationChecks).toBe(0);
  expect(await readMailAi(f.db, f.key)).toMatchObject({ status: 'failed', result_json: null, lease_until: 0 });
});


test.each([false, true])('immediate rate-limit handling preserves manual retry and prevents background resubmission (guarded=%s)', async (guarded) => {
  const f = setup(); let calls = 0; let checks = 0; let authorized = true;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls++;
    if (calls === 1) {
      authorized = false;
      return Response.json({ error: { code: 'rate_limit_exceeded' } }, { status: 429, headers: { 'retry-after': '0' } });
    }
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
      summary: 'A meeting invitation.', keyPoints: [], actionItems: [], dates: [], language: 'en', suggestion: null
    }) } }] });
  }) as unknown as typeof fetch;
  try {
    const result = workspaceMailAi(f.env, session(), 'email:mail', {
      language: 'en', analyze: true,
      ...(guarded ? { beforeAnalyze: async () => { checks++; return authorized; } } : {})
    });
    if (guarded) {
      await expect(result).rejects.toMatchObject({ code: 'AI_RATE_LIMITED' });
      expect(calls).toBe(1); expect(checks).toBe(1);
      expect(await readMailAi(f.db, f.key)).toMatchObject({ status: 'failed', result_json: null, lease_until: 0 });
    } else {
      expect(await result).toMatchObject({ status: 'ready' });
      expect(calls).toBe(2); expect(checks).toBe(0);
    }
  } finally { globalThis.fetch = originalFetch; }
});
