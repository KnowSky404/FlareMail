import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { WorkspaceContext } from '$lib/server/workspace/shared';
import { GET as GET_ATTACHMENT } from '../attachments/[attachmentId]/+server';
import { GET as GET_HTML } from './+server';

class Statement {
  private values: SQLQueryBindings[] = [];

  constructor(private readonly database: Database, private readonly sql: string) {}

  bind(...values: unknown[]) {
    this.values = values as SQLQueryBindings[];
    return this as unknown as D1PreparedStatement;
  }

  async first<T>() {
    return (this.database.query(this.sql).get(...this.values) as T | null) ?? null;
  }

  async all<T>() {
    return { results: this.database.query(this.sql).all(...this.values) as T[] };
  }
}

class D1 {
  constructor(readonly database: Database) {}

  prepare(sql: string) {
    return new Statement(this.database, sql) as unknown as D1PreparedStatement;
  }
}

class Bucket {
  readonly objects = new Map<string, Uint8Array>();

  async get(key: string) {
    const bytes = this.objects.get(key);
    if (!bytes) return null;
    const body = new Response(bytes.slice().buffer as ArrayBuffer).body;
    return { body, size: bytes.byteLength } as R2ObjectBody;
  }
}

const databases: Database[] = [];

const workspace = (userId = 'user-1'): WorkspaceContext => ({
  id: `session-${userId}`,
  userId,
  storage: 'd1',
  incomingSequence: 0,
  createdAt: '2026-08-19T00:00:00.000Z',
  updatedAt: '2026-08-19T00:00:00.000Z',
  profile: {
    name: 'User',
    role: '',
    email: `${userId}@example.test`,
    company: '',
    location: '',
    timezone: 'UTC',
    forwardingEnabled: false,
    signature: ''
  }
});

function event(
  path: string,
  env: { DB: D1; BUCKET: Bucket },
  params: { id: string; attachmentId?: string },
  userId: string | null = 'user-1'
) {
  return {
    request: new Request(`https://flaremail.test${path}`),
    url: new URL(`https://flaremail.test${path}`),
    params,
    locals: { workspaceSession: userId ? workspace(userId) : null },
    platform: { env }
  } as never;
}

function fixture() {
  const database = new Database(':memory:');
  databases.push(database);
  database.exec(readFileSync(resolve(import.meta.dir, '../../../../../../../schema.sql'), 'utf8'));
  database.query(`
    INSERT INTO workspace_users (id, login_email, name, role, email, company, location, timezone, forwarding_enabled, signature)
    VALUES ('user-1', 'user-1@example.test', 'User', '', 'user-1@example.test', '', '', 'UTC', 0, '')
  `).run();
  database.query(`
    INSERT INTO workspace_sessions (id, user_id, token_hash, expires_at)
    VALUES ('session-user-1', 'user-1', 'test-session-token-hash', '2099-01-01T00:00:00.000Z')
  `).run();
  database.query(`
    INSERT INTO email_messages (
      id, message_id, "from", "to", subject, "timestamp", snippet, raw_key, raw_size,
      text_body, html_body, owner_user_id
    ) VALUES (
      'mail-1', '<mail-1@example.test>', 'Sender <sender@example.test>', 'user-1@example.test',
      'HTML fixture', '2026-08-19T00:00:00.000Z', 'Safe fallback', 'raw/mail-1.eml', 10,
      'Safe fallback',
      '<p onclick="alert(1)">Hello <a href="https://example.com/login">https://different.example/login</a></p><script>alert(1)</script><img src="https://tracker.example/pixel"><img src="http://insecure.example/pixel"><img src="cid:logo@example.test" alt="logo"><img src="cid:vector@example.test" alt="vector">',
      'user-1'
    )
  `).run();
  database.query(`
    INSERT INTO workspace_attachments (id, user_id, message_id, filename, content_type, size, inline, content_id, r2_key)
    VALUES
      ('att-png', 'user-1', 'mail-1', 'logo.png', 'image/png', 3, 1, '<logo@example.test>', 'attachments/logo'),
      ('att-svg', 'user-1', 'mail-1', 'vector.svg', 'image/svg+xml', 5, 1, '<vector@example.test>', 'attachments/vector'),
      ('att-other', 'user-2', 'mail-1', 'other.png', 'image/png', 3, 1, '<other@example.test>', 'attachments/other')
  `).run();
  const DB = new D1(database);
  const BUCKET = new Bucket();
  BUCKET.objects.set('attachments/logo', new Uint8Array([1, 2, 3]));
  BUCKET.objects.set('attachments/vector', new TextEncoder().encode('<svg>'));
  BUCKET.objects.set('attachments/other', new Uint8Array([4, 5, 6]));
  return { database, env: { DB, BUCKET } };
}

afterEach(() => {
  while (databases.length) databases.pop()?.close();
});

describe('safe HTML workspace routes', () => {
  test('returns an isolated document with owned CID images and remote images blocked by default', async () => {
    const { env } = fixture();
    const response = await GET_HTML(event(
      '/api/workspace/messages/email:mail-1/html?remote=0',
      env,
      { id: 'email:mail-1' }
    ));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(response.headers.get('content-security-policy')).toContain("img-src 'self'");
    expect(response.headers.get('content-security-policy')).toContain('sandbox allow-popups allow-popups-to-escape-sandbox');
    expect(response.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(html).not.toContain('onclick=');
    expect(html).not.toContain('alert(1)');
    expect(html).not.toContain('tracker.example');
    expect(html).toContain('/api/workspace/messages/email%3Amail-1/attachments/att-png?inline=1&amp;cid_session=session-user-1');
    expect(html).toContain('&amp;cid_signature=');
    expect(html).not.toContain('/attachments/att-svg');
    expect(html).toContain('[example.com]');
    expect(html).toContain('显示文本与目标不一致');
    expect(html).toContain('已阻止 3 个未授权或不安全的图片');
  });

  test('loads only HTTPS remote images after exact per-message consent', async () => {
    const { env } = fixture();
    const response = await GET_HTML(event(
      '/api/workspace/messages/email:mail-1/html?remote=1',
      env,
      { id: 'email:mail-1' }
    ));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-security-policy')).toContain("img-src 'self' https:");
    expect(response.headers.get('content-security-policy')).not.toContain('http:');
    expect(html).toContain('https://tracker.example/pixel');
    expect(html).not.toContain('http://insecure.example/pixel');
    expect(html).toContain('已按你的选择加载 1 个远程图片');
  });

  test('does not reveal another owner\'s HTML or attachment records', async () => {
    const { env } = fixture();
    const html = await GET_HTML(event(
      '/api/workspace/messages/email:mail-1/html',
      env,
      { id: 'email:mail-1' },
      'user-2'
    ));
    const attachment = await GET_ATTACHMENT(event(
      '/api/workspace/messages/email:mail-1/attachments/att-png?inline=1',
      env,
      { id: 'email:mail-1', attachmentId: 'att-png' },
      'user-2'
    ));

    expect(html.status).toBe(404);
    expect(attachment.status).toBe(404);
  });

  test('serves only owned safe image MIME types inline and forces SVG to download', async () => {
    const { env } = fixture();
    const png = await GET_ATTACHMENT(event(
      '/api/workspace/messages/email:mail-1/attachments/att-png?inline=1',
      env,
      { id: 'email:mail-1', attachmentId: 'att-png' }
    ));
    const svg = await GET_ATTACHMENT(event(
      '/api/workspace/messages/email:mail-1/attachments/att-svg?inline=1',
      env,
      { id: 'email:mail-1', attachmentId: 'att-svg' }
    ));

    expect(png.status).toBe(200);
    expect(png.headers.get('content-type')).toBe('image/png');
    expect(png.headers.get('content-disposition')).toStartWith('inline;');
    expect(png.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await png.arrayBuffer()).toHaveLength(3);

    expect(svg.status).toBe(200);
    expect(svg.headers.get('content-type')).toBe('application/octet-stream');
    expect(svg.headers.get('content-disposition')).toStartWith('attachment;');
    expect(await svg.text()).toBe('<svg>');
  });

  test('serves a CID image without ambient cookies only through its scoped capability', async () => {
    const { env } = fixture();
    const htmlResponse = await GET_HTML(event(
      '/api/workspace/messages/email:mail-1/html',
      env,
      { id: 'email:mail-1' }
    ));
    const html = await htmlResponse.text();
    const source = html.match(/src="([^"]*attachments\/att-png[^"]*)"/u)?.[1].replaceAll('&amp;', '&');
    expect(source).toBeTruthy();

    const authorized = await GET_ATTACHMENT(event(
      source!,
      env,
      { id: 'email:mail-1', attachmentId: 'att-png' },
      null
    ));
    const tampered = await GET_ATTACHMENT(event(
      source!.replace('/att-png?', '/att-svg?'),
      env,
      { id: 'email:mail-1', attachmentId: 'att-svg' },
      null
    ));

    expect(authorized.status).toBe(200);
    expect(authorized.headers.get('content-type')).toBe('image/png');
    expect(tampered.status).toBe(401);
  });
});
