import { assertNoConsoleErrors, assertNoHorizontalOverflow, expect, login, openFolder, test } from './fixtures';
import AxeBuilder from '@axe-core/playwright';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

const webhookSecretBytes = new TextEncoder().encode('FlareMail E2E webhook secret 2026');

async function signWebhook(id: string, timestamp: number, body: string) {
  const key = await crypto.subtle.importKey('raw', webhookSecretBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${timestamp}.${body}`));
  return Buffer.from(digest).toString('base64');
}

type DraftSnapshot = { id: string; subject: string; body: string; sentAt: string };

async function listDrafts(page: Page) {
  const response = await page.request.get('/api/workspace/mailbox?folder=drafts&limit=40');
  if (!response.ok()) throw new Error(`Draft list failed: ${response.status()} ${await response.text()}`);
  return (await response.json() as { data: { page: { messages: DraftSnapshot[] } } }).data.page.messages;
}

async function readDraft(page: Page, draftId: string) {
  const response = await page.request.get(`/api/workspace/drafts/${encodeURIComponent(draftId)}`);
  if (!response.ok()) throw new Error(`Draft detail failed: ${response.status()} ${await response.text()}`);
  return (await response.json() as { data: { message: DraftSnapshot } }).data.message;
}

async function updateServerDraft(page: Page, subject: string, body: string) {
  const current = (await listDrafts(page)).find((draft) => draft.subject === subject);
  expect(current, `missing draft ${subject}`).toBeTruthy();
  const result = await page.evaluate(async ({ draft, nextBody }) => {
    const response = await fetch('/api/workspace/drafts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        draftId: draft.id,
        expectedUpdatedAt: draft.sentAt,
        toEmail: 'draft-recipient@flaremail.test',
        cc: '',
        subject: draft.subject,
        body: nextBody
      })
    });
    return { ok: response.ok, status: response.status, body: await response.json() };
  }, { draft: current!, nextBody: body });
  expect(result.ok, JSON.stringify(result.body)).toBe(true);
  return (result.body as { data: { message: DraftSnapshot } }).data.message;
}

async function createDraft(page: Page, subject: string, body: string) {
  const result = await page.evaluate(async ({ nextSubject, nextBody }) => {
    const response = await fetch('/api/workspace/drafts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        to: [{ name: 'Trash Fixture', email: 'trash-fixture@flaremail.test' }],
        subject: nextSubject,
        body: nextBody
      })
    });
    return { ok: response.ok, status: response.status, payload: await response.json() };
  }, { nextSubject: subject, nextBody: body });
  expect(result.ok, JSON.stringify(result.payload)).toBe(true);
  return (result.payload as { data: { message: DraftSnapshot } }).data.message;
}

async function openDraftEditor(page: Page, subject: string) {
  await openFolder(page, '草稿箱');
  const item = page.getByRole('listitem').filter({ hasText: subject });
  await expect(item).toBeVisible();
  await item.getByRole('button', { name: new RegExp(subject, 'u') }).first().click();
  await page.getByRole('button', { name: '更多邮件操作' }).click();
  await page.getByRole('menuitem', { name: '继续编辑草稿' }).click();
  await expect(page.getByRole('dialog', { name: '编辑草稿' })).toBeVisible();
}

test('hydrates global metrics and pagination on fresh login, then purges state on logout', async ({ page, consoleErrors }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Desktop navigation exposes all global metric badges and logout controls.');
  await login(page);
  const navigation = page.getByRole('navigation', { name: '主导航' });
  await expect(navigation.getByRole('button', { name: '收件箱', exact: true }).getByText('47', { exact: true })).toBeVisible();
  await expect(navigation.getByRole('button', { name: '已发送', exact: true }).getByText('1', { exact: true })).toBeVisible();
  await expect(navigation.getByRole('button', { name: '草稿箱', exact: true }).getByText('5', { exact: true })).toBeVisible();

  const selected = page.getByLabel('选择E2E Inbox Welcome');
  await selected.check();
  await expect(page.getByLabel('批量邮件操作')).toContainText('已选 1 封');
  await expect(page.getByRole('button', { name: '加载更多' })).toBeVisible();
  await page.getByRole('button', { name: '加载更多' }).click();
  await expect(page.getByText('E2E Bulk 45', { exact: true })).toBeVisible();
  await expect(selected).toBeChecked();

  await openFolder(page, '归档');
  await expect(page.getByLabel('批量邮件操作')).not.toContainText('已选');
  await openFolder(page, '收件箱');
  await page.getByLabel('选择E2E Inbox Welcome').check();
  await page.getByLabel('搜索邮件').fill('E2E Inbox Welcome');
  await expect(page.getByLabel('批量邮件操作')).not.toContainText('已选');
  await page.getByRole('button', { name: '清除搜索' }).click();
  await page.getByLabel('选择E2E Inbox Welcome').check();
  await page.getByRole('button', { name: '已加星标' }).click();
  await expect(page.getByLabel('批量邮件操作')).not.toContainText('已选');
  await page.getByRole('button', { name: '全部', exact: true }).click();
  await page.getByRole('listitem').filter({ hasText: 'E2E Inbox Welcome' }).getByRole('button', { name: /E2E Inbox Welcome/ }).first().click();
  await expect(page).toHaveURL(/message=/u);

  await page.getByRole('button', { name: '退出登录' }).click();
  await expect(page.getByRole('heading', { name: '登录邮件工作台' })).toBeVisible();
  await expect(page).not.toHaveURL(/message=|folder=sent|q=/u);
  await login(page);
  await expect(page.getByLabel('搜索邮件')).toHaveValue('');
  await expect(page.getByRole('button', { name: '全部', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('批量邮件操作')).not.toContainText('已选');
  await expect(page.getByRole('button', { name: '加载更多' })).toBeVisible();
  await assertNoConsoleErrors(consoleErrors);
});

test('logs in, reads the seeded message, and persists a star', async ({ page, consoleErrors }, testInfo) => {
  await login(page);
  const item = page.getByRole('listitem').filter({ hasText: 'E2E Inbox Welcome' });
  await expect(item).toBeVisible();
  const itemButton = item.getByRole('button', { name: /E2E Inbox Welcome/ }).first();
  await itemButton.click();
  await expect(page.getByRole('article', { name: '邮件正文详情' })).toContainText('This message is seeded');
  if (testInfo.project.name === 'desktop') {
    await expect(itemButton).not.toHaveAttribute('aria-label', /未读/);
  }

  const detail = page.getByRole('region', { name: '邮件详情' });
  const addStar = detail.getByRole('button', { name: '加星', exact: true });
  const removeStar = detail.getByRole('button', { name: '取消星标', exact: true });
  await expect(addStar.or(removeStar)).toBeVisible();
  if (await addStar.isVisible()) {
    await addStar.click();
    await expect(removeStar).toBeVisible();
    if (testInfo.project.name === 'desktop') {
      await expect(page.getByRole('status').filter({ hasText: '已加入星标邮件' })).toBeVisible();
    }
  }
  if (testInfo.project.name !== 'desktop') {
    await page.getByRole('button', { name: '更多邮件操作' }).click();
    await expect(page.getByRole('menuitem', { name: '标为未读' })).toBeVisible();
    await page.keyboard.press('Escape');
  }
  await page.reload();
  await login(page);
  await expect(page.getByRole('listitem').filter({ hasText: 'E2E Inbox Welcome' }).getByRole('button', { name: '取消星标', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await assertNoConsoleErrors(consoleErrors);
});

test('runs advanced owner-scoped FTS search with highlighted persisted results', async ({ page, consoleErrors }) => {
  await login(page);
  const query = 'from:html-sender@flaremail.test subject:"E2E HTML Safety" has:attachment';
  await page.getByLabel('搜索邮件').fill(query);
  const result = page.getByRole('listitem').filter({ hasText: 'E2E HTML Safety' });
  await expect(result).toBeVisible();
  await expect(page.getByRole('listitem').filter({ hasText: 'E2E Inbox Welcome' })).toHaveCount(0);
  await expect(page.getByText('1 个结果', { exact: true })).toBeVisible();
  await expect(result).toContainText('发件人 · 主题 · 附件');
  await expect(result.locator('mark')).not.toHaveCount(0);
  await expect(page).toHaveURL(/q=from%3Ahtml-sender/u);

  await page.reload();
  await expect(page.getByLabel('搜索邮件')).toHaveValue(query);
  await expect(result).toBeVisible();
  await page.getByRole('button', { name: '清除搜索' }).click();
  await expect(page.getByRole('listitem').filter({ hasText: 'E2E Inbox Welcome' })).toBeVisible();
  await assertNoConsoleErrors(consoleErrors);
});

test('reads sanitized HTML with reversible remote-image consent and a private display report', async ({ page, consoleErrors }, testInfo) => {
  test.skip(testInfo.project.name === 'narrow', 'Desktop and mobile cover the safe HTML reader interaction.');
  const remoteRequests: string[] = [];
  await page.route('https://tracker.example/**', async (route) => {
    remoteRequests.push(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: 'image/png',
      body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
    });
  });

  await login(page);
  const item = page.getByRole('listitem').filter({ hasText: 'E2E HTML Safety' });
  await item.getByRole('button', { name: /E2E HTML Safety/u }).first().click();
  const detail = page.getByRole('region', { name: '邮件详情' });
  await detail.getByText('技术详情', { exact: true }).click();
  await expect(detail).toContainText('Support <support@flaremail.test>');
  await expect(detail).toContainText('Observer <observer@flaremail.test>');
  await expect(detail).toContainText('spf=pass');
  await expect(detail).toContainText('FlareMail 未独立执行 SPF、DKIM 或 DMARC 验证');
  await detail.getByRole('button', { name: '回复全部', exact: true }).click();
  const replyAllDialog = page.getByRole('dialog', { name: '回复邮件' });
  await expect(replyAllDialog.getByRole('button', { name: '移除收件人 support@flaremail.test' })).toBeVisible();
  await expect(replyAllDialog.getByRole('button', { name: '移除抄送 observer@flaremail.test' })).toBeVisible();
  await expect(replyAllDialog.getByRole('button', { name: '移除抄送 team@flaremail.test' })).toBeVisible();
  await replyAllDialog.getByRole('button', { name: '关闭' }).click();
  await expect(replyAllDialog).toBeHidden();
  await expect(detail.getByRole('button', { name: '纯文本' })).toHaveAttribute('aria-pressed', 'true');
  await expect(detail.getByTitle('安全 HTML 邮件正文')).toHaveCount(0);

  await detail.getByRole('button', { name: '安全 HTML' }).click();
  const frame = page.frameLocator('iframe[title="安全 HTML 邮件正文"]');
  await expect(frame.getByText('Safe HTML fixture')).toBeVisible();
  await expect(frame.getByText('[example.com]')).toBeVisible();
  await expect(frame.getByText(/显示文本与目标不一致/u)).toBeVisible();
  await expect(frame.locator('script, form, iframe, object, embed, svg')).toHaveCount(0);
  const cidImage = frame.locator('img[alt="inline logo"]');
  await expect(cidImage).toHaveCount(1);
  await expect.poll(() => cidImage.evaluate((image) => image instanceof HTMLImageElement && image.complete && image.naturalWidth === 1)).toBe(true);
  await expect(frame.locator('img[src^="https://tracker.example/"]')).toHaveCount(0);
  expect(remoteRequests).toEqual([]);

  const consent = detail.getByRole('button', { name: '加载本邮件 HTTPS 图片' });
  await consent.click();
  await expect(frame.locator('img[src^="https://tracker.example/"]')).toHaveCount(1);
  await expect.poll(() => remoteRequests.length).toBe(1);
  await expect(frame.locator('img[src^="http://insecure.example/"]')).toHaveCount(0);
  await page.screenshot({ path: join(tmpdir(), `flaremail-safe-html-${testInfo.project.name}.png`), fullPage: false });

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
  expect(JSON.stringify(report)).not.toContain('sender@flaremail.test');
  await expect(page.getByRole('status').filter({ hasText: '显示问题报告已下载' })).toBeVisible();
  // Wrangler's local explorer injects a debug script into text/html responses.
  // The production build does not; the iframe sandbox intentionally blocks it.
  await assertNoConsoleErrors(consoleErrors.filter((message) => !(
    message.startsWith('Blocked script execution in ') &&
    message.includes('/api/workspace/messages/email%3Ae2e-html-inbox-message/html?remote=') &&
    message.includes("'allow-scripts' permission is not set")
  )));
});

test('uses global service metrics and exposes typed API errors with a request ID', async ({ page, consoleErrors }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'The desktop topbar exposes the service summary.');
  await login(page);

  const serviceStatus = page.locator('details').filter({ hasText: '全局状态正常' });
  const serviceSummary = page.getByText('全局状态正常', { exact: true });
  await expect(serviceSummary).toBeVisible();
  await serviceSummary.click();
  await expect(serviceStatus).toContainText('指标覆盖整个工作区');
  await expect(serviceStatus).toContainText('长时间提交中');

  const item = page.getByRole('listitem').filter({ hasText: 'E2E Inbox Welcome' });
  await item.getByRole('button', { name: /E2E Inbox Welcome/u }).first().click();
  await page.route('**/api/workspace/messages/*/flags', async (route) => {
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      headers: { 'x-request-id': 'runtime-toast-e2e' },
      body: JSON.stringify({
        ok: false,
        error: { code: 'D1_UNAVAILABLE', message: '模拟运行时故障。', retryable: true },
        requestId: 'runtime-toast-e2e'
      })
    });
  });
  const detail = page.getByRole('region', { name: '邮件详情' });
  await detail.getByRole('button', { name: /(?:加星|取消星标)/u }).click();
  const errorToast = page.getByRole('alert').filter({ hasText: '模拟运行时故障' });
  await expect(errorToast).toContainText('详情 ID：runtime-toast-e2e');
  await errorToast.getByRole('button', { name: '关闭通知' }).click();
  await expect(errorToast).toBeHidden();
  await assertNoConsoleErrors(consoleErrors.filter((message) => !message.includes('503')));
});

test('archives and restores a selected mailbox message', async ({ page, consoleErrors }) => {
  await login(page);
  const label = page.getByLabel('选择E2E Inbox Welcome');
  await expect(label).toBeVisible();
  await label.check();
  await page.getByRole('button', { name: '归档', exact: true }).last().click();
  await expect(page.getByRole('status').filter({ hasText: '已归档所选邮件' })).toBeVisible();
  await openFolder(page, '归档');
  await expect(page.getByRole('listitem').filter({ hasText: 'E2E Inbox Welcome' })).toBeVisible();
  await page.getByLabel('选择E2E Inbox Welcome').check();
  await page.getByRole('button', { name: '移回收件箱', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '已将所选邮件移回收件箱' })).toBeVisible();
  await openFolder(page, '收件箱');
  await expect(page.getByRole('listitem').filter({ hasText: 'E2E Inbox Welcome' })).toBeVisible();
  await assertNoConsoleErrors(consoleErrors);
});

test('moves a draft to trash, persists across refresh, restores, and permanently deletes', async ({ page, consoleErrors }) => {
  await login(page);
  const subject = `E2E Trash Lifecycle ${Date.now()}`;
  await createDraft(page, subject, 'Trash lifecycle body.');

  const moveToTrash = async () => {
    await openFolder(page, '草稿箱');
    const item = page.getByRole('listitem').filter({ hasText: subject });
    await expect(item).toBeVisible();
    await item.getByRole('button', { name: new RegExp(subject, 'u') }).first().click();
    await page.getByRole('button', { name: '更多邮件操作' }).click();
    await page.getByRole('menuitem', { name: '移入垃圾箱' }).click();
    await page.getByRole('dialog', { name: '移入垃圾箱？' }).getByRole('button', { name: '移入垃圾箱' }).click();
    await expect(page.getByRole('status').filter({ hasText: '已移入垃圾箱' })).toBeVisible();
  };

  await moveToTrash();
  await page.getByRole('status').filter({ hasText: '已移入垃圾箱' }).getByRole('button', { name: '撤销' }).click();
  await expect(page.getByRole('status').filter({ hasText: '已撤销移入垃圾箱' })).toBeVisible();

  await moveToTrash();
  await openFolder(page, '垃圾箱');
  await expect(page.getByRole('listitem').filter({ hasText: subject })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('main', { name: '邮件工作区' })).toBeVisible();
  await expect(page).toHaveURL(/folder=trash/u);
  const persistedItem = page.getByRole('listitem').filter({ hasText: subject });
  await expect(persistedItem).toBeVisible();
  await persistedItem.getByRole('button', { name: new RegExp(subject, 'u') }).first().click();
  await page.getByRole('button', { name: '恢复', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '已恢复到草稿箱' })).toBeVisible();

  await moveToTrash();
  await openFolder(page, '垃圾箱');
  await page.getByRole('listitem').filter({ hasText: subject }).getByRole('button', { name: new RegExp(subject, 'u') }).first().click();
  await page.getByRole('button', { name: '永久删除', exact: true }).click();
  await page.getByRole('dialog', { name: '永久删除此项目？' }).getByRole('button', { name: '永久删除' }).click();
  await expect(page.getByRole('listitem').filter({ hasText: subject })).toHaveCount(0);
  await assertNoConsoleErrors(consoleErrors);
});

test('autosaves a compose draft and restores it after refresh', async ({ page, consoleErrors }) => {
  await login(page);
  await page.getByRole('button', { name: '写邮件', exact: true }).first().click();
  const composeDialog = page.getByRole('dialog', { name: '新邮件' });
  await expect(composeDialog).toBeVisible();
  expect((await new AxeBuilder({ page }).include('.compose-dialog').analyze()).violations).toEqual([]);
  await page.getByLabel('收件人').fill('draft-recipient@flaremail.test');
  await page.getByRole('textbox', { name: '主题', exact: true }).fill('E2E autosaved draft');
  await page.getByRole('textbox', { name: '正文', exact: true }).fill('This draft must survive a page refresh.');
  await composeDialog.getByLabel('HTML 源码（可选）', { exact: true }).fill('<p>This <strong>HTML</strong> draft must survive a page refresh.</p>');
  await expect(page.getByRole('status').filter({ hasText: '已自动保存于' })).toBeVisible({ timeout: 8_000 });
  await page.reload();
  await expect(page.getByRole('main', { name: '邮件工作区' })).toBeVisible();
  await openDraftEditor(page, 'E2E autosaved draft');
  await expect(page.getByLabel('HTML 源码（可选）', { exact: true })).toHaveValue('<p>This <strong>HTML</strong> draft must survive a page refresh.</p>');
  await assertNoConsoleErrors(consoleErrors);
});

test('uploads, restores, edits, sends and downloads outbound attachments', async ({ page, consoleErrors }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'The desktop path covers the complete attachment lifecycle once.');
  await login(page);
  await page.getByRole('button', { name: '写邮件', exact: true }).first().click();
  const subject = 'E2E outbound attachments';
  await page.getByLabel('收件人').fill('attachment-recipient@flaremail.test');
  await page.getByRole('textbox', { name: '主题', exact: true }).fill(subject);
  await page.getByRole('textbox', { name: '正文', exact: true }).fill('Two files enter; one verified file is sent.');
  await page.getByLabel('选择附件').setInputFiles([
    { name: 'keep.txt', mimeType: 'text/plain', buffer: Buffer.from('kept attachment bytes') },
    { name: 'discard.txt', mimeType: 'text/plain', buffer: Buffer.from('discarded attachment bytes') }
  ]);
  await expect(page.getByLabel('附件名称 keep.txt')).toHaveValue('keep.txt', { timeout: 12_000 });
  await expect(page.getByLabel('附件名称 discard.txt')).toHaveValue('discard.txt');
  await expect(page.getByRole('list', { name: '附件上传状态' })).toHaveCount(0);

  await page.reload();
  await openDraftEditor(page, subject);
  await expect(page.getByLabel('附件名称 keep.txt')).toHaveValue('keep.txt');
  await page.getByRole('button', { name: '删除附件 discard.txt' }).click();
  await expect(page.getByLabel('附件名称 discard.txt')).toHaveCount(0);
  await page.getByLabel('附件名称 keep.txt').fill('renamed-evidence.txt');
  await page.getByRole('button', { name: '重命名', exact: true }).click();
  await expect(page.getByLabel('附件名称 renamed-evidence.txt')).toHaveValue('renamed-evidence.txt');
  await page.getByRole('button', { name: '发送邮件' }).click();

  const detail = page.getByRole('region', { name: '邮件详情' });
  await expect(detail.getByRole('heading', { name: subject, exact: true })).toBeVisible();
  const download = detail.getByRole('link', { name: '下载附件 renamed-evidence.txt' });
  await expect(download).toBeVisible({ timeout: 10_000 });
  const href = await download.getAttribute('href');
  expect(href).toBeTruthy();
  const response = await page.request.get(href!);
  expect(response.ok(), await response.text()).toBe(true);
  expect(await response.body()).toEqual(Buffer.from('kept attachment bytes'));

  await detail.getByRole('button', { name: '转发', exact: true }).click();
  const forwardDialog = page.getByRole('dialog', { name: '转发邮件' });
  await expect(forwardDialog.getByText('原邮件有 1 个附件，默认不包含。')).toBeVisible();
  await forwardDialog.getByRole('button', { name: '包含原附件', exact: true }).click();
  await expect(forwardDialog.getByLabel('附件名称 renamed-evidence.txt')).toHaveValue('renamed-evidence.txt', { timeout: 12_000 });
  await expect(forwardDialog.getByText('原邮件有 1 个附件，默认不包含。')).toHaveCount(0);
  await assertNoConsoleErrors(consoleErrors);
});

test('persists To CC and BCC chips as canonical recipient arrays', async ({ page, consoleErrors }) => {
  await login(page);
  await page.getByRole('button', { name: '写邮件', exact: true }).first().click();
  await expect(page.getByRole('dialog', { name: '新邮件' })).toBeVisible();

  await page.getByLabel('收件人').fill('"张 三" <ZHANG@flaremail.test>, second@flaremail.test');
  await page.getByLabel('收件人').press('Enter');
  await page.getByRole('button', { name: '添加抄送', exact: true }).click();
  await page.getByLabel('抄送').fill('copy@flaremail.test; duplicate@flaremail.test');
  await page.getByLabel('抄送').press('Enter');
  await page.getByRole('button', { name: '添加密送', exact: true }).click();
  await page.getByLabel('密送').evaluate((input) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', 'blind@flaremail.test\nsecret@flaremail.test');
    input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, clipboardData }));
  });
  const subject = `E2E recipient arrays ${Date.now()}`;
  await page.getByRole('textbox', { name: '主题', exact: true }).fill(subject);
  await page.getByRole('textbox', { name: '正文', exact: true }).fill('Structured recipient draft.');
  await expect(page.getByRole('status').filter({ hasText: '已自动保存于' })).toBeVisible({ timeout: 8_000 });

  const response = await page.request.get(`/api/workspace/mailbox?folder=drafts&q=${encodeURIComponent(subject)}&limit=10`);
  expect(response.ok()).toBe(true);
  const payload = await response.json() as {
    data: { page: { messages: Array<{ toAddresses?: Array<{ name: string; email: string }>; ccAddresses?: Array<{ name: string; email: string }>; bccAddresses?: Array<{ name: string; email: string }> }> } };
  };
  const draft = payload.data.page.messages[0];
  expect(draft?.toAddresses).toEqual([
    { name: '张 三', email: 'zhang@flaremail.test' },
    { name: '', email: 'second@flaremail.test' }
  ]);
  expect(draft?.ccAddresses).toEqual([
    { name: '', email: 'copy@flaremail.test' },
    { name: '', email: 'duplicate@flaremail.test' }
  ]);
  expect(draft?.bccAddresses).toEqual([
    { name: '', email: 'blind@flaremail.test' },
    { name: '', email: 'secret@flaremail.test' }
  ]);
  await assertNoConsoleErrors(consoleErrors);
});

test('preserves the latest existing-draft edit while an autosave is in flight and closing', async ({ page, consoleErrors }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'The desktop flow exercises deterministic request delay and close coordination.');
  await login(page);
  await openDraftEditor(page, 'E2E Existing Concurrent');

  let releaseFirstSave!: () => void;
  const firstSaveGate = new Promise<void>((resolve) => (releaseFirstSave = resolve));
  let intercepted = 0;
  await page.route('**/api/workspace/drafts', async (route) => {
    if (route.request().method() === 'POST' && intercepted++ === 0) await firstSaveGate;
    await route.continue();
  });

  const body = page.getByRole('textbox', { name: '正文', exact: true });
  await body.fill('Older request snapshot');
  await expect(page.getByRole('status').filter({ hasText: '正在自动保存草稿' })).toBeVisible();
  await body.fill('Latest edit must survive close');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: '未保存的改动' })).toBeVisible();
  await page.getByRole('button', { name: '保存并关闭' }).click();
  releaseFirstSave();
  await expect(page.getByRole('dialog', { name: '编辑草稿' })).toBeHidden({ timeout: 12_000 });
  await page.unroute('**/api/workspace/drafts');

  await page.reload();
  await openDraftEditor(page, 'E2E Existing Concurrent');
  await expect(page.getByRole('textbox', { name: '正文', exact: true })).toHaveValue('Latest edit must survive close');
  await assertNoConsoleErrors(consoleErrors);
});

test('resolves draft conflicts by loading, copying, and explicitly overwriting', async ({ page, consoleErrors }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'The desktop flow covers all three optimistic-concurrency actions.');
  await login(page);

  await openDraftEditor(page, 'E2E Conflict Load');
  await updateServerDraft(page, 'E2E Conflict Load', 'Server body for load');
  await page.getByRole('textbox', { name: '正文', exact: true }).fill('Stale local body for load');
  await expect(page.getByRole('alert').filter({ hasText: '服务器版本已更新' })).toBeVisible({ timeout: 8_000 });
  await page.getByRole('button', { name: '载入服务器版本' }).click();
  await expect(page.getByRole('textbox', { name: '正文', exact: true })).toHaveValue('Server body for load');
  await page.getByRole('button', { name: '取消' }).click();

  await openDraftEditor(page, 'E2E Conflict Copy');
  const originalCopyDraft = (await listDrafts(page)).find((draft) => draft.subject === 'E2E Conflict Copy')!;
  await updateServerDraft(page, 'E2E Conflict Copy', 'Server body preserved on copy');
  await page.getByRole('textbox', { name: '正文', exact: true }).fill('Local body saved as copy');
  await expect(page.getByRole('alert').filter({ hasText: '服务器版本已更新' })).toBeVisible({ timeout: 8_000 });
  await page.getByRole('button', { name: '另存为新草稿' }).click();
  await expect(page.getByRole('dialog', { name: '编辑草稿' })).toBeHidden();
  const afterCopy = await listDrafts(page);
  expect((await readDraft(page, originalCopyDraft.id)).body).toBe('Server body preserved on copy');
  const copiedDraft = afterCopy.find((draft) => draft.id !== originalCopyDraft.id && draft.subject === 'E2E Conflict Copy');
  expect(copiedDraft).toBeTruthy();
  expect((await readDraft(page, copiedDraft!.id)).body).toBe('Local body saved as copy');

  await openDraftEditor(page, 'E2E Conflict Overwrite');
  const originalOverwriteDraft = (await listDrafts(page)).find((draft) => draft.subject === 'E2E Conflict Overwrite')!;
  await updateServerDraft(page, 'E2E Conflict Overwrite', 'Server body before overwrite');
  await page.getByRole('textbox', { name: '正文', exact: true }).fill('Explicit local overwrite body');
  await expect(page.getByRole('alert').filter({ hasText: '服务器版本已更新' })).toBeVisible({ timeout: 8_000 });
  await page.getByRole('button', { name: '明确覆盖' }).click();
  await expect(page.getByRole('dialog', { name: '编辑草稿' })).toBeHidden();
  expect((await readDraft(page, originalOverwriteDraft.id)).body).toBe('Explicit local overwrite body');
  const expectedConflicts = consoleErrors.filter((message) => message.includes('409 (Conflict)'));
  expect(expectedConflicts).toHaveLength(3);
  await assertNoConsoleErrors(consoleErrors.filter((message) => !message.includes('409 (Conflict)')));
});

test('continues an existing draft on mobile and persists its next version', async ({ page, consoleErrors }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'This is the required mobile existing-draft persistence path.');
  await login(page);
  await openDraftEditor(page, 'E2E Mobile Existing');
  await page.getByRole('textbox', { name: '正文', exact: true }).fill('Mobile existing draft next version');
  await expect(page.getByRole('status').filter({ hasText: '已自动保存于' })).toBeVisible({ timeout: 8_000 });
  await page.reload();
  await openDraftEditor(page, 'E2E Mobile Existing');
  await expect(page.getByRole('textbox', { name: '正文', exact: true })).toHaveValue('Mobile existing draft next version');
  await assertNoConsoleErrors(consoleErrors);
});

test('sends through the local fake provider and applies a signed delivered webhook', async ({ page, consoleErrors }, testInfo) => {
  const externalRequests: string[] = [];
  let outboundPayload: Record<string, unknown> | undefined;
  page.on('request', (request) => {
    if (/resend\.com/iu.test(request.url())) externalRequests.push(request.url());
    if (request.url().endsWith('/api/send') && request.method() === 'POST') {
      outboundPayload = request.postDataJSON() as Record<string, unknown>;
    }
  });
  await login(page);
  await page.getByRole('button', { name: '写邮件', exact: true }).first().click();
  const subject = 'E2E fake send';
  await page.getByLabel('收件人').fill('send-recipient@flaremail.test');
  await page.getByRole('textbox', { name: '主题', exact: true }).fill(subject);
  await page.getByRole('textbox', { name: '正文', exact: true }).fill('This message is sent by the local fake provider.');
  await page.getByLabel('HTML 源码（可选）', { exact: true }).fill('<p>This <em>HTML</em> message is sent by the local fake provider.</p>');
  await page.getByRole('button', { name: '发送邮件' }).click();
  const detail = page.getByRole('region', { name: '邮件详情' });
  await expect(detail.getByRole('heading', { name: subject, exact: true })).toBeVisible();
  await expect(detail.getByText('已提交', { exact: true }).first()).toBeVisible();
  expect(externalRequests).toEqual([]);
  expect(outboundPayload?.html).toBe('<p>This <em>HTML</em> message is sent by the local fake provider.</p>');

  const providerLine = detail.locator('p').filter({ hasText: 'Provider ID' }).first();
  await expect(providerLine).toBeVisible();
  const providerMessageId = (await providerLine.textContent())?.match(/Provider ID\s+(\S+)/u)?.[1];
  expect(providerMessageId).toBeTruthy();
  const timestamp = Math.floor(Date.now() / 1000);
  const svixId = `e2e-${testInfo.project.name}-${timestamp}`;
  const body = JSON.stringify({
    type: 'email.delivered',
    created_at: new Date(timestamp * 1000).toISOString(),
    data: { email_id: providerMessageId }
  });
  const webhook = await page.request.post('/api/webhooks/resend', {
    data: body,
    headers: {
      'content-type': 'application/json',
      'svix-id': svixId,
      'svix-timestamp': String(timestamp),
      'svix-signature': `v1,${await signWebhook(svixId, timestamp, body)}`
    }
  });
  expect(webhook.ok(), await webhook.text()).toBe(true);
  await detail.getByRole('button', { name: '刷新投递回执' }).click();
  await expect(detail.getByText('已送达', { exact: true }).first()).toBeVisible();
  await expect(detail.getByRole('list', { name: '投递事件列表' })).toContainText('已送达');
  await assertNoConsoleErrors(consoleErrors);
});

test('supports mobile detail drill-in and back navigation', async ({ page, consoleErrors }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'This flow verifies the mobile-only detail drill-in.');
  await login(page);
  const item = page.getByRole('listitem').filter({ hasText: 'E2E Inbox Welcome' });
  await item.getByRole('button', { name: /E2E Inbox Welcome/ }).first().click();
  await expect(page.getByRole('button', { name: '返回邮件列表' })).toBeVisible();
  await page.getByRole('button', { name: '返回邮件列表' }).click();
  await expect(page.getByRole('button', { name: /E2E Inbox Welcome/ }).first()).toBeVisible();
  await assertNoConsoleErrors(consoleErrors);
});

test('supports theme cycling and keyboard shortcut help/navigation', async ({ page, consoleErrors }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'AppTopbar theme and command controls are desktop-only.');
  await login(page);
  const theme = page.getByRole('button', { name: /主题：/ });
  await expect(theme).toBeVisible();
  const initialTheme = await theme.getAttribute('aria-label');
  await theme.click();
  await expect(theme).not.toHaveAttribute('aria-label', initialTheme ?? '');
  await page.keyboard.press('?');
  await expect(page.getByRole('dialog', { name: '键盘快捷键' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: '键盘快捷键' })).toBeHidden();
  await page.keyboard.press('g');
  await page.keyboard.press('s');
  await expect(page).toHaveURL(/folder=sent/);
  await assertNoConsoleErrors(consoleErrors);
});

test('has no horizontal overflow at 320px and an emulated 200% zoom', async ({ page, consoleErrors }, testInfo) => {
  test.skip(testInfo.project.name !== 'narrow', 'This flow is specific to the 320px project.');
  await login(page);
  await assertNoHorizontalOverflow(page);
  await page.evaluate(() => {
    document.documentElement.style.zoom = '2';
  });
  const zoomed = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth)
  }));
  expect(zoomed.scrollWidth, `unexpected overflow beyond the intentional 2x scale: ${JSON.stringify(zoomed)}`)
    .toBeLessThanOrEqual(zoomed.viewport * 2 + 2);
  await expect(page.getByRole('button', { name: '打开导航' })).toBeVisible();
  await assertNoConsoleErrors(consoleErrors);
});

test('has an accessible WCAG 2.1 AA workspace and touch targets', async ({ page, consoleErrors }, testInfo) => {
  test.skip(testInfo.project.name === 'narrow', 'The mobile project covers the small-screen accessibility baseline.');
  await login(page);

  if (testInfo.project.name === 'mobile') {
    await page.getByRole('button', { name: '打开导航' }).click();
    await expect(page.getByRole('navigation', { name: '移动端导航' })).toBeVisible();
    await page.keyboard.press('Escape');
  } else {
    await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
  }
  await expect(page.getByRole('main', { name: '邮件工作区' })).toBeVisible();
  await expect(page.getByRole('list', { name: '收件箱邮件' })).toBeVisible();

  const scan = async () => new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect((await scan()).violations).toEqual([]);

  await page.evaluate(() => localStorage.setItem('flaremail-theme', 'dark'));
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect((await scan()).violations).toEqual([]);

  if (testInfo.project.name === 'mobile') {
    const undersized = await page.locator('a, button, input, select, textarea, [role="button"], [role="menuitem"]').evaluateAll((elements) =>
      elements.flatMap((element) => {
        const style = getComputedStyle(element);
        if (style.visibility === 'hidden' || style.display === 'none') return [];
        const ownRect = element.getBoundingClientRect();
        if (ownRect.width === 0 || ownRect.height === 0) return [];
        const target = element instanceof HTMLInputElement && /^(checkbox|radio)$/u.test(element.type) && element.labels?.[0]
          ? element.labels[0]
          : element;
        const rect = target.getBoundingClientRect();
        return rect.width + 0.5 < 44 || rect.height + 0.5 < 44
          ? [`${element.tagName.toLowerCase()}${element.getAttribute('aria-label') ? `[aria-label="${element.getAttribute('aria-label')}"]` : ''}: ${Math.round(rect.width)}x${Math.round(rect.height)}`]
          : [];
      })
    );
    expect(undersized, `touch targets below 44px: ${undersized.join(', ')}`).toEqual([]);
  }
  await assertNoConsoleErrors(consoleErrors);
});
