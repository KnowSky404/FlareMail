import { join } from 'node:path';
import { tmpdir } from 'node:os';
import AxeBuilder from '@axe-core/playwright';
import { assertNoConsoleErrors, assertNoHorizontalOverflow, expect, login, test } from './fixtures';

test.describe.configure({ mode: 'serial' });

test('renders inbox and focused reading without Firefox errors', async ({ page, consoleErrors }) => {
  await login(page);
  await expect(page).toHaveTitle(/FlareMail/u);
  await expect(page.getByRole('heading', { name: '收件箱', exact: true })).toBeVisible();
  await expect(page.locator('.mail-workspace')).toHaveAttribute('data-list-width-effective', '440');
  await assertNoHorizontalOverflow(page);
  await page.setViewportSize({ width: 1505, height: 1045 });
  await page.screenshot({ path: join(tmpdir(), 'flaremail-firefox-inbox-concept-size.png'), fullPage: false });
  await page.setViewportSize({ width: 1366, height: 900 });
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

test('keeps an exceptionally long subject and message readable at desktop, tablet, and phone widths', async ({ page, consoleErrors }, testInfo) => {
  await login(page);
  const subject = `E2E Long Subject ${'UnbrokenSubject'.repeat(28)}`;
  const body = Array.from({ length: 400 }, (_, index) => `Long message line ${index + 1}: ${'content '.repeat(12)}`).join('\n');
  const created = await page.evaluate(async ({ subject, body }) => {
    const response = await fetch('/api/workspace/drafts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: [{ name: 'Long Content Fixture', email: 'long-content@flaremail.test' }], subject, body })
    });
    return { ok: response.ok, status: response.status, payload: await response.json() };
  }, { subject, body });
  expect(created.ok, `${created.status}: ${JSON.stringify(created.payload)}`).toBe(true);

  await page.goto('/?folder=drafts');
  const item = page.getByRole('listitem').filter({ hasText: 'E2E Long Subject' });
  await expect(item).toBeVisible();
  await item.getByRole('button', { name: /E2E Long Subject/u }).click();
  const detail = page.getByRole('region', { name: '邮件详情' });
  await expect(detail.getByRole('heading', { name: subject, exact: true })).toBeVisible();
  await expect(detail.locator('.message-plain-body')).toContainText('Long message line 400:');

  for (const width of [1366, 768, 390]) {
    await page.setViewportSize({ width, height: width < 900 ? 844 : 900 });
    await assertNoHorizontalOverflow(page);
    await expect(detail.getByRole('button', { name: '展开主题' })).toBeVisible();
    const geometry = await detail.locator('.message-header-row').evaluate((header) => {
      const subject = header.querySelector('h1')?.getBoundingClientRect();
      const row = header.getBoundingClientRect();
      return { subjectLeft: subject?.left ?? -1, subjectRight: subject?.right ?? -1, rowLeft: row.left, rowRight: row.right };
    });
    expect(geometry.subjectLeft).toBeGreaterThanOrEqual(geometry.rowLeft);
    expect(geometry.subjectRight).toBeLessThanOrEqual(geometry.rowRight);
  }
  await page.screenshot({ path: join(tmpdir(), `flaremail-long-message-${testInfo.project.name}-mobile.png`), fullPage: false });
  await detail.getByRole('button', { name: '展开主题' }).click();
  await expect(detail.getByRole('button', { name: '收起主题' })).toBeVisible();
  await assertNoHorizontalOverflow(page);
  await assertNoConsoleErrors(consoleErrors);
});

test('uploads and downloads a near-limit attachment without mobile layout overflow', async ({ page, consoleErrors }, testInfo) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.locator('.mobile-bar').getByRole('button', { name: '写邮件' }).click();
  const compose = page.getByRole('dialog', { name: '新邮件' });
  await expect(compose).toBeVisible();
  await compose.getByLabel('收件人').fill('attachment-recipient@flaremail.test');
  await compose.getByRole('textbox', { name: '主题', exact: true }).fill('E2E Near-Limit Attachment');
  await compose.getByRole('textbox', { name: '正文', exact: true }).fill('Mobile near-limit attachment smoke.');

  const filename = `${'project-review-'.repeat(10)}report.bin`;
  const size = 7 * 1024 * 1024;
  await compose.getByLabel('选择附件').setInputFiles([{
    name: filename,
    mimeType: 'application/octet-stream',
    buffer: Buffer.alloc(size, 0x41)
  }]);
  await expect(compose.getByLabel(`附件名称 ${filename}`)).toHaveValue(filename, { timeout: 60_000 });
  await expect(compose.getByRole('list', { name: '附件上传状态' })).toHaveCount(0);
  await expect(compose.locator('.compose-attachment-count')).toHaveText('1');
  await expect(compose.locator('#compose-footer-attachment-count')).toHaveText('已添加 1 个附件');
  await expect(compose.getByRole('list', { name: '待发送附件' })).toContainText('7 MB');
  await assertNoHorizontalOverflow(page);
  await page.screenshot({ path: join(tmpdir(), `flaremail-large-attachment-${testInfo.project.name}-mobile.png`), fullPage: false });
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await expect(compose.locator('.compose-attachment-count')).toHaveCSS('color', 'rgb(17, 24, 39)');
  await assertNoHorizontalOverflow(page);
  await page.screenshot({ path: join(tmpdir(), `flaremail-large-attachment-${testInfo.project.name}-mobile-dark.png`), fullPage: false });

  await compose.getByRole('button', { name: '发送邮件' }).click();
  const detail = page.getByRole('region', { name: '邮件详情' });
  await expect(detail.getByRole('heading', { name: 'E2E Near-Limit Attachment' })).toBeVisible({ timeout: 60_000 });
  const download = detail.getByRole('link', { name: `下载附件 ${filename}` });
  await expect(download).toBeVisible();
  const href = await download.getAttribute('href');
  expect(href).toBeTruthy();
  const response = await page.request.get(href!);
  expect(response.ok()).toBe(true);
  const bytes = await response.body();
  expect(bytes.length).toBe(size);
  expect(bytes[0]).toBe(0x41);
  expect(bytes[size - 1]).toBe(0x41);
  await assertNoHorizontalOverflow(page);
  await assertNoConsoleErrors(consoleErrors);
});

test('keeps mobile compose, domains, and settings accessible in light and dark themes', async ({ page, consoleErrors }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  const composeButton = page.locator('.mobile-bar').getByRole('button', { name: '写邮件' });
  await composeButton.click();
  await expect(page.getByRole('dialog', { name: '新邮件' })).toBeVisible();

  const scan = async () => (await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze()).violations;
  expect(await scan()).toEqual([]);
  await page.getByRole('dialog', { name: '新邮件' }).getByRole('button', { name: '关闭' }).click();
  await expect(page.getByRole('dialog', { name: '新邮件' })).toBeHidden();
  await expect(composeButton).toBeFocused();

  await page.goto('/?folder=settings&view=domains');
  await expect(page.getByRole('heading', { name: '域名概览' })).toBeVisible();
  expect(await scan()).toEqual([]);
  await page.goto('/?folder=settings');
  await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible();
  expect(await scan()).toEqual([]);
  await page.evaluate(() => localStorage.setItem('flaremail-theme', 'dark'));
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await scan()).toEqual([]);
  await assertNoHorizontalOverflow(page);
  await assertNoConsoleErrors(consoleErrors);
});
