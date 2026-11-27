import { createHash, randomBytes } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const settings = '/api/workspace/integrations/mcp';
const endpointHeaders = { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' };
const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
  protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'FlareMail test', version: '1' }
} };

async function save(request: APIRequestContext, origin: string, data: unknown) {
  expect((await request.post(settings, { headers: { Origin: origin }, data })).status()).toBe(200);
}

async function login(page: Page, origin: string) {
  const response = await page.request.post('/api/workspace/session', {
    headers: { Origin: origin },
    data: { username: 'flower', password: 'FlareMail-E2E-password-2026!', remember: true }
  });
  expect(response.status()).toBe(200);
}

async function approveConsent(page: Page, origin: string, scopes: string, confidential = false) {
  const redirectUri = origin + '/mcp-test-callback';
  const registration = await page.request.post('/mcp/register', { data: {
    redirect_uris: [redirectUri], client_name: 'Synthetic MCP client',
    grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: confidential ? 'client_secret_post' : 'none'
  } });
  expect(registration.status()).toBe(201);
  const { client_id, client_secret } = await registration.json();
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(24).toString('base64url');
  const params = {
    response_type: 'code', client_id, code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    state, redirect_uri: redirectUri, resource: origin + '/mcp', scope: scopes
  };
  await page.route('**/mcp-test-callback?*', (route) => route.fulfill({ contentType: 'text/plain', body: 'Synthetic callback' }));
  await page.goto('/mcp/authorize?' + new URLSearchParams(params));
  await expect(page.getByText('Synthetic MCP client', { exact: false })).toBeVisible();
  if (scopes.includes('mail.attachments.metadata.read')) {
    await page.locator('input[value="mail.attachments.metadata.read"]').check();
  }
  await page.getByRole('button', { name: /授权访问|Allow access/ }).click();
  await page.waitForURL('**/mcp-test-callback?*');
  const reply = new URL(page.url()).searchParams;
  expect(reply.get('state')).toBe(state);
  expect(reply.get('iss')).toBe(origin);
  const code = reply.get('code')!;
  expect(Boolean(code)).toBe(true);
  const paramsForToken = { grant_type: 'authorization_code', client_id, redirect_uri: redirectUri,
    code_verifier: verifier, code, resource: origin + '/mcp',
    ...(client_secret ? { client_secret } : {}) };
  return paramsForToken;
}

async function authorize(page: Page, origin: string, scopes: string, confidential = false) {
  const paramsForToken = await approveConsent(page, origin, scopes, confidential);
  const wrongPkce = await page.request.post('/mcp/token', { form: { ...paramsForToken, code_verifier: 'x'.repeat(43) } });
  expect(wrongPkce.status()).toBe(400);
  const exchanged = await page.request.post('/mcp/token', { form: paramsForToken });
  expect(exchanged.status()).toBe(200);
  const tokens = await exchanged.json();
  return { client_id: paramsForToken.client_id, client_secret: paramsForToken.client_secret, tokens };
}

test.skip(process.env.FLAREMAIL_E2E_MCP !== 'true', 'Run with the isolated local MCP target enabled');

test('authorizes and queries read-only tools with the official MCP SDK @mcp', async ({ page, baseURL: origin }) => {
  const base = origin!;
  const mcp = base + '/mcp';
  const postMcp = (token?: string, data: unknown = init) => page.request.post(mcp, {
    headers: { ...endpointHeaders, ...(token ? { Authorization: 'Bearer ' + token } : {}) }, data
  });
  expect((await postMcp()).status()).toBe(404);
  await login(page, base);
  await save(page.request, base, { action: 'settings', enabled: true,
    scopes: ['mail.read', 'mail.metadata.read', 'mail.attachments.metadata.read'] });
  const challenge = await postMcp();
  expect(challenge.status()).toBe(401);
  expect(challenge.headers()['www-authenticate']).toContain('/.well-known/oauth-protected-resource/mcp');
  const discovery = await page.request.get('/.well-known/oauth-authorization-server');
  expect(await discovery.json()).toMatchObject({ issuer: base, code_challenge_methods_supported: ['S256'],
    authorization_response_iss_parameter_supported: true });
  expect((await page.request.get('/mcp')).status()).toBe(405);
  expect((await page.request.post('/mcp/register', { data: { redirect_uris: ['https://example.test/callback'] } })).status()).toBe(400);
  expect((await postMcp('invalid')).status()).toBe(401);
  expect((await page.request.post('/mcp', { headers: { ...endpointHeaders, Origin: 'https://invalid.test' }, data: init })).status()).toBe(403);

  const grant = await authorize(page, base, 'mail.read mail.metadata.read mail.attachments.metadata.read', true);
  const token = grant.tokens.access_token as string;
  const transport = new StreamableHTTPClientTransport(new URL(mcp), { requestInit: { headers: { Authorization: 'Bearer ' + token } } });
  const client = new Client({ name: 'FlareMail compatible client', version: '1' });
  try {
    await client.connect(transport);
    const wireTools = await postMcp(token, { jsonrpc: '2.0', id: 9, method: 'tools/list' });
    expect(await wireTools.json()).toMatchObject({ result: { tools: expect.arrayContaining([
      expect.objectContaining({ name: 'fetch', securitySchemes: [{ type: 'oauth2', scopes: ['mail.read'] }] })
    ]) } });
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
      'fetch', 'get_delivery_status', 'get_mailbox_metrics', 'get_message', 'get_thread',
      'list_attachments', 'list_domains', 'list_labels', 'list_mail_addresses', 'list_messages', 'search', 'search_messages'
    ]);
    for (const tool of listed.tools) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(Array.isArray(tool._meta?.securitySchemes)).toBe(true);
    }
    const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
    const found = await call('search', { query: 'subject:"E2E Inbox Welcome"' });
    expect(found.structuredContent).toMatchObject({ results: [{ id: 'e2e-inbox-message' }] });
    const fetched = await call('fetch', { id: 'e2e-inbox-message' });
    expect(fetched.structuredContent).toMatchObject({ text: 'This message is seeded in the isolated local D1 database.', metadata: { isRead: false } });
    expect((await call('get_message', { id: 'e2e-inbox-message' })).structuredContent).toMatchObject({ isRead: false });
    const pageOne = await call('list_messages', { limit: 1 });
    expect(pageOne.structuredContent).toMatchObject({ nextCursor: expect.any(String) });
    expect((await call('list_messages', { limit: 1, cursor: (pageOne.structuredContent as { nextCursor: string }).nextCursor })).structuredContent).not.toEqual(pageOne.structuredContent);
    expect((await call('search_messages', { query: 'from:html-sender', envelopeRecipient: 'e2e-admin@flaremail.test' })).structuredContent)
      .toMatchObject({ messages: [{ id: 'email:e2e-html-inbox-message', envelopeRecipient: 'e2e-admin@flaremail.test' }] });
    expect((await call('get_thread', { id: 'e2e-inbox-message' })).structuredContent).toMatchObject({ rfcThread: false, messages: [{ id: 'e2e-inbox-message' }] });
    expect((await call('list_domains')).structuredContent).toMatchObject({ domains: expect.arrayContaining([{ id: expect.any(String), domain: 'flaremail.test', enabled: true }]) });
    expect((await call('list_mail_addresses')).structuredContent).toHaveProperty('addresses');
    expect((await call('get_mailbox_metrics')).structuredContent).toMatchObject({ sentCount: 1 });
    expect((await call('list_labels')).structuredContent).toEqual({ labels: [] });
    expect((await call('get_delivery_status', { id: 'e2e-sent-message' })).structuredContent).toMatchObject({ status: 'sent' });
    expect((await call('list_attachments', { id: 'email:e2e-html-inbox-message' })).structuredContent)
      .toMatchObject({ attachments: [{ filename: 'logo.png' }] });
    expect((await call('get_message', { id: 'missing' })).isError).toBe(true);
    expect((await call('search_messages', { query: 'is:trash' })).isError).toBe(true);
    expect((await call('list_messages', { limit: 31 })).isError).toBe(true);
    expect(await call('unknown_tool')).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('-32602') }] });

    await save(page.request, base, { action: 'settings', enabled: true, scopes: ['mail.read', 'mail.metadata.read'] });
    expect((await call('list_attachments', { id: 'email:e2e-html-inbox-message' })).isError).toBe(true);
    await save(page.request, base, { action: 'settings', enabled: true, scopes: ['mail.read', 'mail.metadata.read', 'mail.attachments.metadata.read'] });
    expect((await call('list_attachments', { id: 'email:e2e-html-inbox-message' })).isError).toBe(true);
    expect((await postMcp(token, 'x'.repeat(17_000))).status()).toBe(413);
    const anonymous = await page.context().browser()!.newContext();
    try {
      expect((await anonymous.request.get(base + settings, { headers: { Authorization: 'Bearer ' + token } })).status()).toBe(401);
    } finally { await anonymous.close(); }
  } finally {
    await client.close();
  }

  const refresh = { grant_type: 'refresh_token', client_id: grant.client_id,
    client_secret: grant.client_secret, refresh_token: grant.tokens.refresh_token };
  const removedScope = await page.request.post('/mcp/token', { form: { ...refresh, scope: 'mail.attachments.metadata.read' } });
  expect((await removedScope.json()).error).toBe('invalid_scope');
  expect((await page.request.post('/mcp/token', { form: { ...refresh, resource: base + '/api' } })).status()).toBe(400);
  const renewed = await page.request.post('/mcp/token', { form: refresh });
  expect(renewed.status()).toBe(200);
  const next = await renewed.json();
  expect(next.refresh_token).not.toBe(grant.tokens.refresh_token);
  expect((await postMcp(next.access_token)).status()).toBe(200);
  const invalidClient = await page.request.post('/mcp/token', { form: { ...refresh, client_secret: 'wrong' } });
  expect((await invalidClient.json()).error).toBe('invalid_client');
  expect((await postMcp(next.access_token)).status()).toBe(200);
  expect((await page.request.post('/mcp/token', { form: refresh })).status()).toBe(400);
  expect((await postMcp(next.access_token)).status()).toBe(401);
  await save(page.request, base, { action: 'settings', enabled: false, scopes: ['mail.read', 'mail.metadata.read'] });
  expect((await postMcp(token)).status()).toBe(404);
  expect((await page.request.post('/mcp/token', { form: refresh })).status()).toBe(404);
  await save(page.request, base, { action: 'settings', enabled: true, scopes: ['mail.read'] });
  const pending = await approveConsent(page, base, 'mail.read');
  const clients = (await (await page.request.get(settings)).json()).data.clients;
  const approval = clients.find((item: { status: string }) => item.status === 'pending');
  expect(approval).toBeDefined();
  await save(page.request, base, { action: 'revoke', id: approval.id });
  expect((await page.request.post('/mcp/token', { form: pending })).status()).toBe(400);
  await save(page.request, base, { action: 'settings', enabled: false, scopes: ['mail.read'] });
});

test('integration settings are accessible across languages and themes @mcp', async ({ page, baseURL: origin }, testInfo) => {
  await login(page, origin!);
  await save(page.request, origin!, { action: 'settings', enabled: false, scopes: ['mail.read', 'mail.metadata.read'] });
  await page.goto('/?folder=settings&tab=integrations');
  await expect(page.getByText('FlareMail MCP Server')).toBeVisible();
  const enable = page.getByRole('switch', { name: /启用 MCP|Enable MCP/ });
  const saveButton = page.getByRole('button', { name: /保存设置|Save settings/ });
  await expect(enable).toHaveAttribute('aria-checked', 'false');
  await enable.focus();
  await page.keyboard.press('Space');
  await expect(enable).toHaveAttribute('aria-checked', 'true');
  await saveButton.click();
  await expect(page.getByText(/已启用|^Enabled$/)).toBeVisible();
  await expect(page.getByRole('button', { name: /复制 MCP 地址|Copy MCP endpoint/ })).toBeVisible();
  const panel = page.locator('#settings-panel-integrations');
  expect((await new AxeBuilder({ page }).include('#settings-panel-integrations').analyze()).violations.map(({ id }) => id)).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await testInfo.attach('mcp-settings-light', { body: await panel.screenshot(), contentType: 'image/png' });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.context().addCookies([{ name: 'flaremail-locale', value: 'en', url: origin! }]);
  await page.reload();
  await expect(page.getByRole('tab', { name: 'Integrations' })).toBeVisible();
  await expect(page.getByText('Authorized clients')).toBeVisible();
  await testInfo.attach('mcp-settings-dark', { body: await panel.screenshot(), contentType: 'image/png' });
  await enable.click();
  await saveButton.click();
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByText('Disabled', { exact: true })).toBeVisible();
});
