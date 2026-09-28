import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertNoConsoleErrors, assertNoHorizontalOverflow, expect, login, test } from './fixtures';

test.describe.configure({ mode: 'serial' });

test('renders inbox and focused reading without Firefox errors', async ({ page, consoleErrors }) => {
  await login(page);
  await expect(page).toHaveTitle(/FlareMail/u);
  await expect(page.getByRole('heading', { name: '收件箱', exact: true })).toBeVisible();
  await assertNoHorizontalOverflow(page);
  await page.screenshot({ path: join(tmpdir(), 'flaremail-firefox-inbox.png'), fullPage: false });

  const item = page.getByRole('listitem').filter({ hasText: 'E2E Inbox Welcome' });
  await item.getByRole('button', { name: /E2E Inbox Welcome/u }).click();
  const detail = page.getByRole('region', { name: '邮件详情' });
  await expect(detail.getByRole('heading', { name: 'E2E Inbox Welcome' })).toBeVisible();
  await expect(detail.locator('.message-plain-body')).toBeVisible();
  await detail.getByRole('button', { name: '展开专注阅读' }).click();
  const reader = page.getByRole('dialog', { name: 'E2E Inbox Welcome' });
  await expect(reader).toBeVisible();
  await reader.getByRole('button', { name: '关闭专注阅读' }).click();
  await expect(reader).toBeHidden();
  await assertNoConsoleErrors(consoleErrors);
});

test('persists a created label on a message through Firefox reload and rename', async ({ page, consoleErrors }) => {
  await login(page);
  await page.getByRole('listitem').filter({ hasText: 'E2E Inbox Welcome' })
    .getByRole('button', { name: /E2E Inbox Welcome/u }).click();
  await page.getByRole('button', { name: '管理标签' }).click();
  await page.getByRole('dialog', { name: '管理标签' }).getByRole('button', { name: '新建标签' }).click();
  const editor = page.getByRole('dialog', { name: '新建标签' });
  await editor.getByLabel('标签名称').fill('Firefox Follow Up');
  await editor.getByRole('button', { name: '保存' }).click();
  await expect(editor).toBeHidden();
  await page.getByRole('button', { name: 'Firefox Follow Up', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Firefox Follow Up' })).toBeVisible();
  await expect(page.getByRole('listitem').filter({ hasText: 'E2E Inbox Welcome' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Firefox Follow Up' })).toBeVisible();
  await page.getByRole('button', { name: '重命名标签' }).click();
  const rename = page.getByRole('dialog', { name: '重命名标签' });
  await rename.getByLabel('标签名称').fill('Firefox Resolved');
  await rename.getByRole('button', { name: '保存' }).click();
  await expect(page.getByRole('heading', { name: 'Firefox Resolved' })).toBeVisible();
  await assertNoConsoleErrors(consoleErrors);
});

test('sends with a second managed identity through the local demo provider', async ({ page, consoleErrors }) => {
  const remoteRequests: string[] = [];
  page.on('request', (request) => {
    if (/resend\.com/iu.test(request.url())) remoteRequests.push(request.url());
  });
  await login(page);
  await page.getByRole('button', { name: '写邮件', exact: true }).first().click();
  const compose = page.getByRole('dialog', { name: '新邮件' });
  await expect(compose).toBeVisible();
  await compose.getByLabel('发件地址').selectOption('00000000-0000-4000-8000-000000000022');
  await compose.getByLabel('收件人').fill('firefox-recipient@flaremail.test');
  await compose.getByRole('textbox', { name: '主题', exact: true }).fill('E2E Firefox Send');
  await compose.getByRole('textbox', { name: '正文', exact: true }).fill('Firefox local demo provider smoke.');
  await compose.getByRole('button', { name: '发送邮件' }).click();
  await expect(page.getByRole('region', { name: '邮件详情' }).getByRole('heading', { name: 'E2E Firefox Send' })).toBeVisible();
  expect(remoteRequests).toEqual([]);
  await assertNoConsoleErrors(consoleErrors);
});

test('keeps domain dashboard responsive in light and dark Firefox', async ({ page, consoleErrors }) => {
  await login(page);
  await page.goto('/?folder=settings&view=domains');
  await expect(page.getByRole('heading', { name: '域名概览' })).toBeVisible();
  await expect(page.locator('.domain-card').filter({ hasText: 'flaremail.test' })).toBeVisible();
  for (const width of [1920, 1440, 1366, 768, 390]) {
    await page.setViewportSize({ width, height: width < 900 ? 844 : 900 });
    await assertNoHorizontalOverflow(page);
  }
  await page.screenshot({ path: join(tmpdir(), 'flaremail-firefox-domains-mobile.png'), fullPage: false });
  await page.evaluate(() => localStorage.setItem('flaremail-theme', 'dark'));
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByRole('heading', { name: '域名概览' })).toBeVisible();
  await assertNoHorizontalOverflow(page);
  await page.screenshot({ path: join(tmpdir(), 'flaremail-firefox-domains-mobile-dark.png'), fullPage: false });
  await assertNoConsoleErrors(consoleErrors);
});
