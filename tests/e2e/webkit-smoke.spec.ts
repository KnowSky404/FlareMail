import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { assertNoConsoleErrors, assertNoHorizontalOverflow, expect, login, openFolder, test } from './fixtures';

test.describe.configure({ mode: 'serial', timeout: 75_000 });

const projectIsPhone = (name: string) => name.includes('iphone');
const projectIsMobile = (name: string) => projectIsPhone(name) || name.includes('ipad');

async function createSmokeDraft(page: Page, subject: string) {
  const result = await page.evaluate(async (nextSubject) => {
    const response = await fetch('/api/workspace/drafts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        to: [{ name: 'WebKit Smoke', email: 'trash@flaremail.test' }],
        subject: nextSubject,
        body: 'WebKit trash restore fixture.'
      })
    });
    return { ok: response.ok, status: response.status, payload: await response.json() };
  }, subject);
  expect(result.ok, `${result.status}: ${JSON.stringify(result.payload)}`).toBe(true);
}

async function openCompose(page: Page) {
  const backButton = page.getByRole('button', { name: '返回邮件列表' });
  if (await backButton.isVisible()) await backButton.click();

  const composeButtons = page.getByRole('button', { name: '写邮件', exact: true });
  for (let index = 0; index < await composeButtons.count(); index += 1) {
    const button = composeButtons.nth(index);
    if (await button.isVisible()) {
      await button.click();
      return;
    }
  }

  await page.getByRole('button', { name: '打开导航' }).click();
  await page.getByRole('navigation', { name: '移动端导航' }).getByRole('button', { name: '写邮件', exact: true }).click();
}

test('logs in, navigates, searches, opens a message, and returns', async ({ page, consoleErrors }, testInfo) => {
  await login(page);
  await openFolder(page, '已发送');
  await expect(page.getByRole('heading', { name: '已发送', exact: true })).toBeVisible();
  await openFolder(page, '收件箱');
  await page.getByLabel('搜索邮件').fill('E2E Inbox Welcome');
  const item = page.getByRole('listitem').filter({ hasText: 'E2E Inbox Welcome' });
  await expect(item).toBeVisible();
  await item.getByRole('button', { name: /E2E Inbox Welcome/u }).first().click();
  await expect(page.getByRole('region', { name: '邮件详情' })).toContainText('E2E Inbox Welcome');
  if (projectIsMobile(testInfo.project.name)) {
    await page.getByRole('button', { name: '返回邮件列表' }).click();
    await expect(page.getByLabel('搜索邮件')).toHaveValue('E2E Inbox Welcome');
  }
  await assertNoConsoleErrors(consoleErrors);
});

test('keeps plain text safe while exercising HTML, CID, remote consent, and report download', async ({ page, consoleErrors }) => {
  const remoteRequests: string[] = [];
  await page.route('https://tracker.example/**', async (route) => {
    remoteRequests.push(route.request().url());
    await route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64') });
  });

  await login(page);
  const item = page.getByRole('listitem').filter({ hasText: 'E2E HTML Safety' });
  await item.getByRole('button', { name: /E2E HTML Safety/u }).first().click();
  const detail = page.getByRole('region', { name: '邮件详情' });
  await detail.getByText('技术详情', { exact: true }).click();
  const replyAllDialog = page.getByRole('dialog', { name: '回复邮件' });
  await detail.getByRole('button', { name: '回复全部', exact: true }).click();
  await expect(replyAllDialog.getByRole('button', { name: '移除收件人 support@flaremail.test' })).toBeVisible();
  await expect(replyAllDialog.getByRole('button', { name: '移除抄送 observer@flaremail.test' })).toBeVisible();
  await expect(replyAllDialog.getByRole('button', { name: '移除抄送 team@flaremail.test' })).toBeVisible();
  await replyAllDialog.getByRole('button', { name: '关闭' }).click();
  await expect(replyAllDialog).toBeHidden();
  await expect(detail.getByRole('button', { name: '纯文本', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(detail).toContainText('Safe HTML fixture text fallback.');

  await detail.getByRole('button', { name: '安全 HTML', exact: true }).click();
  const htmlFrame = page.locator('iframe[title="安全 HTML 邮件正文"]');
  await htmlFrame.scrollIntoViewIfNeeded();
  await expect(htmlFrame).toBeVisible();
  const frame = page.frameLocator('iframe[title="安全 HTML 邮件正文"]');
  await expect(frame.getByText('Safe HTML fixture')).toBeVisible();
  await expect(frame.locator('img[src^="https://tracker.example/"]')).toHaveCount(0);
  await expect(frame.locator('img[src*="attachments/"]')).toHaveCount(1);
  expect(remoteRequests).toEqual([]);

  await detail.getByRole('button', { name: '加载本邮件 HTTPS 图片' }).click();
  await expect(frame.locator('img[src^="https://tracker.example/"]')).toHaveCount(1);
  await expect.poll(() => remoteRequests.length).toBe(1);
  await detail.getByRole('button', { name: '撤销远程图片权限' }).click();
  await expect(frame.locator('img[src^="https://tracker.example/"]')).toHaveCount(0);

  const downloadPromise = page.waitForEvent('download');
  await detail.getByRole('button', { name: '下载显示问题报告' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^flaremail-html-display-email_e2e-html-inbox-message\.json$/u);
  const path = await download.path();
  expect(path).toBeTruthy();
  const report = JSON.parse(await readFile(path!, 'utf8')) as Record<string, unknown>;
  expect(report.messageId).toBe('email:e2e-html-inbox-message');
  expect(JSON.stringify(report)).not.toContain('This message is seeded');
  await assertNoConsoleErrors(consoleErrors.filter((message) => !message.includes('allow-scripts')));
});

test('opens the compose attachment modal and restores an autosaved draft', async ({ page, consoleErrors }) => {
  const subject = `WebKit smoke autosave ${Date.now()}`;
  await login(page);
  await openCompose(page);
  const dialog = page.getByRole('dialog', { name: '新邮件' });
  await expect(dialog).toBeVisible();
  const toInput = page.getByLabel('收件人');
  await toInput.dispatchEvent('compositionstart', { data: '' });
  await toInput.fill('"张 三" <ZHANG@flaremail.test>');
  await toInput.dispatchEvent('compositionupdate', { data: '张 三' });
  await toInput.dispatchEvent('compositionend', { data: '张 三' });
  await toInput.press('Enter');
  await expect(dialog.getByRole('button', { name: '移除收件人 zhang@flaremail.test' })).toBeVisible();
  await dialog.getByRole('button', { name: '添加抄送' }).click();
  const ccInput = page.getByLabel('抄送');
  await ccInput.fill('copy@flaremail.test');
  await ccInput.press('Enter');
  await expect(dialog.getByRole('button', { name: '移除抄送 copy@flaremail.test' })).toBeVisible();
  await dialog.getByRole('button', { name: '添加密送' }).click();
  const bccInput = page.getByLabel('密送');
  await bccInput.fill('blind@flaremail.test');
  await bccInput.press('Enter');
  await expect(dialog.getByRole('button', { name: '移除密送 blind@flaremail.test' })).toBeVisible();
  await page.getByRole('textbox', { name: '主题', exact: true }).fill(subject);
  await page.getByRole('textbox', { name: '正文', exact: true }).fill('WebKit autosave fixture.');
  await dialog.getByLabel('HTML 源码（可选）', { exact: true }).fill('<p>WebKit <strong>HTML</strong> autosave fixture.</p>');
  await assertNoHorizontalOverflow(page);
  await page.getByLabel('选择附件').setInputFiles({ name: 'webkit-smoke.txt', mimeType: 'text/plain', buffer: Buffer.from('webkit attachment') });
  await expect(dialog.getByLabel('附件名称 webkit-smoke.txt')).toHaveValue('webkit-smoke.txt', { timeout: 12_000 });
  await expect(dialog.getByRole('status').filter({ hasText: /已自动保存于/u })).toBeVisible({ timeout: 12_000 });
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: '写邮件', exact: true }).filter({ visible: true }).first()).toBeFocused();

  await page.reload();
  await openFolder(page, '草稿箱');
  const draft = page.getByRole('listitem').filter({ hasText: subject });
  await expect(draft).toBeVisible();
  await draft.getByRole('button', { name: new RegExp(subject, 'u') }).first().click();
  await page.getByRole('button', { name: '更多邮件操作' }).click();
  await page.getByRole('menuitem', { name: '继续编辑草稿' }).click();
  const editDialog = page.getByRole('dialog', { name: '编辑草稿' });
  await expect(editDialog).toBeVisible();
  await expect(editDialog.getByLabel('HTML 源码（可选）', { exact: true })).toHaveValue('<p>WebKit <strong>HTML</strong> autosave fixture.</p>');
  await assertNoConsoleErrors(consoleErrors);
});

test('sends successfully and exposes a typed failure without claiming success', async ({ page, consoleErrors }, testInfo) => {
  await login(page);
  const successSubject = `WebKit smoke send ${Date.now()}`;
  await openCompose(page);
  await page.getByLabel('收件人').fill('webkit-send@flaremail.test');
  await page.getByRole('textbox', { name: '主题', exact: true }).fill(successSubject);
  await page.getByRole('textbox', { name: '正文', exact: true }).fill('WebKit fake-provider success.');
  await page.getByLabel('HTML 源码（可选）', { exact: true }).fill('<p>WebKit <strong>HTML</strong> fake-provider success.</p>');
  await page.getByRole('button', { name: '发送邮件' }).click();
  await expect(page.getByRole('region', { name: '邮件详情' }).getByRole('heading', { name: successSubject, exact: true })).toBeVisible({ timeout: 12_000 });
  await expect(page.getByRole('status').filter({ hasText: /已提交|发起投递/u })).toBeVisible({ timeout: 8_000 });

  await page.route('**/api/send', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      headers: { 'x-request-id': `webkit-failure-${testInfo.project.name}` },
      body: JSON.stringify({ ok: false, error: { code: 'OUTBOUND_UNAVAILABLE', message: 'WebKit smoke provider failure。', retryable: true }, requestId: `webkit-failure-${testInfo.project.name}` })
    });
  });
  await openCompose(page);
  await page.getByLabel('收件人').fill('webkit-failure@flaremail.test');
  await page.getByRole('textbox', { name: '主题', exact: true }).fill(`WebKit smoke failure ${Date.now()}`);
  await page.getByRole('textbox', { name: '正文', exact: true }).fill('WebKit fake-provider failure.');
  await page.getByRole('button', { name: '发送邮件' }).click();
  const failure = page.getByRole('alert').filter({ hasText: 'WebKit smoke provider failure' });
  await expect(failure).toContainText('详情 ID：webkit-failure-');
  if (!projectIsMobile(testInfo.project.name)) {
    await expect(page.getByText('全局状态需处理', { exact: true })).toBeVisible();
  }
  const failedDialog = page.getByRole('dialog', { name: '新邮件' });
  await failedDialog.getByRole('button', { name: '取消', exact: true }).click();
  const closeConfirm = page.getByRole('dialog', { name: '未保存的改动' });
  await expect.poll(async () => (await failedDialog.isHidden()) || (await closeConfirm.isVisible())).toBe(true);
  if (await closeConfirm.isVisible()) {
    await closeConfirm.getByRole('button', { name: '放弃改动', exact: true }).click();
  }
  await expect(failedDialog).toBeHidden();
  await page.unroute('**/api/send');
  await page.getByRole('button', { name: '刷新邮件列表' }).click();
  if (!projectIsMobile(testInfo.project.name)) {
    await expect(page.getByText('全局状态正常', { exact: true })).toBeVisible();
  }
  await assertNoConsoleErrors(consoleErrors.filter((message) => !message.includes('503')));
});

test('restores a draft from the trash', async ({ page, consoleErrors }) => {
  const subject = `WebKit smoke trash ${Date.now()}`;
  await login(page);
  await createSmokeDraft(page, subject);
  await openFolder(page, '草稿箱');
  const draft = page.getByRole('listitem').filter({ hasText: subject });
  await expect(draft).toBeVisible();
  await draft.getByRole('button', { name: new RegExp(subject, 'u') }).first().click();
  await page.getByRole('button', { name: '更多邮件操作' }).click();
  await page.getByRole('menuitem', { name: '移入垃圾箱' }).click();
  await page.getByRole('dialog', { name: '移入垃圾箱？' }).getByRole('button', { name: '移入垃圾箱' }).click();
  await expect(page.getByRole('status').filter({ hasText: '已移入垃圾箱' })).toBeVisible();
  await openFolder(page, '垃圾箱');
  const trashed = page.getByRole('listitem').filter({ hasText: subject });
  await expect(trashed).toBeVisible();
  await trashed.getByRole('button', { name: new RegExp(subject, 'u') }).first().click();
  await page.getByRole('button', { name: '恢复', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '已恢复到草稿箱' })).toBeVisible();
  await assertNoConsoleErrors(consoleErrors);
});

test('persists the selected theme across reload', async ({ page, consoleErrors }, testInfo) => {
  await login(page);
  if (projectIsPhone(testInfo.project.name)) {
    await page.getByRole('button', { name: '打开导航' }).click();
    await page.getByRole('navigation', { name: '移动端导航' }).getByRole('button', { name: '设置', exact: true }).click();
  } else {
    await page.getByRole('button', { name: '设置', exact: true }).first().click();
  }
  const theme = page.getByLabel('颜色主题');
  await expect(theme).toBeVisible();
  await theme.selectOption('dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.reload();
  await expect(theme).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await theme.selectOption('light');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await assertNoConsoleErrors(consoleErrors);
});

test('keeps WebKit viewport, focus, drawer, dialog and touch semantics accessible', async ({ page, consoleErrors }, testInfo) => {
  await login(page);
  const isPhone = projectIsPhone(testInfo.project.name);
  if (isPhone) {
    const navButton = page.getByRole('button', { name: '打开导航' });
    await navButton.tap();
    const drawer = page.getByRole('dialog', { name: 'FlareMail 导航' });
    await expect(drawer).toBeVisible();
    await expect(drawer.locator('button').first()).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
    await expect(navButton).toBeFocused();
  } else {
    const searchCommand = page.getByRole('button', { name: /搜索邮件/u }).first();
    if (projectIsMobile(testInfo.project.name)) await searchCommand.tap();
    else await searchCommand.click();
    await expect(page.getByLabel('搜索邮件')).toBeFocused();
  }

  await assertNoHorizontalOverflow(page);
  if (isPhone) {
    const undersized = await page.locator('a, button, input:not([type="checkbox"]):not([type="radio"]), select, textarea, [role="button"], [role="menuitem"]').evaluateAll((elements) => elements.flatMap((element) => {
      const style = getComputedStyle(element);
      if (style.visibility === 'hidden' || style.display === 'none') return [];
      const rect = element.getBoundingClientRect();
      return rect.width === 0 || rect.height === 0 || (rect.width + 0.5 >= 44 && rect.height + 0.5 >= 44)
        ? []
        : [`${element.tagName.toLowerCase()}: ${Math.round(rect.width)}x${Math.round(rect.height)}`];
    }));
    expect(undersized).toEqual([]);
  }
  await assertNoConsoleErrors(consoleErrors);
});
