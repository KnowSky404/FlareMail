import { assertNoConsoleErrors, assertNoHorizontalOverflow, expect, login, openFolder, test } from './fixtures';
import AxeBuilder from '@axe-core/playwright';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page, Route } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

const webhookSecretBytes = new TextEncoder().encode('FlareMail E2E webhook secret 2026');

test('shows icon guidance on pointer and keyboard focus', async ({ page, consoleErrors }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Desktop toolbar exposes the icon-first refresh control.');
  await login(page);
  const refresh = page.getByRole('button', { name: '刷新邮件列表' });
  await expect(refresh).toHaveAttribute('aria-label', '刷新邮件列表');
  const tooltipIds = await page.locator('[role="tooltip"]').evaluateAll((elements) => elements.map((element) => element.id));
  expect(new Set(tooltipIds).size).toBe(tooltipIds.length);
  await refresh.hover();
  const guidance = page.getByRole('tooltip', { name: '刷新邮件列表' });
  await expect(guidance).toBeVisible();
  await expect(refresh).toHaveAttribute('aria-describedby', await guidance.getAttribute('id') ?? '');
  const topbarBottom = await page.locator('.topbar').evaluate((element) => element.getBoundingClientRect().bottom);
  const guidanceBounds = await guidance.boundingBox();
  expect(guidanceBounds?.y).toBeGreaterThanOrEqual(topbarBottom);
  expect(guidanceBounds!.width).toBeGreaterThan(guidanceBounds!.height);
  await page.screenshot({ path: join(tmpdir(), 'flaremail-icon-tooltip-desktop.png'), fullPage: false });
  await page.mouse.move(1, 1);
  await expect(guidance).toBeHidden();
  await refresh.focus();
  await expect(guidance).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(guidance).toBeHidden();
  await expect(refresh).toBeFocused();
  const serviceStatus = page.locator('summary[aria-label="查看工作区服务状态"]');
  await serviceStatus.hover();
  const statusGuidance = page.getByRole('tooltip', { name: /全局状态/u });
  await expect(statusGuidance).toBeVisible();
  await expect(serviceStatus).toHaveAttribute('aria-describedby', await statusGuidance.getAttribute('id') ?? '');
  const statusGuidanceBounds = await statusGuidance.boundingBox();
  expect(statusGuidanceBounds!.x).toBeGreaterThanOrEqual(0);
  expect(statusGuidanceBounds!.x + statusGuidanceBounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.screenshot({ path: join(tmpdir(), 'flaremail-topbar-tooltip-desktop.png'), fullPage: false });
  await page.setViewportSize({ width: 1505, height: 1045 });
  await serviceStatus.hover();
  await expect(statusGuidance).toBeVisible();
  await page.screenshot({ path: join(tmpdir(), 'flaremail-topbar-tooltip-concept-size.png'), fullPage: false });
  await page.setViewportSize({ width: 1280, height: 900 });
  await serviceStatus.click();
  await expect(statusGuidance).toBeHidden();
  await expect(page.locator('#service-status-content')).toBeVisible();
  await page.keyboard.press('Escape');
  const preferences = page.getByRole('button', { name: '显示偏好' });
  await preferences.focus();
  const preferenceGuidance = page.getByRole('tooltip', { name: '显示偏好' });
  await expect(preferenceGuidance).toBeVisible();
  await preferences.click();
  await expect(preferenceGuidance).toBeHidden();
  await expect(page.getByRole('dialog', { name: '显示偏好' })).toBeVisible();
  await page.keyboard.press('Escape');
  const account = page.getByRole('button', { name: '账号菜单' });
  await account.hover();
  const accountGuidance = page.getByRole('tooltip', { name: '账号菜单' });
  await expect(accountGuidance).toBeVisible();
  await account.click();
  await expect(accountGuidance).toBeHidden();
  await expect(page.getByRole('menu')).toBeVisible();
  await page.keyboard.press('Escape');
  const star = page.getByRole('listitem').filter({ hasText: 'E2E Inbox Welcome' }).getByRole('button', { name: '加星' });
  await star.hover();
  await expect(page.getByRole('tooltip', { name: '加星' })).toBeVisible();
  const search = page.getByLabel('搜索邮件');
  const searched = page.waitForResponse((response) => response.url().includes('/api/workspace/mailbox?')
    && new URL(response.url()).searchParams.get('q') === 'E2E');
  await search.fill('E2E');
  await searched;
  const clear = page.getByRole('button', { name: '清除搜索' });
  const searchBounds = await search.boundingBox();
  const clearBounds = await clear.boundingBox();
  expect(clearBounds!.x).toBeGreaterThan(searchBounds!.x + searchBounds!.width / 2);
  expect(clearBounds!.x + clearBounds!.width).toBeLessThanOrEqual(searchBounds!.x + searchBounds!.width);
  const cleared = page.waitForResponse((response) => response.url().includes('/api/workspace/mailbox?')
    && !new URL(response.url()).searchParams.has('q'));
  await clear.click();
  await cleared;
  await expect(search).toHaveValue('');
  await expect(search).toBeFocused();
  await expect(page.locator('.mail-list-panel [aria-busy="true"]')).toHaveCount(0);
  await page.screenshot({ path: join(tmpdir(), 'flaremail-search-clear-desktop.png'), fullPage: false });
  await search.fill('E2E Inbox');
  await expect(page.getByRole('listitem').filter({ hasText: 'E2E Inbox Welcome' })).toBeVisible();
  const keyboardClear = page.getByRole('button', { name: '清除搜索' });
  await keyboardClear.focus();
  await keyboardClear.press('Enter');
  await expect(search).toBeFocused();
  await assertNoConsoleErrors(consoleErrors);
});

test('keeps the mobile search clear icon inside its field', async ({ page, consoleErrors }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'Mobile search uses the folder header field.');
  await login(page);
  const search = page.getByLabel('搜索邮件');
  const searched = page.waitForResponse((response) => response.url().includes('/api/workspace/mailbox?')
    && new URL(response.url()).searchParams.get('q') === 'E2E');
  await search.fill('E2E');
  await searched;
  await expect(search).toBeFocused();
  const clear = page.getByRole('button', { name: '清除搜索' });
  const searchBounds = await search.boundingBox();
  const clearBounds = await clear.boundingBox();
  expect(clearBounds!.x).toBeGreaterThan(searchBounds!.x + searchBounds!.width / 2);
  expect(clearBounds!.x + clearBounds!.width).toBeLessThanOrEqual(searchBounds!.x + searchBounds!.width);
  const cleared = page.waitForResponse((response) => response.url().includes('/api/workspace/mailbox?')
    && !new URL(response.url()).searchParams.has('q'));
  await clear.click();
  await cleared;
  await expect(search).toHaveValue('');
  await expect(search).toBeFocused();
  await expect(page.locator('.mail-list-panel [aria-busy="true"]')).toHaveCount(0);
  await page.screenshot({ path: join(tmpdir(), 'flaremail-search-clear-mobile.png'), fullPage: false });
  await search.fill('E2E Inbox');
  await expect(page.getByRole('listitem').filter({ hasText: 'E2E Inbox Welcome' })).toBeVisible();
  await page.getByRole('button', { name: '清除搜索' }).click();
  await page.getByRole('listitem').filter({ hasText: 'E2E Inbox Welcome' }).getByRole('button', { name: /E2E Inbox Welcome/u }).click();
  const back = page.getByRole('button', { name: '返回邮件列表' });
  await back.focus();
  const guidance = page.getByRole('tooltip', { name: '返回邮件列表' });
  await expect(guidance).toBeVisible();
  const guidanceBounds = await guidance.boundingBox();
  expect(guidanceBounds!.x).toBeGreaterThanOrEqual(0);
  expect(guidanceBounds!.x + guidanceBounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.screenshot({ path: join(tmpdir(), 'flaremail-icon-tooltip-mobile.png'), fullPage: false });
  const moreActions = page.getByRole('button', { name: '更多邮件操作' });
  await moreActions.focus();
  const moreGuidance = page.getByRole('tooltip', { name: '更多邮件操作' });
  await expect(moreGuidance).toBeVisible();
  const moreBounds = await moreGuidance.boundingBox();
  expect(moreBounds!.x).toBeGreaterThanOrEqual(0);
  expect(moreBounds!.x + moreBounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.screenshot({ path: join(tmpdir(), 'flaremail-message-menu-tooltip-mobile.png'), fullPage: false });
  await moreActions.click();
  await expect(moreGuidance).toBeHidden();
  await expect(page.getByRole('menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toBeHidden();
  await assertNoHorizontalOverflow(page);
  await assertNoConsoleErrors(consoleErrors);
});

test('lets users change the mail filter while search results load', async ({ page, consoleErrors }, testInfo) => {
  test.skip(testInfo.project.name === 'narrow', 'Desktop and 390 px mobile cover the filter control.');
  await login(page);
  let releaseSearch: () => void = () => {};
  const searchGate = new Promise<void>((resolve) => { releaseSearch = resolve; });
  await page.route('**/api/workspace/mailbox?**', async (route) => {
    const params = new URL(route.request().url()).searchParams;
    if (params.get('q') === 'E2E') await searchGate;
    // Switching the filter or identity cancels older requests, so intercepted routes may be gone.
    await route.continue().catch(() => {});
  });

  const search = page.getByLabel('搜索邮件');
  await search.fill('E2E');
  await expect(page.getByLabel('正在加载邮件')).toBeVisible();
  const loadingViolations = (await new AxeBuilder({ page }).include('.mail-list-panel').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()).violations;
  expect(loadingViolations.flatMap(({ id, nodes }) => nodes.map(({ target }) => `${id}: ${target.join(', ')}`))).toEqual([]);
  const starred = page.getByRole('button', { name: '已加星标', exact: true });
  const identity = page.getByLabel('按邮件身份筛选');
  try {
    expect(await starred.isEnabled()).toBe(true);
    await starred.click();
    await expect(starred).toHaveAttribute('aria-pressed', 'true');
    await expect(page).toHaveURL(/filter=starred/u);
    expect(await identity.isEnabled()).toBe(true);
    await identity.selectOption('domain:00000000-0000-4000-8000-000000000011');
    await expect(identity).toHaveValue('domain:00000000-0000-4000-8000-000000000011');
  } finally {
    releaseSearch();
  }
  await expect(search).toHaveValue('E2E');
  await expect(page.getByLabel('正在加载邮件')).toHaveCount(0);
  await expect(starred).toHaveAttribute('aria-pressed', 'true');
  expect(new URL(page.url()).searchParams.get('identity')).toBe('domain:00000000-0000-4000-8000-000000000011');
  await page.screenshot({ path: join(tmpdir(), `flaremail-filter-during-refresh-${testInfo.project.name}.png`), fullPage: false });
  await assertNoConsoleErrors(consoleErrors);
});

test('keeps loaded mail and scroll position while appending the next page', async ({ page, consoleErrors }, testInfo) => {
  test.skip(testInfo.project.name === 'narrow', 'Desktop and 390 px mobile cover incremental pagination.');
  await login(page);
  let releaseNextPage: () => void = () => {};
  const nextPageGate = new Promise<void>((resolve) => { releaseNextPage = resolve; });
  await page.route('**/api/workspace/mailbox?**', async (route) => {
    if (new URL(route.request().url()).searchParams.has('cursor')) await nextPageGate;
    await route.continue().catch(() => {});
  });

  const scrollRegion = page.locator('.fm-list-scroll');
  const rows = scrollRegion.getByRole('listitem');
  const loadMore = scrollRegion.getByRole('button', { name: '加载更多' });
  const initialCount = await rows.count();
  expect(initialCount).toBeGreaterThan(0);
  await loadMore.scrollIntoViewIfNeeded();
  const initialScrollTop = await scrollRegion.evaluate((element) => element.scrollTop);
  expect(initialScrollTop).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await expect(page.getByRole('heading', { name: '收件箱', exact: true })).toBeInViewport();
  try {
    await loadMore.click();
    await expect(rows).toHaveCount(initialCount);
    await expect(loadMore).toHaveAttribute('aria-busy', 'true');
    expect(await scrollRegion.evaluate((element) => element.scrollTop)).toBeGreaterThanOrEqual(initialScrollTop - 2);
    await page.screenshot({ path: join(tmpdir(), `flaremail-load-more-pending-${testInfo.project.name}.png`), fullPage: false });
  } finally {
    releaseNextPage();
  }
  await expect.poll(() => rows.count()).toBeGreaterThan(initialCount);
  await expect(loadMore).toHaveCount(0);
  await assertNoHorizontalOverflow(page);
  await assertNoConsoleErrors(consoleErrors);
});

test('shows one illustration in the empty mail detail pane', async ({ page, consoleErrors }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'The desktop workspace keeps the detail pane beside the list.');
  await login(page);
  await page.setViewportSize({ width: 1505, height: 1045 });
  await page.getByLabel('搜索邮件').fill('zzzznomatchzzzz');
  await expect(page.getByRole('heading', { name: '没有匹配的邮件' })).toBeVisible();
  const detail = page.getByRole('region', { name: '邮件详情' });
  const emptyContent = detail.getByRole('heading', { name: '选择一封邮件开始阅读' }).locator('..');
  await expect(emptyContent.locator('svg')).toHaveCount(1);
  await assertNoHorizontalOverflow(page);
  await page.screenshot({ path: join(tmpdir(), 'flaremail-empty-detail-single-icon-desktop.png'), fullPage: false });
  await assertNoConsoleErrors(consoleErrors);
});

test('creates, applies, navigates, renames and deletes a persistent label', async ({ page, consoleErrors }, testInfo) => {
  await login(page);
  const mobile = page.viewportSize()!.width < 901;
  if (mobile) await page.getByRole('button', { name: '打开导航' }).click();
  await page.getByRole('button', { name: '新建标签' }).click();
  await page.getByRole('dialog', { name: '新建标签' }).getByLabel('标签名称').fill('E2E Follow Up');
  await page.getByRole('dialog', { name: '新建标签' }).getByRole('button', { name: '保存' }).click();
  await expect(page.getByRole('dialog', { name: '新建标签' })).toBeHidden();

  const inboxItem = page.getByRole('listitem').filter({ hasText: 'E2E Inbox Welcome' });
  await expect(inboxItem).toBeVisible();
  await inboxItem.getByRole('button', { name: /E2E Inbox Welcome/u }).click();
  await page.getByRole('button', { name: '管理标签' }).click();
  const manager = page.getByRole('dialog', { name: '管理标签' });
  await manager.getByRole('checkbox', { name: 'E2E Follow Up' }).check();
  await expect(manager.getByRole('checkbox', { name: 'E2E Follow Up' })).toBeChecked();
  await manager.getByRole('button', { name: '关闭' }).click();

  if (mobile) {
    await page.getByRole('button', { name: '返回邮件列表' }).click();
  }
  await expect(inboxItem.getByText('E2E Follow Up', { exact: true })).toBeVisible();
  await expect(inboxItem.getByRole('button', { name: /E2E Inbox Welcome/u })).toHaveAttribute('aria-label', /标签: E2E Follow Up/u);
  await page.screenshot({ path: join(tmpdir(), `flaremail-label-chip-${testInfo.project.name}.png`), fullPage: false });
  const search = page.getByLabel('搜索邮件');
  await search.fill('label:"E2E Follow Up"');
  await expect(inboxItem).toBeVisible();
  await expect(page.getByRole('listitem').filter({ hasText: 'E2E HTML Safety' })).toHaveCount(0);
  await expect(page.getByText('1 个结果', { exact: true })).toBeVisible();
  await page.reload();
  await expect(search).toHaveValue('label:"E2E Follow Up"');
  await expect(inboxItem).toBeVisible();
  await assertNoHorizontalOverflow(page);
  await page.screenshot({ path: join(tmpdir(), `flaremail-label-search-${testInfo.project.name}.png`), fullPage: false });
  await page.getByRole('button', { name: '清除搜索' }).click();
  if (mobile) {
    await page.getByRole('button', { name: '打开导航' }).click();
  }
  await page.getByRole('button', { name: 'E2E Follow Up', exact: true }).click();
  await expect(page).toHaveURL(/folder=label/u);
  await expect(page.getByRole('heading', { name: 'E2E Follow Up' })).toBeVisible();
  await expect(page.getByRole('listitem').filter({ hasText: 'E2E Inbox Welcome' })).toBeVisible();
  await expect(page.getByRole('listitem').filter({ hasText: 'E2E Inbox Welcome' }).getByText('E2E Follow Up', { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'E2E Follow Up' })).toBeVisible();
  await expect(page.getByRole('listitem').filter({ hasText: 'E2E Inbox Welcome' })).toBeVisible();

  await page.getByRole('button', { name: '重命名标签' }).click();
  await page.getByRole('dialog', { name: '重命名标签' }).getByLabel('标签名称').fill('E2E Resolved');
  await page.getByRole('dialog', { name: '重命名标签' }).getByRole('button', { name: '保存' }).click();
  await expect(page.getByRole('heading', { name: 'E2E Resolved' })).toBeVisible();
  await page.getByRole('button', { name: '删除标签' }).click();
  await page.getByRole('dialog', { name: '删除标签' }).getByRole('button', { name: '删除标签' }).click();
  await expect(page).toHaveURL(/folder=inbox/u);
  await assertNoHorizontalOverflow(page);
  await assertNoConsoleErrors(consoleErrors);
});

test('creates a label from a message and applies it in the same flow', async ({ page, consoleErrors }) => {
  await login(page);
  const subject = 'E2E Inbox Welcome';
  await page.getByRole('listitem').filter({ hasText: subject }).getByRole('button', { name: /E2E Inbox Welcome/u }).click();
  await page.getByRole('button', { name: '管理标签' }).click();
  const manager = page.getByRole('dialog', { name: '管理标签' });
  await manager.getByRole('button', { name: '新建标签' }).click();
  await expect(manager).toBeHidden();
  const editor = page.getByRole('dialog', { name: '新建标签' });
  await editor.getByLabel('标签名称').fill('E2E One Step');
  await editor.getByRole('button', { name: '保存' }).click();
  await expect(editor).toBeHidden();
  await expect(page.getByRole('region', { name: '邮件详情' }).getByText('E2E One Step')).toBeVisible();
  if (page.viewportSize()!.width < 901) {
    await page.getByRole('button', { name: '返回邮件列表' }).click();
    await page.getByRole('button', { name: '打开导航' }).click();
  }
  await page.getByRole('button', { name: 'E2E One Step', exact: true }).click();
  await expect(page.getByRole('listitem').filter({ hasText: subject })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('listitem').filter({ hasText: subject })).toBeVisible();
  await assertNoHorizontalOverflow(page);
  await assertNoConsoleErrors(consoleErrors);
});

test('mutates selected inbox and sent mail in a label view without touching selected drafts', async ({ page, consoleErrors }, testInfo) => {
  await login(page);
  const created = await page.evaluate(async (project) => {
    const response = await fetch('/api/workspace/labels', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: `E2E Mixed Actions ${project}` })
    });
    return { ok: response.ok, payload: await response.json() };
  }, testInfo.project.name);
  expect(created.ok, JSON.stringify(created.payload)).toBe(true);
  const labelId = (created.payload as { data: { label: { id: string } } }).data.label.id;
  for (const target of [
    { kind: 'workspace', id: 'e2e-inbox-message' },
    { kind: 'workspace', id: 'e2e-sent-message' },
    { kind: 'draft', id: 'e2e-draft-1' }
  ]) {
    const applied = await page.evaluate(async ({ id, message }) => {
      const response = await fetch(`/api/workspace/labels/${id}/messages`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(message)
      });
      return { ok: response.ok, payload: await response.json() };
    }, { id: labelId, message: target });
    expect(applied.ok, JSON.stringify(applied.payload)).toBe(true);
  }

  await page.goto(`/?folder=label&label=${encodeURIComponent(labelId)}`);
  const toolbar = page.getByRole('group', { name: '批量邮件操作' });
  const inbox = page.getByRole('listitem').filter({ hasText: 'E2E Inbox Welcome' });
  const sent = page.getByRole('listitem').filter({ hasText: 'E2E Seeded Sent' });
  const draft = page.getByRole('listitem').filter({ hasText: 'E2E Existing Concurrent' });
  await expect(inbox).toBeVisible();
  await expect(sent).toBeVisible();
  await expect(draft).toBeVisible();
  await toolbar.getByRole('checkbox', { name: '选择已加载邮件' }).check();
  await expect(page.getByRole('status').filter({ hasText: '所选邮件包含草稿' })).toBeVisible();
  await expect(toolbar.getByRole('button', { name: '标为已读' })).toHaveCount(0);
  await expect(toolbar.getByRole('button', { name: '移入垃圾箱' })).toHaveCount(0);
  await page.screenshot({ path: join(tmpdir(), `flaremail-mixed-bulk-draft-${testInfo.project.name}.png`), fullPage: false });
  await toolbar.getByRole('checkbox', { name: '取消选择' }).uncheck();
  await inbox.getByRole('checkbox').check();
  await sent.getByRole('checkbox').check();
  await expect(page.getByRole('status').filter({ hasText: '所选邮件包含草稿' })).toHaveCount(0);
  await expect(toolbar.getByRole('button', { name: '标为已读' })).toBeVisible();
  await expect(toolbar.getByRole('button', { name: '移入垃圾箱' })).toBeVisible();
  await toolbar.getByRole('button', { name: '更多邮件操作' }).click();
  await page.getByRole('menuitem', { name: '标为未读' }).click();
  await expect(inbox.getByRole('button', { name: /E2E Inbox Welcome/u })).toHaveAttribute('aria-label', /未读/u);
  await expect(sent.getByRole('button', { name: /E2E Seeded Sent/u })).toHaveAttribute('aria-label', /未读/u);
  await inbox.getByRole('checkbox').check();
  await sent.getByRole('checkbox').check();
  await toolbar.getByRole('button', { name: '标为已读' }).click();
  await expect(page.locator('.toast-region .toast')).toHaveCount(1);
  await expect(inbox.getByRole('button', { name: /E2E Inbox Welcome/u })).not.toHaveAttribute('aria-label', /未读/u);
  await expect(sent.getByRole('button', { name: /E2E Seeded Sent/u })).not.toHaveAttribute('aria-label', /未读/u);
  await inbox.getByRole('checkbox').check();
  await sent.getByRole('checkbox').check();
  await page.screenshot({ path: join(tmpdir(), `flaremail-mixed-bulk-selected-${testInfo.project.name}.png`), fullPage: false });
  await toolbar.getByRole('button', { name: '移入垃圾箱' }).click();
  await expect(inbox).toHaveCount(0);
  await expect(sent).toHaveCount(0);
  await expect(draft).toBeVisible();
  await page.reload();
  await expect(draft).toBeVisible();
  await assertNoHorizontalOverflow(page);
  await assertNoConsoleErrors(consoleErrors);

  // Later serial cases reuse these seeded messages, so restore only the two
  // fixtures this case deliberately moved to trash after verifying that state.
  for (const [id, originalFolder] of [
    ['e2e-inbox-message', 'inbox'], ['e2e-sent-message', 'sent']
  ] as const) {
    const restored = await page.evaluate(async (messageId) => {
      const response = await fetch(`/api/workspace/trash/${encodeURIComponent(messageId)}`, { method: 'POST' });
      return { ok: response.ok, payload: await response.json() };
    }, id);
    expect(restored.ok, JSON.stringify(restored.payload)).toBe(true);
    expect(restored.payload).toMatchObject({ data: { restoredId: id, originalFolder } });
  }
});

test('shows one persistent label across inbox, inbound, sent and drafts', async ({ page, consoleErrors }, testInfo) => {
  await login(page);
  const created = await page.evaluate(async () => {
    const response = await fetch('/api/workspace/labels', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'E2E Across Folders' })
    });
    return { ok: response.ok, payload: await response.json() };
  });
  expect(created.ok, JSON.stringify(created.payload)).toBe(true);
  const labelId = (created.payload as { data: { label: { id: string } } }).data.label.id;
  const secondary = await page.evaluate(async () => {
    const response = await fetch('/api/workspace/labels', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'E2E Bulk Review' })
    });
    return { ok: response.ok, payload: await response.json() };
  });
  expect(secondary.ok, JSON.stringify(secondary.payload)).toBe(true);
  const secondaryLabelId = (secondary.payload as { data: { label: { id: string } } }).data.label.id;
  for (const target of [
    { kind: 'workspace', id: 'e2e-inbox-message' },
    { kind: 'inbound', id: 'e2e-html-inbox-message' },
    { kind: 'workspace', id: 'e2e-sent-message' },
    { kind: 'draft', id: 'e2e-draft-1' }
  ]) {
    const applied = await page.evaluate(async ({ id, message }) => {
      const response = await fetch(`/api/workspace/labels/${id}/messages`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(message)
      });
      return { ok: response.ok, payload: await response.json() };
    }, { id: labelId, message: target });
    expect(applied.ok, JSON.stringify(applied.payload)).toBe(true);
  }

  await page.goto(`/?folder=label&label=${encodeURIComponent(labelId)}`);
  await expect(page.getByRole('heading', { name: 'E2E Across Folders' })).toBeVisible();
  for (const subject of ['E2E Inbox Welcome', 'E2E HTML Safety', 'E2E Seeded Sent', 'E2E Existing Concurrent']) {
    await expect(page.getByRole('listitem').filter({ hasText: subject })).toBeVisible();
  }
  await page.reload();
  await expect(page.getByRole('heading', { name: 'E2E Across Folders' })).toBeVisible();
  await expect(page.getByRole('listitem').filter({ hasText: 'E2E Existing Concurrent' })).toBeVisible();
  await assertNoHorizontalOverflow(page);
  await page.screenshot({ path: join(tmpdir(), `flaremail-labels-${testInfo.project.name}.png`), fullPage: false });
  const selectPage = page.getByRole('checkbox', { name: '选择已加载邮件' });
  await selectPage.check();
  await expect(page.locator('.bulk-context')).toHaveText('已选 4 封');
  await page.getByRole('checkbox', { name: '取消选择' }).uncheck();
  for (const subject of ['E2E Inbox Welcome', 'E2E HTML Safety', 'E2E Seeded Sent', 'E2E Existing Concurrent']) {
    await page.getByRole('listitem').filter({ hasText: subject }).getByRole('checkbox').check();
  }
  await page.getByRole('button', { name: '批量管理标签' }).click();
  const bulkDialog = page.getByRole('dialog', { name: '批量管理标签' });
  await expect(bulkDialog).toContainText('仅更新当前页已选的 4 封邮件');
  await bulkDialog.getByLabel('标签名称').selectOption(secondaryLabelId);
  expect((await new AxeBuilder({ page }).include('[role="dialog"]').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()).violations).toEqual([]);
  await assertNoHorizontalOverflow(page);
  const dialogBounds = await bulkDialog.boundingBox();
  expect(dialogBounds).not.toBeNull();
  expect(dialogBounds!.x).toBeGreaterThanOrEqual(0);
  expect(dialogBounds!.x + dialogBounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  await page.screenshot({ path: join(tmpdir(), `flaremail-labels-bulk-dialog-${testInfo.project.name}.png`), fullPage: false });
  if (testInfo.project.name === 'mobile') {
    await page.setViewportSize({ width: 320, height: 720 });
    await assertNoHorizontalOverflow(page);
    const narrowBounds = await bulkDialog.boundingBox();
    expect(narrowBounds).not.toBeNull();
    expect(narrowBounds!.x + narrowBounds!.width).toBeLessThanOrEqual(321);
    const narrowRemoveButton = await bulkDialog.getByRole('button', { name: '从已选邮件移除' }).boundingBox();
    expect(narrowRemoveButton).not.toBeNull();
    expect(narrowRemoveButton!.height).toBeLessThanOrEqual(48);
    await page.screenshot({ path: join(tmpdir(), 'flaremail-labels-bulk-dialog-narrow.png'), fullPage: false });
    await page.setViewportSize({ width: 390, height: 844 });
  }
  await page.keyboard.press('Escape');
  await expect(bulkDialog).toBeHidden();
  await expect(page.getByRole('button', { name: '批量管理标签' })).toBeFocused();
  await page.getByRole('button', { name: '批量管理标签' }).click();
  await bulkDialog.getByLabel('标签名称').selectOption(secondaryLabelId);
  await bulkDialog.getByRole('button', { name: '添加到已选邮件' }).click();
  await expect(bulkDialog).toBeHidden();
  await page.goto(`/?folder=label&label=${encodeURIComponent(secondaryLabelId)}`);
  await expect(page.getByRole('heading', { name: 'E2E Bulk Review' })).toBeVisible();
  for (const subject of ['E2E Inbox Welcome', 'E2E HTML Safety', 'E2E Seeded Sent', 'E2E Existing Concurrent']) {
    await expect(page.getByRole('listitem').filter({ hasText: subject })).toBeVisible();
  }
  for (const subject of ['E2E Seeded Sent', 'E2E Existing Concurrent']) {
    await page.getByRole('listitem').filter({ hasText: subject }).getByRole('checkbox').check();
  }
  await page.getByRole('button', { name: '批量管理标签' }).click();
  await bulkDialog.getByRole('button', { name: '从已选邮件移除' }).click();
  await expect(bulkDialog).toBeHidden();
  await expect(page.getByRole('listitem').filter({ hasText: 'E2E Seeded Sent' })).toHaveCount(0);
  await expect(page.getByRole('listitem').filter({ hasText: 'E2E Existing Concurrent' })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('listitem').filter({ hasText: 'E2E Inbox Welcome' })).toBeVisible();
  await expect(page.getByRole('listitem').filter({ hasText: 'E2E HTML Safety' })).toBeVisible();
  await expect(page.getByRole('listitem').filter({ hasText: 'E2E Seeded Sent' })).toHaveCount(0);
  await assertNoHorizontalOverflow(page);
  await page.screenshot({ path: join(tmpdir(), `flaremail-labels-bulk-${testInfo.project.name}.png`), fullPage: false });
  await page.goto(`/?folder=label&label=${encodeURIComponent(labelId)}`);
  await expect(page.getByRole('heading', { name: 'E2E Across Folders' })).toBeVisible();
  await page.evaluate(() => localStorage.setItem('flaremail-theme', 'dark'));
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByRole('listitem').filter({ hasText: 'E2E Existing Concurrent' })).toBeVisible();
  await assertNoHorizontalOverflow(page);
  await page.screenshot({ path: join(tmpdir(), `flaremail-labels-${testInfo.project.name}-dark.png`), fullPage: false });
  await page.getByRole('listitem').filter({ hasText: 'E2E Inbox Welcome' }).getByRole('checkbox').check();
  await page.getByRole('button', { name: '批量管理标签' }).click();
  await expect(bulkDialog).toBeVisible();
  expect((await new AxeBuilder({ page }).include('[role="dialog"]').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()).violations).toEqual([]);
  await page.screenshot({ path: join(tmpdir(), `flaremail-labels-bulk-dialog-${testInfo.project.name}-dark.png`), fullPage: false });
  await page.keyboard.press('Escape');
  await expect(bulkDialog).toBeHidden();
  await assertNoConsoleErrors(consoleErrors);
});

test('shows a server-paginated global Starred view across inbox and sent', async ({ page, consoleErrors }) => {
  await login(page);
  for (const id of ['e2e-inbox-message', 'e2e-sent-message']) {
    const response = await page.evaluate(async (messageId) => {
      const result = await fetch(`/api/workspace/messages/${messageId}/flags`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ starred: true })
      });
      return { ok: result.ok, body: await result.text() };
    }, id);
    expect(response.ok, response.body).toBe(true);
  }
  await openFolder(page, '星标邮件');
  await expect(page.getByRole('heading', { name: '星标邮件', exact: true })).toBeVisible();
  const inbox = page.getByRole('listitem').filter({ hasText: 'E2E Inbox Welcome' });
  const sent = page.getByRole('listitem').filter({ hasText: 'E2E Seeded Sent' });
  await expect(inbox).toBeVisible();
  await expect(sent).toBeVisible();
  await inbox.getByRole('checkbox').check();
  await sent.getByRole('checkbox').check();
  await page.getByRole('button', { name: '批量管理标签' }).click();
  const bulkDialog = page.getByRole('dialog', { name: '批量管理标签' });
  await expect(bulkDialog).toContainText('仅更新当前页已选的 2 封邮件');
  if (await bulkDialog.getByText('尚无标签').isVisible()) {
    await expect(bulkDialog.getByRole('button', { name: '新建标签' })).toBeVisible();
  } else {
    await expect(bulkDialog.getByLabel('标签名称')).toBeVisible();
  }
  await bulkDialog.getByRole('button', { name: '取消' }).click();
  const response = await page.request.get('/api/workspace/mailbox?folder=starred&limit=1');
  expect(response.ok()).toBe(true);
  const first = await response.json() as { data: { page: { folder: string; nextCursor: string | null; hasMore: boolean } } };
  expect(first.data.page).toMatchObject({ folder: 'starred', hasMore: true });
  expect(first.data.page.nextCursor).toBeTruthy();
  await sent.getByRole('button', { name: '取消星标' }).click();
  await expect(sent).toBeHidden();
  await page.reload();
  await expect(inbox).toBeVisible();
  await expect(sent).toBeHidden();
  await assertNoHorizontalOverflow(page);
  await assertNoConsoleErrors(consoleErrors);
  const cleanup = await page.evaluate(async () => {
    const response = await fetch('/api/workspace/messages/e2e-inbox-message/flags', {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ starred: false })
    });
    return response.ok;
  });
  expect(cleanup).toBe(true);
});

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

type MockTelegramState = {
  binding: 'none' | 'candidate' | 'active';
  enabled: boolean;
  privacyMode: boolean;
  summaryEnabled: boolean;
};

function mockTelegramStatus(state: MockTelegramState) {
  return {
    globalEnabled: true,
    configReady: true,
    schemaReady: true,
    botUsername: 'flaremail_test_bot',
    timezone: 'UTC',
    userBound: state.binding !== 'none',
    userEnabled: state.binding === 'active' && state.enabled,
    binding: state.binding === 'none' ? null : {
      state: state.binding,
      enabled: state.binding === 'active' && state.enabled,
      privacyMode: state.privacyMode,
      summaryEnabled: state.summaryEnabled,
      telegramUsername: 'e2e_alice',
      telegramDisplayName: 'Alice E2E',
      candidateExpiresAt: state.binding === 'candidate' ? '2099-01-01T00:10:00.000Z' : null,
      boundAt: state.binding === 'active' ? '2026-09-09T12:00:00.000Z' : null,
      confirmedAt: state.binding === 'active' ? '2026-09-09T12:00:00.000Z' : null,
      lastSentAt: null,
      lastErrorCode: null,
      lastErrorAt: null
    },
    recentDeliveries: []
  };
}

async function installTelegramApiMock(page: Page) {
  const state: MockTelegramState = { binding: 'none', enabled: false, privacyMode: false, summaryEnabled: false };
  let testFailure = false;
  let settingsRequests = 0;
  let settingsFailures = 0;
  let bindingExpiresAt = '2099-01-01T00:10:00.000Z';
  const response = (route: import('@playwright/test').Route, data: unknown, status = 200) => route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(status >= 400
      ? { ok: false, error: { code: 'TELEGRAM_RATE_LIMITED', message: '模拟 Telegram 限流。', retryable: false }, requestId: 'telegram-e2e-error' }
      : { ok: true, data, requestId: 'telegram-e2e' })
  });

  await page.route('**/api/workspace/notifications/telegram/**', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const method = request.method();
    if (pathname.endsWith('/settings') && method === 'GET') {
      settingsRequests += 1;
      if (settingsFailures > 0) {
        settingsFailures -= 1;
        return response(route, {}, 503);
      }
      return response(route, mockTelegramStatus(state));
    }
    if (pathname.endsWith('/settings') && (method === 'PATCH' || method === 'PUT')) {
      const input = JSON.parse(request.postData() ?? '{}') as Partial<Pick<MockTelegramState, 'enabled' | 'privacyMode' | 'summaryEnabled'>>;
      if (typeof input.enabled === 'boolean') state.enabled = input.enabled;
      if (typeof input.privacyMode === 'boolean') state.privacyMode = input.privacyMode;
      if (typeof input.summaryEnabled === 'boolean') state.summaryEnabled = input.summaryEnabled;
      return response(route, { settings: { enabled: state.enabled, privacyMode: state.privacyMode, summaryEnabled: state.summaryEnabled } });
    }
    if (pathname.endsWith('/bind') && method === 'POST') {
      return response(route, { state: 'pending', expiresAt: bindingExpiresAt, deepLink: 'https://t.me/flaremail_test_bot?start=abcdefghijklmnopqrstuvwxyz012345' });
    }
    if (pathname.endsWith('/confirm') && method === 'POST') {
      state.binding = 'active';
      return response(route, mockTelegramStatus(state));
    }
    if (pathname.endsWith('/test') && method === 'POST') {
      return response(route, { sent: true }, testFailure ? 429 : 200);
    }
    if (pathname.endsWith('/unbind') && method === 'POST') {
      state.binding = 'none';
      state.enabled = false;
      return response(route, mockTelegramStatus(state));
    }
    return route.continue();
  });

  return {
    settingsRequests() { return settingsRequests; },
    failNextSettings() { settingsFailures += 1; },
    expireBindingAt(value: string) { bindingExpiresAt = value; },
    receiveStart() { state.binding = 'candidate'; },
    setTestFailure(value: boolean) {
      testFailure = value;
    }
  };
}

async function openSettings(page: Page) {
  const profileButton = page.getByRole('button', { name: '账号菜单' });
  if (await profileButton.isVisible().catch(() => false)) {
    await profileButton.click();
    await page.getByRole('menuitem', { name: '打开设置', exact: true }).click();
  } else {
    await page.getByRole('button', { name: '打开导航' }).click();
    await page.getByRole('navigation', { name: '移动端导航' }).getByRole('button', { name: '设置', exact: true }).click();
  }
  await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible();
}

test('keeps settings sections reachable and the save action visible while scrolling', async ({ page, consoleErrors }, testInfo) => {
  await login(page);
  await page.goto('/?folder=settings');
  await expect(page).toHaveTitle('FlareMail');
  const sections = page.getByRole('navigation', { name: '设置分区' });
  const name = page.getByLabel('显示姓名');
  await name.fill('  Unsaved section navigation  ');

  await sections.getByRole('link', { name: '通知', exact: true }).click();
  await expect(page).toHaveURL(/#settings-notifications$/u);
  await expect(page.locator('#settings-notifications')).toBeInViewport();
  await expect(sections).toBeInViewport();
  const save = page.getByRole('button', { name: '保存设置' });
  await expect(save).toBeInViewport();
  const navBounds = await sections.boundingBox();
  const notificationBounds = await page.locator('#settings-notifications').boundingBox();
  const appbarBounds = await page.getByRole('banner').first().boundingBox();
  expect(navBounds!.y).toBeLessThanOrEqual(appbarBounds!.y + appbarBounds!.height + 1);
  expect(notificationBounds!.y).toBeGreaterThanOrEqual(navBounds!.y + navBounds!.height - 1);
  if (testInfo.project.name === 'mobile') await expect(page.getByRole('button', { name: '打开导航' })).toBeInViewport();
  const toast = page.locator('.toast-region .toast');
  if (await toast.count()) {
    const toastBounds = await toast.first().boundingBox();
    const saveBounds = await save.boundingBox();
    expect(toastBounds!.y + toastBounds!.height).toBeLessThanOrEqual(saveBounds!.y);
  }
  await assertNoHorizontalOverflow(page);
  if (testInfo.project.name === 'desktop' || testInfo.project.name === 'mobile') {
    await page.screenshot({ path: `/tmp/flaremail-settings-sections-${testInfo.project.name}.png`, fullPage: false });
  }

  await sections.getByRole('link', { name: '诊断', exact: true }).click();
  await expect(page.locator('#settings-diagnostics')).toBeInViewport();
  await sections.getByRole('link', { name: '个人资料', exact: true }).click();
  await expect(name).toHaveValue('  Unsaved section navigation  ');
  await sections.getByRole('link', { name: '外观', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#settings-appearance$/u);
  await page.getByLabel('主题').selectOption('dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect((await new AxeBuilder({ page }).include('main').analyze()).violations).toEqual([]);
  await assertNoHorizontalOverflow(page);
  if (testInfo.project.name === 'desktop' || testInfo.project.name === 'mobile') {
    await page.screenshot({ path: `/tmp/flaremail-settings-appearance-dark-${testInfo.project.name}.png`, fullPage: false });
  }
  if (testInfo.project.name === 'desktop') {
    await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '收件箱', exact: true }).click();
  } else {
    await page.getByRole('button', { name: '打开导航' }).click();
    await page.getByRole('navigation', { name: '移动端导航' }).getByRole('button', { name: /^收件箱(?: \d+)?$/u }).click();
  }
  await expect(page).toHaveURL(/folder=inbox/u);
  expect(new URL(page.url()).hash).toBe('');
  await assertNoConsoleErrors(consoleErrors);
});

test('opens dedicated domain and address management views with a domain-scoped create shortcut', async ({ page, consoleErrors }, testInfo) => {
  test.setTimeout(90_000);
  await login(page);
  await page.goto('/?folder=settings&view=domains');
  await expect(page.getByRole('heading', { name: '域名概览' })).toBeVisible();
  const domainCard = page.locator('.domain-card').filter({ hasText: 'flaremail.test' });
  await expect(domainCard).toBeVisible();
  await expect(domainCard).toContainText('Cloudflare');
  const capabilities = domainCard.locator('.capability-summary');
  await expect(capabilities).toContainText('收信');
  await expect(capabilities).toContainText('发信');
  await expect(capabilities.locator('dd')).toHaveCount(2);
  await expect(capabilities.locator('dd').nth(1)).toHaveText('可用');
  expect((await new AxeBuilder({ page }).include('main').analyze()).violations).toEqual([]);
  await assertNoHorizontalOverflow(page);
  await page.screenshot({ path: `/tmp/flaremail-domains-${testInfo.project.name}.png` });
  if (testInfo.project.name === 'desktop') {
    for (const width of [1920, 1440, 1366, 768, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await assertNoHorizontalOverflow(page);
    }
    await page.setViewportSize({ width: 1280, height: 900 });
  }

  const quickCreateTrigger = domainCard.getByRole('button', { name: '为此域名创建地址' });
  await quickCreateTrigger.click();
  await expect(quickCreateTrigger).toHaveAttribute('aria-expanded', 'true');
  const quickCreateForm = domainCard.locator('.quick-create-form');
  await expect(quickCreateForm.getByLabel('地址前缀 (@flaremail.test)')).toBeFocused();
  await expect(quickCreateForm).toContainText('@flaremail.test');
  const passiveToastDismiss = page.locator('.toast-region .dismiss');
  while (await passiveToastDismiss.count()) await passiveToastDismiss.first().click();
  if (testInfo.project.name === 'desktop') await page.setViewportSize({ width: 1505, height: 1045 });
  await quickCreateForm.evaluate((element) => element.scrollIntoView({ block: 'center' }));
  await page.screenshot({ path: `/tmp/flaremail-domain-quick-create-${testInfo.project.name}.png` });
  if (testInfo.project.name === 'desktop') {
    await page.setViewportSize({ width: 390, height: 844 });
    await quickCreateForm.evaluate((element) => element.scrollIntoView({ block: 'center' }));
    await assertNoHorizontalOverflow(page);
    const primaryBox = await quickCreateForm.getByRole('button', { name: '创建并配置收信规则' }).boundingBox();
    const detailsBox = await quickCreateForm.getByRole('button', { name: '填写名称与签名' }).boundingBox();
    const cancelBox = await quickCreateForm.getByRole('button', { name: '取消' }).boundingBox();
    expect(primaryBox!.y + primaryBox!.height).toBeLessThan(detailsBox!.y);
    expect(Math.abs(detailsBox!.y - cancelBox!.y)).toBeLessThan(2);
    await page.screenshot({ path: '/tmp/flaremail-domain-quick-create-mobile.png' });
    await page.setViewportSize({ width: 1280, height: 900 });
  }
  expect((await new AxeBuilder({ page }).include('.quick-create-form').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()).violations).toEqual([]);
  const prefixInput = quickCreateForm.getByLabel('地址前缀 (@flaremail.test)');
  await prefixInput.fill('hello@other.test');
  await quickCreateForm.getByRole('button', { name: '创建并配置收信规则' }).click();
  await expect(prefixInput).toHaveAttribute('aria-invalid', 'true');
  await expect(quickCreateForm).toContainText('这里只填写 @ 前的地址前缀');
  await page.keyboard.press('Escape');
  await expect(quickCreateForm).toBeHidden();
  await expect(quickCreateTrigger).toBeFocused();
  await quickCreateTrigger.click();
  await quickCreateForm.getByLabel('地址前缀 (@flaremail.test)').fill('details-e2e');
  await quickCreateForm.getByRole('button', { name: '填写名称与签名' }).click();
  await expect(page).toHaveURL(/folder=settings.*view=addresses/u);
  await expect(page.getByRole('heading', { name: '受管邮件地址' })).toBeVisible();
  await expect(page.getByLabel('收信域名')).toHaveValue('00000000-0000-4000-8000-000000000011');
  await expect(page.getByLabel('邮件地址或本地部分')).toHaveValue('details-e2e');
  await page.reload();
  await expect(page.getByRole('heading', { name: '受管邮件地址' })).toBeVisible();
  await expect(page.getByLabel('收信域名')).toHaveValue('00000000-0000-4000-8000-000000000011');
  await assertNoHorizontalOverflow(page);
  await page.screenshot({ path: `/tmp/flaremail-addresses-${testInfo.project.name}.png` });
  await page.evaluate(() => localStorage.setItem('flaremail-theme', 'dark'));
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect((await new AxeBuilder({ page }).include('main').analyze()).violations).toEqual([]);
  await assertNoHorizontalOverflow(page);
  await page.getByLabel('收信域名').selectOption('00000000-0000-4000-8000-000000000012');
  await expect(page).toHaveURL(/domain=00000000-0000-4000-8000-000000000012/u);
  await page.reload();
  await expect(page.getByLabel('收信域名')).toHaveValue('00000000-0000-4000-8000-000000000012');
  const compactNavigation = page.viewportSize()!.width < 901;
  if (compactNavigation) await page.getByRole('button', { name: '打开导航' }).click();
  const navigation = page.getByRole('navigation', { name: compactNavigation ? '移动端导航' : '主导航' });
  await navigation.getByRole('button', { name: '域名', exact: true }).click();
  await expect(page).toHaveURL(/folder=settings.*view=domains/u);
  await expect(page.getByRole('heading', { name: '域名概览' })).toBeVisible();
  await assertNoConsoleErrors(consoleErrors);
});

test('keeps addresses visible after local routing fails in quick and full creation', async ({ page }) => {
  await login(page);
  await page.goto('/?folder=settings&view=domains');
  const domainCard = page.locator('.domain-card').filter({ hasText: 'flaremail.test' });
  await expect(domainCard).toBeVisible();
  const trigger = domainCard.getByRole('button', { name: '为此域名创建地址' });
  await trigger.click();
  const quickCreateForm = domainCard.locator('.quick-create-form');
  await quickCreateForm.getByLabel('地址前缀 (@flaremail.test)').fill('quick-e2e');
  await quickCreateForm.getByRole('button', { name: '创建并配置收信规则' }).click();
  await expect(domainCard).toContainText('quick-e2e@flaremail.test');
  await expect(domainCard.getByRole('status')).toContainText('地址已保存，但收信规则配置未完成');
  await expect(quickCreateForm).toBeHidden();
  await expect(trigger).toBeFocused();
  await page.reload();
  await expect(domainCard).toContainText('quick-e2e@flaremail.test');
  const duplicatePosts: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/api/workspace/mail-identities')) duplicatePosts.push(request.url());
  });
  await trigger.click();
  const duplicateForm = domainCard.locator('.quick-create-form');
  await duplicateForm.getByLabel('地址前缀 (@flaremail.test)').fill('quick-e2e');
  await duplicateForm.getByRole('button', { name: '创建并配置收信规则' }).click();
  await expect(duplicateForm).toContainText('此地址已存在或待恢复');
  expect(duplicatePosts).toEqual([]);
  await page.goto('/?folder=settings&view=addresses&domain=00000000-0000-4000-8000-000000000011');
  await expect(page.getByRole('heading', { name: '受管邮件地址' })).toBeVisible();
  await page.getByLabel('邮件地址或本地部分').fill('full-e2e');
  await page.getByRole('button', { name: '创建并配置收信规则' }).click();
  await expect(page.getByRole('status').filter({ hasText: '地址已保存，但收信规则配置未完成' })).toBeVisible();
  await expect(page.locator('.domain-card').filter({ hasText: 'flaremail.test' })).toContainText('full-e2e@flaremail.test');
  await page.reload();
  await expect(page.locator('.domain-card').filter({ hasText: 'flaremail.test' })).toContainText('full-e2e@flaremail.test');
  await assertNoHorizontalOverflow(page);
});

test('preserves an unsaved profile edit across another tab identity refresh', async ({ page, context, consoleErrors }, testInfo) => {
  await login(page);
  await page.goto('/?folder=settings');
  const name = page.getByLabel('显示姓名');
  const company = page.getByLabel('公司名称');
  await expect(name).toBeVisible();
  await name.fill('  Unsaved E2E Name  ');

  const otherTab = await context.newPage();
  await otherTab.goto('/');
  const refreshSession = async (route: Route) => {
    const response = await route.fetch();
    const payload = await response.json() as { data: { workspace: { profile: { company: string } } } };
    payload.data.workspace.profile.company = 'Synced Company';
    await route.fulfill({ response, json: payload });
  };
  await page.route('**/api/workspace/session', refreshSession);
  const refreshedSession = page.waitForResponse((response) =>
    response.url().endsWith('/api/workspace/session') && response.request().method() === 'GET'
  );
  await otherTab.evaluate(() => {
    const channel = new BroadcastChannel('flaremail-workspace-v1');
    channel.postMessage({ type: 'mail-identity-options-changed', nonce: crypto.randomUUID(), at: Date.now() });
    channel.close();
  });
  await refreshedSession;
  await expect(company).toHaveValue('Synced Company');
  await expect(name).toHaveValue('  Unsaved E2E Name  ');
  await page.unroute('**/api/workspace/session', refreshSession);
  await page.screenshot({ path: join(tmpdir(), `flaremail-profile-draft-sync-${testInfo.project.name}.png`), fullPage: false });

  await page.getByRole('button', { name: '保存设置' }).click();
  await expect(name).toHaveValue('Unsaved E2E Name');
  await page.reload();
  await expect(name).toHaveValue('Unsaved E2E Name');
  await otherTab.close();
  await assertNoConsoleErrors(consoleErrors);
});

test('hydrates global metrics and pagination on fresh login, then purges state on logout', async ({ page, consoleErrors }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Desktop navigation exposes all global metric badges and logout controls.');
  await login(page);
  const navigation = page.getByRole('navigation', { name: '主导航' });
  await expect(navigation.getByRole('button', { name: '收件箱', exact: true }).getByText('48', { exact: true })).toBeVisible();
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
  await expect(page.getByRole('button', { name: '已加星标' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page).toHaveURL(/filter=starred/u);
  await expect(page.getByLabel('批量邮件操作')).not.toContainText('已选');
  await page.getByRole('button', { name: '全部', exact: true }).click();
  await page.getByRole('listitem').filter({ hasText: 'E2E Inbox Welcome' }).getByRole('button', { name: /E2E Inbox Welcome/ }).first().click();
  await expect(page).toHaveURL(/message=/u);

  await page.getByRole('button', { name: '账号菜单' }).click();
  await page.getByRole('menuitem', { name: '退出登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '登录邮件工作台' })).toBeVisible();
  await expect(page).not.toHaveURL(/message=|folder=sent|q=/u);
  await login(page);
  await expect(page.getByLabel('搜索邮件')).toHaveValue('');
  await expect(page.getByRole('button', { name: '全部', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('批量邮件操作')).not.toContainText('已选');
  await expect(page.getByRole('button', { name: '加载更多' })).toBeVisible();
  await assertNoConsoleErrors(consoleErrors);
});

test('opens an older inbound message from a cold deep link without selecting the first page item', async ({ page, consoleErrors }) => {
  await login(page);
  await page.goto('/?folder=inbox&message=email%3Ae2e-deep-inbound-message');
  const detail = page.getByRole('region', { name: '邮件详情' });
  await expect(detail.getByRole('heading', { name: 'E2E Deep Link Target', exact: true })).toBeVisible();
  await expect(page.getByRole('article', { name: '邮件正文详情' })).toContainText('This older inbound message must open directly from its URL.');
  await assertNoConsoleErrors(consoleErrors);
});

test('keeps readable default columns, persists the layout, and opens one focused reader', async ({ page, consoleErrors }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'The desktop project covers the wide reading workspace controls.');
  test.setTimeout(75_000);
  await login(page);

  await expect(page.locator('.mail-workspace')).toHaveAttribute('data-list-width-preference', '440');
  await page.setViewportSize({ width: 1505, height: 1045 });
  await expect(page.locator('.mail-workspace')).toHaveAttribute('data-list-width-effective', '440');
  await expect(page.locator('.topbar')).toHaveCSS('height', '64px');
  const workspaceBounds = await page.locator('.fm-workspace-body').evaluate((body) => ({
    bottom: body.getBoundingClientRect().bottom,
    viewport: window.innerHeight,
    pageHeight: document.documentElement.scrollHeight
  }));
  expect(workspaceBounds.bottom).toBeLessThanOrEqual(workspaceBounds.viewport + 1);
  expect(workspaceBounds.pageHeight).toBeLessThanOrEqual(workspaceBounds.viewport + 1);
  await expect(page.locator('.topbar .account-trigger-label')).toBeHidden();
  const firstRowHeight = await page.locator('.mail-list-item').first().evaluate((item) => item.getBoundingClientRect().height);
  expect(firstRowHeight).toBeGreaterThanOrEqual(88);
  const columns = await page.locator('.mail-workspace').evaluate((workspace) => ({
    list: workspace.querySelector('.mail-list-panel')?.getBoundingClientRect().width ?? 0,
    detail: workspace.querySelector('.mail-detail-panel')?.getBoundingClientRect().width ?? 0
  }));
  expect(columns.list).toBeGreaterThanOrEqual(440);
  expect(columns.detail).toBeGreaterThanOrEqual(700);
  await page.screenshot({ path: join(tmpdir(), 'flaremail-list-default-desktop.png'), fullPage: false });
  await page.getByRole('button', { name: '显示偏好' }).click();
  await page.getByRole('radio', { name: '紧凑显示' }).click();
  const compactRowHeight = await page.locator('.mail-list-item').first().evaluate((item) => item.getBoundingClientRect().height);
  expect(compactRowHeight).toBeLessThan(firstRowHeight);
  await page.getByRole('radio', { name: '标准显示' }).click();
  await page.keyboard.press('Escape');
  for (const width of [1920, 1440, 1366, 768, 390]) {
    await page.setViewportSize({ width, height: width <= 900 ? 844 : 900 });
    await assertNoHorizontalOverflow(page);
    if (width > 900) {
      await expect(page.locator('.mail-workspace')).toHaveAttribute('data-list-width-effective', '440');
      const bounds = await page.locator('.fm-workspace-body').evaluate((body) => ({
        bottom: body.getBoundingClientRect().bottom,
        viewport: window.innerHeight
      }));
      expect(bounds.bottom).toBeLessThanOrEqual(bounds.viewport + 1);
    }
  }
  await page.setViewportSize({ width: 1280, height: 900 });

  const sidebar = page.locator('#fm-main-sidebar');
  const collapse = sidebar.getByRole('button', { name: '折叠侧边栏' });
  await collapse.click();
  await expect(sidebar).toHaveAttribute('aria-label', '邮箱导航');
  await expect(collapse).toHaveCount(0);
  await expect(sidebar.getByRole('button', { name: '展开侧边栏' })).toBeVisible();
  await page.reload();
  await expect(page.locator('#fm-main-sidebar').getByRole('button', { name: '展开侧边栏' })).toBeVisible();
  await page.locator('#fm-main-sidebar').getByRole('button', { name: '展开侧边栏' }).click();

  const splitter = page.locator('.mail-splitter');
  await splitter.focus();
  await page.keyboard.press('End');
  await expect(splitter).toHaveAttribute('aria-valuenow', '480');
  await page.setViewportSize({ width: 1000, height: 900 });
  await expect(page.locator('.mail-workspace')).toHaveAttribute('data-list-width-preference', '480');
  await expect(page.locator('.mail-workspace')).toHaveAttribute('data-list-width-effective', '400');
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.locator('.mail-workspace')).toHaveAttribute('data-list-width-effective', '480');
  await page.keyboard.press('Enter');
  await expect(splitter).toHaveAttribute('aria-valuenow', '440');

  await page.setViewportSize({ width: 1505, height: 1045 });
  const item = page.getByRole('listitem').filter({ hasText: 'E2E Inbox Welcome' });
  await item.getByRole('button', { name: /E2E Inbox Welcome/u }).first().click();
  await page.getByRole('region', { name: '邮件详情' }).getByRole('button', { name: '展开专注阅读' }).click();
  const reader = page.getByRole('dialog', { name: 'E2E Inbox Welcome' });
  await expect(reader).toBeVisible();
  await expect(reader).toBeFocused();
  await expect(reader).toHaveAttribute('aria-modal', 'true');
  await expect(page.locator('.fm-workspace-shell')).toHaveAttribute('inert', '');
  await expect(reader.locator('h1', { hasText: 'E2E Inbox Welcome' })).toHaveCount(1);
  await expect(reader.getByRole('button', { name: '关闭专注阅读' })).toHaveCount(1);
  await expect(page.locator('.toast-region .toast')).toHaveCount(0);
  await page.screenshot({ path: join(tmpdir(), 'flaremail-focused-reader-desktop.png'), fullPage: false });
  await page.keyboard.press('Shift+Tab');
  expect(await reader.evaluate((element) => element.contains(document.activeElement) && document.activeElement !== element)).toBe(true);
  expect(await reader.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.getClientRects().length > 0)).toBe(true);
  await page.keyboard.press('Tab');
  expect(await reader.evaluate((element) => element.contains(document.activeElement) && document.activeElement !== element)).toBe(true);
  await reader.getByRole('button', { name: '关闭专注阅读' }).click();
  await expect(reader).toBeHidden();
  const readerTrigger = page.getByRole('region', { name: '邮件详情' }).getByRole('button', { name: '展开专注阅读' });
  await expect(readerTrigger).toBeFocused();
  await expect(page.locator('.fm-workspace-shell')).not.toHaveAttribute('inert', '');
  await readerTrigger.click();
  await expect(reader).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(reader).toBeHidden();
  await expect(readerTrigger).toBeFocused();

  await page.getByRole('button', { name: '显示偏好' }).click();
  const language = page.getByLabel('切换语言');
  await language.selectOption('en');
  await expect(page.getByRole('main', { name: 'Mail workspace' })).toBeVisible();
  await expect(page.locator('#fm-main-sidebar').getByRole('button', { name: 'Collapse sidebar' })).toBeVisible();
  const filters = page.getByRole('group', { name: 'Mail filters' });
  await expect(filters.getByRole('button', { name: 'All', exact: true })).toBeVisible();
  await expect(filters.getByRole('button', { name: 'Unread', exact: true })).toBeVisible();
  await expect(filters.getByRole('button', { name: 'Starred', exact: true })).toBeVisible();
  await page.screenshot({ path: join(tmpdir(), `flaremail-reading-layout-${testInfo.project.name}-en.png`), fullPage: false });
  await page.getByLabel('Change language').selectOption('zh-CN');
  await expect(page.getByRole('main', { name: '邮件工作区' })).toBeVisible();
  await page.evaluate(() => localStorage.removeItem('flaremail-layout-v1'));
  await assertNoConsoleErrors(consoleErrors);
  await page.screenshot({ path: join(tmpdir(), `flaremail-reading-layout-${testInfo.project.name}.png`), fullPage: false });
});

test('keeps long messages readable in the focused reader across viewport sizes', async ({ page, consoleErrors }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'The desktop project drives the reader viewport matrix.');
  test.setTimeout(90_000);
  await login(page);
  const subject = `E2E Long Reader ${Date.now()}`;
  const lastLine = 'End of the long reader fixture.';
  const body = [...Array.from({ length: 90 }, (_, index) => `Paragraph ${index + 1}: A readable line with enough content to test wrapping and scrolling across viewport widths.`), lastLine].join('\n\n');
  await createDraft(page, subject, body);
  await openFolder(page, '草稿箱');
  const item = page.getByRole('listitem').filter({ hasText: subject });
  await expect(item).toBeVisible();
  await item.getByRole('button', { name: new RegExp(subject, 'u') }).first().click();
  const trigger = page.getByRole('region', { name: '邮件详情' }).getByRole('button', { name: '展开专注阅读' });
  await trigger.click();
  const reader = page.getByRole('dialog', { name: subject });
  await expect(reader.locator('.message-plain-body')).toContainText(lastLine);
  await expect(reader).toBeFocused();

  for (const width of [1920, 1440, 1366, 768, 390]) {
    await page.setViewportSize({ width, height: width <= 900 ? 844 : 900 });
    await assertNoHorizontalOverflow(page);
    const metrics = await reader.evaluate((element) => {
      const scroll = element.querySelector<HTMLElement>('.fm-detail-scroll');
      const body = element.querySelector<HTMLElement>('.message-plain-body');
      if (!scroll || !body) return null;
      const bodyWidth = body.getBoundingClientRect().width;
      const scrollWidth = scroll.getBoundingClientRect().width;
      const maxScroll = scroll.scrollHeight - scroll.clientHeight;
      scroll.scrollTop = maxScroll;
      return { bodyWidth, scrollWidth, maxScroll, actualScroll: scroll.scrollTop };
    });
    expect(metrics).not.toBeNull();
    expect(metrics!.bodyWidth).toBeLessThanOrEqual(metrics!.scrollWidth);
    expect(metrics!.maxScroll).toBeGreaterThan(0);
    expect(metrics!.actualScroll).toBeGreaterThan(0);
    await expect(reader.getByRole('button', { name: '关闭专注阅读' })).toBeVisible();
    await expect(reader.getByRole('tooltip', { name: '加星' })).toBeHidden();
    if (width === 390) await page.screenshot({ path: join(tmpdir(), 'flaremail-focused-reader-long-mobile.png'), fullPage: false });
  }
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.keyboard.press('Escape');
  await expect(reader).toBeHidden();
  await expect(trigger).toBeFocused();
  await assertNoConsoleErrors(consoleErrors);
});

test('shows accessible tooltips for the collapsed sidebar including scrollable labels', async ({ page, consoleErrors }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'The sidebar is a desktop-only control.');
  await login(page);
  const created = await page.evaluate(async () => {
    for (const name of [...Array.from({ length: 18 }, (_, index) => `E2E Sidebar Extra ${String(index + 1).padStart(2, '0')}`), 'E2E Sidebar Tooltip']) {
      const response = await fetch('/api/workspace/labels', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name })
      });
      if (!response.ok) return false;
    }
    return true;
  });
  expect(created).toBe(true);
  await page.reload();
  const sidebar = page.locator('#fm-main-sidebar');
  await sidebar.getByRole('button', { name: '折叠侧边栏' }).click();
  const inbox = sidebar.getByRole('button', { name: '收件箱' });
  await inbox.hover();
  await expect(page.getByRole('tooltip', { name: '收件箱' })).toBeVisible();
  const [inboxBounds, inboxCountBounds, collapsedSidebarBounds] = await Promise.all([
    inbox.boundingBox(), inbox.locator('.count').boundingBox(), sidebar.boundingBox()
  ]);
  expect(inboxBounds).not.toBeNull();
  expect(inboxCountBounds).not.toBeNull();
  expect(collapsedSidebarBounds).not.toBeNull();
  expect(inboxBounds!.width).toBeGreaterThanOrEqual(44);
  expect(inboxCountBounds!.x + inboxCountBounds!.width / 2)
    .toBeGreaterThan(collapsedSidebarBounds!.x + collapsedSidebarBounds!.width / 2);
  await inbox.focus();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('tooltip', { name: '收件箱' })).toBeHidden();

  const label = sidebar.getByRole('button', { name: 'E2E Sidebar Tooltip' });
  await label.focus();
  expect(await sidebar.locator('.label-navigation').evaluate((navigation) => navigation.scrollTop)).toBeGreaterThan(0);
  const tooltip = page.getByRole('tooltip', { name: 'E2E Sidebar Tooltip' });
  await expect(tooltip).toBeVisible();
  const descriptionId = await label.getAttribute('aria-describedby');
  expect(descriptionId).toBe(await tooltip.getAttribute('id'));
  const [tooltipBounds, sidebarBounds] = await Promise.all([tooltip.boundingBox(), sidebar.boundingBox()]);
  expect(tooltipBounds).not.toBeNull();
  expect(sidebarBounds).not.toBeNull();
  expect(tooltipBounds!.x + tooltipBounds!.width).toBeGreaterThan(sidebarBounds!.x + sidebarBounds!.width + 20);
  expect((await new AxeBuilder({ page }).include('#fm-main-sidebar').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()).violations).toEqual([]);
  await page.screenshot({ path: join(tmpdir(), `flaremail-sidebar-tooltip-${testInfo.project.name}.png`), fullPage: false });
  await sidebar.locator('.label-navigation').evaluate((navigation) => (navigation.scrollTop = 0));
  await expect(tooltip).toBeHidden();
  await page.evaluate(() => localStorage.setItem('flaremail-theme', 'dark'));
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await label.focus();
  await expect(tooltip).toBeVisible();
  await page.screenshot({ path: join(tmpdir(), `flaremail-sidebar-tooltip-${testInfo.project.name}-dark.png`), fullPage: false });
  await assertNoHorizontalOverflow(page);
  await assertNoConsoleErrors(consoleErrors);
});

test('opens a private standalone reader document without duplicating the message header', async ({ page, context, consoleErrors }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'The desktop project covers the standalone reader route.');
  await login(page);
  const item = page.getByRole('listitem').filter({ hasText: 'E2E Inbox Welcome' });
  await item.getByRole('button', { name: /E2E Inbox Welcome/u }).first().click();
  const detail = page.getByRole('region', { name: '邮件详情' });
  const href = await detail.getByRole('link', { name: '在新窗口打开邮件' }).getAttribute('href');
  expect(href).toMatch(/^\/messages\//u);

  const standalone = await context.newPage();
  try {
    const response = await standalone.goto(href!);
    expect(response?.headers()['cache-control']).toContain('private, no-store');
    await expect(standalone.getByText('独立邮件阅读', { exact: true })).toBeVisible();
    await expect(standalone.getByRole('heading', { name: 'E2E Inbox Welcome', exact: true })).toHaveCount(1);
    await expect(standalone.getByRole('button', { name: '在新窗口打开邮件' })).toHaveCount(0);
  } finally {
    await standalone.close();
  }
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
  const starColors = [await removeStar.locator('svg').evaluate((icon) => ({ stroke: getComputedStyle(icon).stroke, fill: getComputedStyle(icon).fill }))];
  if (testInfo.project.name === 'desktop') {
    starColors.push(await item.getByRole('button', { name: '取消星标', exact: true }).locator('svg').evaluate((icon) => ({ stroke: getComputedStyle(icon).stroke, fill: getComputedStyle(icon).fill })));
  }
  const expectedColors = await page.evaluate(() => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--fm-brand-orange-strong)';
    probe.style.fill = 'var(--fm-brand-orange)';
    document.body.appendChild(probe);
    const colors = { stroke: getComputedStyle(probe).color, fill: getComputedStyle(probe).fill };
    probe.remove();
    return colors;
  });
  for (const colors of starColors) {
    expect(colors).toEqual(expectedColors);
  }
  await page.screenshot({ path: join(tmpdir(), `flaremail-star-contrast-${testInfo.project.name}.png`), fullPage: false });
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

test('announces list selection, star, attachment and delivery states', async ({ page, consoleErrors }, testInfo) => {
  await login(page);
  const reset = await page.evaluate(async () => {
    const response = await fetch('/api/workspace/messages/e2e-inbox-message/flags', {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ read: false, starred: false })
    });
    return response.ok;
  });
  expect(reset).toBe(true);
  await page.reload();
  const inboxItem = page.getByRole('listitem').filter({ hasText: 'E2E Inbox Welcome' });
  const inboxButton = inboxItem.getByRole('button', { name: /E2E Inbox Welcome/u }).first();
  await expect(inboxItem.getByText('E2E Sender', { exact: true })).toBeVisible();
  await expect(inboxButton).toHaveAttribute('aria-label', /E2E Sender <sender@flaremail\.test>.*E2E Inbox Welcome/u);
  await expect(inboxButton).toHaveAttribute('aria-label', /未读.*E2E Inbox Welcome/u);
  await inboxItem.getByRole('button', { name: '加星', exact: true }).click();
  await expect(inboxButton).toHaveAttribute('aria-label', /已加星标.*E2E Inbox Welcome/u);
  await inboxButton.click();
  if (testInfo.project.name === 'desktop') {
    await expect(inboxButton).toHaveAttribute('aria-label', /^当前邮件, .*E2E Inbox Welcome/u);
    await page.mouse.move(1, 1);
    const selectedColor = await inboxItem.evaluate((item) => getComputedStyle(item).backgroundColor);
    const unselectedColor = await page.getByRole('listitem').filter({ hasText: 'E2E HTML Safety' })
      .evaluate((item) => getComputedStyle(item).backgroundColor);
    expect(selectedColor).not.toBe(unselectedColor);
    await inboxButton.hover();
    await expect.poll(() => inboxItem.evaluate((item) => getComputedStyle(item).backgroundColor)).toBe(selectedColor);
  } else {
    await expect(page.getByRole('region', { name: '邮件详情' }).getByRole('heading', { name: 'E2E Inbox Welcome' })).toBeVisible();
  }

  await openFolder(page, '已发送');
  const sentButton = page.getByRole('listitem').filter({ hasText: 'E2E Seeded Sent' })
    .getByRole('button', { name: /E2E Seeded Sent/u }).first();
  await expect(sentButton).toHaveAttribute('aria-label', /E2E Seeded Sent.*投递: 已发送/u);

  await openFolder(page, '收件箱');
  const attachmentButton = page.getByRole('listitem').filter({ hasText: 'E2E HTML Safety' })
    .getByRole('button', { name: /E2E HTML Safety/u }).first();
  await expect(attachmentButton).toHaveAttribute('aria-label', /E2E HTML Safety.*含附件/u);
  if (testInfo.project.name === 'desktop') {
    await attachmentButton.click();
    await expect(attachmentButton).toHaveAttribute('aria-label', /E2E HTML Safety.*含附件/u);
    await page.setViewportSize({ width: 1505, height: 1045 });
    await page.screenshot({ path: join(tmpdir(), 'flaremail-accessible-list-desktop.png'), fullPage: false });
  }
  await assertNoConsoleErrors(consoleErrors);
});

test('runs advanced owner-scoped FTS search with highlighted persisted results', async ({ page, consoleErrors }, testInfo) => {
  await login(page);
  const query = 'from:html-sender@flaremail.test subject:"E2E HTML Safety" date:2026-08-13 attachment:yes';
  await page.getByLabel('搜索邮件').fill(query);
  const result = page.getByRole('listitem').filter({ hasText: 'E2E HTML Safety' });
  await expect(result).toBeVisible();
  await expect(page.getByRole('listitem').filter({ hasText: 'E2E Inbox Welcome' })).toHaveCount(0);
  await expect(page.getByText('1 个结果', { exact: true })).toBeVisible();
  await expect(result).toContainText('发件人 · 主题 · 附件 · 日期');
  await expect(result.locator('mark')).not.toHaveCount(0);
  await expect(page).toHaveURL(/q=from%3Ahtml-sender/u);
  if (testInfo.project.name === 'desktop') await page.setViewportSize({ width: 1505, height: 1045 });
  await assertNoHorizontalOverflow(page);
  await page.screenshot({ path: `/tmp/flaremail-search-date-attachment-${testInfo.project.name}.png`, fullPage: false });

  await page.reload();
  await expect(page.getByLabel('搜索邮件')).toHaveValue(query);
  await expect(result).toBeVisible();
  await page.getByLabel('搜索邮件').fill('subject:"E2E Inbox Welcome" date:2026-08-13 attachment:no');
  await expect(page.getByRole('listitem').filter({ hasText: 'E2E Inbox Welcome' })).toBeVisible();
  await expect(result).toHaveCount(0);
  await expect(page.getByText('1 个结果', { exact: true })).toBeVisible();
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
  if (testInfo.project.name === 'desktop') await page.setViewportSize({ width: 1505, height: 1045 });
  const item = page.getByRole('listitem').filter({ hasText: 'E2E HTML Safety' });
  await item.getByRole('button', { name: /E2E HTML Safety/u }).first().click();
  const detail = page.getByRole('region', { name: '邮件详情' });
  const attachmentList = detail.getByRole('list', { name: '邮件附件列表' });
  await expect(attachmentList.getByRole('listitem')).toHaveCount(1);
  await expect(detail.getByText('1 个附件 · 68 B', { exact: true })).toBeVisible();
  const attachmentWidths = await attachmentList.evaluate((list) => ({
    list: list.getBoundingClientRect().width,
    row: list.querySelector('li')?.getBoundingClientRect().width ?? 0
  }));
  expect(attachmentWidths.row).toBeGreaterThanOrEqual(attachmentWidths.list - 1);
  await page.screenshot({ path: join(tmpdir(), `flaremail-attachment-${testInfo.project.name}.png`), fullPage: false });
  await detail.getByText('技术详情', { exact: true }).click();
  await expect(detail).toContainText('Support <support@flaremail.test>');
  await expect(detail).toContainText('Observer <observer@flaremail.test>');
  await expect(detail).toContainText('spf=pass');
  await expect(detail).toContainText('FlareMail 未独立执行 SPF、DKIM 或 DMARC 验证');
  await detail.getByRole('button', { name: '回复全部', exact: true }).click();
  const replyAllDialog = page.getByRole('dialog', { name: '回复邮件' });
  await expect(replyAllDialog.getByRole('button', { name: '移除收件人 html-sender@flaremail.test' })).toBeVisible();
  await expect(replyAllDialog.getByRole('button', { name: /移除(?:收件人|抄送) support@flaremail\.test/u })).toHaveCount(0);
  await expect(replyAllDialog.getByLabel('发件地址')).toHaveValue('00000000-0000-4000-8000-000000000021');
  await expect(replyAllDialog.getByRole('button', { name: '移除抄送 observer@flaremail.test' })).toBeVisible();
  await expect(replyAllDialog.getByRole('button', { name: '移除抄送 team@flaremail.test' })).toBeVisible();
  await replyAllDialog.getByRole('button', { name: '关闭' }).click();
  await expect(replyAllDialog).toBeHidden();
  await expect(detail.getByRole('button', { name: '纯文本' })).toHaveAttribute('aria-pressed', 'true');
  await expect(detail.getByTitle('安全 HTML 邮件正文')).toHaveCount(0);

  await detail.getByRole('button', { name: '安全 HTML' }).click();
  if (testInfo.project.name === 'mobile') {
    await expect(detail.getByRole('button', { name: '安全 HTML' })).toBeInViewport();
    const readingScroll = await detail.evaluate((element) => ({
      headerBottom: element.querySelector('header')?.getBoundingClientRect().bottom ?? 0,
      scrollTopEdge: element.querySelector<HTMLElement>('.fm-detail-scroll')?.getBoundingClientRect().top ?? 0,
      pageScrollY: window.scrollY
    }));
    expect(readingScroll.headerBottom).toBeLessThanOrEqual(readingScroll.scrollTopEdge + 1);
    expect(readingScroll.pageScrollY).toBe(0);
    await assertNoHorizontalOverflow(page);
    await page.screenshot({ path: join(tmpdir(), 'flaremail-detail-expanded-mobile.png'), fullPage: false });
  }
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

  const bodyMetrics = await detail.locator('article[aria-label="邮件正文详情"]').evaluate((article) => {
    const iframe = article.querySelector<HTMLIFrameElement>('iframe[title="安全 HTML 邮件正文"]');
    const scrollOwner = article.parentElement;
    return {
      viewportHeight: window.innerHeight,
      iframeHeight: iframe?.getBoundingClientRect().height ?? null,
      articleHeight: article.getBoundingClientRect().height,
      scrollOwnerClientHeight: scrollOwner?.clientHeight ?? null,
      scrollOwnerScrollHeight: scrollOwner?.scrollHeight ?? null
    };
  });
  await writeFile(join(tmpdir(), `flaremail-body-metrics-${testInfo.project.name}.json`), JSON.stringify(bodyMetrics, null, 2));
  expect(bodyMetrics.iframeHeight).toBeGreaterThanOrEqual(352);
  expect(bodyMetrics.iframeHeight).toBeLessThanOrEqual(896);

  const consent = detail.getByRole('button', { name: '加载本邮件 HTTPS 图片' });
  await consent.click();
  await expect(frame.locator('img[src^="https://tracker.example/"]')).toHaveCount(1);
  await expect.poll(() => remoteRequests.length).toBe(1);
  await expect(frame.locator('img[src^="http://insecure.example/"]')).toHaveCount(0);
  await page.screenshot({ path: join(tmpdir(), `flaremail-safe-html-${testInfo.project.name}.png`), fullPage: false });

  await detail.getByRole('button', { name: '撤销远程图片权限' }).click();
  await expect(frame.locator('img[src^="https://tracker.example/"]')).toHaveCount(0);

  const downloadPromise = page.waitForEvent('download');
  await detail.getByRole('region', { name: '邮件正文' }).getByRole('button', { name: '更多邮件操作' }).click();
  await detail.getByRole('menuitem', { name: '下载显示问题报告', exact: true }).click();
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

test('keeps reading space when a message has many labels', async ({ page, consoleErrors }, testInfo) => {
  test.setTimeout(90_000);
  await login(page);
  let createdIds: string[] = [];
  try {
    const seeded = await page.evaluate(async () => {
      const ids: string[] = [];
      try {
        for (let index = 0; index < 36; index += 1) {
          const name = `E2E Header Stress ${String(index).padStart(2, '0')}`;
          const created = await fetch('/api/workspace/labels', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name })
          });
          if (!created.ok) throw new Error(`Create label ${index}: HTTP ${created.status}`);
          const payload = await created.json() as { data: { label: { id: string } } };
          const id = payload.data.label.id;
          ids.push(id);
          const applied = await fetch(`/api/workspace/labels/${encodeURIComponent(id)}/messages`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ kind: 'inbound', id: 'e2e-html-inbox-message' })
          });
          if (!applied.ok) throw new Error(`Apply label ${index}: HTTP ${applied.status}`);
        }
        return { ids, error: null };
      } catch (error) {
        return { ids, error: error instanceof Error ? error.message : String(error) };
      }
    });
    createdIds = seeded.ids;
    expect(seeded.error).toBeNull();
    await page.reload();
    const item = page.getByRole('listitem').filter({ hasText: 'E2E HTML Safety' });
    await item.getByRole('button', { name: /E2E HTML Safety/u }).first().click();
    const detail = page.getByRole('region', { name: '邮件详情' });
    await expect(detail.locator('.message-header-labels').getByText(/^E2E Header Stress /u)).toHaveCount(36);
    await expect(detail.getByRole('button', { name: '纯文本' })).toBeInViewport();
    const moreLabels = detail.locator('summary').filter({ hasText: /另外 \d+ 个标签/u });
    await expect(moreLabels).toBeVisible();
    await moreLabels.click();
    await expect(detail.getByText('E2E Header Stress 35', { exact: true })).toBeVisible();
    await moreLabels.click();
    await page.screenshot({ path: join(tmpdir(), `flaremail-many-labels-${testInfo.project.name}.png`), fullPage: false });
    const reading = await detail.evaluate((element) => ({
      scrollHeight: element.querySelector<HTMLElement>('.fm-detail-scroll')?.clientHeight ?? 0,
      viewportHeight: window.innerHeight,
      pageScrollY: window.scrollY
    }));
    expect(reading.scrollHeight).toBeGreaterThanOrEqual(reading.viewportHeight * 0.55);
    expect(reading.pageScrollY).toBe(0);
    await assertNoHorizontalOverflow(page);
  } finally {
    if (createdIds.length) {
      await page.evaluate(async (ids) => {
        for (let index = 0; index < ids.length; index += 6) {
          await Promise.all(ids.slice(index, index + 6).map((id) => fetch(`/api/workspace/labels/${encodeURIComponent(id)}`, { method: 'DELETE' })));
        }
      }, createdIds);
    }
  }
  await assertNoConsoleErrors(consoleErrors);
});

test('keeps a reply-all sender tied to the selected delivery after changing identity filter', async ({ page, consoleErrors }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'A mobile full-screen compose dialog covers the mailbox identity filter.');
  await login(page);
  const item = page.getByRole('listitem').filter({ hasText: 'E2E HTML Safety' });
  await item.getByRole('button', { name: /E2E HTML Safety/u }).first().click();
  const detail = page.getByRole('region', { name: '邮件详情' });
  await detail.getByRole('button', { name: '回复全部', exact: true }).click();
  const replyAllDialog = page.getByRole('dialog', { name: '回复邮件' });
  await expect(page.locator('.toast-region .toast')).toHaveCount(0);
  await expect(replyAllDialog.getByLabel('发件地址')).toHaveValue('00000000-0000-4000-8000-000000000021');

  const identityFilter = page.locator('#mail-identity-filter');
  await identityFilter.selectOption('address:00000000-0000-4000-8000-000000000022');
  await expect(identityFilter).toHaveValue('address:00000000-0000-4000-8000-000000000022');
  await expect(replyAllDialog.getByLabel('发件地址')).toHaveValue('00000000-0000-4000-8000-000000000021');
  await expect(replyAllDialog.getByRole('button', { name: '移除抄送 observer@flaremail.test' })).toBeVisible();
  await expect(replyAllDialog.getByRole('button', { name: '移除抄送 team@flaremail.test' })).toBeVisible();
  await assertNoConsoleErrors(consoleErrors);
});

test('uses global service metrics and exposes typed API errors with a request ID', async ({ page, consoleErrors }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'The desktop topbar exposes the service summary.');
  await login(page);

  const serviceStatus = page.locator('details.status-menu');
  const serviceSummary = page.locator('summary[aria-label="查看工作区服务状态"]');
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
    const confirmation = page.getByRole('dialog', { name: '移入垃圾箱？' });
    await confirmation.getByRole('button', { name: '移入垃圾箱' }).click();
    await expect(confirmation).toBeHidden();
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

test('moves, resizes, minimizes, and maximizes the desktop compose window', async ({ page, consoleErrors }, testInfo) => {
  test.setTimeout(90_000);
  test.skip(testInfo.project.name !== 'desktop', 'Desktop compose window controls are hidden on touch layouts.');
  await login(page);
  await page.getByRole('button', { name: '写邮件', exact: true }).first().click();
  const composeDialog = page.getByRole('dialog', { name: '新邮件' });
  await expect(composeDialog).toHaveAttribute('aria-modal', 'false');
  const initial = await composeDialog.boundingBox();
  expect(initial).toBeTruthy();

  const move = composeDialog.getByRole('button', { name: '移动写信窗口' });
  const moveBox = await move.boundingBox();
  expect(moveBox).toBeTruthy();
  await page.mouse.move(moveBox!.x + moveBox!.width / 2, moveBox!.y + moveBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(moveBox!.x + moveBox!.width / 2 - 96, moveBox!.y + moveBox!.height / 2 - 64);
  await page.mouse.up();
  const moved = await composeDialog.boundingBox();
  expect(moved!.x).toBeLessThan(initial!.x - 50);
  expect(moved!.y).toBeLessThan(initial!.y - 30);

  const resize = composeDialog.getByRole('button', { name: '调整写信窗口大小' });
  await resize.focus();
  await resize.press('ArrowLeft');
  await resize.press('ArrowUp');
  const resized = await composeDialog.boundingBox();
  expect(resized!.width).toBeGreaterThan(moved!.width);
  expect(resized!.height).toBeGreaterThan(moved!.height);

  await composeDialog.getByRole('button', { name: '最大化写信窗口' }).click();
  await expect(composeDialog).toHaveAttribute('data-maximized', 'true');
  await composeDialog.getByRole('button', { name: '还原写信窗口' }).click();
  await expect(composeDialog).toHaveAttribute('data-maximized', 'false');
  await composeDialog.getByRole('textbox', { name: '主题', exact: true }).fill('E2E floating compose');
  await composeDialog.getByRole('button', { name: '最小化写信窗口' }).click();
  await expect(composeDialog).toHaveAttribute('data-minimized', 'true');
  await expect(composeDialog.getByRole('textbox', { name: '主题', exact: true })).toHaveCount(0);
  const restore = composeDialog.getByRole('button', { name: '还原写信窗口' });
  await restore.focus();
  const restoreGuidance = composeDialog.getByRole('tooltip', { name: '还原写信窗口' });
  await expect(restoreGuidance).toBeVisible();
  const restoreBounds = await restoreGuidance.boundingBox();
  expect(restoreBounds!.y).toBeGreaterThanOrEqual(0);
  expect(restoreBounds!.y + restoreBounds!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '草稿箱', exact: true }).click();
  await restore.click();
  await expect(composeDialog.getByRole('textbox', { name: '主题', exact: true })).toHaveValue('E2E floating compose');
  expect((await new AxeBuilder({ page }).include('.compose-dialog').analyze()).violations).toEqual([]);
  await composeDialog.getByRole('button', { name: '关闭' }).click();
  const unsavedDialog = page.getByRole('dialog', { name: '未保存的改动' });
  if (await unsavedDialog.isVisible().catch(() => false)) {
    await unsavedDialog.getByRole('button', { name: '保存并关闭' }).click();
  }
  await expect(composeDialog).toBeHidden();
  await assertNoConsoleErrors(consoleErrors);
});

test('keeps the floating compose window inside a short desktop viewport', async ({ page, consoleErrors }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Desktop compose geometry does not apply to the mobile full-screen layout.');
  await login(page);
  await page.setViewportSize({ width: 1505, height: 1045 });
  const composeButton = page.getByRole('button', { name: '写邮件', exact: true }).first();
  await composeButton.click();
  const composeDialog = page.getByRole('dialog', { name: '新邮件' });
  await expect(composeDialog).toBeVisible();
  await page.screenshot({ path: join(tmpdir(), 'flaremail-compose-floating-concept-size.png'), fullPage: false });

  for (const viewport of [{ width: 1366, height: 320 }, { width: 641, height: 320 }]) {
    await page.setViewportSize(viewport);
    await page.screenshot({ path: join(tmpdir(), `flaremail-compose-floating-${viewport.width}x${viewport.height}.png`), fullPage: false });
    const geometry = await composeDialog.evaluate((dialog) => {
      const panel = dialog.getBoundingClientRect();
      const header = dialog.querySelector('.compose-window-header')?.getBoundingClientRect();
      const body = dialog.querySelector('.compose-window-body')?.getBoundingClientRect();
      const footer = dialog.querySelector('.compose-window-footer')?.getBoundingClientRect();
      return { panelTop: panel.top, panelRight: panel.right, panelBottom: panel.bottom, headerBottom: header?.bottom, bodyHeight: body?.height, footerTop: footer?.top, footerBottom: footer?.bottom };
    });
    expect(geometry.panelTop).toBeGreaterThanOrEqual(0);
    expect(geometry.panelRight).toBeLessThanOrEqual(viewport.width);
    expect(geometry.panelBottom).toBeLessThanOrEqual(viewport.height);
    expect(geometry.bodyHeight).toBeGreaterThan(0);
    expect(geometry.footerTop).toBeGreaterThanOrEqual(geometry.headerBottom!);
    expect(geometry.footerBottom).toBeLessThanOrEqual(viewport.height);
    await assertNoHorizontalOverflow(page);
  }
  await page.setViewportSize({ width: 1366, height: 320 });
  await composeDialog.getByRole('button', { name: '调整写信窗口大小' }).press('ArrowUp');
  await composeDialog.getByRole('button', { name: '移动写信窗口' }).press('ArrowDown');
  let adjusted = await composeDialog.boundingBox();
  expect(adjusted!.y + adjusted!.height).toBeLessThanOrEqual(320);
  await composeDialog.getByRole('button', { name: '最大化写信窗口' }).click();
  await expect(composeDialog).toHaveAttribute('data-maximized', 'true');
  await composeDialog.getByRole('button', { name: '还原写信窗口' }).click();
  adjusted = await composeDialog.boundingBox();
  expect(adjusted!.y + adjusted!.height).toBeLessThanOrEqual(320);
  await composeDialog.getByRole('button', { name: '关闭' }).click();
  await expect(composeButton).toBeFocused();
  await assertNoConsoleErrors(consoleErrors);
});

test('keeps an open compose draft when its sidebar action is clicked again', async ({ page, consoleErrors }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Only the desktop floating compose leaves the sidebar action available.');
  await login(page);
  const composeButton = page.getByRole('button', { name: '写邮件', exact: true }).first();
  await composeButton.click();
  const compose = page.getByRole('dialog', { name: '新邮件' });
  const subject = compose.getByRole('textbox', { name: '主题', exact: true });
  const body = compose.getByRole('textbox', { name: '正文', exact: true });
  await subject.fill('Keep this unsaved subject');
  await body.fill('Keep this unsaved body.');
  await composeButton.click();
  await expect(compose).toBeVisible();
  await expect(subject).toHaveValue('Keep this unsaved subject');
  await expect(body).toHaveValue('Keep this unsaved body.');
  await compose.getByRole('button', { name: '最小化写信窗口' }).click();
  await expect(compose).toHaveAttribute('data-minimized', 'true');
  await composeButton.click();
  await expect(compose).toHaveAttribute('data-minimized', 'false');
  await expect(subject).toHaveValue('Keep this unsaved subject');
  await expect(body).toHaveValue('Keep this unsaved body.');
  await expect(compose.getByLabel('收件人')).toBeFocused();
  await page.screenshot({ path: '/tmp/flaremail-compose-repeat-preserved-desktop.png', fullPage: false });
  await assertNoConsoleErrors(consoleErrors);
});

test('downloads the compose editor on demand and recovers from an unavailable chunk', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'The desktop project checks the first editor download and failure path.');
  await login(page);
  const scriptResources = () => page.evaluate(() => performance.getEntriesByType('resource')
    .map((entry) => entry.name)
    .filter((url) => new URL(url).pathname.startsWith('/_app/immutable/chunks/') && url.endsWith('.js')));
  const before = await scriptResources();
  const composeButton = page.getByRole('button', { name: '写邮件', exact: true }).first();
  await composeButton.click();
  const compose = page.getByRole('dialog', { name: '新邮件' });
  await expect(compose).toBeVisible();
  await page.setViewportSize({ width: 1505, height: 1045 });
  await page.screenshot({ path: '/tmp/flaremail-lazy-compose-native-desktop.png', fullPage: false });
  const editorChunk = (await scriptResources()).find((url) => !before.includes(url));
  expect(editorChunk).toBeTruthy();
  await compose.getByRole('button', { name: '关闭' }).click();

  await page.route(editorChunk!, (route) => route.abort());
  await page.reload();
  await expect(page.getByRole('main', { name: '邮件工作区' })).toBeVisible();
  expect(await scriptResources()).not.toContain(editorChunk);
  await composeButton.click();
  await expect(page.getByRole('alert').filter({ hasText: '无法载入写信窗口' })).toBeVisible();
  await expect(compose).toHaveCount(0);
  await expect(page.getByRole('main', { name: '邮件工作区' })).toBeVisible();
  await page.unroute(editorChunk!);
  await page.reload();
  await expect(page.getByRole('main', { name: '邮件工作区' })).toBeVisible();
  await composeButton.click();
  await expect(compose).toBeVisible();
});

test('loads management panels on demand, supports deep links, and recovers after a failed download', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'The desktop project checks management chunk downloads and failure recovery.');
  await login(page);
  const scriptResources = () => page.evaluate(() => performance.getEntriesByType('resource')
    .map((entry) => entry.name)
    .filter((url) => new URL(url).pathname.startsWith('/_app/immutable/chunks/') && url.endsWith('.js')));
  const inboxScripts = await scriptResources();
  await page.setViewportSize({ width: 1505, height: 1045 });

  let releaseManagementChunk = () => {};
  const managementChunkGate = new Promise<void>((resolve) => { releaseManagementChunk = resolve; });
  await page.route('**/_app/immutable/chunks/*.js', async (route) => {
    await managementChunkGate;
    await route.continue();
  });
  try {
    await page.getByRole('button', { name: '账号菜单' }).click();
    await page.getByRole('menuitem', { name: '打开设置', exact: true }).click();
    const managementLoading = page.locator('[data-management-loading]');
    await expect(managementLoading).toBeVisible();
    await expect(managementLoading).toContainText('正在打开设置');
    expect(await managementLoading.locator('[aria-hidden="true"]').count()).toBeGreaterThanOrEqual(6);
    await assertNoHorizontalOverflow(page);
    await page.screenshot({ path: '/tmp/flaremail-management-loading-desktop.png', fullPage: false });
  } finally {
    releaseManagementChunk();
  }
  await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible();
  await page.unroute('**/_app/immutable/chunks/*.js');
  const settingsScripts = await scriptResources();
  expect(settingsScripts.some((url) => !inboxScripts.includes(url))).toBe(true);
  await page.goto('/?folder=settings&view=domains');
  await expect(page.getByRole('heading', { name: '域名概览' })).toBeVisible();
  const domainScripts = await scriptResources();
  expect(domainScripts.some((url) => !settingsScripts.includes(url))).toBe(true);
  await page.goto('/?folder=settings&view=addresses');
  await expect(page.getByRole('heading', { name: '受管邮件地址', exact: true })).toBeVisible();

  await page.goto('/?folder=inbox');
  await page.route('**/_app/immutable/chunks/*.js', (route) => route.abort());
  await page.getByRole('button', { name: '账号菜单' }).click();
  await page.getByRole('menuitem', { name: '打开设置', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: '无法载入设置' })).toBeVisible();
  await expect(page.getByRole('main', { name: '邮件工作区' })).toBeVisible();
  expect((await new AxeBuilder({ page }).include('main').analyze()).violations).toEqual([]);
  await page.screenshot({ path: '/tmp/flaremail-management-lazy-failure-desktop.png', fullPage: false });
  await page.unroute('**/_app/immutable/chunks/*.js');
  await page.reload();
  await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible();
});

test('keeps mobile navigation usable while the management panel downloads', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'The mobile project checks the loading layout at 390 px.');
  await login(page);
  let releaseManagementChunk = () => {};
  const managementChunkGate = new Promise<void>((resolve) => { releaseManagementChunk = resolve; });
  await page.route('**/_app/immutable/chunks/*.js', async (route) => {
    await managementChunkGate;
    await route.continue();
  });
  try {
    await page.getByRole('button', { name: '打开导航' }).click();
    await page.getByRole('navigation', { name: '移动端导航' }).getByRole('button', { name: '设置', exact: true }).click();
    const managementLoading = page.locator('[data-management-loading]');
    await expect(managementLoading).toBeVisible();
    await expect(page.getByRole('button', { name: '打开导航' })).toBeVisible();
    await assertNoHorizontalOverflow(page);
    expect((await new AxeBuilder({ page }).include('main').analyze()).violations).toEqual([]);
    await page.screenshot({ path: '/tmp/flaremail-management-loading-mobile.png', fullPage: false });
  } finally {
    releaseManagementChunk();
  }
  await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible();
  await page.unroute('**/_app/immutable/chunks/*.js');
});

test('autosaves a compose draft and restores it after refresh', async ({ page, consoleErrors }, testInfo) => {
  const isPhoneViewport = testInfo.project.name === 'mobile' || testInfo.project.name === 'narrow';
  await login(page);
  await page.getByRole('button', { name: '写邮件', exact: true }).first().click();
  const composeDialog = page.getByRole('dialog', { name: '新邮件' });
  await expect(composeDialog).toBeVisible();
  await expect(composeDialog).toHaveAttribute('aria-modal', isPhoneViewport ? 'true' : 'false');
  await page.screenshot({ path: `/tmp/flaremail-compose-floating-${testInfo.project.name}.png` });
  expect((await new AxeBuilder({ page }).include('.compose-dialog').analyze()).violations).toEqual([]);
  await page.getByLabel('收件人').fill('html-sen');
  const suggestion = composeDialog.getByRole('listbox', { name: '最近联系人建议' })
    .getByRole('option', { name: /html-sender@flaremail\.test/u });
  await expect(suggestion).toBeVisible();
  if (isPhoneViewport) {
    const suggestionBounds = await suggestion.boundingBox();
    expect(suggestionBounds?.height).toBeGreaterThanOrEqual(44);
    expect(suggestionBounds?.width).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: `/tmp/flaremail-compose-suggestion-${testInfo.project.name}.png`, fullPage: false });
  }
  expect((await new AxeBuilder({ page }).include('.compose-dialog').analyze()).violations).toEqual([]);
  await assertNoHorizontalOverflow(page);
  await page.getByLabel('收件人').press('Enter');
  const removeRecipient = composeDialog.getByRole('button', { name: '移除收件人 html-sender@flaremail.test' });
  await expect(removeRecipient).toBeVisible();
  if (isPhoneViewport) {
    const removeBounds = await removeRecipient.boundingBox();
    expect(removeBounds?.height).toBeGreaterThanOrEqual(44);
    expect(removeBounds?.width).toBeGreaterThanOrEqual(44);
    const ccBcc = composeDialog.getByRole('button', { name: '抄送/密送' });
    expect((await ccBcc.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    const subjectLabel = composeDialog.locator('.compose-subject span').first();
    const subjectField = composeDialog.getByRole('textbox', { name: '主题', exact: true });
    expect(Math.abs((await subjectLabel.boundingBox())!.y - (await subjectField.boundingBox())!.y)).toBeLessThan(20);
    await page.screenshot({ path: `/tmp/flaremail-compose-recipient-${testInfo.project.name}.png`, fullPage: false });
  }
  await removeRecipient.focus();
  await expect(composeDialog.getByRole('tooltip', { name: '移除收件人 html-sender@flaremail.test' })).toBeVisible();
  expect(await composeDialog.locator('[role="tooltip"]:not([hidden])').count()).toBe(1);
  if (testInfo.project.name === 'desktop' || isPhoneViewport) {
    await page.screenshot({ path: `/tmp/flaremail-compose-recipient-tooltip-${testInfo.project.name}.png`, fullPage: false });
  }
  await removeRecipient.click();
  await page.getByLabel('收件人').fill('draft-recipient@flaremail.test');
  await page.getByRole('textbox', { name: '主题', exact: true }).fill('E2E autosaved draft');
  await page.getByRole('textbox', { name: '正文', exact: true }).fill('This draft must survive a page refresh.');
  if (isPhoneViewport) {
    await expect(page.getByRole('textbox', { name: '正文', exact: true })).toHaveCSS('box-shadow', /inset/u);
    await expect(page.getByRole('status').filter({ hasText: '已自动保存于' })).toBeVisible({ timeout: 8_000 });
    await composeDialog.locator('.compose-window-body').evaluate((element) => { element.scrollTop = 0; });
    const dismissToast = page.getByRole('button', { name: '关闭通知' }).first();
    if (await dismissToast.isVisible()) await dismissToast.click();
    await page.mouse.move(1, 600);
    await page.screenshot({ path: `/tmp/flaremail-compose-layout-${testInfo.project.name}.png`, fullPage: false });
    await composeDialog.getByRole('button', { name: '抄送/密送' }).click();
    await expect(composeDialog.getByLabel('抄送', { exact: true })).toBeVisible();
    await expect(composeDialog.getByLabel('密送', { exact: true })).toBeVisible();
  }
  await composeDialog.getByRole('button', { name: 'HTML 写信选项' }).click();
  if (isPhoneViewport) {
    await expect(composeDialog.locator('#compose-html-options')).toHaveAttribute('open', '');
    await expect.poll(async () => {
      const summary = await composeDialog.locator('#compose-html-options > summary').boundingBox();
      const body = await composeDialog.locator('.compose-window-body').boundingBox();
      return Math.max(0, (summary?.y ?? 0) + (summary?.height ?? 0) - (body?.y ?? 0) - (body?.height ?? 0));
    }).toBeLessThan(1);
  }
  await composeDialog.getByLabel('HTML 源码（可选）', { exact: true }).fill('<p>This <strong>HTML</strong> draft must survive a page refresh.</p>');
  await expect(page.getByRole('status').filter({ hasText: '已自动保存于' })).toBeVisible({ timeout: 8_000 });
  if (isPhoneViewport) {
    await expect(composeDialog.locator('.mobile-status')).toHaveText('已保存');
    const cancel = await composeDialog.getByRole('button', { name: '取消', exact: true }).boundingBox();
    const save = await composeDialog.getByRole('button', { name: '保存草稿', exact: true }).boundingBox();
    const send = await composeDialog.getByRole('button', { name: '发送邮件', exact: true }).boundingBox();
    expect(cancel?.y).toBe(save?.y);
    expect(save?.y).toBe(send?.y);
    expect((send?.y ?? 0) + (send?.height ?? 0)).toBeLessThanOrEqual(page.viewportSize()!.height - 2);
  }
  await page.reload();
  await expect(page.getByRole('main', { name: '邮件工作区' })).toBeVisible();
  await openDraftEditor(page, 'E2E autosaved draft');
  await expect(page.getByLabel('HTML 源码（可选）', { exact: true })).toHaveValue('<p>This <strong>HTML</strong> draft must survive a page refresh.</p>');
  await assertNoConsoleErrors(consoleErrors);
});

test('keeps a long multi-attachment compose usable in a short mobile viewport', async ({ page, consoleErrors }, testInfo) => {
  test.skip(!['mobile', 'narrow'].includes(testInfo.project.name), 'Only phone-width projects exercise the full-screen compose.');
  test.setTimeout(90_000);
  const width = testInfo.project.name === 'narrow' ? 320 : 390;
  await page.setViewportSize({ width, height: 844 });
  await login(page);
  await page.locator('.mobile-bar').getByRole('button', { name: '写邮件' }).click();
  const compose = page.getByRole('dialog', { name: '新邮件' });
  await expect(page.locator('.toast-region .toast')).toHaveCount(0);
  const subject = `E2E Short Viewport ${width}`;
  const longBody = Array.from({ length: 100 }, (_, index) => `Line ${index + 1}: this draft keeps its text while the viewport gets shorter.`).join('\n');
  await compose.getByLabel('收件人').fill('short-viewport@flaremail.test');
  await compose.getByRole('textbox', { name: '主题', exact: true }).fill(subject);
  await compose.getByRole('textbox', { name: '正文', exact: true }).fill(longBody);
  await compose.getByLabel('选择附件').setInputFiles([
    { name: 'long-project-review-notes-one.txt', mimeType: 'text/plain', buffer: Buffer.alloc(128 * 1024, 0x41) },
    { name: 'long-project-review-notes-two.txt', mimeType: 'text/plain', buffer: Buffer.alloc(128 * 1024, 0x42) }
  ]);
  const attachments = compose.getByRole('list', { name: '待发送附件' });
  await expect(attachments.getByRole('listitem')).toHaveCount(2, { timeout: 30_000 });
  await expect(compose.locator('.compose-attachment-count:visible')).toHaveText('2');

  await page.setViewportSize({ width, height: 500 });
  const geometry = await compose.evaluate((dialog) => {
    const header = dialog.querySelector('.compose-window-header')!.getBoundingClientRect();
    const body = dialog.querySelector('.compose-window-body')! as HTMLElement;
    const footer = dialog.querySelector('.compose-window-footer')!.getBoundingClientRect();
    return { headerBottom: header.bottom, bodyHeight: body.clientHeight, bodyScrollHeight: body.scrollHeight, footerTop: footer.top, footerBottom: footer.bottom, viewportHeight: window.innerHeight };
  });
  expect(geometry.bodyHeight).toBeGreaterThan(80);
  expect(geometry.bodyScrollHeight).toBeGreaterThan(geometry.bodyHeight);
  expect(geometry.footerTop).toBeGreaterThanOrEqual(geometry.headerBottom);
  expect(geometry.footerBottom).toBeLessThanOrEqual(geometry.viewportHeight + 1);
  for (const name of ['添加附件', 'HTML 写信选项', '取消', '保存草稿', '发送邮件']) {
    await expect(compose.getByRole('button', { name, exact: true })).toBeVisible();
  }
  await compose.getByRole('textbox', { name: '正文', exact: true }).focus();
  await expect(compose.getByRole('textbox', { name: '正文', exact: true })).toBeFocused();
  await attachments.getByRole('listitem').last().scrollIntoViewIfNeeded();
  const bodyBounds = await compose.locator('.compose-window-body').boundingBox();
  const firstAttachment = attachments.getByRole('listitem').first();
  const [cardBounds, lastCardBounds, nameBounds, deleteBounds] = await Promise.all([
    firstAttachment.boundingBox(),
    attachments.getByRole('listitem').last().boundingBox(),
    firstAttachment.getByLabel('附件名称 long-project-review-notes-one.txt').boundingBox(),
    firstAttachment.getByRole('button', { name: '删除附件 long-project-review-notes-one.txt' }).boundingBox()
  ]);
  expect(bodyBounds).not.toBeNull();
  expect(cardBounds).not.toBeNull();
  expect(lastCardBounds).not.toBeNull();
  expect(nameBounds).not.toBeNull();
  expect(deleteBounds).not.toBeNull();
  expect(cardBounds!.y).toBeGreaterThanOrEqual(bodyBounds!.y);
  expect(lastCardBounds!.y + lastCardBounds!.height).toBeLessThanOrEqual(bodyBounds!.y + bodyBounds!.height + 1);
  expect(cardBounds!.height).toBeLessThanOrEqual(width === 390 ? 72 : 116);
  if (width === 390) expect(Math.abs(deleteBounds!.y - nameBounds!.y)).toBeLessThan(12);
  const deleteColor = await firstAttachment.getByRole('button', { name: '删除附件 long-project-review-notes-one.txt' }).evaluate((button) => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--fm-danger)';
    document.body.appendChild(probe);
    const result = { actual: getComputedStyle(button).color, expected: getComputedStyle(probe).color };
    probe.remove();
    return result;
  });
  expect(deleteColor.actual).toBe(deleteColor.expected);
  await assertNoHorizontalOverflow(page);
  expect((await new AxeBuilder({ page }).include('.compose-dialog').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()).violations).toEqual([]);
  await page.screenshot({ path: join(tmpdir(), `flaremail-compose-short-${testInfo.project.name}.png`), fullPage: false });
  await compose.getByRole('button', { name: '保存草稿', exact: true }).click();
  await expect(compose).toBeHidden();
  await expect(page.getByRole('region', { name: '邮件详情' }).getByRole('heading', { name: subject })).toBeVisible();
  await expect(page.getByRole('article', { name: '邮件正文详情' })).toContainText('Line 1: this draft keeps its text');
  await expect(page.getByRole('article', { name: '邮件正文详情' })).toContainText('Line 100: this draft keeps its text');
  if (testInfo.project.name === 'mobile') {
    await page.evaluate(() => localStorage.setItem('flaremail-theme', 'dark'));
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await openDraftEditor(page, subject);
    const darkCompose = page.getByRole('dialog', { name: '编辑草稿' });
    await expect(page.locator('.toast-region .toast')).toHaveCount(0);
    const darkAttachments = darkCompose.getByRole('list', { name: '待发送附件' });
    await expect(darkAttachments.getByRole('listitem')).toHaveCount(2);
    await darkAttachments.getByRole('listitem').last().scrollIntoViewIfNeeded();
    await expect(darkCompose.getByRole('textbox', { name: '正文', exact: true })).toHaveValue(longBody);
    await assertNoHorizontalOverflow(page);
    expect((await new AxeBuilder({ page }).include('.compose-dialog').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()).violations).toEqual([]);
    await page.screenshot({ path: join(tmpdir(), 'flaremail-compose-short-mobile-dark.png'), fullPage: false });
  }
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
  await expect(page.locator('.toast-region .toast')).toHaveCount(0);
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
  const addCcBcc = page.getByRole('button', { name: '抄送/密送' });
  const combinedRecipients = await addCcBcc.isVisible();
  if (combinedRecipients) await addCcBcc.click();
  else await page.getByRole('button', { name: '添加抄送', exact: true }).click();
  await page.getByLabel('抄送').fill('copy@flaremail.test; duplicate@flaremail.test');
  await page.getByLabel('抄送').press('Enter');
  if (!combinedRecipients) await page.getByRole('button', { name: '添加密送', exact: true }).click();
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
  const sender = page.getByLabel('发件地址');
  await expect(sender).toHaveValue('00000000-0000-4000-8000-000000000021');
  await sender.selectOption('00000000-0000-4000-8000-000000000022');
  const subject = 'E2E fake send';
  await page.getByLabel('收件人').fill('send-recipient@flaremail.test');
  await page.getByRole('textbox', { name: '主题', exact: true }).fill(subject);
  await page.getByRole('textbox', { name: '正文', exact: true }).fill('This message is sent by the local fake provider.');
  await page.getByRole('dialog', { name: '新邮件' }).getByRole('button', { name: 'HTML 写信选项' }).click();
  await page.getByLabel('HTML 源码（可选）', { exact: true }).fill('<p>This <em>HTML</em> message is sent by the local fake provider.</p>');
  await page.getByRole('button', { name: '发送邮件' }).click();
  const detail = page.getByRole('region', { name: '邮件详情' });
  await expect(detail.getByRole('heading', { name: subject, exact: true })).toBeVisible();
  await expect(detail.getByText('已提交', { exact: true }).first()).toBeVisible();
  expect(externalRequests).toEqual([]);
  expect(outboundPayload?.senderAddressId).toBe('00000000-0000-4000-8000-000000000022');
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
  await detail.locator('section[aria-labelledby="delivery-title"]').getByRole('button', { name: '刷新投递回执' }).click();
  await expect(detail.getByText('已送达', { exact: true }).first()).toBeVisible();
  await expect(detail.getByRole('list', { name: '投递事件列表' })).toContainText('已送达');
  await assertNoConsoleErrors(consoleErrors);
});

test('defaults new mail from the exact address filter and keeps domain views on the global default', async ({ page, consoleErrors }, testInfo) => {
  await login(page);
  const identityFilter = page.locator('#mail-identity-filter');
  await expect(identityFilter).toBeEnabled();

  await identityFilter.selectOption('address:00000000-0000-4000-8000-000000000022');
  await page.getByRole('button', { name: '写邮件', exact: true }).first().click();
  let composeDialog = page.getByRole('dialog', { name: '新邮件' });
  await expect(composeDialog.getByLabel('发件地址')).toHaveValue('00000000-0000-4000-8000-000000000022');
  if (testInfo.project.name === 'desktop') {
    await page.screenshot({ path: join(tmpdir(), 'flaremail-sender-exact-address-desktop.png'), fullPage: false });
  }
  await composeDialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(composeDialog).toBeHidden();

  await identityFilter.selectOption('domain:00000000-0000-4000-8000-000000000011');
  await page.getByRole('button', { name: '写邮件', exact: true }).first().click();
  composeDialog = page.getByRole('dialog', { name: '新邮件' });
  await expect(composeDialog.getByLabel('发件地址')).toHaveValue('00000000-0000-4000-8000-000000000021');
  await composeDialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(composeDialog).toBeHidden();
  await assertNoConsoleErrors(consoleErrors);
});

test('recovers a local Access-style edge 401 in another tab without losing or replaying a compose edit', async ({ page, context, consoleErrors }, testInfo) => {
  let expireNextSessionGet = false;
  let ajaxHeader: string | undefined;
  const draftWrites: Array<{ body?: string; subject?: string }> = [];
  await page.route('**/api/workspace/session', async (route) => {
    if (expireNextSessionGet && route.request().method() === 'GET') {
      expireNextSessionGet = false;
      ajaxHeader = route.request().headers()['x-requested-with'];
      await route.fulfill({ status: 401, contentType: 'text/html', body: '<html>Access session expired</html>' });
      return;
    }
    await route.continue();
  });
  page.on('request', (request) => {
    if (request.url().endsWith('/api/workspace/drafts') && request.method() === 'POST') {
      draftWrites.push(request.postDataJSON() as { body?: string; subject?: string });
    }
  });

  await login(page);
  await page.clock.install();
  await page.getByRole('button', { name: '写邮件', exact: true }).first().click();
  const composeDialog = page.getByRole('dialog', { name: '新邮件' });
  await composeDialog.getByLabel('收件人').fill('access-recovery@flaremail.test');
  await composeDialog.getByRole('textbox', { name: '主题', exact: true }).fill('Preserve this compose buffer');
  await composeDialog.getByRole('textbox', { name: '正文', exact: true }).fill('Draft text before session expiry');

  expireNextSessionGet = true;
  await page.evaluate(() => {
    const channel = new BroadcastChannel('flaremail-workspace-v1');
    channel.postMessage({ type: 'mail-identity-options-changed', nonce: 'e2e-auth-expiry', at: Date.now() });
    channel.close();
  });
  const expiredHeading = page.getByRole('heading', { name: '登录状态已过期' });
  await expect(expiredHeading).toBeVisible();
  await page.screenshot({ path: join(tmpdir(), `flaremail-auth-expired-${testInfo.project.name}.png`), fullPage: false });
  expect(ajaxHeader).toBe('XMLHttpRequest');
  await composeDialog.getByRole('textbox', { name: '正文', exact: true }).fill('Latest edit kept in the expired tab');
  await expect(composeDialog.getByRole('button', { name: '保存草稿', exact: true })).toBeDisabled();
  await expect(composeDialog.getByRole('button', { name: '发送邮件', exact: true })).toBeDisabled();
  await page.clock.runFor(5_000);
  expect(draftWrites).toHaveLength(0);

  await context.clearCookies();
  const reauthenticatedTab = await context.newPage();
  await login(reauthenticatedTab);
  await expect(expiredHeading).toBeHidden({ timeout: 10_000 });
  await expect(composeDialog.getByRole('textbox', { name: '正文', exact: true })).toHaveValue('Latest edit kept in the expired tab');
  await page.clock.runFor(5_000);
  expect(draftWrites).toHaveLength(0);

  await composeDialog.getByRole('button', { name: '保存草稿', exact: true }).click();
  await expect(composeDialog).toBeHidden();
  expect(draftWrites).toHaveLength(1);
  expect(draftWrites[0]).toMatchObject({ subject: 'Preserve this compose buffer', body: 'Latest edit kept in the expired tab' });
  const expectedEdgeUnauthorized = consoleErrors.filter((message) => message.includes('401 (Unauthorized)'));
  expect(expectedEdgeUnauthorized).toHaveLength(1);
  await assertNoConsoleErrors(consoleErrors.filter((message) => !message.includes('401 (Unauthorized)')));
  await reauthenticatedTab.close();
});

test('supports mobile detail drill-in and back navigation', async ({ page, consoleErrors }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'This flow verifies the mobile-only detail drill-in.');
  await login(page);
  const item = page.getByRole('listitem').filter({ hasText: 'E2E Inbox Welcome' });
  await item.getByRole('button', { name: /E2E Inbox Welcome/ }).first().click();
  const detail = page.getByRole('region', { name: '邮件详情' });
  await expect(detail.locator('header').first().getByText('收件箱', { exact: true })).toBeVisible();
  const geometry = await detail.locator('header').first().evaluate((header) => {
    const bounds = (selector: string) => header.querySelector<HTMLElement>(selector)?.getBoundingClientRect();
    const visibleActions = [...header.querySelectorAll<HTMLElement>('.message-primary-actions')]
      .find((navigation) => getComputedStyle(navigation).display !== 'none');
    return {
      chrome: bounds('.message-header-tools')?.bottom ?? 0,
      subject: bounds('.message-subject')?.top ?? 0,
      subjectBottom: bounds('.message-subject')?.bottom ?? 0,
      sender: bounds('.message-sender')?.top ?? 0,
      senderBottom: bounds('.message-sender')?.bottom ?? 0,
      actions: visibleActions?.getBoundingClientRect().top ?? 0
    };
  });
  expect(geometry.subject).toBeGreaterThanOrEqual(geometry.chrome - 1);
  expect(geometry.sender).toBeGreaterThanOrEqual(geometry.subjectBottom - 1);
  expect(geometry.actions).toBeGreaterThanOrEqual(geometry.senderBottom - 1);
  const actionsFollowSender = await detail.locator('header').first().evaluate((header) => {
    const sender = header.querySelector('.message-sender');
    const actions = [...header.querySelectorAll<HTMLElement>('nav.message-primary-actions')]
      .find((navigation) => getComputedStyle(navigation).display !== 'none');
    return Boolean(sender && actions && (sender.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING));
  });
  expect(actionsFollowSender, 'mobile reading order should follow the visible sender-before-actions layout').toBe(true);
  await expect(detail.getByRole('navigation', { name: '邮件操作' }).getByRole('button', { name: '回复', exact: true })).toContainText('回复');
  const dismissNotice = page.getByRole('button', { name: '关闭通知' });
  if (await dismissNotice.isVisible()) await dismissNotice.click();
  await page.screenshot({ path: join(tmpdir(), 'flaremail-mobile-detail-layout.png'), fullPage: false });
  await expect(page.getByRole('button', { name: '返回邮件列表' })).toBeVisible();
  await expect(page).toHaveURL(/message=/u);
  await page.reload();
  await expect(detail.getByRole('heading', { name: 'E2E Inbox Welcome' })).toBeVisible();
  await expect(page.getByRole('button', { name: '返回邮件列表' })).toBeVisible();
  await page.getByRole('button', { name: '返回邮件列表' }).click();
  await expect(page.getByRole('button', { name: /E2E Inbox Welcome/ }).first()).toBeVisible();
  await assertNoConsoleErrors(consoleErrors);
});

test('uses shared decorative avatars across account, mailbox, and reading views', async ({ page, consoleErrors }, testInfo) => {
  test.skip(testInfo.project.name === 'narrow', 'Desktop and 390 px mobile cover the avatar scale.');
  await login(page);
  if (testInfo.project.name === 'desktop') await page.setViewportSize({ width: 1505, height: 1045 });
  const accountAvatar = page.locator('.topbar .fm-avatar');
  if (testInfo.project.name === 'desktop') {
    await expect(accountAvatar).toBeVisible();
    const accountName = (await page.locator('.topbar .account-trigger-label').textContent())?.trim() ?? '';
    await expect(accountAvatar).toHaveText(accountName.slice(0, 2).toUpperCase() || 'FM');
    await expect(accountAvatar).toHaveAttribute('aria-hidden', 'true');
    expect((await accountAvatar.boundingBox())?.width).toBe(28);
  } else {
    await expect(accountAvatar).toBeHidden();
  }

  const inboxItem = page.getByRole('listitem').filter({ hasText: 'E2E Inbox Welcome' });
  const listAvatar = inboxItem.locator('.fm-avatar');
  await expect(listAvatar).toHaveText('E');
  await expect(listAvatar).toHaveAttribute('aria-hidden', 'true');
  expect((await listAvatar.boundingBox())?.width).toBe(36);
  await inboxItem.getByRole('button', { name: /E2E Inbox Welcome/u }).first().click();

  const detail = page.getByRole('region', { name: '邮件详情' });
  const senderAvatar = detail.locator('.message-sender .fm-avatar');
  await expect(senderAvatar).toHaveText('E');
  await expect(senderAvatar).toHaveAttribute('aria-hidden', 'true');
  expect((await senderAvatar.boundingBox())?.width).toBe(40);
  const dismissNotice = page.getByRole('button', { name: '关闭通知' });
  if (await dismissNotice.isVisible()) await dismissNotice.click();
  await page.screenshot({ path: join(tmpdir(), `flaremail-shared-avatar-${testInfo.project.name}.png`), fullPage: false });
  await assertNoHorizontalOverflow(page);

  await openFolder(page, '草稿箱');
  const draftAvatar = page.getByRole('listitem').filter({ hasText: 'E2E Existing Concurrent' }).locator('.fm-avatar');
  await expect(draftAvatar.locator('svg')).toBeVisible();
  await expect(draftAvatar).toHaveAttribute('aria-hidden', 'true');
  await assertNoConsoleErrors(consoleErrors);
});

test('keeps the active mobile folder title when reading across folders', async ({ page, consoleErrors }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'The compact detail header is mobile-only.');
  await login(page);
  const inboxItem = page.getByRole('listitem').filter({ hasText: 'E2E Inbox Welcome' });
  let addedStar = false;
  try {
    if (await inboxItem.getByRole('button', { name: '加星' }).isVisible()) {
      await inboxItem.getByRole('button', { name: '加星' }).click();
      addedStar = true;
    }
    await openFolder(page, '星标邮件');
    const starredItem = page.getByRole('listitem').filter({ hasText: 'E2E Inbox Welcome' });
    await starredItem.getByRole('button', { name: /E2E Inbox Welcome/u }).first().click();
    const detail = page.getByRole('region', { name: '邮件详情' });
    await expect(detail.locator('header').first().getByText('星标邮件', { exact: true })).toBeVisible();
    await detail.getByRole('button', { name: '返回邮件列表' }).click();
    await expect(page.getByRole('heading', { name: '星标邮件', exact: true })).toBeVisible();
    await assertNoHorizontalOverflow(page);
  } finally {
    if (addedStar) {
      const restored = await page.evaluate(async () => {
        const response = await fetch('/api/workspace/messages/e2e-inbox-message/flags', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ starred: false })
        });
        return response.ok;
      });
      expect(restored).toBe(true);
    }
  }
  await assertNoConsoleErrors(consoleErrors);
});

test('supports display preferences and keyboard shortcut help/navigation', async ({ page, consoleErrors }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'AppTopbar theme and command controls are desktop-only.');
  await login(page);
  const preferences = page.getByRole('button', { name: '显示偏好' });
  await expect(preferences).toBeVisible();
  await preferences.click();
  const darkTheme = page.getByRole('radio', { name: '深色' });
  await darkTheme.click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.keyboard.press('Escape');
  await expect(darkTheme).toBeHidden();
  await page.keyboard.press('?');
  await expect(page.getByRole('dialog', { name: '键盘快捷键' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: '键盘快捷键' })).toBeHidden();
  await page.keyboard.press('g');
  await page.keyboard.press('s');
  await expect(page).toHaveURL(/folder=sent/);
  await assertNoConsoleErrors(consoleErrors);
});

test('uses one keyboard stop per display preference radio group', async ({ page, consoleErrors }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Display preferences are in the desktop topbar.');
  await login(page);
  await page.evaluate(() => localStorage.setItem('flaremail-theme', 'light'));
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByRole('button', { name: '显示偏好' }).click();
  const dialog = page.getByRole('dialog', { name: '显示偏好' });
  const theme = dialog.getByRole('radiogroup', { name: '颜色主题' });
  const density = dialog.getByRole('radiogroup', { name: '显示密度' });
  const light = theme.getByRole('radio', { name: '浅色' });
  const dark = theme.getByRole('radio', { name: '深色' });
  const system = theme.getByRole('radio', { name: '跟随系统' });
  const standard = density.getByRole('radio', { name: '标准显示' });
  const compact = density.getByRole('radio', { name: '紧凑显示' });
  await expect(light).toBeFocused();
  await expect(light).toHaveAttribute('tabindex', '0');
  await expect(dark).toHaveAttribute('tabindex', '-1');
  await page.keyboard.press('ArrowRight');
  await expect(dark).toBeFocused();
  await expect(dark).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.keyboard.press('ArrowRight');
  await expect(system).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(light).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(standard).toBeFocused();
  await expect(compact).toHaveAttribute('tabindex', '-1');
  await page.keyboard.press('ArrowDown');
  await expect(compact).toBeFocused();
  await expect(compact).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Home');
  await expect(standard).toBeFocused();
  await expect(standard).toHaveAttribute('aria-checked', 'true');
  expect((await new AxeBuilder({ page }).include('#display-preferences-content').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()).violations).toEqual([]);
  await page.setViewportSize({ width: 1505, height: 1045 });
  await assertNoHorizontalOverflow(page);
  await page.screenshot({ path: join(tmpdir(), 'flaremail-display-preferences-keyboard-desktop.png'), fullPage: false });
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: '显示偏好' })).toBeFocused();
  await assertNoConsoleErrors(consoleErrors);
});

test('keeps one responsive search entry, three desktop topbar actions, and a visible reading viewport', async ({ page, consoleErrors }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'The desktop project drives the complete responsive width matrix.');
  await login(page);

  const topbar = page.locator('.topbar');
  const mobileBar = page.locator('.mobile-bar');
  const widths = [1920, 1440, 1366, 1280, 1024, 1023, 901, 900, 768, 480, 390, 320];
  for (const width of widths) {
    const height = width === 1920 ? 1080 : width === 1440 ? 900 : width <= 900 ? 844 : 768;
    await page.setViewportSize({ width, height });
    if (width >= 901) {
      await expect(topbar).toBeVisible();
      await expect(topbar.locator('.actions > *')).toHaveCount(3);
    } else {
      await expect(topbar).toBeHidden();
      const returnToList = page.getByRole('button', { name: '返回邮件列表' });
      if (await returnToList.isVisible()) {
        if (width <= 767) await expect(mobileBar).toBeHidden();
        await returnToList.click();
      }
      await expect(mobileBar).toBeVisible();
    }
    await expect(page.getByLabel('搜索邮件')).toHaveCount(1);
    await expect(page.getByLabel('搜索邮件')).toBeVisible();
    await assertNoHorizontalOverflow(page);
  }

  await page.setViewportSize({ width: 1366, height: 768 });
  const item = page.getByRole('listitem').filter({ hasText: 'E2E Inbox Welcome' });
  await item.getByRole('button', { name: /E2E Inbox Welcome/u }).first().click();
  const detail = page.getByRole('region', { name: '邮件详情' });
  await expect(detail.locator('.message-plain-body')).toBeVisible();
  const metrics = await detail.evaluate((element) => {
    const scroll = element.querySelector<HTMLElement>('.fm-detail-scroll');
    const body = element.querySelector<HTMLElement>('.message-plain-body');
    const detailRect = element.getBoundingClientRect();
    const scrollRect = scroll?.getBoundingClientRect();
    const viewportTop = Math.max(0, detailRect.top, scrollRect?.top ?? 0);
    const viewportBottom = Math.min(window.innerHeight, detailRect.bottom, scrollRect?.bottom ?? 0);
    return {
      bodyTop: body?.getBoundingClientRect().top ?? null,
      scrollTop: scrollRect?.top ?? null,
      detailHeaderHeight: scrollRect ? scrollRect.top - detailRect.top : null,
      visibleBodyHeight: Math.max(0, viewportBottom - viewportTop),
      viewportHeight: window.innerHeight
    };
  });
  expect(metrics.bodyTop).not.toBeNull();
  expect(metrics.scrollTop).not.toBeNull();
  expect(metrics.bodyTop! - metrics.scrollTop!).toBeLessThanOrEqual(100);
  expect(metrics.detailHeaderHeight).toBeLessThan(180);
  expect(metrics.visibleBodyHeight).toBeGreaterThanOrEqual(metrics.viewportHeight * 0.6);
  await page.screenshot({ path: join(tmpdir(), `flaremail-responsive-reading-${testInfo.project.name}.png`), fullPage: false });
  for (const { width, height } of [{ width: 1920, height: 1080 }, { width: 1440, height: 900 }]) {
    await page.setViewportSize({ width, height });
    await expect(detail.locator('.message-plain-body')).toBeVisible();
    await assertNoHorizontalOverflow(page);
    await page.screenshot({ path: join(tmpdir(), `flaremail-responsive-reading-${width}-${testInfo.project.name}.png`), fullPage: false });
  }
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

test('keeps the primary mail journey accessible in both themes', async ({ page, consoleErrors }, testInfo) => {
  test.setTimeout(120_000);
  test.skip(testInfo.project.name === 'narrow', 'Desktop and 390 px mobile cover the primary journey.');
  await login(page);
  if (testInfo.project.name === 'desktop') await page.setViewportSize({ width: 1505, height: 1045 });

  const scan = async (state: string) => {
    const { violations } = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(violations.flatMap(({ id, nodes }) => nodes.map(({ target }) => `${id}: ${target.join(', ')}`)), state).toEqual([]);
    await assertNoHorizontalOverflow(page);
  };

  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((nextTheme) => localStorage.setItem('flaremail-theme', nextTheme), theme);
    await page.goto('/?folder=inbox');
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(page.getByRole('list', { name: '收件箱邮件' })).toBeVisible();
    await scan(`${theme} inbox`);
    if (testInfo.project.name === 'desktop') {
      await page.screenshot({ path: join(tmpdir(), `flaremail-journey-inbox-${theme}-desktop.png`), fullPage: false });
    }

    await page.getByRole('listitem').filter({ hasText: 'E2E Inbox Welcome' })
      .getByRole('button', { name: /E2E Inbox Welcome/u }).first().click();
    await expect(page.getByRole('region', { name: '邮件详情' })).toBeVisible();
    await scan(`${theme} mail detail`);
    if (testInfo.project.name === 'mobile') {
      await page.screenshot({ path: join(tmpdir(), `flaremail-journey-detail-${theme}-mobile.png`), fullPage: false });
    }

    await openFolder(page, '收件箱');
    const compose = testInfo.project.name === 'mobile'
      ? page.locator('.mobile-bar').getByRole('button', { name: '写邮件' })
      : page.getByRole('button', { name: '写邮件', exact: true }).first();
    await compose.click();
    await expect(page.getByRole('dialog', { name: '新邮件' })).toBeVisible();
    await scan(`${theme} compose`);
    if (testInfo.project.name === 'mobile') {
      await page.screenshot({ path: join(tmpdir(), `flaremail-journey-compose-${theme}-mobile.png`), fullPage: false });
    }
    await page.getByRole('dialog', { name: '新邮件' }).getByRole('button', { name: '关闭' }).click();

    for (const [view, heading] of [
      ['', '设置'], ['domains', '域名概览'], ['addresses', '受管邮件地址']
    ] as const) {
      await page.goto(`/?folder=settings${view ? `&view=${view}` : ''}`);
      await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
      await scan(`${theme} ${view || 'settings'}`);
    }
  }
  await assertNoConsoleErrors(consoleErrors);
});

test('binds, confirms, enables, tests, and unbinds Telegram from a non-default mailbox view', async ({ page, consoleErrors }, testInfo) => {
  const telegram = await installTelegramApiMock(page);
  await login(page);
  await page.goto('/?folder=inbox&q=E2E%20Bulk%2030');
  await expect(page.getByRole('main', { name: '邮件工作区' })).toBeVisible();
  await openSettings(page);

  await expect(page.getByRole('heading', { name: 'Telegram 通知', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '生成 Telegram 绑定链接' }).click();
  const bindingLink = page.getByRole('link', { name: '打开 Telegram 继续绑定' });
  await expect(bindingLink).toHaveAttribute('href', /^https:\/\/t\.me\/flaremail_test_bot\?start=/u);
  await expect(bindingLink).toBeInViewport();
  await expect(page.getByLabel('也可以复制以下完整链接')).toHaveValue('https://t.me/flaremail_test_bot?start=abcdefghijklmnopqrstuvwxyz012345');
  await expect(page.getByLabel('也可以复制以下完整链接')).toBeInViewport();
  const command = page.getByLabel('完整绑定命令（含一次性绑定码）');
  await expect(command).toHaveValue('/start abcdefghijklmnopqrstuvwxyz012345');
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => {
      if (text !== '/start abcdefghijklmnopqrstuvwxyz012345') throw new Error('Incorrect binding command');
    } } });
  });
  await page.getByRole('button', { name: '复制绑定命令', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '完整绑定命令已复制' })).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('Clipboard unavailable'); } } });
  });
  await page.getByRole('button', { name: '复制绑定命令', exact: true }).click();
  await expect(command).toBeFocused();
  expect(await command.evaluate((element: HTMLTextAreaElement) => element.selectionEnd - element.selectionStart)).toBe('/start abcdefghijklmnopqrstuvwxyz012345'.length);
  await expect(page.getByRole('status').filter({ hasText: '无法自动复制' })).toBeVisible();
  await page.screenshot({ path: `/tmp/telegram-binding-${testInfo.project.name}.png` });
  telegram.receiveStart();
  await expect(page.getByRole('button', { name: '确认绑定', exact: true })).toBeVisible();
  expect(page.url()).not.toContain('start=');
  expect(await page.evaluate(() => Object.keys(localStorage).some((key) => /telegram/i.test(key)))).toBe(false);

  await page.getByRole('button', { name: '确认绑定' }).click();
  await expect(page.getByRole('button', { name: '发送测试通知' })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Telegram 绑定身份' })).toContainText('Alice E2E');

  const enabled = page.getByRole('switch', { name: '启用入站 Telegram 通知' });
  await expect(enabled).toHaveAttribute('aria-checked', 'false');
  await enabled.click();
  await expect(enabled).toHaveAttribute('aria-checked', 'true');

  telegram.setTestFailure(true);
  await page.getByRole('button', { name: '发送测试通知' }).click();
  await expect(page.getByRole('alert').filter({ hasText: '模拟 Telegram 限流' })).toBeVisible();
  telegram.setTestFailure(false);
  await page.getByRole('button', { name: '发送测试通知' }).click();
  await expect(page.getByRole('status').filter({ hasText: '测试通知已发送' })).toBeVisible();

  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: '解除绑定' }).click();
  await expect(page.getByRole('button', { name: '生成 Telegram 绑定链接' })).toBeVisible();
  if (testInfo.project.name !== 'desktop') await assertNoHorizontalOverflow(page);
  expect(consoleErrors.filter((error) => !error.includes('429 (Too Many Requests)')).length, `unexpected browser console errors: ${consoleErrors.join('\n')}`).toBe(0);
});

test('keeps Telegram binding polling alive beyond one minute and recovers from a failed read', async ({ page }) => {
  const telegram = await installTelegramApiMock(page);
  await login(page);
  await openSettings(page);
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  await page.getByRole('button', { name: '生成 Telegram 绑定链接' }).click();
  for (let index = 0; index < 14; index += 1) {
    const nextRead = page.waitForResponse((response) => response.url().endsWith('/telegram/settings'));
    await page.clock.runFor(5_000);
    await (await nextRead).finished();
    await page.evaluate(() => Promise.resolve());
  }
  telegram.failNextSettings();
  await page.clock.runFor(5_000);
  await expect(page.getByRole('alert').filter({ hasText: '模拟 Telegram 限流' })).toBeVisible();
  telegram.receiveStart();
  await page.clock.runFor(5_000);
  await expect(page.getByRole('button', { name: '确认绑定', exact: true })).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: '模拟 Telegram 限流' })).toHaveCount(0);
});

test('refreshes Telegram binding when returning to the page even after a reload lost the link', async ({ page }, testInfo) => {
  const telegram = await installTelegramApiMock(page);
  await login(page);
  await openSettings(page);
  await page.getByRole('button', { name: '生成 Telegram 绑定链接' }).click();
  await page.reload();
  await expect(page.getByRole('main', { name: '邮件工作区' })).toBeVisible();
  if (!await page.getByRole('heading', { name: '设置', exact: true }).isVisible()) await openSettings(page);
  await expect(page.getByLabel('完整绑定命令（含一次性绑定码）')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '刷新绑定状态', exact: true })).toBeVisible();
  telegram.receiveStart();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('button', { name: '确认绑定', exact: true })).toBeVisible();
  await expect(page.getByRole('group', { name: '确认 Telegram 绑定', exact: true })).toBeFocused();
  await expect(page.getByRole('button', { name: '确认绑定', exact: true })).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: `/tmp/telegram-return-${testInfo.project.name}.png` });
});

test('expires Telegram binding commands and stops polling at the link deadline', async ({ page }) => {
  const telegram = await installTelegramApiMock(page);
  await login(page);
  await openSettings(page);
  const now = new Date();
  await page.clock.install({ time: now });
  await page.clock.pauseAt(now);
  telegram.expireBindingAt(new Date(now.getTime() + 10_000).toISOString());
  await page.getByRole('button', { name: '生成 Telegram 绑定链接' }).click();
  await expect(page.getByLabel('完整绑定命令（含一次性绑定码）')).toBeVisible();
  await page.clock.fastForward(10_001);
  await expect(page.getByRole('status').filter({ hasText: '本次绑定链接已过期' })).toBeVisible();
  await expect(page.getByLabel('完整绑定命令（含一次性绑定码）')).toHaveCount(0);
  const reads = telegram.settingsRequests();
  await page.clock.runFor(30_000);
  expect(telegram.settingsRequests()).toBe(reads);
});

test('ignores a stale Telegram status read after confirmation and stops reads on unmount', async ({ page }) => {
  const telegram = await installTelegramApiMock(page);
  telegram.receiveStart();
  await login(page);
  await openSettings(page);
  await expect(page.getByRole('button', { name: '确认绑定', exact: true })).toBeVisible();
  let releaseRead: () => void = () => {};
  const heldRead = new Promise<void>((resolve) => { releaseRead = resolve; });
  let readStarted = false;
  await page.route('**/api/workspace/notifications/telegram/settings', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    readStarted = true;
    await heldRead;
    await route.fulfill({ json: { ok: true, data: mockTelegramStatus({ binding: 'candidate', enabled: false, privacyMode: false, summaryEnabled: false }) } }).catch(() => {});
  }, { times: 1 });
  try {
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect.poll(() => readStarted).toBe(true);
    await page.getByRole('button', { name: '确认绑定', exact: true }).click();
    await expect(page.getByRole('button', { name: '发送测试通知', exact: true })).toBeVisible();
  } finally {
    releaseRead();
  }
  await page.waitForTimeout(100);
  await expect(page.getByRole('button', { name: '确认绑定', exact: true })).toHaveCount(0);
  await page.clock.install();
  await openFolder(page, '收件箱');
  const reads = telegram.settingsRequests();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.clock.fastForward(30_000);
  expect(telegram.settingsRequests()).toBe(reads);
});

test('keeps Telegram controls unavailable to an unauthenticated browser', async ({ page, consoleErrors }) => {
  const response = await page.request.get('/api/workspace/notifications/telegram/settings');
  expect(response.status()).toBe(401);
  await page.goto('/?folder=profile');
  await expect(page.getByRole('heading', { name: '登录邮件工作台' })).toBeVisible();
  await expect(page.getByText('生成 Telegram 绑定链接', { exact: true })).toHaveCount(0);
  await assertNoConsoleErrors(consoleErrors);
});

test('has an accessible Telegram settings panel on mobile', async ({ page, consoleErrors }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'The mobile project covers the Telegram settings accessibility baseline.');
  await installTelegramApiMock(page);
  await login(page);
  await openSettings(page);
  await expect(page.getByRole('heading', { name: 'Telegram 通知', exact: true })).toBeVisible();
  expect((await new AxeBuilder({ page }).include('main').analyze()).violations).toEqual([]);
  await assertNoHorizontalOverflow(page);
  await assertNoConsoleErrors(consoleErrors);
});

test('renders a representative multi-domain message with two attachments for visual review', async ({ page, consoleErrors }, testInfo) => {
  test.skip(!['desktop', 'mobile'].includes(testInfo.project.name), 'The concept comparison uses desktop and 390 px mobile.');
  test.setTimeout(90_000);
  if (testInfo.project.name === 'desktop') await page.setViewportSize({ width: 1505, height: 1045 });
  await login(page);

  await page.getByRole('button', { name: '写邮件', exact: true }).first().click();
  const compose = page.getByRole('dialog', { name: '新邮件' });
  await compose.getByLabel('发件地址').selectOption('00000000-0000-4000-8000-000000000023');
  await compose.getByLabel('收件人').fill('reviewer@flaremail.test, second@flaremail.test');
  await compose.getByLabel('收件人').press('Enter');
  const addCcBcc = compose.getByRole('button', { name: '抄送/密送' });
  const combinedRecipients = await addCcBcc.isVisible();
  if (combinedRecipients) await addCcBcc.click();
  else await compose.getByRole('button', { name: '添加抄送', exact: true }).click();
  await compose.getByLabel('抄送').fill('copy@flaremail.test');
  await compose.getByLabel('抄送').press('Enter');
  if (!combinedRecipients) await compose.getByRole('button', { name: '添加密送', exact: true }).click();
  await compose.getByLabel('密送').fill('blind@flaremail.test');
  await compose.getByLabel('密送').press('Enter');
  const subject = '多域名邮箱发布检查清单';
  const body = [
    '你好，',
    '这是一封只在隔离本地环境中发送的多域名邮箱检查邮件。请确认以下事项：',
    '1. 收件箱、归档和已发送邮件在不同地址筛选下仍保持准确。',
    '2. 回复与转发保留原有发件身份，附件下载只对当前 Owner 开放。',
    '3. 桌面和手机阅读区能完整显示正文、两个附件及邮件信息。',
    '如有问题，请在发布前记录复现步骤。',
    'FlareMail 本地验收'
  ].join('\n\n');
  await compose.getByRole('textbox', { name: '主题', exact: true }).fill(subject);
  await compose.getByRole('textbox', { name: '正文', exact: true }).fill(body);
  await compose.getByLabel('选择附件').setInputFiles([
    { name: 'domain-review.csv', mimeType: 'text/csv', buffer: Buffer.from('domain,status\nflaremail.test,ready\nexample.test,ready\n') },
    { name: 'release-notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Synthetic local release notes for visual QA.\n') }
  ]);
  await expect(compose.getByRole('list', { name: '待发送附件' }).getByRole('listitem')).toHaveCount(2, { timeout: 15_000 });
  await expect(compose.getByRole('list', { name: '附件上传状态' })).toHaveCount(0);
  await compose.getByRole('button', { name: '发送邮件' }).click();

  const detail = page.getByRole('region', { name: '邮件详情' });
  await expect(detail.getByRole('heading', { name: subject, exact: true })).toBeVisible();
  await expect(detail.locator('.message-sender-identity')).toContainText('收件人');
  await expect(detail.locator('.message-sender-identity')).toContainText('另有 3 位收件人');
  await expect(detail.locator('.message-outbound-identity')).toContainText('postmaster@example.test');
  await expect(detail.locator('.message-plain-body')).toContainText('FlareMail 本地验收');
  const attachments = detail.getByRole('list', { name: '邮件附件列表' });
  await expect(attachments.getByRole('listitem')).toHaveCount(2);
  await expect(attachments.getByRole('link', { name: '下载附件 domain-review.csv' })).toBeVisible();
  await expect(attachments.getByRole('link', { name: '下载附件 release-notes.txt' })).toBeVisible();
  await expect(page.locator('#send-status-announcement')).toContainText('已提交到 fake');
  await expect(page.locator('.toast-region .toast.success')).toHaveCount(0);
  await expect(detail.getByText('已提交至投递服务').filter({ visible: true }).first()).toBeVisible();
  await assertNoHorizontalOverflow(page);
  const violations = (await new AxeBuilder({ page }).include('main').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()).violations;
  expect(violations.flatMap(({ id, nodes }) => nodes.map(({ target }) => `${id}: ${target.join(', ')}`))).toEqual([]);
  await page.screenshot({ path: join(tmpdir(), `flaremail-rich-detail-${testInfo.project.name}.png`), fullPage: false });
  if (testInfo.project.name === 'mobile') {
    await attachments.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(tmpdir(), 'flaremail-rich-detail-attachments-mobile.png'), fullPage: false });
  }
  await detail.getByText('收件人详情', { exact: true }).click();
  const recipients = detail.locator('dl').filter({ hasText: 'second@flaremail.test' });
  await expect(recipients).toContainText('copy@flaremail.test');
  await expect(recipients).toContainText('blind@flaremail.test');
  await recipients.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(tmpdir(), `flaremail-multi-recipients-${testInfo.project.name}.png`), fullPage: false });
  await assertNoHorizontalOverflow(page);
  await expect(page).toHaveURL(/message=/u);
  await page.reload();
  await expect(page.getByRole('region', { name: '邮件详情' }).locator('.message-outbound-identity')).toContainText('postmaster@example.test');
  await expect(page.getByRole('region', { name: '邮件详情' }).locator('.message-sender-identity')).toContainText('另有 3 位收件人');
  await assertNoConsoleErrors(consoleErrors);
});
