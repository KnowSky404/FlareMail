import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Locator, Page } from '@playwright/test';
import { assertNoConsoleErrors, assertNoHorizontalOverflow, expect, login, openFolder, test } from './fixtures';

// The pinned headless WebKit build intermittently reports stationary, visible
// controls as unstable; these paths assert visibility before triggering them.
test.describe.configure({ mode: 'serial', timeout: 75_000 });

// These legacy suites exercise simultaneous list/detail previews. Keep their
// split-pane coverage explicit; gmail-workflows.spec.ts covers the real list default.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('flaremail-layout-v1') ?? '{}') ?? {}; } catch {}
    localStorage.setItem('flaremail-layout-v1', JSON.stringify({ ...saved, version: 1, readingLayout: 'split' }));
  });
});

const projectIsPhone = (name: string) => name.includes('iphone');
const projectIsMobile = (name: string) => projectIsPhone(name) || name.includes('ipad');

async function clickHeadlessControl(locator: Locator) {
  await expect(locator).toBeVisible();
  await expect(locator).toBeEnabled();
  await locator.click({ force: true });
}

async function pressHeadlessControl(locator: Locator) {
  await expect(locator).toBeVisible();
  await expect(locator).toBeEnabled();
  await locator.focus();
  await locator.press('Enter');
}

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
  if (await backButton.isVisible()) {
    await expect(backButton).toBeVisible();
    await backButton.click({ force: true });
  }

  const composeButtons = page.getByRole('button', { name: '写邮件', exact: true });
  for (let index = 0; index < await composeButtons.count(); index += 1) {
    const button = composeButtons.nth(index);
    if (await button.isVisible()) {
      await button.click({ force: true });
      return;
    }
  }

  const navigationToggle = page.getByRole('button', { name: '打开导航' });
  await expect(navigationToggle).toBeVisible();
  await navigationToggle.click({ force: true });
  const mobileCompose = page.getByRole('navigation', { name: '移动端导航' }).getByRole('button', { name: '写邮件', exact: true });
  await expect(mobileCompose).toBeVisible();
  await mobileCompose.click({ force: true });
}

test('shows collapsed sidebar tooltips beyond the label scroller in WebKit', async ({ page, consoleErrors }, testInfo) => {
  test.skip(testInfo.project.name !== 'webkit-desktop', 'The sidebar is a desktop-only control.');
  await login(page);
  const created = await page.evaluate(async () => {
    const response = await fetch('/api/workspace/labels', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'WebKit Sidebar Tooltip' })
    });
    return response.ok;
  });
  expect(created).toBe(true);
  await page.reload();
  const sidebar = page.locator('#fm-main-sidebar');
  await clickHeadlessControl(sidebar.getByRole('button', { name: '折叠侧边栏' }));
  const label = sidebar.getByRole('button', { name: 'WebKit Sidebar Tooltip' });
  await label.focus();
  const tooltip = page.getByRole('tooltip', { name: 'WebKit Sidebar Tooltip' });
  await expect(tooltip).toBeVisible();
  const [tip, rail] = await Promise.all([tooltip.boundingBox(), sidebar.boundingBox()]);
  expect(tip!.x + tip!.width).toBeGreaterThan(rail!.x + rail!.width + 20);
  await page.keyboard.press('Escape');
  await expect(tooltip).toBeHidden();
  await assertNoHorizontalOverflow(page);
  await assertNoConsoleErrors(consoleErrors);
});

test('keeps the floating compose footer visible in a short desktop WebKit viewport', async ({ page, consoleErrors }, testInfo) => {
  test.skip(testInfo.project.name !== 'webkit-desktop', 'Mobile WebKit uses the full-screen compose layout.');
  await login(page);
  await clickHeadlessControl(page.getByRole('button', { name: '写邮件', exact: true }).first());
  const composeDialog = page.getByRole('dialog', { name: '新邮件' });
  await page.setViewportSize({ width: 1366, height: 320 });
  const panel = await composeDialog.boundingBox();
  const footer = await composeDialog.locator('.compose-window-footer').boundingBox();
  expect(panel!.y + panel!.height).toBeLessThanOrEqual(320);
  expect(footer!.y + footer!.height).toBeLessThanOrEqual(320);
  await page.screenshot({ path: join(tmpdir(), 'flaremail-compose-floating-short-webkit.png'), fullPage: false });
  await assertNoHorizontalOverflow(page);
  await assertNoConsoleErrors(consoleErrors);
});

test('returns mobile search focus after clearing in WebKit', async ({ page, consoleErrors }, testInfo) => {
  test.skip(testInfo.project.name !== 'webkit-iphone', 'The iPhone layout exposes search in the folder header.');
  await login(page);
  const search = page.getByLabel('搜索邮件');
  await search.fill('E2E');
  await clickHeadlessControl(page.getByRole('button', { name: '清除搜索' }));
  await expect(search).toHaveValue('');
  await expect(search).toBeFocused();
  await page.screenshot({ path: join(tmpdir(), 'flaremail-search-clear-webkit-iphone.png'), fullPage: false });
  await assertNoHorizontalOverflow(page);
  await assertNoConsoleErrors(consoleErrors);
});

test('navigates display preference radio groups by keyboard in desktop WebKit', async ({ page, consoleErrors }, testInfo) => {
  test.skip(testInfo.project.name !== 'webkit-desktop', 'The preference panel is in the desktop topbar.');
  await login(page);
  await clickHeadlessControl(page.getByRole('button', { name: '显示偏好' }));
  const dialog = page.getByRole('dialog', { name: '显示偏好' });
  const theme = dialog.getByRole('radiogroup', { name: '颜色主题' });
  const density = dialog.getByRole('radiogroup', { name: '显示密度' });
  await expect(theme.getByRole('radio', { name: '跟随系统' })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(theme.getByRole('radio', { name: '浅色' })).toBeFocused();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.keyboard.press('Tab');
  await expect(density.getByRole('radio', { name: '标准显示' })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(density.getByRole('radio', { name: '紧凑显示' })).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await assertNoConsoleErrors(consoleErrors);
});

test('opens a domain-scoped quick address form without WebKit overflow', async ({ page, consoleErrors }) => {
  await login(page);
  await page.goto('/?folder=settings&view=domains');
  const domainCard = page.locator('.domain-card').filter({ hasText: 'flaremail.test' });
  await expect(domainCard).toBeVisible();
  const quickCreate = domainCard.getByRole('button', { name: '为此域名创建地址' });
  await clickHeadlessControl(quickCreate);
  const quickCreateForm = domainCard.locator('.quick-create-form');
  await expect(quickCreateForm.getByLabel('地址前缀 (@flaremail.test)')).toBeFocused();
  await expect(quickCreate).toHaveAttribute('aria-expanded', 'true');
  await assertNoHorizontalOverflow(page);
  await clickHeadlessControl(quickCreateForm.getByRole('button', { name: '取消' }));
  await expect(quickCreateForm).toBeHidden();
  await expect(quickCreate).toBeFocused();
  await assertNoConsoleErrors(consoleErrors);
});

test('bulk-removes a label from selected inbox and draft mail in WebKit', async ({ page, consoleErrors }, testInfo) => {
  await login(page);
  const created = await page.evaluate(async () => {
    const response = await fetch('/api/workspace/labels', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'WebKit Bulk Label' })
    });
    return { ok: response.ok, payload: await response.json() };
  });
  expect(created.ok, JSON.stringify(created.payload)).toBe(true);
  const labelId = (created.payload as { data: { label: { id: string } } }).data.label.id;
  for (const target of [
    { kind: 'workspace', id: 'e2e-inbox-message' },
    { kind: 'workspace', id: 'e2e-sent-message' },
    { kind: 'draft', id: 'e2e-draft-1' }
  ]) {
    const result = await page.evaluate(async ({ id, message }) => {
      const response = await fetch(`/api/workspace/labels/${encodeURIComponent(id)}/messages`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(message)
      });
      return { ok: response.ok, status: response.status };
    }, { id: labelId, message: target });
    expect(result.ok, `label setup failed: ${result.status}`).toBe(true);
  }

  await page.goto('/?folder=inbox');
  await expect(page.getByRole('searchbox', { name: '搜索邮件' })).toHaveAttribute('inputmode', 'search');
  await page.getByLabel('搜索邮件').fill('label:"WebKit Bulk Label"');
  await expect(page.getByRole('listitem').filter({ hasText: 'E2E Inbox Welcome' })).toBeVisible();
  await expect(page.getByText('1 个结果', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '清除搜索', exact: true })).toBeVisible();
  if (testInfo.project.name === 'webkit-desktop') await expect(page.locator('.topbar-search kbd')).toHaveCount(0);
  await page.screenshot({ path: join(tmpdir(), `flaremail-label-search-${testInfo.project.name}.png`), fullPage: false });
  await page.goto(`/?folder=label&label=${encodeURIComponent(labelId)}`);
  await expect(page.getByRole('heading', { name: 'WebKit Bulk Label' })).toBeVisible();
  const inbox = page.getByRole('listitem').filter({ hasText: 'E2E Inbox Welcome' });
  const sent = page.getByRole('listitem').filter({ hasText: 'E2E Seeded Sent' });
  const toolbar = page.getByRole('group', { name: '批量邮件操作' });
  await inbox.getByRole('checkbox').check({ force: true });
  await sent.getByRole('checkbox').check({ force: true });
  await expect(toolbar.getByRole('button', { name: '标为已读' })).toBeVisible();
  await page.screenshot({ path: join(tmpdir(), `flaremail-webkit-mixed-bulk-${testInfo.project.name}.png`), fullPage: false });
  await clickHeadlessControl(toolbar.getByRole('button', { name: '标为已读' }));
  await expect(inbox.getByRole('button', { name: /E2E Inbox Welcome/u })).not.toHaveAttribute('aria-label', /未读/u);
  await expect(sent).toBeVisible();
  await clickHeadlessControl(page.getByRole('button', { name: '关闭通知' }));
  for (const subject of ['E2E Inbox Welcome', 'E2E Existing Concurrent']) {
    const row = page.getByRole('listitem').filter({ hasText: subject });
    await expect(row).toBeVisible();
    await row.getByRole('checkbox').check({ force: true });
  }
  await expect(page.getByRole('status').filter({ hasText: '所选邮件包含草稿' })).toBeVisible();
  await expect(toolbar.getByRole('button', { name: '标为已读' })).toHaveCount(0);
  await clickHeadlessControl(page.getByRole('button', { name: '批量管理标签' }));
  const dialog = page.getByRole('dialog', { name: '批量管理标签' });
  await expect(dialog).toContainText('仅更新当前页已选的 2 封邮件');
  await assertNoHorizontalOverflow(page);
  await page.screenshot({ path: join(tmpdir(), `flaremail-webkit-bulk-label-${testInfo.project.name}.png`), fullPage: false });
  await clickHeadlessControl(dialog.getByRole('button', { name: '从已选邮件移除' }));
  await expect(dialog).toBeHidden();
  await expect(inbox).toHaveCount(0);
  await expect(page.getByRole('listitem').filter({ hasText: 'E2E Existing Concurrent' })).toHaveCount(0);
  await expect(page.getByRole('listitem').filter({ hasText: 'E2E Seeded Sent' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('listitem').filter({ hasText: 'E2E Seeded Sent' })).toBeVisible();
  await assertNoHorizontalOverflow(page);
  await assertNoConsoleErrors(consoleErrors);
  const removed = await page.evaluate(async (id) => {
    const response = await fetch(`/api/workspace/labels/${encodeURIComponent(id)}`, { method: 'DELETE' });
    return response.ok;
  }, labelId);
  expect(removed).toBe(true);
});

test('logs in, navigates, searches, opens a message, and returns', async ({ page, consoleErrors }, testInfo) => {
  await login(page);
  if (!projectIsMobile(testInfo.project.name)) {
    await expect(page.locator('.mail-workspace')).toHaveAttribute('data-list-width-effective', '440');
  }
  await openFolder(page, '已发送');
  await expect(page.getByRole('heading', { name: '已发送', exact: true })).toBeVisible();
  await openFolder(page, '收件箱');
  const filteredMailbox = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === '/api/workspace/mailbox'
      && url.searchParams.get('folder') === 'inbox'
      && url.searchParams.get('q') === 'E2E Inbox Welcome'
      && response.ok();
  });
  await page.getByLabel('搜索邮件').fill('E2E Inbox Welcome');
  await filteredMailbox;
  await expect(page.getByRole('button', { name: '刷新邮件列表' })).toHaveAttribute('aria-busy', 'false');
  const item = page.getByRole('listitem').filter({ hasText: 'E2E Inbox Welcome' });
  await expect(item).toBeVisible();
  await expect(item.locator('mark')).not.toHaveCount(0);
  await item.getByRole('button', { name: /E2E Inbox Welcome/u }).first().click({ force: true });
  const detail = page.getByRole('region', { name: '邮件详情' });
  await expect(detail).toContainText('E2E Inbox Welcome');
  if (!projectIsMobile(testInfo.project.name)) {
    const trigger = detail.getByRole('button', { name: '展开专注阅读' });
    await trigger.focus();
    await page.keyboard.press('Enter');
    const reader = page.getByRole('dialog', { name: 'E2E Inbox Welcome' });
    await expect(reader).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    expect(await reader.evaluate((element) => element.contains(document.activeElement) &&
      document.activeElement instanceof HTMLElement && document.activeElement.getClientRects().length > 0)).toBe(true);
    await reader.getByRole('button', { name: '关闭专注阅读' }).focus();
    await page.keyboard.press('Enter');
    await expect(reader).toBeHidden();
    await expect(trigger).toBeFocused();
  }
  if (projectIsMobile(testInfo.project.name)) {
    const backButton = page.getByRole('button', { name: '返回邮件列表' });
    await expect(backButton).toBeVisible();
    await backButton.click({ force: true });
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
  const messageButton = item.getByRole('button', { name: /E2E HTML Safety/u }).first();
  await expect(messageButton).toBeVisible();
  await pressHeadlessControl(messageButton);
  const detail = page.getByRole('region', { name: '邮件详情' });
  const technicalDetails = detail.getByText('技术详情', { exact: true });
  await expect(technicalDetails).toBeVisible();
  await technicalDetails.click({ force: true });
  const replyAllDialog = page.getByRole('dialog', { name: '回复邮件' });
  await clickHeadlessControl(detail.getByRole('button', { name: '回复全部', exact: true }));
  await expect(replyAllDialog.getByRole('button', { name: '移除收件人 html-sender@flaremail.test' })).toBeVisible();
  await expect(replyAllDialog.getByRole('button', { name: /移除(?:收件人|抄送) support@flaremail\.test/u })).toHaveCount(0);
  await expect(replyAllDialog.getByLabel('发件地址')).toHaveValue('00000000-0000-4000-8000-000000000021');
  await expect(replyAllDialog.getByRole('button', { name: '移除抄送 observer@flaremail.test' })).toBeVisible();
  await expect(replyAllDialog.getByRole('button', { name: '移除抄送 team@flaremail.test' })).toBeVisible();
  await clickHeadlessControl(replyAllDialog.getByRole('button', { name: '关闭' }));
  await expect(replyAllDialog).toBeHidden();
  await expect(detail.getByRole('button', { name: '纯文本', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(detail).toContainText('Safe HTML fixture text fallback.');

  await clickHeadlessControl(detail.getByRole('button', { name: '安全 HTML', exact: true }));
  const htmlFrame = page.locator('iframe[title="安全 HTML 邮件正文"]');
  await expect(htmlFrame).toBeVisible();
  const frame = page.frameLocator('iframe[title="安全 HTML 邮件正文"]');
  await expect(frame.getByText('Safe HTML fixture')).toBeVisible();
  await expect(frame.locator('img[src^="https://tracker.example/"]')).toHaveCount(0);
  await expect(frame.locator('img[src*="attachments/"]')).toHaveCount(1);
  expect(remoteRequests).toEqual([]);

  const remoteImagesButton = detail.locator('[role="note"] button');
  await pressHeadlessControl(remoteImagesButton);
  await expect(remoteImagesButton).toHaveAttribute('aria-pressed', 'true');
  await expect(htmlFrame).toHaveAttribute('src', /remote=1/u);
  await expect(frame.locator('img[src^="https://tracker.example/"]')).toHaveCount(1);
  await expect.poll(() => remoteRequests.length).toBe(1);
  await pressHeadlessControl(remoteImagesButton);
  await expect(remoteImagesButton).toHaveAttribute('aria-pressed', 'false');
  await expect(htmlFrame).toHaveAttribute('src', /remote=0/u);
  await expect(frame.locator('img[src^="https://tracker.example/"]')).toHaveCount(0);

  const downloadPromise = page.waitForEvent('download');
  await clickHeadlessControl(detail.getByRole('region', { name: '邮件正文' }).getByRole('button', { name: '更多邮件操作' }));
  await pressHeadlessControl(detail.getByRole('menuitem', { name: '下载显示问题报告', exact: true }));
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
  const toInput = page.getByRole('combobox', { name: '收件人' });
  await toInput.dispatchEvent('compositionstart', { data: '' });
  await toInput.fill('"张 三" <ZHANG@flaremail.test>');
  await toInput.dispatchEvent('compositionupdate', { data: '张 三' });
  await toInput.dispatchEvent('compositionend', { data: '张 三' });
  await toInput.press('Enter');
  await expect(dialog.getByRole('button', { name: '移除收件人 zhang@flaremail.test' })).toBeVisible();
  const addCcBcc = dialog.getByRole('button', { name: '抄送/密送' });
  const combinedRecipients = await addCcBcc.isVisible();
  if (combinedRecipients) {
    await addCcBcc.click({ force: true });
  } else {
    const addCc = dialog.getByRole('button', { name: '添加抄送' });
    await expect(addCc).toBeVisible();
    await addCc.click({ force: true });
  }
  const ccInput = page.getByLabel('抄送');
  await ccInput.fill('copy@flaremail.test');
  await ccInput.press('Enter');
  await expect(dialog.getByRole('button', { name: '移除抄送 copy@flaremail.test' })).toBeVisible();
  if (!combinedRecipients) {
    const addBcc = dialog.getByRole('button', { name: '添加密送' });
    await expect(addBcc).toBeVisible();
    await addBcc.click({ force: true });
  }
  const bccInput = page.getByLabel('密送');
  await bccInput.fill('blind@flaremail.test');
  await bccInput.press('Enter');
  await expect(dialog.getByRole('button', { name: '移除密送 blind@flaremail.test' })).toBeVisible();
  await page.getByRole('textbox', { name: '主题', exact: true }).fill(subject);
  await page.getByRole('textbox', { name: '正文', exact: true }).fill('WebKit autosave fixture.');
  await clickHeadlessControl(dialog.getByRole('button', { name: 'HTML 写信选项' }));
  await dialog.getByLabel('HTML 源码（可选）', { exact: true }).fill('<p>WebKit <strong>HTML</strong> autosave fixture.</p>');
  await assertNoHorizontalOverflow(page);
  await page.getByLabel('选择附件').setInputFiles({ name: 'webkit-smoke.txt', mimeType: 'text/plain', buffer: Buffer.from('webkit attachment') });
  await expect(dialog.getByLabel('附件名称 webkit-smoke.txt')).toHaveValue('webkit-smoke.txt', { timeout: 12_000 });
  await expect(dialog.getByRole('status').filter({ hasText: /已自动保存于/u })).toBeVisible({ timeout: 12_000 });
  const cancelCompose = dialog.getByRole('button', { name: '取消', exact: true });
  await expect(cancelCompose).toBeVisible();
  await pressHeadlessControl(cancelCompose);
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: '写邮件', exact: true }).filter({ visible: true }).first()).toBeFocused();

  await page.reload();
  await openFolder(page, '草稿箱');
  const draft = page.getByRole('listitem').filter({ hasText: subject });
  await expect(draft).toBeVisible();
  await clickHeadlessControl(draft.getByRole('button', { name: new RegExp(subject, 'u') }).first());
  await clickHeadlessControl(page.getByRole('button', { name: '更多邮件操作' }));
  await clickHeadlessControl(page.getByRole('menuitem', { name: '继续编辑草稿' }));
  const editDialog = page.getByRole('dialog', { name: '编辑草稿' });
  await expect(editDialog).toBeVisible();
  await expect(editDialog.getByLabel('HTML 源码（可选）', { exact: true })).toHaveValue('<p>WebKit <strong>HTML</strong> autosave fixture.</p>');
  await assertNoConsoleErrors(consoleErrors);
});

test('keeps two attachment actions reachable in a short WebKit phone viewport', async ({ page, consoleErrors }, testInfo) => {
  test.skip(!projectIsPhone(testInfo.project.name), 'The full-screen short-viewport layout is phone-only.');
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await openCompose(page);
  const dialog = page.getByRole('dialog', { name: '新邮件' });
  const subject = `WebKit short viewport compose ${Date.now()}`;
  await dialog.getByLabel('收件人').fill('webkit-short@flaremail.test');
  await dialog.getByRole('textbox', { name: '主题', exact: true }).fill(subject);
  await dialog.getByRole('textbox', { name: '正文', exact: true }).fill(Array.from({ length: 100 }, (_, index) => `Line ${index + 1}`).join('\n'));
  await dialog.getByLabel('选择附件').setInputFiles([
    { name: 'webkit-short-one.txt', mimeType: 'text/plain', buffer: Buffer.alloc(128 * 1024, 0x41) },
    { name: 'webkit-short-two.txt', mimeType: 'text/plain', buffer: Buffer.alloc(128 * 1024, 0x42) }
  ]);
  const attachments = dialog.getByRole('list', { name: '待发送附件' });
  await expect(attachments.getByRole('listitem')).toHaveCount(2, { timeout: 20_000 });
  await page.setViewportSize({ width: 390, height: 500 });
  await attachments.getByRole('listitem').last().scrollIntoViewIfNeeded();
  const body = await dialog.locator('.compose-window-body').boundingBox();
  const footer = await dialog.locator('.compose-window-footer').boundingBox();
  const first = await attachments.getByRole('listitem').first().boundingBox();
  const second = await attachments.getByRole('listitem').last().boundingBox();
  const remove = await attachments.getByRole('button', { name: '删除附件 webkit-short-one.txt' }).boundingBox();
  expect(body).not.toBeNull();
  expect(footer).not.toBeNull();
  expect(first).not.toBeNull();
  expect(second).not.toBeNull();
  expect(remove).not.toBeNull();
  expect(footer!.y + footer!.height).toBeLessThanOrEqual(501);
  expect(first!.y).toBeGreaterThanOrEqual(body!.y);
  expect(second!.y + second!.height).toBeLessThanOrEqual(body!.y + body!.height + 1);
  expect(first!.height).toBeLessThanOrEqual(72);
  expect(remove!.y).toBeGreaterThanOrEqual(first!.y);
  expect(remove!.y + remove!.height).toBeLessThanOrEqual(first!.y + first!.height + 1);
  const deleteColor = await attachments.getByRole('button', { name: '删除附件 webkit-short-one.txt' }).evaluate((button) => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--fm-danger)';
    document.body.appendChild(probe);
    const result = { actual: getComputedStyle(button).color, expected: getComputedStyle(probe).color };
    probe.remove();
    return result;
  });
  expect(deleteColor.actual).toBe(deleteColor.expected);
  await assertNoHorizontalOverflow(page);
  await page.screenshot({ path: join(tmpdir(), 'flaremail-compose-short-webkit-iphone.png'), fullPage: false });
  await pressHeadlessControl(dialog.getByRole('button', { name: '保存草稿', exact: true }));
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('region', { name: '邮件详情' }).getByRole('heading', { name: subject })).toBeVisible();
  await expect(page.getByRole('article', { name: '邮件正文详情' })).toContainText('Line 100');
  await assertNoConsoleErrors(consoleErrors);
});

test('sends successfully and exposes a typed failure without claiming success', async ({ page, consoleErrors }, testInfo) => {
  await login(page);
  const successSubject = `WebKit smoke send ${Date.now()}`;
  await openCompose(page);
  await page.getByLabel('收件人').fill('webkit-send@flaremail.test');
  await page.getByRole('textbox', { name: '主题', exact: true }).fill(successSubject);
  await page.getByRole('textbox', { name: '正文', exact: true }).fill('WebKit fake-provider success.');
  const htmlOptions = page.getByRole('dialog', { name: '新邮件' }).getByRole('button', { name: 'HTML 写信选项' });
  await htmlOptions.focus();
  await htmlOptions.press('Enter');
  await page.getByLabel('HTML 源码（可选）', { exact: true }).fill('<p>WebKit <strong>HTML</strong> fake-provider success.</p>');
  const successSend = page.getByRole('button', { name: '发送邮件' });
  await expect(successSend).toBeVisible();
  await expect(successSend).toBeEnabled();
  await successSend.focus();
  await successSend.press('Enter');
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
  const failedSend = page.getByRole('button', { name: '发送邮件' });
  await expect(failedSend).toBeVisible();
  await expect(failedSend).toBeEnabled();
  await failedSend.focus();
  await failedSend.press('Enter');
  const failure = page.getByRole('alert').filter({ hasText: 'WebKit smoke provider failure' });
  await expect(failure).toContainText('详情 ID：webkit-failure-');
  if (!projectIsMobile(testInfo.project.name)) {
    const degradedStatus = page.locator('summary[aria-label="查看工作区服务状态"]');
    await expect(degradedStatus).toHaveClass(/degraded/u);
  }
  const failedDialog = page.getByRole('dialog', { name: '新邮件' });
  await expect(failedDialog.getByRole('status').filter({ hasText: /已自动保存于/u })).toBeVisible();
  const cancelFailedCompose = failedDialog.getByRole('button', { name: '取消', exact: true });
  await expect(cancelFailedCompose).toBeVisible();
  await expect(cancelFailedCompose).toBeEnabled();
  await cancelFailedCompose.focus();
  await cancelFailedCompose.press('Enter');
  const closeConfirm = page.getByRole('dialog', { name: '未保存的改动' });
  await expect.poll(async () => (await failedDialog.isHidden()) || (await closeConfirm.isVisible())).toBe(true);
  if (await closeConfirm.isVisible()) {
    await clickHeadlessControl(closeConfirm.getByRole('button', { name: '放弃改动', exact: true }));
  }
  await expect(failedDialog).toBeHidden();
  await page.unroute('**/api/send');
  await clickHeadlessControl(page.getByRole('button', { name: '刷新邮件列表' }));
  if (!projectIsMobile(testInfo.project.name)) {
    await expect(page.locator('summary[aria-label="查看工作区服务状态"]')).not.toHaveClass(/degraded/u);
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
  await clickHeadlessControl(draft.getByRole('button', { name: '移入垃圾箱', exact: true }));
  await expect(page.getByRole('status').filter({ hasText: '已移入垃圾箱' })).toBeVisible();
  await openFolder(page, '垃圾箱');
  const trashed = page.getByRole('listitem').filter({ hasText: subject });
  await expect(trashed).toBeVisible();
  await clickHeadlessControl(trashed.getByRole('button', { name: new RegExp(subject, 'u') }).first());
  await clickHeadlessControl(page.getByRole('button', { name: '恢复', exact: true }));
  await expect(page.getByRole('status').filter({ hasText: '已恢复到草稿箱' })).toBeVisible();
  await assertNoConsoleErrors(consoleErrors);
});

test('persists the selected theme across reload', async ({ page, consoleErrors }, testInfo) => {
  await login(page);
  if (projectIsMobile(testInfo.project.name)) {
    await page.getByRole('button', { name: '打开导航' }).click({ force: true });
    await pressHeadlessControl(page.getByRole('navigation', { name: '移动端导航' }).getByRole('button', { name: '设置', exact: true }));
    await expect(page.getByRole('dialog', { name: '移动端导航' })).toBeHidden();
  } else {
    await clickHeadlessControl(page.getByRole('button', { name: '设置', exact: true }).first());
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

test('keeps settings sections and save action reachable in WebKit', async ({ page, consoleErrors }, testInfo) => {
  await login(page);
  await page.goto('/?folder=settings');
  await expect(page).toHaveTitle('FlareMail');
  const sections = page.getByRole('navigation', { name: '设置分区' });
  const name = page.getByLabel('显示姓名');
  await name.fill('Unsaved WebKit settings draft');

  await pressHeadlessControl(sections.getByRole('link', { name: '通知', exact: true }));
  await expect(page).toHaveURL(/#settings-notifications$/u);
  const notification = page.locator('#settings-notifications');
  await expect(notification).toBeInViewport();
  await expect(sections).toBeInViewport();
  await expect(page.getByRole('button', { name: '保存设置' })).toBeInViewport();
  const navBounds = await sections.boundingBox();
  const sectionBounds = await notification.boundingBox();
  expect(sectionBounds!.y).toBeGreaterThanOrEqual(navBounds!.y + navBounds!.height - 1);
  await assertNoHorizontalOverflow(page);
  await page.screenshot({ path: join(tmpdir(), `flaremail-settings-webkit-${testInfo.project.name}.png`), fullPage: false });

  await pressHeadlessControl(sections.getByRole('link', { name: '诊断', exact: true }));
  await expect(page.locator('#settings-diagnostics')).toBeInViewport();
  await pressHeadlessControl(sections.getByRole('link', { name: '个人资料', exact: true }));
  await expect(name).toHaveValue('Unsaved WebKit settings draft');
  await assertNoConsoleErrors(consoleErrors);
});

test('keeps WebKit viewport, focus, drawer, dialog and touch semantics accessible', async ({ page, consoleErrors }, testInfo) => {
  await login(page);
  const isPhone = projectIsPhone(testInfo.project.name);
  if (isPhone) {
    const navButton = page.getByRole('button', { name: '打开导航' });
    await navButton.tap({ force: true });
    const drawer = page.locator('[role="dialog"][aria-modal="true"]').first();
    await expect(drawer).toBeVisible();
    await expect(drawer.locator('h2')).toHaveText('移动端导航');
    await expect(drawer.locator('button').first()).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
    await expect(navButton).toBeFocused();
  } else {
    const searchInput = page.getByLabel('搜索邮件');
    if (projectIsMobile(testInfo.project.name)) await searchInput.tap({ force: true });
    else await clickHeadlessControl(searchInput);
    await expect(searchInput).toBeFocused();
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
