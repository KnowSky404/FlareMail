import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import type { APIRequestContext, Page, TestInfo } from '@playwright/test';
import type { MailboxPage } from '../../src/lib/domain/mail/types';
import type { DeliveryAttentionPage, DeliveryAttentionSummary } from '../../src/lib/domain/mail/delivery-attention';
import { assertNoConsoleErrors, assertNoHorizontalOverflow, expect, login, openFolder, signResendWebhook, test } from './fixtures';

const target = JSON.parse(readFileSync(new URL('../../cloudflare.local.json', import.meta.url), 'utf8')) as { databaseId: string };
const primary = '00000000-0000-4000-8000-000000000021';
const support = '00000000-0000-4000-8000-000000000022';
const owner = 'e2e-admin-user';
const endpoint = '/api/workspace/attention';
const subject = 'E2E Delivery Exception';
const notice = (page: Page) => page.getByRole('button', { name: /^(通知|Notifications)/u });
const panel = (page: Page) => page.locator('#delivery-notifications-content');

async function screenshot(page: Page, testInfo: TestInfo, name: string) {
  const directory = process.env.FLAREMAIL_ATTENTION_SCREENSHOTS;
  if (directory) await page.screenshot({ path: join(directory, `${testInfo.project.name}-${name}.png`), animations: 'disabled' });
}

function originOf(baseURL: string | undefined) {
  const url = new URL(baseURL ?? '');
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port) throw new Error('Delivery fixtures require the isolated local Worker.');
  return url.origin;
}

async function seed(request: APIRequestContext, origin: string, id: string, status: string, label = subject) {
  const response = await request.post(origin + `/cdn-cgi/local/explorer/api/d1/database/${target.databaseId}/raw`, { data: { batch: [
    { sql: `INSERT INTO workspace_messages
        (id, user_id, folder, from_name, from_email, to_name, to_email, subject, body, sender_address_id, sent_at, is_read)
        SELECT ?, user_id, 'sent', 'E2E Sender', 'e2e-admin@flaremail.test', 'Recipient', 'recipient@flaremail.test',
          ?, 'Synthetic delivery test body', ?, '2026-08-13T08:00:00.000Z', 1
        FROM workspace_owner WHERE singleton = 1 AND user_id = ?`, params: [id, label, primary, owner] },
    { sql: `INSERT INTO workspace_delivery_statuses
        (message_id, user_id, status, attempts, idempotency_key, provider, provider_message_id, last_event_at)
        SELECT id, user_id, ?, 1, id, 'resend', id, '2026-08-13T08:00:00.000Z'
        FROM workspace_messages WHERE id = ? AND user_id = ?`, params: [status, id, owner] }
  ] } });
  expect(response.ok()).toBe(true);
  expect((await response.json()).result.map(({ success }: { success: boolean }) => success)).toEqual([true, true]);
}

async function events(request: APIRequestContext, messageId: string, type: string, id: string, offsetSeconds = 0) {
  const timestamp = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({ type, created_at: new Date((timestamp + offsetSeconds) * 1000).toISOString(),
    data: { email_id: messageId, to: ['private@example.test'], reason: 'provider-private-details' } });
  return request.post('/api/webhooks/resend', { data: body, headers: {
    'content-type': 'application/json', 'svix-id': id, 'svix-timestamp': String(timestamp),
    'svix-signature': `v1,${await signResendWebhook(id, timestamp, body)}`
  } });
}

async function getNotices(request: APIRequestContext, view = 'pending'): Promise<DeliveryAttentionPage> {
  const response = await request.get(endpoint + '?view=' + view);
  expect(response.ok()).toBe(true);
  return (await response.json()).data;
}

test('refreshes the stale first page after loading more notifications', async ({ page }) => {
  const occurredAt = '2026-08-13T08:00:00.000Z';
  const replayStarted = Promise.withResolvers<void>();
  const releaseReplay = Promise.withResolvers<void>();
  let firstPageSubject = 'First page';
  await page.route('**/api/workspace/attention/summary', async (route) => {
    replayStarted.resolve();
    await releaseReplay.promise;
    firstPageSubject = 'Updated first page';
    await route.fulfill({ json: { ok: true, data: { pendingCount: 2, snapshot: { asOf: occurredAt, version: 2 }, replayed: 1 } } });
  }, { times: 1 });
  await page.route((url) => url.pathname === endpoint, async (route) => {
    const lastPage = new URL(route.request().url()).searchParams.has('cursor');
    const id = lastPage ? 2 : 1;
    const data: DeliveryAttentionPage = {
      notices: [{
        id, version: id, messageId: String(id), kind: 'complained', state: 'open', occurredAt,
        acknowledgedAt: null, closedAt: null, sender: 'e2e-admin@flaremail.test',
        subject: lastPage ? 'Final page' : firstPageSubject
      }],
      nextCursor: lastPage ? null : 'last-page',
      summary: { pendingCount: 2, snapshot: { asOf: occurredAt, version: 2 } }
    };
    await route.fulfill({ json: { ok: true, data } });
  });

  const nextReplay = () => page.waitForResponse((response) =>
    new URL(response.url()).pathname === endpoint + '/summary' &&
    response.request().method() === 'POST' && response.ok());
  await login(page);
  await replayStarted.promise;
  await notice(page).press('Enter');
  const items = panel(page).getByRole('listitem');
  const more = panel(page).getByRole('button', { name: '加载更多', exact: true });
  try {
    await expect(items.first().getByText('First page', { exact: true })).toBeVisible();
  } finally {
    releaseReplay.resolve();
  }
  await expect(items.first().getByText('Updated first page', { exact: true })).toBeVisible();
  await page.evaluate(() => {
    const now = Date.now;
    Date.now = () => now() + 31_000;
  });
  await more.press('Enter');
  await expect(items).toHaveCount(2);
  await expect(more).toHaveCount(0);
  await expect(items.last().getByRole('button', { name: '查看邮件', exact: true })).toBeFocused();
  firstPageSubject = 'New first page';
  const replay = nextReplay();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await replay;
  await expect(items.first().getByText('New first page', { exact: true })).toBeVisible();
  await expect(items).toHaveCount(1);
});

test('finds an Owner-wide bounce from another identity and acknowledges it without changing the receipt', async ({ page, baseURL, consoleErrors }, info) => {
  const origin = originOf(baseURL);
  const id = 'e2e-attention-bounced';
  await seed(page.request, origin, id, 'bounced');
  await login(page);
  await expect(notice(page)).toHaveAccessibleName(/1 条待处理投递异常/u);
  const notificationRequests: string[] = [];
  const trackNotifications = (request: import('@playwright/test').Request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname.startsWith(endpoint) || pathname === '/api/readiness') notificationRequests.push(pathname);
  };
  page.on('request', trackNotifications);
  await page.getByLabel('按邮件身份筛选').selectOption('address:' + primary);
  await page.getByLabel('按邮件身份筛选').selectOption('address:' + support);
  await expect(page).toHaveURL(new RegExp(support, 'u'));
  page.off('request', trackNotifications);
  expect(notificationRequests).toEqual([]);
  await expect(notice(page)).toHaveAccessibleName(/1 条待处理投递异常/u);
  await screenshot(page, info, 'entry');

  await notice(page).focus();
  await notice(page).press('Space');
  const close = panel(page).getByRole('button', { name: '关闭', exact: true });
  await expect(close).toBeFocused();
  await expect(panel(page).getByText('系统运行正常', { exact: true })).toBeVisible();
  await expect(panel(page).getByText(subject)).toBeVisible();
  await expect(page).toHaveTitle('FlareMail');
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  await assertNoHorizontalOverflow(page);
  const bounds = (await panel(page).boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  expect((await new AxeBuilder({ page }).include('#delivery-notifications-content')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()).violations).toEqual([]);
  await screenshot(page, info, 'pending');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Escape');
  await expect(notice(page)).toBeFocused();
  await notice(page).press('Enter');

  await panel(page).getByRole('button', { name: '查看邮件' }).press('Enter');
  await expect(page.getByRole('heading', { name: subject, exact: true })).toBeFocused();
  await expect(page).toHaveURL(new RegExp('message=' + id, 'u'));
  await expect(page).not.toHaveURL(/identity=/u);
  const timeline = page.locator('section[aria-labelledby="delivery-title"]').filter({ visible: true });
  await expect(timeline.getByRole('button', { name: '确认异常' })).toBeVisible();
  await expect(timeline.getByText('已退信', { exact: true })).toBeVisible();
  await expect(timeline.getByRole('button', { name: '重试投递' })).toHaveCount(0);
  await screenshot(page, info, 'delivery-detail');
  const startedAt = performance.now();
  await timeline.getByRole('button', { name: '确认异常' }).press('Enter');
  await expect(timeline.getByRole('heading', { name: '投递时间线' })).toBeFocused();
  const compactReader = page.viewportSize()!.width < 768;
  if (!compactReader) await expect(notice(page)).toHaveAccessibleName('通知');
  const badgeMs = compactReader ? null : performance.now() - startedAt;
  await expect(timeline.getByText(/已确认/u)).toBeVisible();
  const detailMs = performance.now() - startedAt;
  await expect(timeline.getByText('已退信', { exact: true })).toBeVisible();
  const directory = process.env.FLAREMAIL_ATTENTION_SCREENSHOTS;
  if (directory) {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(directory, '..', 'ack-' + info.project.name + '.json'), JSON.stringify({ badgeMs, detailMs }));
  }
  await page.goBack();
  await expect(page).toHaveURL(/identity=address/u);
  await expect(notice(page)).toHaveAccessibleName('通知');
  await notice(page).click();
  await expect(panel(page).getByText('没有待处理的投递异常。')).toBeVisible();
  await screenshot(page, info, 'empty');
  await panel(page).getByRole('button', { name: '历史', exact: true }).click();
  await expect(panel(page).getByText('已确认', { exact: true })).toBeVisible();
  await screenshot(page, info, 'history');
  await page.keyboard.press('Escape');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(notice(page)).toHaveAccessibleName('通知');
  await notice(page).click();
  await expect(panel(page).getByText('没有待处理的投递异常。')).toBeVisible();
  await page.keyboard.press('Escape');
  await openFolder(page, '已发送');
  await page.getByLabel('按邮件身份筛选').selectOption('');
  await expect(page.getByText(subject, { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: '待处理投递异常', exact: true }).click();
  await expect(page).toHaveURL(/filter=attention/u);
  await expect(page.getByText(subject, { exact: true })).toHaveCount(0);
  if (info.project.name === 'desktop') {
    const viewport = page.viewportSize()!;
    await page.setViewportSize({ width: 768, height: 1024 });
    await notice(page).click();
    await expect(panel(page).getByText('没有待处理的投递异常。')).toBeVisible();
    await assertNoHorizontalOverflow(page);
    await screenshot(page, info, 'tablet');
    await page.keyboard.press('Escape');
    await page.setViewportSize(viewport);

    const standalone = await page.context().newPage();
    await standalone.goto('/messages/' + id + '?folder=sent', { waitUntil: 'domcontentloaded' });
    const receipt = standalone.locator('section[aria-labelledby="delivery-title"]');
    await receipt.getByRole('button', { name: '重新打开异常' }).click();
    await expect(notice(page)).toHaveAccessibleName(/1 条待处理投递异常/u);
    await receipt.getByRole('button', { name: '确认异常' }).click();
    await expect(notice(page)).toHaveAccessibleName('通知');
    await expect(receipt.getByText('已退信', { exact: true })).toBeVisible();
    await standalone.close();

    await notice(page).click();
    await panel(page).getByRole('button', { name: '诊断', exact: true }).press('Enter');
    await expect(page).toHaveURL(/tab=diagnostics/u);
    await expect(page.getByRole('tab', { name: '诊断', exact: true })).toBeFocused();
    await expect(page).not.toHaveURL(/filter=attention/u);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: '诊断', exact: true })).toBeVisible();
    await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '域名', exact: true }).click();
    await expect(page).toHaveURL(/view=domains/u);
    await page.getByRole('table').first().waitFor();
    await notice(page).click();
    await panel(page).getByRole('button', { name: '诊断', exact: true }).click();
    await expect(page).toHaveURL(/tab=diagnostics/u);
  }
  await assertNoConsoleErrors(consoleErrors);
});

test('refreshes another tab after a send conflict that can persist a failure', async ({ page, context }, info) => {
  test.skip(info.project.name !== 'desktop', 'Desktop covers the cross-tab send error path.');
  await login(page);
  const peer = await context.newPage();
  await login(peer);
  await openFolder(peer, '已发送');
  const attentionMailbox = (url: URL) => url.pathname === '/api/workspace/mailbox' &&
    url.searchParams.get('folder') === 'sent' && url.searchParams.get('filter') === 'attention';
  await Promise.all([
    peer.waitForResponse((response) => attentionMailbox(new URL(response.url())) && response.ok()),
    peer.getByRole('button', { name: '待处理投递异常', exact: true }).click()
  ]);

  await page.route('**/api/send', (route) => route.fulfill({
    status: 409,
    json: { ok: false, error: { code: 'IDEMPOTENCY_CONFLICT', message: 'synthetic provider conflict after persistence' } }
  }));
  await page.getByRole('button', { name: '写邮件', exact: true }).first().click();
  const compose = page.getByRole('dialog', { name: '新邮件' });
  await compose.getByRole('combobox', { name: '收件人', exact: true }).fill('delivery-test@flaremail.test');
  await compose.getByRole('textbox', { name: '主题', exact: true }).fill('Synthetic send conflict');
  await compose.getByRole('textbox', { name: '正文', exact: true }).fill('No provider request is made.');

  await Promise.all([
    peer.waitForResponse((response) => new URL(response.url()).pathname === endpoint + '/summary' && response.ok()),
    peer.waitForResponse((response) => attentionMailbox(new URL(response.url())) && response.ok()),
    compose.getByRole('button', { name: '发送邮件', exact: true }).click()
  ]);
  await expect(page.getByText(/投递服务拒绝了幂等重试/u)).toBeVisible();
  await expect(compose).toBeVisible();
  await peer.close();
});

test('reports a broken Access Owner mapping as degraded', async ({ page }) => {
  await login(page);
  await page.route('**/api/readiness?scope=system', (route) => route.fulfill({
    status: 503,
    json: { ok: false, error: { code: 'OWNER_MAPPING_REQUIRED', message: 'synthetic missing Owner mapping' } }
  }));
  await notice(page).press('Enter');
  await panel(page).getByRole('button', { name: '刷新通知和系统状态' }).click();
  await expect(panel(page).getByText('系统运行异常', { exact: true })).toBeVisible();
});

test('refreshes an open issue in another tab, handles failure, and keeps health independent', async ({ page, context, baseURL, consoleErrors }, info) => {
  test.skip(info.project.name !== 'desktop', 'One desktop run covers cross-tab synchronization and health changes.');
  const origin = originOf(baseURL);
  const id = 'e2e-attention-cross-tab';
  await seed(page.request, origin, id, 'suppressed');
  await login(page);
  const second = await context.newPage();
  await login(second);
  await expect(notice(second)).toHaveAccessibleName(/1 条待处理投递异常/u);

  let degraded = true;
  await page.route('**/api/readiness?scope=system', async (route) => {
    if (!degraded) return route.continue();
    await route.fulfill({ status: 503, json: { ok: false, error: { code: 'ACCESS_UNAVAILABLE', message: 'synthetic Access key lookup failure' } } });
  });
  await notice(page).click();
  await panel(page).getByRole('button', { name: '刷新通知和系统状态' }).click();
  await expect(panel(page).getByText('系统运行异常', { exact: true })).toBeVisible();

  await page.route(endpoint, async (route) => route.fulfill({ status: 503, json: { ok: false, error: { code: 'D1_UNAVAILABLE', message: 'synthetic unavailable' } } }));
  await panel(page).getByRole('button', { name: '确认异常', exact: true }).press('Enter');
  await expect(panel(page).getByRole('alert')).toContainText('未能更新投递异常');
  await expect(panel(page).getByRole('button', { name: /^待处理/u })).toBeFocused();
  await expect(panel(page).getByText(subject)).toBeVisible();
  await page.unroute(endpoint);

  const requestStarted = Promise.withResolvers<void>();
  const releaseFailure = Promise.withResolvers<void>();
  await page.route(endpoint, async (route) => {
    requestStarted.resolve();
    await releaseFailure.promise;
    await route.fulfill({ status: 503, json: { ok: false, error: { code: 'D1_UNAVAILABLE', message: 'synthetic unavailable' } } });
  });
  await panel(page).getByRole('button', { name: '确认异常', exact: true }).press('Enter');
  await requestStarted.promise;
  const closeNotifications = panel(page).getByRole('button', { name: '关闭', exact: true });
  await closeNotifications.focus();
  releaseFailure.resolve();
  await expect(panel(page).getByRole('alert')).toBeVisible();
  await expect(closeNotifications).toBeFocused();
  await page.unroute(endpoint);

  await panel(page).getByRole('button', { name: '全部确认', exact: true }).click();
  await expect(panel(page).getByText(/确认整个工作区当前的 1 条/u)).toBeVisible();
  await panel(page).getByRole('button', { name: '全部确认', exact: true }).click();
  await expect(notice(second)).toHaveAccessibleName('通知');
  await expect(panel(page).getByText('系统运行异常', { exact: true })).toBeVisible();
  await screenshot(page, info, 'system-degraded');
  await panel(page).getByRole('button', { name: '历史', exact: true }).click();
  await panel(page).getByText(subject).first().waitFor();
  await panel(page).locator('li').filter({ hasText: '已抑制' }).getByRole('button', { name: '重新打开异常' }).click();
  await expect(notice(second)).toHaveAccessibleName(/1 条待处理投递异常/u);
  degraded = false;
  await panel(page).getByRole('button', { name: '刷新通知和系统状态' }).click();
  await expect(panel(page).getByText('系统运行正常', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '显示偏好' }).click();
  await page.getByRole('radio', { name: '深色' }).click();
  await page.getByRole('radio', { name: 'English', exact: true }).click();
  await page.keyboard.press('Escape');
  await notice(page).click();
  await expect(panel(page).getByText('System operational', { exact: true })).toBeVisible();
  await expect(panel(page).getByRole('listitem').getByText('Suppressed', { exact: true })).toBeVisible();
  await screenshot(page, info, 'dark-english');
  await panel(page).getByRole('button', { name: 'Acknowledge', exact: true }).click();
  await expect(notice(second)).toHaveAccessibleName('通知');

  const post = (data: object) => page.request.post(endpoint, { data, headers: { origin } });
  const previous = (await getNotices(page.request, 'history')).notices.find((item) => item.messageId === id)!;
  expect((await post({ action: 'reopen', incident: { id: previous.id, version: previous.version } })).ok()).toBe(true);
  await page.goto('/?folder=sent&message=' + id, { waitUntil: 'domcontentloaded' });
  await expect(notice(page)).toHaveAccessibleName(/1 pending delivery issue/u);
  const listStarted = Promise.withResolvers<void>();
  const releaseList = Promise.withResolvers<void>();
  const pendingList = '**/api/workspace/attention?view=pending';
  await page.route(pendingList, async (route) => {
    listStarted.resolve();
    await releaseList.promise;
    await route.abort().catch(() => undefined);
  }, { times: 1 });
  await notice(page).click();
  await listStarted.promise;
  await page.keyboard.press('Escape');
  const receiptAction = page.locator('section[aria-labelledby="delivery-title"]').filter({ visible: true })
    .getByRole('button', { name: 'Acknowledge', exact: true });
  await page.route(endpoint, (route) => route.fulfill({ status: 503, json: { ok: false, error: { code: 'D1_UNAVAILABLE', message: 'synthetic unavailable' } } }),
    { times: 1 });
  const failedWrite = page.waitForResponse((response) => new URL(response.url()).pathname === endpoint && response.status() === 503);
  try {
    await receiptAction.click();
    await failedWrite;
    await expect(receiptAction).toBeEnabled();
    await notice(page).click();
    await expect(panel(page).getByText(subject)).toBeVisible();
    await page.keyboard.press('Escape');
  } finally {
    releaseList.resolve();
  }

  const concurrentId = 'e2e-attention-concurrent';
  await page.evaluate(() => {
    const listener = new BroadcastChannel('flaremail-workspace-v1');
    listener.addEventListener('message', (event) => {
      if (event.data?.id !== 'e2e-attention-concurrent') return;
      document.documentElement.dataset.attentionInvalidated = 'true';
      listener.close();
    });
  });
  await page.route(endpoint, async (route) => {
    const response = await route.fetch();
    await seed(page.request, origin, concurrentId, 'bounced');
    await second.evaluate((messageId) => {
      const sender = new BroadcastChannel('flaremail-workspace-v1');
      sender.postMessage({ type: 'delivery-attention-changed', id: messageId });
      sender.close();
    }, concurrentId);
    await expect(page.locator('html')).toHaveAttribute('data-attention-invalidated', 'true');
    await route.fulfill({ response });
  });
  const receipt = page.locator('section[aria-labelledby="delivery-title"]').filter({ visible: true });
  await receipt.getByRole('button', { name: 'Acknowledge', exact: true }).click();
  await expect(receipt.getByText(/Acknowledged/u)).toBeVisible();
  await expect(notice(page)).toHaveAccessibleName(/1 pending delivery issue/u);
  await page.unroute(endpoint);
  const reopenedResponse = await post({ action: 'reopen', incident: { id: previous.id,
    version: (await getNotices(page.request, 'history')).notices.find((item) => item.id === previous.id)!.version } });
  expect((await reopenedResponse.json()).data.changed).toBe(1);
  const reopened = (await getNotices(page.request)).notices.find((item) => item.id === previous.id)!;
  expect((await post({ action: 'acknowledge', incident: { id: reopened.id, version: reopened.version } })).ok()).toBe(true);
  const concurrent = (await getNotices(page.request)).notices.find((item) => item.messageId === concurrentId)!;
  expect((await post({ action: 'acknowledge', incident: { id: concurrent.id, version: concurrent.version } })).ok()).toBe(true);
  await second.close();
  await assertNoConsoleErrors(consoleErrors.filter((error) => !error.includes('503')));
});

test('enforces API session, scope, versions, provider ordering, and retry boundaries', async ({ page, baseURL }, info) => {
  test.skip(info.project.name !== 'desktop', 'The API and signed synthetic webhook exercise the same Worker across browsers.');
  const origin = originOf(baseURL);
  expect((await page.request.get(endpoint)).status()).toBe(401);
  const id = 'e2e-attention-api';
  const recovery = 'e2e-attention-recovery';
  await seed(page.request, origin, id, 'submitted');
  await seed(page.request, origin, recovery, 'submitted');
  await login(page);
  const request = page.request;
  const post = (data: object, csrfOrigin = origin) => request.post(endpoint, { data, headers: { origin: csrfOrigin } });
  const sent = await request.post('/api/workspace/messages', {
    headers: { origin, 'Idempotency-Key': 'e2e-native-d1-delivery-claim' },
    data: { senderAddressId: primary, toEmail: 'demo-recipient@flaremail.test', subject: 'E2E native claim', body: 'Synthetic send' }
  });
  expect(sent.ok()).toBe(true);
  const native = (await sent.json()).data.message;
  expect(native).toMatchObject({ deliveryStatus: 'submitted', deliveryAttempts: 1 });

  expect((await events(request, id, 'email.delivery_delayed', 'attention-delayed')).ok()).toBe(true);
  expect((await events(request, recovery, 'email.delivery_delayed', 'attention-recovery-1')).ok()).toBe(true);
  const delayed = (await getNotices(request)).notices.find((item) => item.messageId === id)!;
  const ack = { action: 'acknowledge', incident: { id: delayed.id, version: delayed.version } };
  const snapshot = ((await (await request.get(endpoint + '/summary')).json()).data as DeliveryAttentionSummary).snapshot;
  await notice(page).click();
  await expect(panel(page).getByRole('button', { name: '待处理 (2)', exact: true })).toBeVisible();

  expect((await post(ack, 'https://unrelated.invalid')).status()).toBe(403);
  expect((await post({ action: 'acknowledge', incident: { id: 99999999, version: 1 } })).status()).toBe(404);
  expect((await request.get(endpoint + '?kind=invalid')).status()).toBe(400);
  expect((await request.get(endpoint + '?limit=51')).status()).toBe(400);
  expect((await request.get(endpoint + '?cursor=bad')).status()).toBe(400);
  const bounded = await request.get(endpoint + '?limit=1');
  expect((await bounded.json()).data.nextCursor).toEqual(expect.any(String));
  const posted = await Promise.all([post(ack), post(ack)]);
  expect((await Promise.all(posted.map(async (response) => (await response.json()).data.changed))).sort()).toEqual([0, 1]);
  expect((await events(request, id, 'email.delivery_delayed', 'attention-delayed')).ok()).toBe(true);
  expect((await events(request, id, 'email.delivery_delayed', 'attention-delayed-2')).ok()).toBe(true);
  expect((await events(request, id, 'email.sent', 'attention-old', -10)).ok()).toBe(true);
  expect((await getNotices(request)).notices.some((item) => item.messageId === id)).toBe(false);
  await panel(page).getByRole('button', { name: '刷新通知和系统状态' }).click();
  await expect(panel(page).getByRole('button', { name: '待处理 (1)', exact: true })).toBeVisible();
  expect((await events(request, recovery, 'email.delivered', 'attention-recovery-2', 5)).ok()).toBe(true);
  await panel(page).getByRole('button', { name: '确认异常', exact: true }).press('Enter');
  await expect(panel(page).getByRole('alert')).toContainText('异常已发生变化');
  await expect(panel(page).getByRole('button', { name: /^待处理/u })).toBeFocused();
  await expect(panel(page).getByRole('button', { name: '确认异常', exact: true })).toHaveCount(0);
  const recovered = (await getNotices(request, 'history')).notices.find((item) => item.messageId === recovery)!;
  expect(recovered.state).toBe('resolved');
  expect((await post({ action: 'reopen', incident: { id: recovered.id, version: recovered.version } })).status()).toBe(409);
  expect((await events(request, id, 'email.bounced', 'attention-bounced', 5)).ok()).toBe(true);
  expect((await post(ack)).status()).toBe(409);
  expect((await post({ action: 'acknowledge_all', snapshot })).ok()).toBe(true);
  const bounce = (await getNotices(request)).notices.find((item) => item.messageId === id)!;
  expect(bounce).toMatchObject({ kind: 'bounced', state: 'open' });
  await panel(page).getByRole('button', { name: '历史', exact: true }).click();
  const resolved = panel(page).getByRole('listitem').filter({ hasText: '已恢复' });
  await expect(resolved).toBeVisible();
  await expect(resolved.getByRole('button', { name: '重新打开异常' })).toHaveCount(0);
  await panel(page).getByRole('button', { name: '待处理 (1)', exact: true }).click();
  await expect(panel(page).getByRole('listitem').getByText('已退信', { exact: true })).toBeVisible();
  expect(JSON.stringify(bounce)).not.toMatch(/private@example|provider-private|Synthetic delivery test body/u);
  const retry = await request.post('/api/workspace/messages/' + id + '/retry', { headers: { origin } });
  expect(retry.status()).toBe(409);
  expect((await post({ action: 'acknowledge', incident: { id: bounce.id, version: bounce.version } })).ok()).toBe(true);
  const detail = await request.get('/api/workspace/messages/' + id + '/delivery');
  expect((await detail.json()).data.detail).toMatchObject({ status: 'bounced', attention: { state: 'acknowledged' } });
  expect((await events(request, native.deliveryProviderMessageId, 'email.delivery_delayed', 'attention-native-claim-delay')).ok()).toBe(true);
  const nativeRetry = await request.post('/api/workspace/messages/' + native.id + '/retry', { headers: { origin } });
  expect(nativeRetry.ok()).toBe(true);
  expect((await nativeRetry.json()).data.message).toMatchObject({ deliveryAttempts: 2 });
  const nativeDetail = await request.get('/api/workspace/messages/' + native.id + '/delivery');
  expect((await nativeDetail.json()).data.detail.attention).toMatchObject({ kind: 'delayed', state: 'open' });
  expect((await events(request, native.deliveryProviderMessageId, 'email.failed', 'attention-native-provider-failure')).ok()).toBe(true);
  await page.goto('/?folder=sent&message=' + native.id);
  const failedReceipt = page.locator('section[aria-labelledby="delivery-title"]').filter({ visible: true });
  await expect(failedReceipt.getByText('发送失败', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: '更多邮件操作', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: '重试投递' })).toHaveCount(0);
  await expect(failedReceipt.getByRole('button', { name: '重试投递' })).toHaveCount(0);
  const nativeFailure = (await getNotices(request)).notices.find((item) => item.messageId === native.id)!;
  expect((await post({ action: 'acknowledge', incident: { id: nativeFailure.id, version: nativeFailure.version } })).ok()).toBe(true);
  expect((await request.delete('/api/workspace/session', { headers: { origin } })).ok()).toBe(true);
  expect((await post(ack)).status()).toBe(401);
  await login(page);
  expect((await getNotices(page.request, 'history')).notices.find((item) => item.id === bounce.id)?.state).toBe('acknowledged');
});

for (const filter of ['all', 'attention']) {
  test(`refreshes Sent after startup replay commits (${filter})`, async ({ page, baseURL }, info) => {
    test.skip(info.project.name !== 'desktop', 'One desktop replay covers the workspace startup path.');
    const origin = originOf(baseURL);
    const id = `e2e-attention-startup-replay-${filter}`;
    const label = `E2E Startup Replay ${filter}`;
    await seed(page.request, origin, id, 'delayed', label);
    await login(page);
    const replayStarted = Promise.withResolvers<void>();
    const releaseReplay = Promise.withResolvers<void>();
    await page.route('**/api/workspace/attention/summary', async (route) => {
      replayStarted.resolve();
      await releaseReplay.promise;
      await route.fulfill({ json: { ok: true, data: {
        pendingCount: 0, snapshot: { asOf: new Date().toISOString(), version: 99 }, replayed: 1
      } } });
    }, { times: 1 });
    await page.goto(`/?folder=sent&filter=${filter}`);
    const row = page.locator('.mail-list-panel').getByRole('button', { name: new RegExp(label, 'u') });
    try {
      await replayStarted.promise;
      await expect(row).toBeVisible();
      await page.evaluate(() => {
        const channel = new BroadcastChannel('flaremail-workspace-v1');
        channel.addEventListener('message', ({ data }) => {
          if (data?.type !== 'mailbox-refresh' || data.delivery !== true) return;
          document.documentElement.dataset.observedReplaySync = 'true';
          channel.close();
        });
      });
      expect((await events(page.request, id, 'email.delivered', `attention-startup-replay-delivered-${filter}`)).ok()).toBe(true);
    } finally {
      releaseReplay.resolve();
    }
    if (filter === 'attention') await expect(row).toHaveCount(0);
    else await expect(row.getByText('已送达', { exact: true })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-observed-replay-sync', 'true');
  });
}

test('refreshes Sent and the open receipt from the notification button', async ({ page, baseURL }, info) => {
  test.skip(info.project.name !== 'desktop', 'The desktop workspace displays the Sent list and open receipt together.');
  const origin = originOf(baseURL);
  const id = 'e2e-attention-manual-refresh';
  const label = 'E2E Manual Notification Refresh';
  await seed(page.request, origin, id, 'delayed', label);
  await login(page);
  await page.goto('/?folder=sent&filter=attention');
  await page.getByRole('button', { name: '显示分栏预览', exact: true }).click();
  const row = page.locator('.mail-list-panel').getByRole('button', { name: new RegExp(label, 'u') });
  await row.click();
  const receipt = page.locator('section[aria-labelledby="delivery-title"]').filter({ visible: true });
  await expect(receipt.getByRole('button', { name: '确认异常', exact: true })).toBeVisible();
  await notice(page).click();
  await expect(panel(page).getByText(label, { exact: true })).toBeVisible();

  expect((await events(page.request, id, 'email.delivered', 'attention-button-delivered')).ok()).toBe(true);
  let summaryRefreshed = false;
  const refreshedSummary = page.waitForResponse((response) =>
    new URL(response.url()).pathname === '/api/workspace/attention/summary' &&
    response.request().method() === 'POST' && response.ok()).then(() => { summaryRefreshed = true; });
  const receiptReadAfterReplay = page.waitForRequest((request) =>
    new URL(request.url()).pathname === `/api/workspace/messages/${id}/delivery`
  ).then(() => summaryRefreshed);
  await panel(page).getByRole('button', { name: '刷新通知和系统状态' }).click();
  expect(await receiptReadAfterReplay).toBe(true);
  await refreshedSummary;

  await expect(panel(page).getByText(label, { exact: true })).toHaveCount(0);
  await expect(row).toHaveCount(0);
  await expect(receipt.getByText('已送达', { exact: true }).first()).toBeVisible();
  await expect(receipt.getByRole('button', { name: '确认异常', exact: true })).toHaveCount(0);
});

test('refreshes the notification scope, Sent filter, and receipt after delivery changes', async ({ page, baseURL }, info) => {
  test.skip(info.project.name !== 'desktop', 'One desktop run covers delivery state refresh.');
  const origin = originOf(baseURL);
  const pendingId = 'e2e-attention-refresh';
  const historyId = 'e2e-attention-refresh-history';
  const pendingSubject = 'E2E Pending Refresh';
  const historySubject = 'E2E History Refresh';
  await seed(page.request, origin, pendingId, 'delayed', pendingSubject);
  await seed(page.request, origin, historyId, 'suppressed', historySubject);
  await login(page);
  const history = (await getNotices(page.request)).notices.find((item) => item.messageId === historyId)!;
  expect((await page.request.post(endpoint, {
    headers: { origin }, data: { action: 'acknowledge', incident: { id: history.id, version: history.version } }
  })).ok()).toBe(true);

  await page.goto('/?folder=sent&filter=attention');
  await expect(page.getByText(pendingSubject, { exact: true }).first()).toBeVisible();
  await openFolder(page, '收件箱');
  await notice(page).click();
  await panel(page).getByRole('button', { name: '历史', exact: true }).click();

  const releaseResponse = Promise.withResolvers<void>();
  await page.route(endpoint, async (route) => {
    await releaseResponse.promise;
    await route.fulfill({ status: 503, json: { ok: false, error: { code: 'D1_UNAVAILABLE', message: 'synthetic unavailable' } } });
  });
  await Promise.all([
    page.waitForRequest((request) => request.method() === 'POST' && request.url().endsWith(endpoint)),
    panel(page).getByRole('listitem').filter({ hasText: historySubject }).getByRole('button', { name: '重新打开异常' }).click()
  ]);
  await panel(page).getByRole('button', { name: '关闭', exact: true }).press('Escape');
  await expect(panel(page)).toBeHidden();
  await notice(page).press('Enter');
  await expect(panel(page).getByText('加载中…', { exact: true })).toBeVisible();
  releaseResponse.resolve();
  await expect(panel(page).getByRole('alert')).toContainText('未能更新投递异常');
  await expect(panel(page).getByRole('listitem').getByText('投递延迟', { exact: true })).toBeVisible();
  await page.unroute(endpoint);
  await panel(page).getByRole('button', { name: '确认异常', exact: true }).click();
  await expect(notice(page)).toHaveAccessibleName('通知');
  await page.keyboard.press('Escape');
  const freshPage = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === '/api/workspace/mailbox' && url.searchParams.get('filter') === 'attention' && response.ok();
  });
  await page.goBack();
  await expect(page).toHaveURL(/filter=attention/u);
  await freshPage;
  await expect(page.getByText(pendingSubject, { exact: true })).toHaveCount(0);

  const acknowledged = (await getNotices(page.request, 'history')).notices.find((item) => item.messageId === pendingId)!;
  expect((await page.request.post(endpoint, {
    headers: { origin }, data: { action: 'reopen', incident: { id: acknowledged.id, version: acknowledged.version } }
  })).ok()).toBe(true);
  await page.goto('/?folder=sent&filter=attention');
  await page.getByRole('button', { name: '显示分栏预览', exact: true }).click();
  const row = page.locator('.mail-list-panel').getByRole('button', { name: new RegExp(pendingSubject, 'u') });
  await row.click();
  const receipt = page.locator('section[aria-labelledby="delivery-title"]').filter({ visible: true });
  await expect(receipt.getByText('投递延迟', { exact: true }).first()).toBeVisible();
  const standalone = await page.context().newPage();
  await standalone.goto('/messages/' + pendingId + '?folder=sent', { waitUntil: 'domcontentloaded' });
  const standaloneReceipt = standalone.locator('section[aria-labelledby="delivery-title"]');
  await expect(standaloneReceipt.getByRole('button', { name: '确认异常', exact: true })).toBeVisible();

  expect((await events(page.request, pendingId, 'email.delivered', 'attention-refresh-delivered')).ok()).toBe(true);
  await standalone.evaluate(() => {
    const now = Date.now;
    Date.now = () => now() + 31_000;
    try { window.dispatchEvent(new Event('focus')); } finally { Date.now = now; }
  });
  await expect(standaloneReceipt.getByText('已送达', { exact: true }).first()).toBeVisible();
  await expect(standaloneReceipt.getByRole('button', { name: '确认异常', exact: true })).toHaveCount(0);
  let replayFinished = false;
  const replayResponse = standalone.waitForResponse((response) =>
    new URL(response.url()).pathname === endpoint + '/summary' &&
    response.request().method() === 'POST' && response.ok()).then(() => { replayFinished = true; });
  const standaloneReadAfterReplay = standalone.waitForRequest((request) =>
    new URL(request.url()).pathname === `/api/workspace/messages/${pendingId}/delivery`
  ).then(() => replayFinished);
  await standaloneReceipt.getByRole('button', { name: '刷新投递回执', exact: true }).click();
  expect(await standaloneReadAfterReplay).toBe(true);
  await replayResponse;
  await page.getByRole('button', { name: '刷新投递回执', exact: true }).click();
  await expect(receipt.getByText('已送达', { exact: true }).first()).toBeVisible();
  await expect(row).toHaveCount(0);
  await expect(page.getByRole('heading', { name: pendingSubject, exact: true })).toBeVisible();
  await expect(receipt.getByRole('button', { name: '重试投递' })).toHaveCount(0);

  await page.locator('.fm-detail-shell').getByRole('button', { name: '加星', exact: true }).click();
  await expect(standalone.getByRole('button', { name: '取消星标', exact: true })).toBeVisible();
  await expect(standaloneReceipt.getByText('已送达', { exact: true }).first()).toBeVisible();
  await expect(standaloneReceipt.getByRole('button', { name: '确认异常', exact: true })).toHaveCount(0);
  expect((await page.request.delete('/api/workspace/messages/' + pendingId, { headers: { origin } })).ok()).toBe(true);
  await page.evaluate(() => {
    const channel = new BroadcastChannel('flaremail-workspace-v1');
    channel.postMessage({ type: 'mailbox-refresh', delivery: true });
    channel.close();
  });
  await expect(standalone).toHaveURL((url) => url.pathname === '/');
  await standalone.close();

  for (const filter of ['all', 'attention']) {
    const focusId = `e2e-attention-focus-${filter}`;
    const focusSubject = `E2E Attention Focus ${filter}`;
    await seed(page.request, origin, focusId, 'delayed', focusSubject);
    await page.goto(`/?folder=sent&filter=${filter}`);
    const focusRow = page.locator('.mail-list-panel').getByRole('button', { name: new RegExp(focusSubject, 'u') });
    await focusRow.click();
    const focusReceipt = page.locator('section[aria-labelledby="delivery-title"]').filter({ visible: true });
    await expect(focusReceipt.getByText('投递延迟', { exact: true }).first()).toBeVisible();
    expect((await events(page.request, focusId, 'email.delivered', `attention-focus-delivered-${filter}`)).ok()).toBe(true);
    const summaryStarted = Promise.withResolvers<void>();
    const releaseSummary = Promise.withResolvers<void>();
    if (filter === 'attention') {
      await page.route('**/api/workspace/attention/summary', async (route) => {
        summaryStarted.resolve();
        await releaseSummary.promise;
        await route.abort().catch(() => undefined);
      }, { times: 1 });
    }
    await page.evaluate(() => {
      const now = Date.now;
      Date.now = () => now() + 31_000;
      try { window.dispatchEvent(new Event('focus')); } finally { Date.now = now; }
    });
    if (filter === 'attention') {
      try {
        await summaryStarted.promise;
        const listResponse = page.waitForResponse((response) => new URL(response.url()).pathname === endpoint && response.ok());
        await notice(page).click();
        await listResponse;
        await page.keyboard.press('Escape');
      } finally {
        releaseSummary.resolve();
      }
    }
    await expect(focusRow).toHaveCount(filter === 'attention' ? 0 : 1);
    await expect(focusReceipt.getByText('已送达', { exact: true }).first()).toBeVisible();
    const header = page.locator('.fm-detail-shell').getByRole('heading', { name: focusSubject, exact: true });
    await expect(header.locator('..').getByText('已送达', { exact: true })).toBeVisible();
    await expect(focusReceipt.getByRole('button', { name: '确认异常', exact: true })).toHaveCount(0);
  }
});

test('keeps page three of Sent attention when the tab regains focus', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'One desktop run covers background pagination.');
  await login(page);
  await openFolder(page, '已发送');

  const mailboxPath = (url: URL) => url.pathname === '/api/workspace/mailbox' &&
    url.searchParams.get('folder') === 'sent' && url.searchParams.get('filter') === 'attention';
  const cursors: (string | null)[] = [];
  await page.route(mailboxPath, async (route) => {
    const cursor = new URL(route.request().url()).searchParams.get('cursor');
    cursors.push(cursor);
    const number = Number(cursor ?? 1);
    const label = 'E2E Attention Page ' + number;
    const data: MailboxPage = {
      folder: 'sent', query: '', filter: 'attention', limit: 40, deliveryStatus: null,
      nextCursor: number < 3 ? String(number + 1) : null, hasMore: number < 3,
      messages: [{
        id: 'e2e-attention-page-' + number, folder: 'sent', source: 'workspace', deliveryStatus: 'delayed',
        fromName: 'Sender', fromEmail: 'sender@example.test', toName: 'Recipient', toEmail: 'recipient@example.test',
        subject: label, preview: '', body: '', sentAt: '2026-08-13T08:00:00.000Z', labels: [], read: true, starred: false
      }]
    };
    await route.fulfill({ json: { ok: true, data: { page: data } } });
  });

  await page.getByRole('button', { name: '待处理投递异常', exact: true }).click();
  const next = page.getByRole('button', { name: '下一页', exact: true });
  const previous = page.getByRole('button', { name: '上一页', exact: true });
  const pageRow = (number: number) => page.locator('.mail-list-panel')
    .getByRole('button', { name: new RegExp('E2E Attention Page ' + number, 'u') });
  await expect(pageRow(1)).toBeVisible();
  await next.click();
  await expect(pageRow(2)).toBeVisible();
  await next.click();
  await expect(pageRow(3)).toBeVisible();
  await expect(next).toBeDisabled();

  const refreshedSummary = page.waitForResponse((response) =>
    new URL(response.url()).pathname === '/api/workspace/attention/summary' && response.ok()
  );
  await page.evaluate(() => {
    const now = Date.now;
    Date.now = () => now() + 31_000;
    try {
      window.dispatchEvent(new Event('blur'));
      window.dispatchEvent(new Event('focus'));
    } finally { Date.now = now; }
  });
  await refreshedSummary;
  await expect(pageRow(3)).toBeVisible();
  expect(cursors).toEqual([null, '2', '3']);

  const revalidated = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return mailboxPath(url) && url.searchParams.get('cursor') === '2' && response.ok();
  });
  await previous.click();
  await revalidated;
  await expect(pageRow(2)).toBeVisible();
});

test('replays a manual refresh during confirmation and clears cached receipts', async ({ page, baseURL }, info) => {
  test.skip(info.project.name !== 'desktop', 'One desktop run covers the workspace receipt cache.');
  const origin = originOf(baseURL);
  const selected = 'E2E Confirmation In Flight';
  const cached = 'E2E Previously Opened Receipt';
  const selectedId = 'e2e-attention-confirm-in-flight';
  const cachedId = 'e2e-attention-cached-replay';
  await seed(page.request, origin, selectedId, 'delayed', selected);
  await seed(page.request, origin, cachedId, 'delayed', cached);
  await login(page);
  await page.goto('/?folder=sent');
  await page.getByRole('button', { name: '显示分栏预览', exact: true }).click();
  const row = (label: string) => page.locator('.mail-list-panel').getByRole('button', { name: new RegExp(label, 'u') });
  const receipt = page.locator('section[aria-labelledby="delivery-title"]').filter({ visible: true });
  await row(cached).click();
  await expect(receipt.getByText('投递延迟', { exact: true }).first()).toBeVisible();
  await row(selected).click();
  await expect(receipt.getByText('投递延迟', { exact: true }).first()).toBeVisible();
  await notice(page).click();
  const item = panel(page).getByRole('listitem').filter({ hasText: selected });
  const confirmationStarted = Promise.withResolvers<void>();
  const releaseConfirmation = Promise.withResolvers<void>();
  await page.route((url) => url.pathname === endpoint, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    confirmationStarted.resolve();
    await releaseConfirmation.promise;
    await route.abort().catch(() => undefined);
  });
  try {
    await item.getByRole('button', { name: '确认异常', exact: true }).click();
    await confirmationStarted.promise;
    await page.keyboard.press('Escape');
    expect((await events(page.request, cachedId, 'email.delivered', 'attention-cached-replay-delivered')).ok()).toBe(true);
    const replayStarted = Promise.withResolvers<void>();
    const releaseReplay = Promise.withResolvers<void>();
    await page.route('**/api/workspace/attention/summary', async (route) => {
      replayStarted.resolve();
      await releaseReplay.promise;
      await route.fulfill({ json: { ok: true, data: {
        pendingCount: 1, snapshot: { asOf: new Date().toISOString(), version: 99 }, replayed: 1
      } } });
    }, { times: 1 });
    const replay = page.waitForResponse((response) =>
      new URL(response.url()).pathname === endpoint + '/summary' && response.request().method() === 'POST' && response.ok());
    const refresh = receipt.getByRole('button', { name: '刷新投递回执', exact: true });
    try {
      await refresh.click();
      await replayStarted.promise;
      await expect(refresh).toBeDisabled();
      await refresh.dispatchEvent('click');
    } finally {
      releaseReplay.resolve();
    }
    await replay;
    await expect(refresh).toBeEnabled();
    await expect(page.getByText('重新载入投递回执失败。', { exact: true })).toHaveCount(0);
    await row(cached).click();
    await expect(receipt.getByText('已送达', { exact: true }).first()).toBeVisible();
  } finally {
    releaseConfirmation.resolve();
    for (const id of [selectedId, cachedId]) {
      await page.request.delete('/api/workspace/messages/' + id, { headers: { origin } });
    }
  }
});

test('keeps notifications readable when replay POST fails', async ({ page, baseURL }, info) => {
  test.skip(info.project.name !== 'desktop', 'One desktop run covers the notification API fallback.');
  const origin = originOf(baseURL);
  const id = 'e2e-attention-replay-fallback';
  const label = 'E2E Replay Read Fallback';
  await seed(page.request, origin, id, 'delayed', label);
  await page.route('**/api/workspace/attention/summary', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    return route.fulfill({ status: 503, json: { ok: false, error: { code: 'REPLAY_FAILED', message: 'Replay unavailable' } } });
  });
  const badge = page.waitForResponse((response) =>
    new URL(response.url()).pathname === endpoint + '/summary' && response.request().method() === 'GET' && response.ok());
  await login(page);
  try {
    await badge;
    await notice(page).click();
    await expect(panel(page).getByRole('listitem').filter({ hasText: label })).toBeVisible();
  } finally {
    await page.request.delete('/api/workspace/messages/' + id, { headers: { origin } });
  }
});
