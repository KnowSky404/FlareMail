import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { test, expect, login, assertNoHorizontalOverflow, assertNoConsoleErrors } from './fixtures';

const title = 'AI 摘要与分类建议';
const path = '/api/workspace/messages/e2e-inbox-message/ai';

async function confirmAnalysis(page: Page, action: Locator, name: string) {
  await action.click();
  const dialog = page.getByRole('dialog', { name: /关于 AI 分析|About AI analysis/u });
  await expect(dialog).toContainText(/外部模型|external model provider/u);
  await dialog.getByRole('button', { name, exact: true }).press('Enter');
}

for (const reader of ['workspace', 'standalone']) {
  test(`AI category confirmation retains the address boundary after reclassification (${reader})`, async ({ page, consoleErrors }) => {
    let generated = false;
    await page.route(`**${path}*`, async (route) => {
      if (route.request().method() === 'POST') generated = true;
      await route.fulfill({ json: { ok: true, data: generated ? { status: 'ready', appliedCategory: 'updates', analysis: {
        summary: 'Synthetic reclassification', keyPoints: [], actionItems: [], dates: [], language: 'zh-CN',
        suggestion: { category: 'updates', confidence: 0.9, reason: 'Service update' }
      } } : { status: 'empty', analysis: null }, requestId: 'fake-reclassification' } });
    });
    await page.route('**/api/workspace/messages/e2e-inbox-message', async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const response = await route.fetch(); const body = await response.json();
      if (response.ok() && generated && !body.data.message.inboxCategoryOverride) body.data.message.inboxCategory = 'updates';
      await route.fulfill({ response, json: body });
    });
    await login(page);
    const split = reader === 'workspace' && (page.viewportSize()?.width ?? 0) > 900;
    if (split) await page.getByRole('button', { name: '显示分栏预览', exact: true }).click();
    const addressId = '00000000-0000-4000-8000-000000000021';
    const restore = () => page.request.patch('/api/workspace/mailbox/categories', { headers: { origin: new URL(page.url()).origin },
      data: { ids: ['e2e-inbox-message'], category: null, scope: { section: 'inbox', identityFilter: null, category: 'all' } } });
    expect((await restore()).status()).toBe(200);
    const query = `folder=inbox&category=primary&identity=address%3A${addressId}`;
    await page.goto(reader === 'workspace' ? `/?${query}&message=e2e-inbox-message` : `/messages/e2e-inbox-message?${query}`, { waitUntil: 'domcontentloaded' });
    const panel = page.getByRole('region', { name: title });
    await confirmAnalysis(page, panel.getByRole('button', { name: '同意并生成分析', exact: true }), '同意并生成分析');
    await expect(panel.getByText('Synthetic reclassification')).toBeVisible();
    await expect(page).toHaveURL(/category=primary/u);
    await panel.getByRole('tab', { name: '分类建议', exact: true }).click();
    const [request] = await Promise.all([
      page.waitForRequest((request) => request.method() === 'PATCH' && request.url().endsWith('/api/workspace/mailbox/categories')),
      panel.getByRole('button', { name: '确认应用此分类' }).click()
    ]);
    expect(request.postDataJSON()).toMatchObject({ ids: ['e2e-inbox-message'], onlyIfAutomatic: true,
      scope: { section: 'inbox', category: 'all', identityFilter: { kind: 'address', id: addressId } } });
    await expect(panel.getByText(/已有手动分类|已应用分类/u)).toBeVisible();
    expect((await restore()).status()).toBe(200);

    if (reader === 'workspace') {
      await page.evaluate(() => {
        const channel = new BroadcastChannel('flaremail-workspace-v1');
        channel.postMessage({ type: 'mailbox-refresh' });
        channel.close();
      });
      const apply = panel.getByRole('button', { name: '确认应用此分类' });
      await expect(apply).toBeVisible();
      await apply.click();
      await expect(panel.getByText(/已有手动分类|已应用分类/u)).toBeVisible();

      const detail = page.getByRole('region', { name: '邮件详情', exact: true });
      const [archive] = await Promise.all([
        page.waitForResponse((response) => response.url().endsWith('/api/workspace/mailbox/mutate')),
        detail.getByRole('button', { name: '归档', exact: true }).click()
      ]);
      expect(archive.status()).toBe(200);
      expect(archive.request().postDataJSON()).toMatchObject({
        action: 'archive', ids: ['e2e-inbox-message'],
        scope: { section: 'inbox', category: 'all', identityFilter: { kind: 'address', id: addressId } }
      });
      if (split) {
        const [unarchive] = await Promise.all([
          page.waitForResponse((response) => response.url().endsWith('/api/workspace/mailbox/mutate')),
          detail.getByRole('button', { name: '移回收件箱', exact: true }).click()
        ]);
        expect(unarchive.status()).toBe(200);
        expect(unarchive.request().postDataJSON()).toMatchObject({
          action: 'unarchive', ids: ['e2e-inbox-message'],
          scope: { section: 'archive', identityFilter: { kind: 'address', id: addressId } }
        });
        await expect(detail.getByRole('button', { name: '归档', exact: true })).toBeVisible();

        await page.getByRole('tab', { name: '服务通知', exact: true }).click();
        const row = page.getByRole('listitem').filter({ hasText: 'E2E Inbox Welcome' });
        await row.getByRole('button', { name: /E2E Inbox Welcome/u }).first().click();
        await panel.getByRole('tab', { name: '分类建议', exact: true }).click();
        await expect(panel.getByText('已有手动分类，保留当前设置。')).toBeVisible();
        await row.getByLabel('选择E2E Inbox Welcome').check();
        await page.getByRole('button', { name: '更改收件分类' }).click();
        await page.getByRole('menuitem', { name: '恢复自动分类', exact: true }).click();
        await expect(apply).toBeVisible();

        await detail.getByRole('button', { name: '归档', exact: true }).click();
        await expect(detail.getByRole('button', { name: '移回收件箱', exact: true })).toBeVisible();
        const archiveUrl = `/?folder=archive&q=unmatched&message=e2e-inbox-message&identity=address%3A${addressId}`;
        await page.goto(archiveUrl);
        await expect(detail.getByRole('button', { name: '移回收件箱', exact: true })).toBeVisible();
        const unarchivedElsewhere = await page.request.post('/api/workspace/mailbox/mutate', {
          headers: { origin: new URL(page.url()).origin },
          data: { action: 'unarchive', ids: ['e2e-inbox-message'], threadKeys: [], scope: { section: 'archive', identityFilter: { kind: 'address', id: addressId }, threadScope: 'selected' } }
        });
        expect(unarchivedElsewhere.status()).toBe(200);
        await page.getByRole('button', { name: '刷新邮件列表', exact: true }).click();
        const [rearchived] = await Promise.all([
          page.waitForResponse((response) => response.url().endsWith('/api/workspace/mailbox/mutate')),
          detail.getByRole('button', { name: '归档', exact: true }).click()
        ]);
        expect(rearchived.status()).toBe(200);
        expect(rearchived.request().postDataJSON()).toMatchObject({
          action: 'archive', scope: { section: 'inbox', category: 'all', identityFilter: { kind: 'address', id: addressId } }
        });
        await expect(detail.getByRole('button', { name: '移回收件箱', exact: true })).toBeVisible();
        await expect(page).toHaveURL(/message=e2e-inbox-message/u);
        await detail.getByRole('button', { name: '展开专注阅读', exact: true }).click();
        const focused = page.getByRole('dialog', { name: 'E2E Inbox Welcome', exact: true });
        await focused.getByRole('button', { name: '移回收件箱', exact: true }).click();
        await expect(page).not.toHaveURL(/message=e2e-inbox-message/u);
        await expect(focused).toBeHidden();
        await expect(detail.getByText('选择一封邮件开始阅读')).toBeVisible();
        const subject = detail.getByRole('heading', { name: 'E2E Inbox Welcome', exact: true });

        for (const external of [true, false]) {
          await page.goto(`/?${query}&message=e2e-inbox-message`);
          await panel.getByRole('tab', { name: '分类建议', exact: true }).click();
          await apply.click();
          await expect(panel.getByText(/已有手动分类|已应用分类/u)).toBeVisible();
          const headers = { origin: new URL(page.url()).origin };
          if (external) {
            const trashed = await page.request.delete('/api/workspace/messages/e2e-inbox-message', { headers });
            expect(trashed.status()).toBe(200);
            await page.evaluate(() => {
              const channel = new BroadcastChannel('flaremail-workspace-v1');
              channel.postMessage({ type: 'mailbox-refresh', id: 'e2e-inbox-message' });
              channel.close();
            });
          } else {
            await detail.getByRole('button', { name: '移入垃圾箱', exact: true }).click();
            const confirm = page.getByRole('dialog', { name: '移入垃圾箱？', exact: true });
            await confirm.getByRole('button', { name: '移入垃圾箱', exact: true }).click();
          }
          await expect(page).not.toHaveURL(/message=e2e-inbox-message/u);
          await expect(subject).toBeHidden();
          expect((await page.request.post('/api/workspace/trash/e2e-inbox-message', { headers })).status()).toBe(200);
          expect((await restore()).status()).toBe(200);
        }

        const headers = { origin: new URL(page.url()).origin };
        const labelName = `E2E Retained Reader ${crypto.randomUUID().slice(0, 8)}`;
        const createdLabel = await page.request.post('/api/workspace/labels', { headers, data: { name: labelName } });
        expect(createdLabel.status()).toBe(201);
        const { data: { label: { id: labelId } } } = await createdLabel.json();
        const labelPath = `/api/workspace/labels/${labelId}`;
        try {
          const applied = await page.request.put(`${labelPath}/messages`, {
            headers, data: { kind: 'workspace', id: 'e2e-inbox-message' }
          });
          expect(applied.status()).toBe(200);
          await page.goto(`/?${query}&message=e2e-inbox-message`);
          await detail.getByRole('button', { name: '展开专注阅读', exact: true }).click();
          await focused.getByRole('tab', { name: '分类建议', exact: true }).click();
          const externalCategory = await page.request.patch('/api/workspace/mailbox/categories', {
            headers,
            data: { ids: ['e2e-inbox-message'], category: 'updates', scope: { section: 'inbox', identityFilter: null, category: 'all' } }
          });
          expect(externalCategory.status()).toBe(200);
          await page.evaluate(() => {
            const channel = new BroadcastChannel('flaremail-workspace-v1');
            channel.postMessage({ type: 'mailbox-refresh', id: 'e2e-inbox-message' });
            channel.close();
          });
          await expect(focused.getByText('已有手动分类，保留当前设置。')).toBeVisible();
          const manageLabels = focused.getByRole('button', { name: '管理标签', exact: true });
          const labels = page.getByRole('dialog', { name: '管理标签', exact: true });
          const checkbox = labels.getByRole('checkbox', { name: labelName, exact: true });
          await manageLabels.click();
          await expect(checkbox).toBeChecked();
          const [labelRefresh] = await Promise.all([
            page.waitForResponse((response) => response.request().method() === 'GET' && response.url().endsWith('/api/workspace/messages/e2e-inbox-message')),
            checkbox.uncheck()
          ]);
          expect(labelRefresh.status()).toBe(200);
          const { data: { message: refreshed } } = await labelRefresh.json();
          expect(refreshed.inboxCategoryOverride).toBe('updates');
          expect(refreshed.userLabels).not.toContainEqual({ id: labelId, name: labelName });
          await expect(checkbox).not.toBeChecked();
          await labels.getByRole('button', { name: '关闭', exact: true }).click();
          await manageLabels.click();
          await expect(checkbox).not.toBeChecked();
          await labels.getByRole('button', { name: '关闭', exact: true }).click();
          await focused.getByRole('button', { name: '关闭专注阅读', exact: true }).click();
        } finally {
          expect((await page.request.delete(labelPath, { headers })).status()).toBe(200);
        }

        const externalArchive = await page.request.post('/api/workspace/mailbox/mutate', {
          headers: { origin: new URL(page.url()).origin },
          data: { action: 'archive', ids: ['e2e-inbox-message'], threadKeys: [], scope: { section: 'inbox', identityFilter: null, threadScope: 'selected' } }
        });
        expect(externalArchive.status()).toBe(200);
        await page.getByRole('button', { name: '刷新邮件列表', exact: true }).click();
        await detail.getByRole('button', { name: '移回收件箱', exact: true }).click();
        await expect(detail.getByRole('button', { name: '归档', exact: true })).toBeVisible();
      } else {
        const unarchive = await page.request.post('/api/workspace/mailbox/mutate', {
          headers: { origin: new URL(page.url()).origin },
          data: { action: 'unarchive', ids: ['e2e-inbox-message'], threadKeys: [], scope: { section: 'archive', identityFilter: null, threadScope: 'selected' } }
        });
        expect(unarchive.status()).toBe(200);
      }
      expect((await restore()).status()).toBe(200);
    }

    await assertNoHorizontalOverflow(page);
    await assertNoConsoleErrors(split ? consoleErrors.filter((text) => !/Failed to load resource.*404/u.test(text)) : consoleErrors);
    await page.unrouteAll({ behavior: 'wait' });
  });
}

test('AI accessible summary, explicit category application and cached refresh', async ({ page, consoleErrors }, info) => {
  let generations = 0;
  let cached = false;
  await page.route(`**${path}*`, async (route) => {
    if (route.request().method() === 'POST') { generations++; cached = true; }
    await route.fulfill({ json: { ok: true, data: cached ? { status: 'ready', truncated: true, analysis: {
      summary: '会议邀请：请确认参会。<script>window.aiInjected = true</script>', keyPoints: ['会议地点待确认'], actionItems: ['确认参会'], dates: ['November 12'], language: 'zh-CN',
      suggestion: { category: 'updates', confidence: 0.8, reason: '会议安排更新' }
    } } : { status: 'empty', analysis: null }, requestId: 'fake-ai' } });
  });
  await login(page);
  const restoreAutomatic = () => page.request.patch('/api/workspace/mailbox/categories', {
    headers: { origin: new URL(page.url()).origin },
    data: { ids: ['e2e-inbox-message'], category: null, scope: { section: 'inbox', identityFilter: null, category: 'all' } }
  });
  expect((await restoreAutomatic()).status()).toBe(200);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('.mail-list-panel').getByRole('listitem').filter({ hasText: 'E2E Inbox Welcome' }).getByRole('button', { name: /E2E Inbox Welcome/u }).first().click();
  const panel = page.getByRole('region', { name: title });
  const toggle = panel.getByRole('button', { name: 'AI 摘要', exact: true });
  await expect(panel.getByRole('button', { name: '同意并生成分析' })).toBeVisible();
  await toggle.focus(); await page.keyboard.press('Enter');
  await expect(panel.getByRole('button', { name: '同意并生成分析' })).toBeHidden();
  await page.keyboard.press('Enter');
  await expect(panel.getByRole('button', { name: '同意并生成分析' })).toBeVisible();
  expect(generations).toBe(0);
  const generate = panel.getByRole('button', { name: '同意并生成分析' });
  if (!info.project.use.isMobile) {
    await panel.getByRole('button', { name: '关于 AI 分析' }).hover();
    await expect(panel.getByRole('tooltip')).toBeVisible();
    await generate.press('Enter');
  } else {
    await generate.click();
  }
  const consent = page.getByRole('dialog', { name: '关于 AI 分析' });
  await expect(consent.getByRole('button', { name: '关闭' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(consent).toBeHidden();
  await expect(generate).toBeFocused();
  await expect(page).toHaveURL(/message=e2e-inbox-message/u);
  expect(generations).toBe(0);
  await confirmAnalysis(page, panel.getByRole('button', { name: '同意并生成分析', exact: true }), '同意并生成分析');
  await expect(toggle).toBeFocused();
  await expect(panel.getByText('会议邀请：', { exact: false })).toBeVisible();
  expect(await page.evaluate(() => 'aiInjected' in window)).toBe(false);
  const summaryTab = panel.getByRole('tab', { name: '摘要', exact: true });
  await expect(summaryTab).toHaveAttribute('aria-selected', 'true');
  await summaryTab.press('ArrowRight');
  await expect(panel.getByRole('tab', { name: '分类建议', exact: true })).toBeFocused();
  await expect(panel.getByRole('tabpanel', { name: '分类建议', exact: true })).toBeVisible();
  expect(generations).toBe(1);
  await panel.getByRole('button', { name: '确认应用此分类' }).click();
  await expect(panel.getByText(/已有手动分类|已应用分类/u)).toBeVisible();
  expect((await restoreAutomatic()).status()).toBe(200);
  await page.evaluate(() => {
    const channel = new BroadcastChannel('flaremail-workspace-v1');
    channel.postMessage({ type: 'mailbox-refresh', id: 'e2e-inbox-message' });
    channel.close();
  });
  await expect(panel.getByRole('button', { name: '确认应用此分类' })).toBeVisible();
  await panel.getByRole('button', { name: '确认应用此分类' }).click();
  await expect(panel.getByText(/已有手动分类|已应用分类/u)).toBeVisible();
  expect(generations).toBe(1);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByText('会议邀请：', { exact: false })).toBeVisible();
  expect(generations).toBe(1);
  await assertNoHorizontalOverflow(page);
  const accessibility = await new AxeBuilder({ page }).include('.message-content').analyze();
  expect(accessibility.violations).toEqual([]);
  await mkdir('/tmp/flaremail-ai-evidence', { recursive: true });
  await page.screenshot({ path: `/tmp/flaremail-ai-evidence/${info.project.name}-summary.png` });
  await assertNoConsoleErrors(consoleErrors);
});

test('AI disabled state does not generate and standalone reader shares the panel', async ({ page, consoleErrors }) => {
  let posts = 0;
  await page.route(`**${path}*`, async (route) => {
    if (route.request().method() === 'POST') posts++;
    await route.fulfill({ json: { ok: true, data: { status: 'disabled', analysis: null }, requestId: 'fake-ai' } });
  });
  await login(page);
  await page.goto('/messages/e2e-inbox-message?folder=inbox', { waitUntil: 'domcontentloaded' });
  const panel = page.getByRole('region', { name: title });
  await expect(panel.getByText('AI 默认关闭', { exact: false })).toBeVisible();
  await expect(panel.getByRole('button', { name: '同意并生成分析' })).toHaveCount(0);
  expect(posts).toBe(0);
  await assertNoHorizontalOverflow(page); await assertNoConsoleErrors(consoleErrors);
});

test('AI accessible error recovery requires consent and prevents duplicate generation while loading', async ({ page, consoleErrors }) => {
  let posts = 0;
  let reads = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => release = resolve);
  await page.route(`**${path}*`, async (route) => {
    if (route.request().method() === 'GET') {
      if (reads++ === 0) {
        await route.fulfill({ json: { ok: true, data: { status: 'processing', analysis: null }, requestId: 'fake-ai' } });
        return;
      }
      await route.fulfill({ status: 409, json: { ok: false, error: { code: 'AI_CACHE_INVALID', message: 'Invalid cache' }, requestId: 'fake-ai' } }); return;
    }
    posts++;
    expect(route.request().postDataJSON()).toMatchObject({ regenerate: true });
    if (posts === 1) {
      await gate;
      await route.fulfill({ status: 503, json: { ok: false, error: { code: 'AI_PROVIDER_UNAVAILABLE', message: 'Unavailable' }, requestId: 'fake-ai' } }); return;
    }
    await route.fulfill({ json: { ok: true, data: { status: 'ready', analysis: { summary: '已恢复分析', keyPoints: [], actionItems: [], dates: [], language: 'zh-CN', suggestion: null } }, requestId: 'fake-ai' } });
  });
  await login(page);
  await page.goto('/messages/e2e-inbox-message?folder=inbox', { waitUntil: 'domcontentloaded' });
  const panel = page.getByRole('region', { name: title });
  await panel.getByRole('button', { name: '刷新分析状态', exact: true }).press('Enter');
  await expect(panel.getByRole('button', { name: 'AI 摘要', exact: true })).toBeFocused();
  await expect(panel.getByRole('alert')).toContainText('AI_CACHE_INVALID'); expect(posts).toBe(0);
  const regenerate = panel.getByRole('button', { name: '同意重新生成' });
  await confirmAnalysis(page, regenerate, '同意重新生成');
  await expect(panel.getByRole('status')).toContainText('正在读取或生成');
  await expect(regenerate).toBeDisabled(); expect(posts).toBe(1);
  release?.();
  await expect(panel.getByRole('alert')).toContainText('AI_PROVIDER_UNAVAILABLE');
  await confirmAnalysis(page, regenerate, '同意重新生成'); await expect(panel.getByText('已恢复分析')).toBeVisible(); expect(posts).toBe(2);
  await panel.getByRole('tab', { name: '分类建议', exact: true }).click();
  await expect(panel.getByText('没有可靠的分类建议。')).toBeVisible();
  await assertNoConsoleErrors(consoleErrors.filter((text) => !/Failed to load resource.*(?:409|503)/u.test(text)));
});

test('AI English output, regeneration and system light/dark themes in standalone reader', async ({ page, consoleErrors }, info) => {
  let posts = 0;
  await page.route(`**${path}*`, async (route) => {
    if (route.request().method() === 'GET') {
      expect(new URL(route.request().url()).searchParams.get('language')).toBe('en');
      await route.fulfill({ json: { ok: true, data: { status: 'empty', analysis: null }, requestId: 'fake-ai' } }); return;
    }
    posts++;
    expect(route.request().postDataJSON()).toMatchObject({ language: 'en', regenerate: posts > 1 });
    await route.fulfill({ json: { ok: true, data: { status: 'ready', analysis: { summary: `Meeting summary ${posts}`, keyPoints: [], actionItems: [], dates: [], language: 'en', suggestion: null } }, requestId: 'fake-ai' } });
  });
  await login(page);
  await page.evaluate(() => { localStorage.setItem('flaremail-locale', 'en'); localStorage.setItem('flaremail-theme', 'system'); document.cookie = 'flaremail-locale=en; Path=/'; });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/messages/e2e-inbox-message?folder=inbox', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const panel = page.getByRole('region', { name: 'AI summary and category suggestion' });
  await confirmAnalysis(page, panel.getByRole('button', { name: 'Agree and generate analysis', exact: true }), 'Agree and generate analysis');
  await expect(panel.getByText('Meeting summary 1')).toBeVisible();
  const controlBounds = await panel.locator('.ai-header button').evaluateAll((buttons) => buttons.map((button) => {
    const range = document.createRange();
    range.selectNodeContents(button);
    const rects = [button.getBoundingClientRect(), ...range.getClientRects()].filter((rect) => rect.width && rect.height);
    return {
      left: Math.min(...rects.map((rect) => rect.left)), right: Math.max(...rects.map((rect) => rect.right)),
      top: Math.min(...rects.map((rect) => rect.top)), bottom: Math.max(...rects.map((rect) => rect.bottom))
    };
  }));
  expect(controlBounds).toHaveLength(3);
  for (const [index, control] of controlBounds.entries()) {
    for (const next of controlBounds.slice(index + 1)) {
      const horizontal = Math.min(control.right, next.right) - Math.max(control.left, next.left);
      const vertical = Math.min(control.bottom, next.bottom) - Math.max(control.top, next.top);
      expect(horizontal <= 1 || vertical <= 1).toBe(true);
    }
  }
  await confirmAnalysis(page, panel.getByRole('button', { name: 'Agree and regenerate', exact: true }), 'Agree and regenerate');
  await expect(panel.getByText('Meeting summary 2')).toBeVisible(); expect(posts).toBe(2);
  await assertNoHorizontalOverflow(page);
  expect((await new AxeBuilder({ page }).include('.message-content').analyze()).violations).toEqual([]);
  await mkdir('/tmp/flaremail-ai-evidence', { recursive: true });
  await panel.screenshot({ path: `/tmp/flaremail-ai-evidence/${info.project.name}-english-dark.png` });
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(panel.getByText('Meeting summary 2')).toBeVisible();
  await assertNoConsoleErrors(consoleErrors);
});

test('AI focused reader uses the shared cached analysis without another generation', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'Focused reader toggle is a desktop control.');
  let posts = 0;
  await page.route(`**${path}*`, async (route) => {
    if (route.request().method() === 'POST') posts++;
    await route.fulfill({ json: { ok: true, data: { status: 'ready', analysis: { summary: '专注阅读缓存', keyPoints: [], actionItems: [], dates: [], language: 'zh-CN', suggestion: null } }, requestId: 'fake-ai' } });
  });
  await login(page);
  await page.locator('.mail-list-panel').getByRole('listitem').filter({ hasText: 'E2E Inbox Welcome' }).getByRole('button', { name: /E2E Inbox Welcome/u }).first().click();
  await page.locator('#fm-open-reader-trigger').click();
  const dialog = page.getByRole('dialog', { name: 'E2E Inbox Welcome', exact: true });
  await expect(dialog.getByText('专注阅读缓存')).toBeVisible();
  expect(posts).toBe(0);
  await expect(page.getByRole('region', { name: title })).toHaveCount(1);

  const toggle = dialog.getByRole('button', { name: 'AI 摘要', exact: true });
  await toggle.press('r');
  const reply = page.getByRole('dialog', { name: '回复邮件', exact: true });
  await expect(reply).toBeVisible();
  await expect(dialog).toBeHidden();
  await reply.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(reply).toBeHidden();
  await page.locator('#fm-open-reader-trigger').click();
  await dialog.getByRole('button', { name: '同意重新生成', exact: true }).click();
  const consent = page.getByRole('dialog', { name: '关于 AI 分析', exact: true });
  const closeConsent = consent.getByRole('button', { name: '关闭', exact: true });
  await closeConsent.press('f');
  const forward = page.getByRole('dialog', { name: '转发邮件', exact: true });
  await expect(forward).toHaveCount(0);
  await closeConsent.press('Escape');
  await expect(consent).toBeHidden();
  await toggle.press('f');
  await expect(forward).toBeVisible();
  await expect(dialog).toBeHidden();
  await forward.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(forward).toBeHidden();
  expect(posts).toBe(0);
  await page.locator('#fm-open-reader-trigger').click();
  await dialog.getByRole('button', { name: '关闭专注阅读', exact: true }).click();
  await expect(dialog).toBeHidden();
});


test('keeps the focused reader open when a refresh returns a row with a pending flag change', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'Focused reader toggle is a desktop control.');
  await login(page);
  const flagsPath = '/api/workspace/messages/e2e-inbox-message/flags';
  const headers = { origin: new URL(page.url()).origin };
  expect((await page.request.patch(flagsPath, { headers, data: { read: true, starred: true } })).status()).toBe(200);
  await page.goto('/?folder=inbox&filter=starred&message=e2e-inbox-message');
  await page.locator('#fm-open-reader-trigger').click();
  const focused = page.getByRole('dialog', { name: 'E2E Inbox Welcome', exact: true });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route(`**${flagsPath}`, async (route) => {
    await gate;
    await route.continue();
  });
  try {
    const started = page.waitForRequest((request) => new URL(request.url()).pathname === flagsPath);
    await focused.getByRole('button', { name: '取消星标', exact: true }).click();
    await started;
    const list = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/workspace/mailbox' && response.ok());
    await page.evaluate(() => {
      const channel = new BroadcastChannel('flaremail-workspace-v1');
      channel.postMessage({ type: 'mailbox-refresh' });
      channel.close();
    });
    await (await list).finished();
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(focused).toBeVisible();
    await expect(focused.getByRole('button', { name: '加星', exact: true })).toBeVisible();
    const finished = page.waitForResponse((response) => new URL(response.url()).pathname === flagsPath && response.ok());
    release();
    await finished;
  } finally {
    release();
    await page.unrouteAll({ behavior: 'wait' });
    await page.request.patch(flagsPath, { headers, data: { starred: false } });
  }
});

test('explicit theme survives OS changes when browser storage writes fail', async ({ page, consoleErrors }, info) => {
  test.skip(info.project.name !== 'desktop', 'Desktop preference controls exercise the shared theme listener.');
  await login(page);
  await page.emulateMedia({ colorScheme: 'light' });
  await page.evaluate(() => {
    localStorage.setItem('flaremail-theme', 'system');
    Storage.prototype.setItem = () => { throw new DOMException('Storage unavailable', 'SecurityError'); };
  });
  await page.getByRole('button', { name: '显示偏好', exact: true }).click();
  await page.getByRole('radio', { name: '深色', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme-preference', 'dark');
  for (const colorScheme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme });
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.locator('html')).toHaveAttribute('data-theme-preference', 'dark');
  }
  await assertNoConsoleErrors(consoleErrors);
});

test('OpenAI quota errors explain Platform billing without exposing provider messages', async ({ page, consoleErrors }) => {
  let calls = 0;
  await page.route(`**${path}*`, async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: { ok: true, data: { status: 'empty', analysis: null }, requestId: 'fake-openai-error' } });
    } else {
      calls++;
      expect(route.request().postDataJSON()).toMatchObject({ regenerate: false });
      await route.fulfill({ status: 429, json: { ok: false, error: { code: 'AI_PROVIDER_QUOTA', message: 'provider-secret-do-not-render' }, requestId: 'fake-openai-error' } });
    }
  });
  await login(page);
  await page.goto('/messages/e2e-inbox-message?folder=inbox', { waitUntil: 'domcontentloaded' });
  const panel = page.getByRole('region', { name: title });
  await confirmAnalysis(page, panel.getByRole('button', { name: '同意并生成分析', exact: true }), '同意并生成分析');
  await expect(panel.getByRole('alert')).toContainText('AI_PROVIDER_QUOTA');
  await expect(panel.getByRole('alert')).toContainText('OpenAI Platform');
  await expect(panel).not.toContainText('provider-secret-do-not-render');
  expect(calls).toBe(1);
  await confirmAnalysis(page, panel.getByRole('button', { name: '同意并生成分析', exact: true }), '同意并生成分析');
  await expect(panel.getByRole('alert')).toContainText('AI_PROVIDER_QUOTA');
  expect(calls).toBe(2);
  await assertNoConsoleErrors(consoleErrors.filter((text) => !/Failed to load resource.*429/u.test(text)));
});

for (const preference of ['auto', 'ja']) {
  test(`AI accessible language switch reads cache and ignores a late response (${preference})`, async ({ page, consoleErrors }) => {
    let posts = 0;
    let initialRead = false;
    let lateFinished = false;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => release = resolve);
    const payload = (summary: string, language: string) => ({ ok: true, data: {
      status: 'ready', language, analysis: { summary, keyPoints: [], actionItems: [], dates: [], language, suggestion: null }
    }, requestId: 'fake-language' });
    await page.route(`**${path}*`, async (route) => {
      if (route.request().method() === 'POST') posts++;
      const language = new URL(route.request().url()).searchParams.get('language');
      if (language === 'zh-CN') {
        initialRead = true;
        await gate;
        await route.fulfill({ json: payload('过期的旧语言响应', preference === 'auto' ? 'zh-CN' : preference) }).catch(() => {});
        lateFinished = true;
        return;
      }
      expect(language).toBe('en');
      await route.fulfill({ json: payload(preference === 'auto' ? 'Current workspace summary' : '日本語のキャッシュ', preference === 'auto' ? 'zh-CN' : preference) });
    });
    await login(page); await page.goto('/messages/e2e-inbox-message?folder=inbox', { waitUntil: 'domcontentloaded' });
    await expect.poll(() => initialRead).toBe(true);
    await page.getByRole('combobox', { name: '切换语言', exact: true }).selectOption('en');
    const panel = page.getByRole('region', { name: 'AI summary and category suggestion' });
    await expect(panel.getByText(preference === 'auto' ? 'Current workspace summary' : '日本語のキャッシュ')).toBeVisible();
    release?.();
    await expect.poll(() => lateFinished).toBe(true);
    await expect(panel).not.toContainText('过期的旧语言响应');
    expect(posts).toBe(0);
    await assertNoHorizontalOverflow(page); await assertNoConsoleErrors(consoleErrors);
  });
}

test('AI accessible generation and completed result survive same-message flag updates', async ({ page, consoleErrors }) => {
  let reads = 0;
  let posts = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => release = resolve);
  await page.route(`**${path}*`, async (route) => {
    if (route.request().method() === 'GET') {
      reads++;
      await route.fulfill({ json: { ok: true, data: { status: 'empty', analysis: null }, requestId: 'fake-ai-flags' } }); return;
    }
    posts++;
    await gate;
    await route.fulfill({ json: { ok: true, data: { status: 'ready', analysis: {
      summary: '标记变化后保留分析', keyPoints: [], actionItems: [], dates: [], language: 'zh-CN', suggestion: null
    } }, requestId: 'fake-ai-flags' } }).catch(() => {});
  });
  await login(page);
  await page.locator('.mail-list-panel').getByRole('listitem').filter({ hasText: 'E2E Inbox Welcome' }).getByRole('button', { name: /E2E Inbox Welcome/u }).first().click();
  const panel = page.getByRole('region', { name: title });
  await confirmAnalysis(page, panel.getByRole('button', { name: '同意并生成分析', exact: true }), '同意并生成分析');
  await expect.poll(() => posts).toBe(1);
  const star = page.getByRole('region', { name: '邮件详情', exact: true }).getByRole('button', { name: /^(?:加星|取消星标)$/u });
  const initialStarred = await star.getAttribute('aria-pressed') === 'true';
  const toggleStar = async (starred: boolean) => {
    const updated = page.waitForResponse((response) => response.request().method() === 'PATCH' && new URL(response.url()).pathname === '/api/workspace/messages/e2e-inbox-message/flags');
    await star.click(); await updated;
    await expect(star).toHaveAttribute('aria-pressed', String(starred));
    await expect(star).toBeEnabled();
  };
  try {
    await toggleStar(!initialStarred);
    await expect(panel.getByRole('status')).toContainText('正在读取或生成');
    release?.();
    await expect(panel.getByText('标记变化后保留分析')).toBeVisible();
    await toggleStar(initialStarred);
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    await expect(panel.getByText('标记变化后保留分析')).toBeVisible();
    expect(reads).toBe(1); expect(posts).toBe(1);
  } finally { release?.(); }
  await assertNoConsoleErrors(consoleErrors);
});

test('cached summary opens automatically, shows its date and survives failed regeneration and reload', async ({ page, consoleErrors }, info) => {
  let reads = 0; let posts = 0;
  await page.route(`**${path}*`, async (route) => {
    if (route.request().method() === 'POST') {
      posts++;
      await route.fulfill({ status: 503, json: { ok: false, error: { code: 'AI_PROVIDER_UNAVAILABLE', message: 'Synthetic failure' } } }); return;
    }
    reads++;
    await route.fulfill({ json: { ok: true, data: { status: 'ready', updatedAt: Date.UTC(2026, 10, 15, 12), language: 'zh-CN', analysis: {
      summary: 'Telegram 与网页共用的缓存摘要', keyPoints: [], actionItems: [], dates: [], language: 'zh-CN', suggestion: null
    } } } });
  });
  await login(page); await page.goto('/messages/e2e-inbox-message?folder=inbox');
  const panel = page.getByRole('region', { name: title });
  await expect(panel.getByText('Telegram 与网页共用的缓存摘要', { exact: true })).toBeVisible();
  const details = panel.getByRole('button', { name: '关于 AI 分析' });
  const tooltip = panel.getByRole('tooltip');
  await expect(tooltip).toBeHidden();
  if (!info.project.use.isMobile) {
    await details.hover();
    await expect(tooltip).toBeVisible();
    const button = (await details.boundingBox())!;
    const hint = (await tooltip.boundingBox())!;
    const x = button.x + button.width / 2;
    await page.mouse.move(x, button.y + button.height + 4, { steps: 8 });
    await expect(tooltip).toBeVisible();
    await page.mouse.move(x, hint.y + hint.height / 2, { steps: 8 });
    await expect(tooltip).toBeVisible();
    const summaryTab = panel.getByRole('tab', { name: '摘要', exact: true });
    await details.focus();
    await summaryTab.focus();
    await expect(tooltip).toBeVisible();
    await details.focus();
    await page.mouse.move(0, 0);
    await expect(tooltip).toBeVisible();
    await summaryTab.focus();
    await expect(tooltip).toBeHidden();
    await details.hover();
    await expect(tooltip).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(tooltip).toBeHidden();
  }
  await details.click();
  await expect(tooltip).toContainText(/生成时间.*2026.*AI 结果可能有误/u);
  await details.press('Escape');
  await expect(tooltip).toBeHidden();
  await details.press('Enter');
  await expect(tooltip).toBeVisible();
  await details.press('Escape');
  await expect(tooltip).toBeHidden();
  expect(reads).toBeGreaterThan(0); expect(posts).toBe(0);
  await confirmAnalysis(page, panel.getByRole('button', { name: '同意重新生成', exact: true }), '同意重新生成');
  await expect(panel.getByRole('alert')).toContainText('AI_PROVIDER_UNAVAILABLE');
  await expect(panel.getByText('Telegram 与网页共用的缓存摘要', { exact: true })).toBeVisible();
  await page.reload();
  await expect(panel.getByText('Telegram 与网页共用的缓存摘要', { exact: true })).toBeVisible(); expect(posts).toBe(1);
  await assertNoHorizontalOverflow(page);
  expect((await new AxeBuilder({ page }).include('.message-content').analyze()).violations).toEqual([]);
  await mkdir('/tmp/flaremail-ai-evidence', { recursive: true });
  await page.screenshot({ path: `/tmp/flaremail-ai-evidence/${info.project.name}-automatic-cache.png` });
  await assertNoConsoleErrors(consoleErrors.filter((text) => !/Failed to load resource.*503/u.test(text)));
});

test('six purpose categories support keyboard navigation and retired deep links', async ({ page, consoleErrors }, info) => {
  await login(page);
  const tabs = page.getByRole('tablist', { name: '收件箱分类', exact: true });
  await expect(tabs.getByRole('tab')).toHaveCount(7);
  for (const name of ['主要往来', '交易账务', '账号安全', '服务通知', '订阅资讯', '营销推广']) {
    await expect(tabs.getByRole('tab', { name, exact: true })).toHaveCount(1);
  }
  const all = tabs.getByRole('tab', { name: '全部', exact: true });
  await all.focus(); await all.press('End');
  await expect(tabs.getByRole('tab', { name: '营销推广', exact: true })).toBeFocused();
  await expect(tabs.getByRole('tab', { name: '营销推广', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.goto('/?folder=inbox&category=social');
  const selected = tabs.getByRole('tab', { name: '服务通知', exact: true });
  await expect(selected).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => selected.evaluate((element) => {
    const tab = element.getBoundingClientRect(); const strip = element.parentElement!.getBoundingClientRect();
    return tab.left >= strip.left - 1 && tab.right <= strip.right + 1;
  })).toBe(true);
  await assertNoHorizontalOverflow(page); await assertNoConsoleErrors(consoleErrors);
  await mkdir('/tmp/flaremail-ai-evidence', { recursive: true });
  await page.screenshot({ path: `/tmp/flaremail-ai-evidence/${info.project.name}-categories.png` });
});
