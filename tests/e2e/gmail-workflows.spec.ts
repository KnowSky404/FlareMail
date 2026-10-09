import type { Page, Response } from '@playwright/test';
import {
  assertNoConsoleErrors,
  assertNoHorizontalOverflow,
  expect,
  login,
  openFolder,
  test
} from './fixtures';

// All mutations below target only the isolated, non-routable local E2E fixtures.
test.describe.configure({ mode: 'default' });
const primaryAddressId = '00000000-0000-4000-8000-000000000021';
const supportAddressId = '00000000-0000-4000-8000-000000000022';
const categoryNames = ['全部', '主要', '推广', '社交', '更新', '论坛'];
type Category = 'all' | 'primary' | 'promotions' | 'social' | 'updates' | 'forums';
type Message = {
  id: string;
  subject: string;
  fromEmail: string;
  recipientAddressId?: string;
  senderAddressId?: string;
  read?: boolean;
  starred?: boolean;
  inboxCategory?: Category;
  inboxCategoryOverride?: Exclude<Category, 'all'> | null;
};

function mailboxResponse(response: Response, category: Category, cursor?: boolean) {
  const url = new URL(response.url());
  return url.pathname === '/api/workspace/mailbox'
    && (url.searchParams.get('category') ?? 'all') === category
    && (cursor === undefined || url.searchParams.has('cursor') === cursor)
    && response.ok();
}

async function mutateLocal(page: Page, path: string, method: string, body?: unknown) {
  const result = await page.evaluate(async ({ path, method, body }) => {
    const response = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { ok: response.ok, status: response.status, payload: await response.json() };
  }, { path, method, body });
  expect(result.ok, `${method} ${path}: ${result.status} ${JSON.stringify(result.payload)}`).toBe(true);
  return result.payload;
}

async function setCategory(page: Page, ids: string[], category: Exclude<Category, 'all'> | null) {
  await mutateLocal(page, '/api/workspace/mailbox/categories', 'PATCH', {
    ids,
    category,
    scope: { section: 'inbox', identityFilter: null, category: 'all' }
  });
}

async function readMessages(page: Page, category: Category = 'all') {
  const response = await page.request.get(`/api/workspace/mailbox?folder=inbox&category=${category}&limit=100`);
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json() as { data: { page: { messages: Message[] } } }).data.page.messages;
}

function row(page: Page, subject: string) {
  return page.locator('.mail-list-panel').getByRole('listitem').filter({ hasText: subject });
}

async function clickCategory(page: Page, label: string, category: Category) {
  await page.getByRole('tablist', { name: '收件箱分类' }).getByRole('tab', { name: label, exact: true }).click();
  await expect(page.locator('#inbox-category-panel')).toHaveAttribute('aria-labelledby', `inbox-tab-${category}`);
  await expect(page.getByRole('tab', { name: label, exact: true })).toHaveAttribute('aria-selected', 'true');
}

test.beforeEach(async ({ page, baseURL }) => {
  expect(new URL(baseURL!).hostname, 'Never run mutable fixture tests against a deployed mailbox').toBe('127.0.0.1');
  // These navigation and draft checks must never send mail, even accidentally.
  await page.route('**/api/send', (route) => route.abort('blockedbyclient'));
});

test('uses a full-width list by default and restores the same inbox after reading', async ({ page, consoleErrors }, testInfo) => {
  await login(page);
  await expect(page).not.toHaveURL(/message=/u);
  const list = page.locator('.mail-list-panel');
  const detail = page.getByRole('region', { name: '邮件详情' });
  await expect(list).toBeVisible();
  await expect(detail).toBeHidden();
  const dimensions = await page.locator('.mail-workspace').evaluate((workspace) => ({
    workspace: workspace.getBoundingClientRect().width,
    list: workspace.querySelector('.mail-list-panel')!.getBoundingClientRect().width
  }));
  expect(Math.abs(dimensions.workspace - dimensions.list)).toBeLessThanOrEqual(2);
  if (testInfo.project.name === 'desktop') {
    expect((await row(page, 'E2E Inbox Welcome').boundingBox())!.height).toBeLessThanOrEqual(64);
  }
  await page.screenshot({ path: testInfo.outputPath('gmail-inbox-default.png') });

  await clickCategory(page, '主要', 'primary');
  await row(page, 'E2E Inbox Welcome').getByRole('button', { name: /E2E Inbox Welcome/u }).first().click();
  await expect(detail.getByRole('heading', { name: 'E2E Inbox Welcome', exact: true })).toBeVisible();
  await expect(list).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath('gmail-message-reader.png') });
  await expect(page).toHaveURL(/category=primary/u);
  await page.goBack();
  await expect(list).toBeVisible();
  await expect(detail).toBeHidden();
  await expect(page).not.toHaveURL(/message=/u);
  await expect(page.getByRole('tab', { name: '主要', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.goForward();
  await expect(detail.getByRole('heading', { name: 'E2E Inbox Welcome', exact: true })).toBeVisible();
  await detail.getByRole('button', { name: '返回邮件列表' }).click();
  await expect(list).toBeVisible();
  await expect(page).not.toHaveURL(/message=/u);
  await expect(page.getByRole('tab', { name: '主要', exact: true })).toHaveAttribute('aria-selected', 'true');
  await assertNoHorizontalOverflow(page);
  await assertNoConsoleErrors(consoleErrors);
});

test('keeps sidebar collapse at the bottom with scrollable navigation and persists its state', async ({ page, consoleErrors }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'The sidebar is a desktop-only control.');
  await login(page);
  const sidebar = page.locator('#fm-main-sidebar');
  const footer = sidebar.locator('.sidebar-footer');
  const collapse = footer.getByRole('button', { name: '折叠侧边栏' });
  const assertFooterVisible = async () => {
    await expect(footer).toBeVisible();
    const bounds = await footer.boundingBox();
    const rail = await sidebar.boundingBox();
    expect(bounds!.y).toBeGreaterThan(rail!.y + rail!.height / 2);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(rail!.y + rail!.height);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  };
  await assertFooterVisible();
  await expect(collapse).toHaveAttribute('aria-expanded', 'true');
  await page.setViewportSize({ width: 1280, height: 480 });
  await sidebar.locator('.sidebar-navigation').evaluate((navigation) => navigation.scrollTop = navigation.scrollHeight);
  await assertFooterVisible();
  await collapse.focus();
  await page.keyboard.press('Enter');
  const expand = footer.getByRole('button', { name: '展开侧边栏' });
  await expect(expand).toHaveAttribute('aria-expanded', 'false');
  await assertFooterVisible();
  await page.reload();
  await expect(expand).toBeVisible();
  await expand.click();
  await expect(collapse).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(sidebar).toBeHidden();
  await page.getByRole('button', { name: '打开导航' }).click();
  await expect(page.getByRole('dialog', { name: '移动端导航' })).toBeVisible();
  await assertNoHorizontalOverflow(page);
  await assertNoConsoleErrors(consoleErrors);
});

test('keeps category navigation in one horizontal accessible tab strip', async ({ page, consoleErrors }) => {
  await login(page);
  const tabs = page.getByRole('tablist', { name: '收件箱分类' });
  await expect(tabs).toBeVisible();
  await expect(tabs.getByRole('tab')).toHaveCount(categoryNames.length);
  const geometry = await tabs.getByRole('tab').evaluateAll((elements) => elements.map((element) => {
    const bounds = element.getBoundingClientRect();
    return { top: bounds.top, left: bounds.left, width: bounds.width };
  }));
  for (let index = 1; index < geometry.length; index += 1) {
    expect(Math.abs(geometry[index].top - geometry[0].top)).toBeLessThanOrEqual(1);
    expect(geometry[index].left).toBeGreaterThan(geometry[index - 1].left);
    expect(geometry[index].width).toBeGreaterThan(0);
  }
  for (const name of categoryNames.slice(1)) {
    await expect(page.locator('#fm-main-sidebar').getByRole('button', { name, exact: true })).toHaveCount(0);
  }
  if (page.viewportSize()!.width <= 900) {
    await page.getByRole('button', { name: '打开导航' }).click();
    const navigation = page.getByRole('navigation', { name: '移动端导航' });
    await expect(navigation.getByRole('tablist')).toHaveCount(0);
    for (const name of categoryNames.slice(1)) {
      await expect(navigation.getByRole('button', { name, exact: true })).toHaveCount(0);
    }
    await page.keyboard.press('Escape');
  }
  // Roving keyboard focus must reveal the final tab on a narrow scroll strip.
  const all = tabs.getByRole('tab', { name: '全部', exact: true });
  const forums = tabs.getByRole('tab', { name: '论坛', exact: true });
  await all.focus();
  const forumsLoaded = page.waitForResponse((response) => mailboxResponse(response, 'forums'));
  await all.press('End');
  await forumsLoaded;
  await expect(forums).toBeFocused();
  await expect(forums).toHaveAttribute('aria-selected', 'true');
  await forums.press('Home');
  await expect(page.locator('#inbox-category-panel')).toHaveAttribute('aria-labelledby', 'inbox-tab-all');
  await expect(all).toBeFocused();
  await expect(all).toHaveAttribute('aria-selected', 'true');
  await assertNoHorizontalOverflow(page);
  await assertNoConsoleErrors(consoleErrors);
});

test('loads categories from the server and preserves deep links, history, pagination, and reset', async ({ page, consoleErrors }) => {
  test.setTimeout(75_000);
  await login(page);
  await setCategory(page, ['e2e-bulk-01'], 'promotions');
  await setCategory(page, ['e2e-bulk-02'], 'social');
  try {
    await page.goto('/?folder=inbox');
    await clickCategory(page, '推广', 'promotions');
    await expect(row(page, 'E2E Bulk 01')).toBeVisible();
    await expect(row(page, 'E2E Bulk 02')).toHaveCount(0);
    await clickCategory(page, '社交', 'social');
    await expect(row(page, 'E2E Bulk 02')).toBeVisible();
    await page.goBack();
    await expect(page.getByRole('tab', { name: '推广', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(row(page, 'E2E Bulk 01')).toBeVisible();
    await expect(row(page, 'E2E Bulk 02')).toHaveCount(0);
    await page.goForward();
    await expect(page.getByRole('tab', { name: '社交', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(row(page, 'E2E Bulk 02')).toBeVisible();
    await page.reload();
    await expect(page.getByRole('tab', { name: '社交', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(row(page, 'E2E Bulk 02')).toBeVisible();

    await page.goto('/?folder=inbox&category=primary');
    const nextPage = page.waitForResponse((response) => mailboxResponse(response, 'primary', true));
    await page.getByRole('button', { name: '加载更多', exact: true }).click();
    const response = await nextPage;
    const payload = await response.json() as { data: { page: { messages: Message[] } } };
    expect(payload.data.page.messages.every((message) => message.inboxCategory === 'primary')).toBe(true);
    await expect(row(page, 'E2E Bulk 45')).toBeVisible();
    await expect(row(page, 'E2E Bulk 01')).toHaveCount(0);
    await clickCategory(page, '推广', 'promotions');
    await expect(row(page, 'E2E Bulk 01')).toBeVisible();
    await expect(row(page, 'E2E Bulk 45')).toHaveCount(0);

    await openFolder(page, '已发送');
    await expect(page).not.toHaveURL(/category=/u);
    await expect(page.getByRole('tablist', { name: '收件箱分类' })).toHaveCount(0);
    await page.goto(`/?folder=inbox&category=promotions&q=NoSuchCategoryFixture&identity=address%3A${supportAddressId}`);
    await expect(page.getByRole('heading', { name: '没有匹配的邮件' })).toBeVisible();
    const reset = page.waitForResponse((response) => mailboxResponse(response, 'all', false)
      && !new URL(response.url()).searchParams.has('q')
      && !new URL(response.url()).searchParams.has('identity'));
    await page.getByRole('button', { name: '清除搜索和筛选', exact: true }).click();
    await reset;
    await expect(page).not.toHaveURL(/category=|q=|identity=|message=/u);
    await expect(page.getByRole('tab', { name: '全部', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(row(page, 'E2E Inbox Welcome')).toBeVisible();
    await expect(page.getByRole('region', { name: '邮件详情' })).toBeHidden();
  } finally {
    await setCategory(page, ['e2e-bulk-01', 'e2e-bulk-02'], null);
  }
  await assertNoHorizontalOverflow(page);
  await assertNoConsoleErrors(consoleErrors);
});

test('persists a manual category for only the selected message without changing its identity', async ({ page, consoleErrors }) => {
  await login(page);
  const before = (await readMessages(page)).find((message) => message.id === 'e2e-inbox-message')!;
  await page.getByLabel('选择E2E Inbox Welcome').check();
  const changed = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/workspace/mailbox/categories'
    && response.request().method() === 'PATCH' && response.ok());
  await page.getByRole('button', { name: '更改收件分类' }).click();
  await page.getByRole('menuitem', { name: '更新', exact: true }).click();
  try {
    const response = await changed;
    expect(response.request().postDataJSON()).toMatchObject({ ids: ['e2e-inbox-message'], category: 'updates' });
    await clickCategory(page, '更新', 'updates');
    await expect(row(page, 'E2E Inbox Welcome')).toBeVisible();
    await page.reload();
    await expect(row(page, 'E2E Inbox Welcome')).toBeVisible();
    const persisted = await readMessages(page, 'updates');
    expect(persisted.map((message) => message.id)).toEqual(['e2e-inbox-message']);
    expect(persisted[0]).toMatchObject({
      inboxCategory: 'updates', inboxCategoryOverride: 'updates',
      fromEmail: before.fromEmail, recipientAddressId: before.recipientAddressId
    });
    await clickCategory(page, '主要', 'primary');
    await expect(row(page, 'E2E Inbox Welcome')).toHaveCount(0);
    await expect(row(page, 'E2E HTML Safety')).toBeVisible();
  } finally {
    await setCategory(page, ['e2e-inbox-message'], null);
  }
  await assertNoConsoleErrors(consoleErrors);
});

test('remembers optional split reading and can return to the full-width list', async ({ page, consoleErrors }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'The optional simultaneous preview is desktop-only.');
  await login(page);
  await page.getByRole('button', { name: '显示分栏预览', exact: true }).click();
  await expect(page.locator('.mail-splitter')).toBeVisible();
  await row(page, 'E2E Inbox Welcome').getByRole('button', { name: /E2E Inbox Welcome/u }).first().click();
  await expect(page.locator('.mail-list-panel')).toBeVisible();
  await expect(page.getByRole('region', { name: '邮件详情' }).getByRole('heading', { name: 'E2E Inbox Welcome', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.locator('.mail-list-panel')).toBeVisible();
  await expect(page.locator('.mail-splitter')).toBeVisible();
  await page.getByRole('button', { name: '关闭分栏预览', exact: true }).click();
  const back = page.getByRole('button', { name: '返回邮件列表' });
  if (await back.isVisible()) await back.click();
  await expect(page.locator('.mail-list-panel')).toBeVisible();
  await expect(page.locator('.mail-splitter')).toBeHidden();
  await page.reload();
  await expect(page.getByRole('button', { name: '显示分栏预览', exact: true })).toBeVisible();
  await assertNoHorizontalOverflow(page);
  await assertNoConsoleErrors(consoleErrors);
});

test('opens a draft directly with its saved sender and supports row trash with undo', async ({ page, consoleErrors }, testInfo) => {
  await login(page);
  const subject = `E2E Direct Draft ${testInfo.project.name} ${Date.now()}`;
  const created = await mutateLocal(page, '/api/workspace/drafts', 'POST', {
    to: [{ email: 'draft-recipient@flaremail.test', name: 'Draft Fixture' }],
    senderAddressId: supportAddressId,
    subject,
    body: 'Saved support identity survives direct draft editing.'
  }) as { data: { message: Message } };
  const draftId = created.data.message.id;
  try {
    await openFolder(page, '草稿箱');
    const draft = row(page, subject);
    await expect(draft).toBeVisible();
    await draft.getByRole('button', { name: new RegExp(subject, 'u') }).first().click();
    const editor = page.getByRole('dialog', { name: '编辑草稿' });
    await expect(editor).toBeVisible();
    await expect(editor.getByLabel('发件地址')).toHaveValue(supportAddressId);
    await expect(editor.getByRole('textbox', { name: '正文', exact: true })).toHaveValue('Saved support identity survives direct draft editing.');
    await expect(page).not.toHaveURL(/message=/u);
    await editor.getByRole('button', { name: '关闭', exact: true }).click();
    await expect(editor).toBeHidden();
    await draft.getByRole('button', { name: '移入垃圾箱', exact: true }).click();
    await expect(draft).toHaveCount(0);
    await expect(editor).toBeHidden();
    await page.getByRole('status').filter({ hasText: '已移入垃圾箱' }).getByRole('button', { name: '撤销' }).click();
    await expect(draft).toBeVisible();
    await page.reload();
    await expect(draft).toBeVisible();
    await draft.getByRole('button', { name: new RegExp(subject, 'u') }).first().click();
    await expect(editor.getByLabel('发件地址')).toHaveValue(supportAddressId);
    await assertNoHorizontalOverflow(page);
    await editor.getByRole('button', { name: '关闭', exact: true }).click();
  } finally {
    // Remove only the synthetic fixture created above, leaving seeded draft counts unchanged.
    await mutateLocal(page, `/api/workspace/messages/${encodeURIComponent(draftId)}`, 'DELETE');
  }
  await assertNoConsoleErrors(consoleErrors);
});

test('keeps reply, reply-all, and forward tied to the selected delivery identity', async ({ page, consoleErrors }) => {
  await login(page);
  let sendRequests = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/send') sendRequests += 1;
  });
  const savedDrafts: Array<Promise<string>> = [];
  page.on('response', (response) => {
    if (new URL(response.url()).pathname === '/api/workspace/drafts' && response.request().method() === 'POST' && response.ok()) {
      savedDrafts.push(response.json().then((payload) => payload.data.message.id as string));
    }
  });
  await row(page, 'E2E HTML Safety').getByRole('button', { name: /E2E HTML Safety/u }).first().click();
  const detail = page.getByRole('region', { name: '邮件详情' });
  if (page.viewportSize()!.width >= 640) {
    const replies = detail.locator('.message-reply-actions');
    await expect(replies).toBeVisible();
    const [replyBounds, headerBounds] = await Promise.all([replies.boundingBox(), detail.locator('.message-detail-header').boundingBox()]);
    expect(replyBounds!.y).toBeGreaterThanOrEqual(headerBounds!.y + headerBounds!.height);
  }
  try {
    for (const [action, title] of [['回复', '回复邮件'], ['回复全部', '回复邮件'], ['转发', '转发邮件']] as const) {
      await detail.getByRole('button', { name: action, exact: true }).click();
      const editor = page.getByRole('dialog', { name: title });
      await expect(editor).toBeVisible();
      await expect(editor.getByLabel('发件地址')).toHaveValue(primaryAddressId);
      if (action === '回复全部') {
        await expect(editor.getByRole('button', { name: '移除抄送 observer@flaremail.test' })).toBeVisible();
        await expect(editor.getByRole('button', { name: '移除抄送 team@flaremail.test' })).toBeVisible();
      }
      await editor.getByRole('button', { name: '关闭', exact: true }).click();
      await expect(editor).toBeHidden();
    }
    expect(sendRequests).toBe(0);
  } finally {
    for (const id of new Set(await Promise.all(savedDrafts))) {
      await mutateLocal(page, `/api/workspace/messages/${encodeURIComponent(id)}`, 'DELETE');
    }
  }
  await assertNoConsoleErrors(consoleErrors);
});


test('keeps row read, star, archive, trash and undo actions in the list and preserves identity', async ({ page, consoleErrors }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Desktop hover reveals the Gmail-style row actions.');
  await login(page);
  const id = 'e2e-bulk-03';
  const before = (await readMessages(page)).find((message) => message.id === id)!;
  const target = row(page, 'E2E Bulk 03');
  try {
    await target.hover();
    await target.getByRole('button', { name: before.read ? '标为未读' : '标为已读', exact: true }).click();
    await expect(target.getByRole('button', { name: before.read ? '标为已读' : '标为未读', exact: true })).toBeVisible();
    await expect(page).not.toHaveURL(/message=/u);
    await expect(page.getByRole('region', { name: '邮件详情' })).toBeHidden();
    await target.getByRole('button', { name: before.starred ? '取消星标' : '加星', exact: true }).click();
    await expect(target.getByRole('button', { name: before.starred ? '加星' : '取消星标', exact: true })).toHaveAttribute('aria-pressed', before.starred ? 'false' : 'true');
    await target.hover();
    await target.getByRole('button', { name: '归档', exact: true }).click();
    await expect(target).toHaveCount(0);
    await expect(page).not.toHaveURL(/message=/u);
    await openFolder(page, '归档');
    await expect(target).toBeVisible();
    await target.hover();
    await target.getByRole('button', { name: '移入垃圾箱', exact: true }).click();
    await expect(target).toHaveCount(0);
    await expect(page.locator('.mail-list-panel')).toBeVisible();
    await expect(page.getByRole('region', { name: '邮件详情' })).toBeHidden();
    await page.getByRole('status').filter({ hasText: '已移入垃圾箱' }).getByRole('button', { name: '撤销' }).click();
    await expect(target).toBeVisible();
    await expect(page).toHaveURL(/folder=archive/u);
    await target.hover();
    await target.getByRole('button', { name: '移回收件箱', exact: true }).click();
    await expect(target).toHaveCount(0);
    await openFolder(page, '收件箱');
    await expect(target).toBeVisible();
    const after = (await readMessages(page)).find((message) => message.id === id)!;
    expect(after).toMatchObject({ fromEmail: before.fromEmail, recipientAddressId: before.recipientAddressId });
    await expect(page.getByRole('region', { name: '邮件详情' })).toBeHidden();
  } finally {
    // Recover only our seeded target if an assertion failed before Undo.
    const trashResponse = await page.request.get('/api/workspace/trash?limit=500');
    expect(trashResponse.ok()).toBe(true);
    const trash = await trashResponse.json() as { data: { items: Array<{ id: string }> } };
    if (trash.data.items.some((item) => item.id === id)) {
      await mutateLocal(page, `/api/workspace/trash/${id}`, 'POST');
    }
    const archived = await page.request.get('/api/workspace/mailbox?folder=archive&limit=100');
    const payload = await archived.json() as { data: { page: { messages: Message[] } } };
    if (payload.data.page.messages.some((message) => message.id === id)) {
      await mutateLocal(page, '/api/workspace/mailbox/mutate', 'POST', {
        action: 'unarchive', ids: [id], threadKeys: [],
        scope: { section: 'archive', identityFilter: null, threadScope: 'selected' }
      });
    }
    await mutateLocal(page, `/api/workspace/messages/${id}/flags`, 'PATCH', { read: before.read, starred: before.starred });
  }
  await assertNoConsoleErrors(consoleErrors);
});

test('ignores a slower category response after newer category navigation', async ({ page, consoleErrors }) => {
  await login(page);
  await setCategory(page, ['e2e-bulk-01'], 'promotions');
  await setCategory(page, ['e2e-bulk-02'], 'social');
  let releasePromotions!: () => void;
  const promotionsGate = new Promise<void>((resolve) => (releasePromotions = resolve));
  await page.route('**/api/workspace/mailbox?**', async (route) => {
    if (new URL(route.request().url()).searchParams.get('category') === 'promotions') await promotionsGate;
    // A newer category intentionally aborts the older request.
    await route.continue().catch(() => {});
  });
  try {
    const requested = page.waitForRequest((request) => new URL(request.url()).pathname === '/api/workspace/mailbox'
      && new URL(request.url()).searchParams.get('category') === 'promotions');
    await page.getByRole('tab', { name: '推广', exact: true }).click();
    await requested;
    await clickCategory(page, '社交', 'social');
    await expect(row(page, 'E2E Bulk 02')).toBeVisible();
    releasePromotions();
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL(/category=social/u);
    await expect(page.getByRole('tab', { name: '社交', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(row(page, 'E2E Bulk 01')).toHaveCount(0);
    await expect(row(page, 'E2E Bulk 02')).toBeVisible();
    await expect(page.getByRole('region', { name: '邮件详情' })).toBeHidden();
  } finally {
    releasePromotions();
    await page.unroute('**/api/workspace/mailbox?**');
    await setCategory(page, ['e2e-bulk-01', 'e2e-bulk-02'], null);
  }
  await assertNoConsoleErrors(consoleErrors);
});

test('does not let a delayed mark-read response replace a newer selected message', async ({ page, consoleErrors }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'The split reading preference makes both message targets available.');
  await login(page);
  await page.getByRole('button', { name: '显示分栏预览', exact: true }).click();
  await mutateLocal(page, '/api/workspace/messages/e2e-inbox-message/flags', 'PATCH', { read: false });
  await page.reload();
  let releaseRead!: () => void;
  const readGate = new Promise<void>((resolve) => (releaseRead = resolve));
  await page.route('**/api/workspace/messages/e2e-inbox-message/flags', async (route) => {
    await readGate;
    await route.continue().catch(() => {});
  });
  try {
    const readStarted = page.waitForRequest((request) => new URL(request.url()).pathname === '/api/workspace/messages/e2e-inbox-message/flags');
    await row(page, 'E2E Inbox Welcome').getByRole('button', { name: /E2E Inbox Welcome/u }).first().click();
    await readStarted;
    await row(page, 'E2E HTML Safety').getByRole('button', { name: /E2E HTML Safety/u }).first().click();
    const detail = page.getByRole('region', { name: '邮件详情' });
    await expect(detail.getByRole('heading', { name: 'E2E HTML Safety', exact: true })).toBeVisible();
    const readFinished = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/workspace/messages/e2e-inbox-message/flags' && response.ok());
    releaseRead();
    await readFinished;
    await expect(detail.getByRole('heading', { name: 'E2E HTML Safety', exact: true })).toBeVisible();
    await expect(page).toHaveURL(/message=email%3Ae2e-html-inbox-message/u);
    await expect(detail.getByRole('article', { name: '邮件正文详情' })).toContainText('Safe HTML fixture text fallback.');
  } finally {
    releaseRead();
    await page.unroute('**/api/workspace/messages/e2e-inbox-message/flags');
  }
  await assertNoConsoleErrors(consoleErrors);
});

test('opens a category deep link beyond the first page without selecting a visible substitute', async ({ page, consoleErrors }) => {
  await login(page);
  await page.goto('/?folder=inbox&category=primary&message=e2e-bulk-45');
  const detail = page.getByRole('region', { name: '邮件详情' });
  await expect(detail.getByRole('heading', { name: 'E2E Bulk 45', exact: true })).toBeVisible();
  await expect(detail.getByRole('article', { name: '邮件正文详情' })).toContainText('Paginated fixture body');
  await expect(page).toHaveURL(/category=primary/u);
  await expect(page).toHaveURL(/message=e2e-bulk-45/u);
  await detail.getByRole('button', { name: '返回邮件列表' }).click();
  await expect(page.getByRole('tab', { name: '主要', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page).not.toHaveURL(/message=/u);
  await expect(page.locator('.mail-list-panel')).toBeVisible();
  await assertNoConsoleErrors(consoleErrors);
});

test('opens only the newest draft and ignores a delayed draft after leaving its folder', async ({ page, consoleErrors }) => {
  await login(page);
  await openFolder(page, '草稿箱');
  const draftPath = '/api/workspace/drafts/e2e-draft-1';
  const delayedDraft = row(page, 'E2E Existing Concurrent');
  const newerDraft = row(page, 'E2E Conflict Load');

  async function delayDraftLoad() {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await page.route(`**${draftPath}`, async (route) => {
      await gate;
      // Latest-request cancellation is expected when another draft or folder wins.
      await route.continue().catch(() => {});
    });
    const requested = page.waitForRequest((request) => new URL(request.url()).pathname === draftPath);
    await delayedDraft.getByRole('button', { name: /E2E Existing Concurrent/u }).first().click();
    await requested;
    return release;
  }

  let release = await delayDraftLoad();
  try {
    await newerDraft.getByRole('button', { name: /E2E Conflict Load/u }).first().click();
    const editor = page.getByRole('dialog', { name: '编辑草稿' });
    await expect(editor.getByRole('textbox', { name: '主题', exact: true })).toHaveValue('E2E Conflict Load');
    release();
    await page.waitForLoadState('networkidle');
    await expect(editor.getByRole('textbox', { name: '主题', exact: true })).toHaveValue('E2E Conflict Load');
    await editor.getByRole('button', { name: '关闭', exact: true }).click();
    await expect(editor).toBeHidden();
  } finally {
    release();
    await page.unroute(`**${draftPath}`);
  }

  release = await delayDraftLoad();
  try {
    await openFolder(page, '收件箱');
    release();
    await page.waitForLoadState('networkidle');
    await expect(row(page, 'E2E Inbox Welcome')).toBeVisible();
    await expect(page.getByRole('dialog', { name: '编辑草稿' })).toBeHidden();
    await expect(page).toHaveURL(/folder=inbox/u);
    await expect(page).not.toHaveURL(/message=/u);
  } finally {
    release();
    await page.unroute(`**${draftPath}`);
  }
  await assertNoConsoleErrors(consoleErrors);
});

test('reuses warm category pages with their loaded cursor and no blocking request', async ({ page, consoleErrors }, testInfo) => {
  const reads: string[] = [];
  page.on('request', (request) => { if (new URL(request.url()).pathname.endsWith('/flags')) reads.push(request.url()); });
  await login(page);
  await clickCategory(page, '主要', 'primary');
  const nextPage = page.waitForResponse((response) => mailboxResponse(response, 'primary', true));
  await page.getByRole('button', { name: '加载更多', exact: true }).click();
  await nextPage;
  await expect(row(page, 'E2E Bulk 45')).toBeAttached();
  const scroller = page.locator('.fm-list-scroll');
  await scroller.evaluate((element) => { element.scrollTop = 280; });
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBe(280);
  await clickCategory(page, '论坛', 'forums');
  await page.waitForLoadState('networkidle');
  const requested: string[] = [];
  page.on('request', (request) => { if (new URL(request.url()).pathname === '/api/workspace/mailbox') requested.push(request.url()); });
  await clickCategory(page, '主要', 'primary');
  await expect(row(page, 'E2E Bulk 45')).toBeAttached();
  await expect(page.getByRole('status', { name: '正在加载邮件', exact: true })).toHaveCount(0);
  await expect(page.getByRole('region', { name: '邮件详情' })).toBeHidden();
  await page.waitForLoadState('networkidle');
  expect(requested).toEqual([]);
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBe(280);
  expect(reads, 'Viewing a list/category must not mark its hidden selection read').toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('warm-inbox-category.png') });
  await assertNoHorizontalOverflow(page);
  await assertNoConsoleErrors(consoleErrors);
});

test('shows identity-wide unread badges and auto-reads deep links once per visible opening', async ({ page, consoleErrors }, testInfo) => {
  await login(page);
  const id = 'e2e-inbox-message';
  const before = (await readMessages(page)).find((message) => message.id === id)!;
  const scope = `address:${primaryAddressId}`;
  async function badge() {
    const response = await page.request.get(`/api/workspace/mailbox/metrics?identity=${scope}`);
    const { data } = await response.json();
    if (testInfo.project.name === 'desktop') {
      const count = page.locator('#fm-main-sidebar').getByRole('button', { name: '收件箱', exact: true }).locator('.count');
      await expect(count).toHaveText(String(data.metrics.unreadCount));
      await expect(count).toHaveAttribute('aria-label', `${data.metrics.unreadCount} 未读`);
    } else {
      await page.getByRole('button', { name: '打开导航' }).click();
      const count = page.getByRole('navigation', { name: '移动端导航' }).getByRole('button').filter({ hasText: '收件箱' }).locator('small');
      await expect(count).toHaveText(String(data.metrics.unreadCount));
      await page.keyboard.press('Escape');
    }
    return data.metrics.unreadCount;
  }
  try {
    await mutateLocal(page, `/api/workspace/messages/${id}/flags`, 'PATCH', { read: false });
    // A category with no welcome mail still shows the address-wide unread total.
    await page.goto(`/?folder=inbox&category=forums&identity=${encodeURIComponent(scope)}`);
    await badge();
    const readStarted = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/workspace/messages/${id}/flags` && response.ok());
    await page.goto(`/?folder=inbox&category=forums&identity=${encodeURIComponent(scope)}&message=${id}`);
    await readStarted;
    const detail = page.getByRole('region', { name: '邮件详情' });
    await expect(detail.getByRole('heading', { name: 'E2E Inbox Welcome', exact: true })).toBeVisible();
    await expect(detail.getByRole('article', { name: '邮件正文详情' })).toContainText('isolated local D1');
    await detail.getByRole('button', { name: '标为未读', exact: true }).click();
    await expect(detail.getByRole('button', { name: '标为已读', exact: true })).toBeVisible();
    await page.waitForLoadState('networkidle');
    expect((await readMessages(page)).find((message) => message.id === id)?.read).toBe(false);
    await detail.getByRole('button', { name: '返回邮件列表' }).click();
    await badge();
    const standaloneRead = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/workspace/messages/${id}/flags` && response.ok());
    await page.goto(`/messages/${id}`);
    await standaloneRead;
    await expect(page.getByRole('heading', { name: 'E2E Inbox Welcome', exact: true })).toBeVisible();
    expect((await readMessages(page)).find((message) => message.id === id)?.read).toBe(true);
  } finally {
    await mutateLocal(page, `/api/workspace/messages/${id}/flags`, 'PATCH', { read: before.read });
  }
  await assertNoConsoleErrors(consoleErrors);
});

test('finishes new folder navigation when an older read write interrupts its request', async ({ page, consoleErrors }) => {
  await login(page);
  await mutateLocal(page, '/api/workspace/messages/e2e-inbox-message/flags', 'PATCH', { read: false });
  await page.reload();
  let releaseRead!: () => void;
  let releasePage!: () => void;
  const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
  const pageGate = new Promise<void>((resolve) => { releasePage = resolve; });
  let sentRequests = 0;
  await page.route('**/api/workspace/messages/e2e-inbox-message/flags', async (route) => { await readGate; await route.continue().catch(() => {}); });
  await page.route('**/api/workspace/mailbox?**', async (route) => {
    if (new URL(route.request().url()).searchParams.get('folder') === 'sent' && ++sentRequests === 1) await pageGate;
    await route.continue().catch(() => {});
  });
  try {
    const readStarted = page.waitForRequest((request) => new URL(request.url()).pathname.endsWith('/e2e-inbox-message/flags'));
    await row(page, 'E2E Inbox Welcome').getByRole('button', { name: /E2E Inbox Welcome/u }).first().click();
    await readStarted;
    const sentStarted = page.waitForRequest((request) => new URL(request.url()).searchParams.get('folder') === 'sent');
    await openFolder(page, '已发送');
    await sentStarted;
    const readFinished = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith('/e2e-inbox-message/flags') && response.ok());
    releaseRead();
    await readFinished;
    releasePage();
    await expect(row(page, 'E2E Seeded Sent')).toBeVisible();
    await expect(page).toHaveURL(/folder=sent/u);
    expect(sentRequests).toBeGreaterThanOrEqual(2);
  } finally {
    releaseRead(); releasePage();
    await page.unroute('**/api/workspace/messages/e2e-inbox-message/flags');
    await page.unroute('**/api/workspace/mailbox?**');
  }
  await assertNoConsoleErrors(consoleErrors);
});
