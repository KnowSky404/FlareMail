import { join } from 'node:path';
import { tmpdir } from 'node:os';
import AxeBuilder from '@axe-core/playwright';
import { assertNoConsoleErrors, assertNoHorizontalOverflow, expect, login, test } from './fixtures';

// All content and mutations use the local fixture mailbox, never remote PRE data.
test('preserves email layout while switching between safe and unsafe HTML in the compact reader', async ({ page, baseURL, consoleErrors }, testInfo) => {
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
  await expect(detail.getByRole('button', { name: '纯文本', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(detail.locator('[role="note"]')).toHaveCount(0);
  const info = detail.getByRole('button', { name: '阅读视图说明', exact: true });
  await info.focus();
  await expect(detail.getByRole('tooltip').filter({ hasText: /纯文本/u })).toBeVisible();
  await info.press('Escape');
  await expect(detail.getByRole('tooltip').filter({ hasText: /纯文本/u })).toBeHidden();
  const toggle = detail.getByRole('button', { name: '安全 HTML', exact: true });
  await toggle.focus();
  await toggle.press('Enter');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  const iframe = detail.locator('iframe[title="安全 HTML 邮件正文"]');
  await expect(iframe).toBeVisible();
  await expect(iframe).toHaveAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox');
  await expect(iframe).toHaveAttribute('src', /\?mode=safe$/u);
  await expect(detail.getByRole('button', { name: /加载本邮件 HTTPS 图片|撤销远程图片权限/u })).toHaveCount(0);
  const frame = page.frameLocator('iframe[title="安全 HTML 邮件正文"]');
  await expect(frame.getByText('Safe HTML fixture', { exact: true })).toBeVisible();
  await expect(frame.locator('script, form, iframe, link')).toHaveCount(0);
  await expect(frame.locator('.fm-email-content #fm-user-table-recovery')).toHaveText('Table recovery fixture');
  await expect(frame.locator('fm-email-html')).toHaveCSS('padding-top', '0px');
  await expect(frame.locator('fm-email-body')).toHaveCSS('padding-top', '0px');
  await expect(frame.locator('#fm-user-root-cascade')).toHaveCSS('padding-top', '20px');
  await expect(frame.locator('#fm-user-root-cascade')).toHaveCSS('color', 'rgb(255, 255, 255)');
  await expect(frame.locator('#fm-user-root-cascade')).toHaveCSS('box-sizing', 'border-box');
  expect(await frame.locator('#fm-user-root-cascade').evaluate((element) => element.getBoundingClientRect().width <= element.closest('.fm-email-content')!.clientWidth)).toBe(true);
  await expect(frame.locator('td.fm-user-cascade-cell')).toHaveCSS('background-color', 'rgb(17, 17, 17)');
  await expect(frame.locator('#fm-user-legacy-hex')).toHaveCSS('background-color', 'rgb(0, 0, 0)');
  await expect(frame.locator('#fm-user-legacy-hex')).toHaveCSS('color', 'rgb(255, 255, 255)');
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
  await expect(frame.locator('a')).toHaveAttribute('href', 'https://example.com/login');
  await expect(frame.getByText(/显示文本与目标不一致/u)).toHaveCount(0);
  await assertNoHorizontalOverflow(page);
  await iframe.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(tmpdir(), `flaremail-html-preview-${testInfo.project.name}.png`) });
  expect(remoteRequests).toEqual([]);
  const unsafeToggle = detail.getByRole('button', { name: '不安全 HTML', exact: true });
  await unsafeToggle.press('Enter');
  await expect(unsafeToggle).toHaveAttribute('aria-pressed', 'true');
  const unsafeIframe = detail.locator('iframe[title="不安全 HTML 邮件正文"]');
  await expect(unsafeIframe).toHaveAttribute('src', /\?mode=unsafe$/u);
  await expect(unsafeIframe).toHaveAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox');
  const unsafeFrame = page.frameLocator('iframe[title="不安全 HTML 邮件正文"]');
  await expect(unsafeFrame.locator('img[src^="https://tracker.example/"]')).toHaveCount(1);
  await expect.poll(() => remoteRequests.some((url) => url.endsWith('/pixel.png'))).toBe(true);
  await expect(unsafeFrame.locator('img[src^="http:"]')).toHaveCount(0);
  if (testInfo.project.use.isMobile) await info.tap();
  else await info.click();
  await expect(detail.getByRole('tooltip').filter({ hasText: /远程|跟踪/u })).toBeVisible();
  await info.press('Escape');
  await toggle.press('Enter');
  await expect(frame.locator('img[src^="https://tracker.example/"]')).toHaveCount(0);
  await detail.getByRole('button', { name: '纯文本', exact: true }).press('Enter');
  await expect(iframe).toHaveCount(0);
  await expect(detail).toContainText('Safe HTML fixture text fallback.');
  // The local runtime injects its explorer script; the mail sandbox blocks it.
  await assertNoConsoleErrors(consoleErrors.filter((message) => !(
    message.startsWith('Blocked script execution in ') &&
    message.includes('/api/workspace/messages/email%3Ae2e-html-inbox-message/html?mode=') &&
    message.includes("'allow-scripts' permission is not set")
  )));
});

test('keeps mail information in the header and makes reading guidance accessible without banners', async ({ page, consoleErrors }, testInfo) => {
  await login(page);
  await page.getByRole('listitem').filter({ hasText: 'E2E HTML Safety' })
    .getByRole('button', { name: /E2E HTML Safety/u }).first().click();
  const detail = page.getByRole('region', { name: '邮件详情' });
  const plainText = detail.getByRole('button', { name: '纯文本', exact: true });
  const info = detail.getByRole('button', { name: '阅读视图说明', exact: true });
  const metadataTrigger = detail.getByRole('button', { name: '邮件信息', exact: true });
  await expect(plainText).toBeInViewport();
  if (page.viewportSize()!.width <= 900) {
    const undersized = await detail.locator('.message-view-controls button').evaluateAll((buttons) => buttons
      .filter((button) => { const bounds = button.getBoundingClientRect(); return bounds.width < 44 || bounds.height < 44; })
      .map((button) => button.getAttribute('aria-label') || button.textContent?.trim()));
    expect(undersized).toEqual([]);
  }
  expect(await plainText.evaluate((button) => Boolean(button.closest('header')))).toBe(true);
  expect(await metadataTrigger.evaluate((button) => Boolean(button.closest('header')))).toBe(true);
  await expect(detail.locator('article [role="note"]')).toHaveCount(0);
  await expect(detail.getByText('技术详情', { exact: true })).toBeHidden();
  await expect(detail.getByText('发件人详情', { exact: true })).toBeHidden();

  if (!testInfo.project.name.includes('mobile') && !testInfo.project.name.includes('iphone') && !testInfo.project.name.includes('ipad')) {
    await info.hover();
    await expect(detail.getByRole('tooltip').filter({ hasText: /纯文本/u })).toBeVisible();
    await page.mouse.move(0, 0);
    await expect(detail.getByRole('tooltip').filter({ hasText: /纯文本/u })).toBeHidden();
  }
  await info.focus();
  const guidance = detail.getByRole('tooltip').filter({ hasText: /纯文本/u });
  await expect(guidance).toBeVisible();
  expect(await info.getAttribute('aria-describedby')).toBe(await guidance.getAttribute('id'));
  await info.press('Escape');
  await expect(guidance).toBeHidden();

  await metadataTrigger.press('Enter');
  const panel = detail.getByRole('dialog', { name: '邮件信息', exact: true });
  await expect(panel).toBeVisible();
  await expect(panel.locator('summary').first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(metadataTrigger).toBeFocused();
  await metadataTrigger.press('Enter');
  await expect(panel).toBeVisible();
  await detail.getByText('发件人详情', { exact: true }).click();
  await expect(panel).toContainText('html-sender@flaremail.test');
  await detail.getByText('技术详情', { exact: true }).click();
  await expect(panel).toContainText('spf=pass');
  const bounds = await panel.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(page.viewportSize()!.height + 1);
  await page.screenshot({ path: join(tmpdir(), `flaremail-reader-metadata-${testInfo.project.name}.png`) });
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(metadataTrigger).toBeFocused();
  await assertNoHorizontalOverflow(page);
  const violations = (await new AxeBuilder({ page }).include('.message-detail-header').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()).violations;
  expect(violations.flatMap(({ id, nodes }) => nodes.map(({ target }) => `${id}: ${target.join(', ')}`))).toEqual([]);
  await plainText.focus();
  await page.mouse.move(0, 0);
  await page.screenshot({ path: join(tmpdir(), `flaremail-reader-compact-${testInfo.project.name}.png`) });
  await assertNoConsoleErrors(consoleErrors);
});

test('limits unsafe HTML to the selected message and preserves its view in focused reading', async ({ page, consoleErrors }) => {
  await page.route('https://tracker.example/**', async (route) => {
    await route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64') });
  });
  await login(page);
  await page.getByRole('listitem').filter({ hasText: 'E2E HTML Safety' })
    .getByRole('button', { name: /E2E HTML Safety/u }).first().click();
  const detail = page.getByRole('region', { name: '邮件详情' });
  await detail.getByRole('button', { name: '不安全 HTML', exact: true }).click();
  await expect(detail.locator('iframe')).toHaveAttribute('src', /mode=unsafe/u);
  const readerTrigger = detail.getByRole('button', { name: '展开专注阅读', exact: true });
  if (await readerTrigger.isVisible()) {
    await readerTrigger.click();
    const reader = page.getByRole('dialog', { name: 'E2E HTML Safety', exact: true });
    await expect(reader.getByRole('button', { name: '不安全 HTML', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(reader.locator('iframe')).toHaveAttribute('src', /mode=unsafe/u);
    await reader.getByRole('button', { name: '关闭专注阅读', exact: true }).click();
    await expect(reader).toBeHidden();
    await expect(readerTrigger).toBeFocused();
  }
  await detail.getByRole('button', { name: '返回邮件列表', exact: true }).click();
  await page.getByRole('listitem').filter({ hasText: 'E2E Inbox Welcome' })
    .getByRole('button', { name: /E2E Inbox Welcome/u }).first().click();
  await expect(detail.locator('.message-plain-body')).toContainText('This message is seeded');
  await detail.getByRole('button', { name: '返回邮件列表', exact: true }).click();
  await page.getByRole('listitem').filter({ hasText: 'E2E HTML Safety' })
    .getByRole('button', { name: /E2E HTML Safety/u }).first().click();
  await expect(detail.getByRole('button', { name: '纯文本', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(detail.locator('iframe')).toHaveCount(0);
  await assertNoConsoleErrors(consoleErrors.filter((message) => !(
    message.startsWith('Blocked script execution in ') &&
    message.includes('/api/workspace/messages/email%3Ae2e-html-inbox-message/html?mode=') &&
    message.includes("'allow-scripts' permission is not set")
  )));
});

test('keeps compact HTML controls accessible in narrow desktop split panes', async ({ page, consoleErrors }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'The Chromium desktop project drives split-pane geometry.');
  await login(page);
  await page.getByRole('button', { name: '显示分栏预览', exact: true }).click();
  const splitter = page.locator('.mail-splitter');
  await splitter.focus();
  await splitter.press('End');
  await page.getByRole('listitem').filter({ hasText: 'E2E HTML Safety' })
    .getByRole('button', { name: /E2E HTML Safety/u }).first().click();
  const detail = page.getByRole('region', { name: '邮件详情' });
  for (const width of [1024, 1100, 1366]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(detail.getByRole('button', { name: '纯文本', exact: true })).toBeInViewport();
    await expect(detail.getByRole('button', { name: '安全 HTML', exact: true })).toBeInViewport();
    await expect(detail.getByRole('button', { name: '不安全 HTML', exact: true })).toBeInViewport();
    const geometry = await detail.evaluate((element) => {
      const area = element.getBoundingClientRect();
      const buttons = [...element.querySelectorAll<HTMLButtonElement>('header button')]
        .filter((button) => button.getClientRects().length > 0)
        .map((button) => ({ label: button.getAttribute('aria-label') || button.textContent?.trim() || '', bounds: button.getBoundingClientRect() }));
      return {
        clipped: buttons.filter(({ bounds }) => bounds.left < area.left - 1 || bounds.right > area.right + 1).map(({ label }) => label),
        overlapping: buttons.flatMap((left, index) => buttons.slice(index + 1).filter((right) =>
          Math.min(left.bounds.right, right.bounds.right) - Math.max(left.bounds.left, right.bounds.left) > 1 &&
          Math.min(left.bounds.bottom, right.bounds.bottom) - Math.max(left.bounds.top, right.bounds.top) > 1
        ).map((right) => `${left.label} / ${right.label}`))
      };
    });
    expect(geometry, `split-pane header geometry at ${width}px`).toEqual({ clipped: [], overlapping: [] });
    await assertNoHorizontalOverflow(page);
    if (width === 1024) await page.screenshot({ path: join(tmpdir(), 'flaremail-reader-split-1024.png') });
  }
  await assertNoConsoleErrors(consoleErrors);
});
