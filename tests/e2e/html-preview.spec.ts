import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertNoConsoleErrors, assertNoHorizontalOverflow, expect, login, test } from './fixtures';

// All content and mutations use the local fixture mailbox, never remote PRE data.
test('preserves email table styles, responsive padding and light canvas in the safe HTML reader', async ({ page, baseURL, consoleErrors }, testInfo) => {
  expect(new URL(baseURL!).hostname).toBe('127.0.0.1');
  const remoteRequests: string[] = [];
  await page.route('https://tracker.example/**', async (route) => {
    remoteRequests.push(route.request().url());
    await route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64') });
  });
  await page.emulateMedia({ colorScheme: 'dark' });
  await login(page);
  await expect(page).toHaveTitle(/FlareMail/iu);
  const item = page.getByRole('listitem').filter({ hasText: 'E2E HTML Safety' });
  await item.getByRole('button', { name: /E2E HTML Safety/u }).first().click();
  const detail = page.getByRole('region', { name: '邮件详情' });
  const toggle = detail.getByRole('button', { name: '安全 HTML', exact: true });
  await toggle.focus();
  await toggle.press('Enter');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  const iframe = detail.locator('iframe[title="安全 HTML 邮件正文"]');
  await expect(iframe).toBeVisible();
  await expect(iframe).toHaveAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox');
  const frame = page.frameLocator('iframe[title="安全 HTML 邮件正文"]');
  await expect(frame.getByText('Safe HTML fixture', { exact: true })).toBeVisible();
  await expect(frame.locator('script, form, iframe, link')).toHaveCount(0);
  const table = frame.locator('table.fm-user-newsletter');
  await expect(table).toHaveCSS('background-color', 'rgb(241, 245, 249)');
  const metrics = await table.evaluate((element) => {
    const cell = element.querySelector('td')!;
    return {
      canvasColor: getComputedStyle(document.body).backgroundColor,
      viewport: innerWidth,
      tableWidth: element.getBoundingClientRect().width,
      cellBorder: getComputedStyle(cell).borderTopWidth,
      cellPadding: getComputedStyle(cell).paddingTop,
      color: getComputedStyle(cell).color,
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
    };
  });
  expect(metrics.canvasColor).toBe('rgb(255, 255, 255)');
  expect(metrics.cellBorder).toBe('0px');
  expect(metrics.cellPadding).toBe(metrics.viewport <= 480 ? '12px' : '24px');
  expect(metrics.color).toBe('rgb(36, 50, 71)');
  expect(metrics.tableWidth).toBeLessThanOrEqual(Math.min(600, metrics.viewport));
  expect(metrics.overflow).toBe(false);
  await expect.poll(() => frame.locator('img[alt="inline logo"]').evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBe(1);
  await expect(frame.locator('img[src^="https:"]')).toHaveCount(0);
  await expect(frame.getByText(/显示文本与目标不一致/u)).toBeVisible();
  await assertNoHorizontalOverflow(page);
  await iframe.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(tmpdir(), `flaremail-html-preview-${testInfo.project.name}.png`) });
  expect(remoteRequests).toEqual([]);
  await detail.getByRole('button', { name: '加载本邮件 HTTPS 图片' }).click({ force: true });
  await expect(frame.locator('img[src^="https://tracker.example/"]')).toHaveCount(1);
  await expect.poll(() => remoteRequests.length).toBe(1);
  expect(remoteRequests[0]).toContain('/pixel.png');
  await expect(frame.locator('img[src^="http:"]')).toHaveCount(0);
  await detail.getByRole('button', { name: '撤销远程图片权限' }).click({ force: true });
  await expect(frame.locator('img[src^="https://tracker.example/"]')).toHaveCount(0);
  await detail.getByRole('button', { name: '纯文本' , exact: true }).press('Enter');
  await expect(iframe).toHaveCount(0);
  await expect(detail).toContainText('Safe HTML fixture text fallback.');
  // Local Wrangler injects its explorer script; the mail sandbox blocks it.
  await assertNoConsoleErrors(consoleErrors.filter((message) => !(
    message.startsWith('Blocked script execution in ') &&
    message.includes('/api/workspace/messages/email%3Ae2e-html-inbox-message/html?remote=') &&
    message.includes("'allow-scripts' permission is not set")
  )));
});
