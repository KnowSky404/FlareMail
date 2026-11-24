import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import type { APIRequestContext, Page, TestInfo } from '@playwright/test';
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

async function seed(request: APIRequestContext, origin: string, id: string, status: string) {
  const response = await request.post(origin + `/cdn-cgi/local/explorer/api/d1/database/${target.databaseId}/raw`, { data: { batch: [
    { sql: `INSERT INTO workspace_messages
        (id, user_id, folder, from_name, from_email, to_name, to_email, subject, body, sender_address_id, sent_at, is_read)
        SELECT ?, user_id, 'sent', 'E2E Sender', 'e2e-admin@flaremail.test', 'Recipient', 'recipient@flaremail.test',
          ?, 'Synthetic delivery test body', ?, '2026-08-13T08:00:00.000Z', 1
        FROM workspace_owner WHERE singleton = 1 AND user_id = ?`, params: [id, subject, primary, owner] },
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

  await panel(page).getByRole('button', { name: '查看邮件' }).click();
  await expect(page).toHaveURL(new RegExp('message=' + id, 'u'));
  await expect(page).not.toHaveURL(/identity=/u);
  const timeline = page.locator('section[aria-labelledby="delivery-title"]').filter({ visible: true });
  await expect(timeline.getByRole('button', { name: '确认异常' })).toBeVisible();
  await expect(timeline.getByText('已退信', { exact: true })).toBeVisible();
  await expect(timeline.getByRole('button', { name: '重试投递' })).toHaveCount(0);
  await screenshot(page, info, 'delivery-detail');
  const startedAt = performance.now();
  await timeline.getByRole('button', { name: '确认异常' }).click();
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
  }
  await assertNoConsoleErrors(consoleErrors);
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
    await route.fulfill({ status: 503, json: { ok: false, error: { code: 'R2_UNAVAILABLE', message: 'synthetic dependency fault' } } });
  });
  await notice(page).click();
  await panel(page).getByRole('button', { name: '刷新通知和系统状态' }).click();
  await expect(panel(page).getByText('系统运行异常', { exact: true })).toBeVisible();

  await page.route(endpoint, async (route) => route.fulfill({ status: 503, json: { ok: false, error: { code: 'D1_UNAVAILABLE', message: 'synthetic unavailable' } } }));
  await panel(page).getByRole('button', { name: '确认异常', exact: true }).click();
  await expect(panel(page).getByRole('alert')).toContainText('未能更新投递异常');
  await expect(panel(page).getByText(subject)).toBeVisible();
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
  expect((await request.delete('/api/workspace/session', { headers: { origin } })).ok()).toBe(true);
  expect((await post(ack)).status()).toBe(401);
  await login(page);
  expect((await getNotices(page.request, 'history')).notices.find((item) => item.id === bounce.id)?.state).toBe('acknowledged');
});
