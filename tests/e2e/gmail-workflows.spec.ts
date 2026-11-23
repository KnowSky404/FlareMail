import { verifyNavigationAttention } from './navigation-attention';
import type { Page, Response } from '@playwright/test';
import {
  assertNoConsoleErrors,
  assertNoHorizontalOverflow,
  expect,
  login,
  openFolder,
  selectSettings,
  test
} from './fixtures';

// All mutations below target only the isolated, non-routable local E2E fixtures.
test.describe.configure({ mode: 'default' });
const primaryAddressId = '00000000-0000-4000-8000-000000000021';
const supportAddressId = '00000000-0000-4000-8000-000000000022';
const categoryNames = ['全部', '主要往来', '交易账务', '账号安全', '服务通知', '订阅资讯', '营销推广'];
type Category = 'all' | 'primary' | 'transactions' | 'security' | 'updates' | 'subscriptions' | 'promotions';
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

const archiveMutationPath = '**/api/workspace/mailbox/mutate';

async function holdArchiveRequest(page: Page) {
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route(archiveMutationPath, async (route) => {
    await gate;
    await route.fulfill({ response: await route.fetch() });
  });
  return {
    release,
    async finish() {
      release();
      await page.unrouteAll({ behavior: 'wait' });
    }
  };
}

async function restoreArchivedFixture(page: Page, id: string) {
  const response = await page.request.get('/api/workspace/mailbox?folder=archive&limit=100');
  const payload = await response.json() as { data: { page: { messages: Message[] } } };
  if (payload.data.page.messages.some((message) => message.id === id)) {
    await mutateLocal(page, '/api/workspace/mailbox/mutate', 'POST', {
      action: 'unarchive', ids: [id], threadKeys: [],
      scope: { section: 'archive', identityFilter: null, threadScope: 'selected' }
    });
  }
}

function row(page: Page, subject: string) {
  return page.locator('.mail-list-panel').getByRole('listitem').filter({ hasText: subject });
}

async function clickCategory(page: Page, label: string, category: Category) {
  await page.getByRole('tablist', { name: '收件箱分类' }).getByRole('tab', { name: new RegExp(`^${label}(?:\\s|$)`, 'u') }).click();
  await expect(page.locator('#inbox-category-panel')).toHaveAttribute('aria-labelledby', `inbox-tab-${category}`);
  await expect(page.getByRole('tab', { name: new RegExp(`^${label}(?:\\s|$)`, 'u') })).toHaveAttribute('aria-selected', 'true');
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

  await clickCategory(page, '主要往来', 'primary');
  await row(page, 'E2E Inbox Welcome').getByRole('button', { name: /E2E Inbox Welcome/u }).first().click();
  await expect(detail.getByRole('heading', { name: 'E2E Inbox Welcome', exact: true })).toBeVisible();
  await expect(list).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath('gmail-message-reader.png') });
  await expect(page).toHaveURL(/category=primary/u);
  await page.goBack();
  await expect(list).toBeVisible();
  await expect(detail).toBeHidden();
  await expect(page).not.toHaveURL(/message=/u);
  await expect(page.getByRole('tab', { name: '主要往来', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.goForward();
  await expect(detail.getByRole('heading', { name: 'E2E Inbox Welcome', exact: true })).toBeVisible();
  await detail.getByRole('button', { name: '返回邮件列表' }).click();
  await expect(list).toBeVisible();
  await expect(page).not.toHaveURL(/message=/u);
  await expect(page.getByRole('tab', { name: '主要往来', exact: true })).toHaveAttribute('aria-selected', 'true');
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
  const lastTab = tabs.getByRole('tab', { name: '营销推广', exact: true });
  await all.focus();
  const lastLoaded = page.waitForResponse((response) => mailboxResponse(response, 'promotions'));
  await all.press('End');
  await lastLoaded;
  await expect(lastTab).toBeFocused();
  await expect(lastTab).toHaveAttribute('aria-selected', 'true');
  await lastTab.press('Home');
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
  await setCategory(page, ['e2e-bulk-02'], 'security');
  try {
    await page.goto('/?folder=inbox');
    await clickCategory(page, '营销推广', 'promotions');
    await expect(row(page, 'E2E Bulk 01')).toBeVisible();
    await expect(row(page, 'E2E Bulk 02')).toHaveCount(0);
    await clickCategory(page, '账号安全', 'security');
    await expect(row(page, 'E2E Bulk 02')).toBeVisible();
    await page.goBack();
    await expect(page.getByRole('tab', { name: '营销推广', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(row(page, 'E2E Bulk 01')).toBeVisible();
    await expect(row(page, 'E2E Bulk 02')).toHaveCount(0);
    await page.goForward();
    await expect(page.getByRole('tab', { name: '账号安全', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(row(page, 'E2E Bulk 02')).toBeVisible();
    await page.reload();
    await expect(page.getByRole('tab', { name: '账号安全', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(row(page, 'E2E Bulk 02')).toBeVisible();

    await page.goto('/?folder=inbox&category=primary');
    const nextPage = page.waitForResponse((response) => mailboxResponse(response, 'primary', true));
    await page.getByRole('button', { name: '下一页', exact: true }).click();
    const response = await nextPage;
    const payload = await response.json() as { data: { page: { messages: Message[] } } };
    expect(payload.data.page.messages.every((message) => message.inboxCategory === 'primary')).toBe(true);
    await expect(row(page, 'E2E Bulk 45')).toBeVisible();
    await expect(row(page, 'E2E Bulk 01')).toHaveCount(0);
    await clickCategory(page, '营销推广', 'promotions');
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
  await page.getByRole('menuitem', { name: '服务通知', exact: true }).click();
  try {
    const response = await changed;
    expect(response.request().postDataJSON()).toMatchObject({ ids: ['e2e-inbox-message'], category: 'updates' });
    await clickCategory(page, '服务通知', 'updates');
    await expect(row(page, 'E2E Inbox Welcome')).toBeVisible();
    await page.reload();
    await expect(row(page, 'E2E Inbox Welcome')).toBeVisible();
    const persisted = await readMessages(page, 'updates');
    expect(persisted.map((message) => message.id)).toEqual(['e2e-inbox-message']);
    expect(persisted[0]).toMatchObject({
      inboxCategory: 'updates', inboxCategoryOverride: 'updates',
      fromEmail: before.fromEmail, recipientAddressId: before.recipientAddressId
    });
    await clickCategory(page, '主要往来', 'primary');
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
    let releaseRefresh = () => {};
    let refreshHeld = false;
    const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    const mailboxUrl = '**/api/workspace/mailbox?**';
    await page.route(mailboxUrl, async (route) => {
      refreshHeld = true;
      await refreshGate;
      await route.continue();
    });
    try {
      await page.evaluate((messageId) => {
        const channel = new BroadcastChannel('flaremail-workspace-v1');
        channel.addEventListener('message', ({ data }) => {
          if (data.type !== 'mailbox-refresh' || data.id !== messageId) return;
          document.body.dataset.archiveNotice = messageId;
          channel.close();
        });
      }, id);
      await target.getByRole('button', { name: '归档', exact: true }).press('Enter');
      await expect.poll(() => refreshHeld).toBe(true);
      await expect(page.getByRole('status').filter({ hasText: '已归档所选邮件' })).toBeVisible();
      await expect(page.locator('body')).toHaveAttribute('data-archive-notice', id);
      await expect(target).toBeVisible();
    } finally {
      releaseRefresh();
      await page.unroute(mailboxUrl);
    }
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

test('keeps an Inbox row when another tab has already reversed a delayed archive', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'This scenario uses the desktop row actions.');
  await login(page);
  const id = 'e2e-bulk-03';
  const target = row(page, 'E2E Bulk 03');
  let letArchiveRespond = () => {};
  const responseGate = new Promise<void>((resolve) => { letArchiveRespond = resolve; });
  let markArchiveSaved = () => {};
  const archiveSaved = new Promise<void>((resolve) => { markArchiveSaved = resolve; });
  await page.route('**/api/workspace/mailbox/mutate', async (route) => {
    const response = await route.fetch();
    if (route.request().postDataJSON().action === 'archive') {
      markArchiveSaved();
      await responseGate;
    }
    await route.fulfill({ response });
  });

  try {
    await target.hover();
    await target.getByRole('button', { name: '归档', exact: true }).press('Enter');
    await archiveSaved;
    await mutateLocal(page, '/api/workspace/mailbox/mutate', 'POST', {
      action: 'unarchive', ids: [id], threadKeys: [],
      scope: { section: 'archive', identityFilter: null, threadScope: 'selected' }
    });
    const synced = page.waitForResponse((response) => mailboxResponse(response, 'all'));
    await page.evaluate((id) => {
      const channel = new BroadcastChannel('flaremail-workspace-v1');
      channel.postMessage({ type: 'mailbox-refresh', id });
      channel.close();
    }, id);
    await (await synced).finished();

    await page.route('**/api/workspace/mailbox?**', (route) => route.abort());
    letArchiveRespond();
    await expect(page.getByRole('status').filter({ hasText: '已归档所选邮件' })).toBeVisible();
    await expect(target).toBeVisible();
  } finally {
    letArchiveRespond();
    await page.unrouteAll({ behavior: 'wait' });
    const archived = await page.request.get('/api/workspace/mailbox?folder=archive&limit=100');
    const payload = await archived.json() as { data: { page: { messages: Message[] } } };
    if (payload.data.page.messages.some((message) => message.id === id)) {
      await mutateLocal(page, '/api/workspace/mailbox/mutate', 'POST', {
        action: 'unarchive', ids: [id], threadKeys: [],
        scope: { section: 'archive', identityFilter: null, threadScope: 'selected' }
      });
    }
  }
});

test('revalidates Inbox after an archive finishes in Settings following a cross-tab refresh', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'This scenario uses the desktop row actions.');
  await login(page);
  const id = 'e2e-bulk-04';
  const target = row(page, 'E2E Bulk 04');
  const archive = await holdArchiveRequest(page);

  try {
    const requested = page.waitForRequest((request) => request.url().endsWith('/api/workspace/mailbox/mutate'));
    await target.hover();
    await target.getByRole('button', { name: '归档', exact: true }).press('Enter');
    await requested;

    const refreshed = page.waitForResponse((response) => mailboxResponse(response, 'all'));
    await page.evaluate(() => {
      const channel = new BroadcastChannel('flaremail-workspace-v1');
      channel.postMessage({ type: 'mailbox-refresh' });
      channel.close();
    });
    await (await refreshed).finished();
    await expect(target).toBeVisible();
    await selectSettings(page);
    await expect(page.locator('.settings-main [role="tabpanel"]')).toBeVisible();

    archive.release();
    await expect(page.getByRole('status').filter({ hasText: '已归档所选邮件' })).toBeVisible();
    await openFolder(page, '收件箱');
    await expect(target).toHaveCount(0);
  } finally {
    await archive.finish();
    await restoreArchivedFixture(page, id);
  }
});

for (const { from, settledStatus } of [
  { from: 'Inbox', settledStatus: 200 },
  { from: 'deep link', settledStatus: 200 },
  { from: 'deep link', settledStatus: 404 },
  { from: 'bulk toolbar', settledStatus: 200 },
  { from: 'bulk toolbar', settledStatus: 404 }
]) {
  test(`refreshes a recovered ${from} when a pending archive returns ${settledStatus}`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'This scenario uses the desktop row and reader actions.');
    await login(page);
    const deepLink = from === 'deep link';
    const bulk = from === 'bulk toolbar';
    const id = deepLink ? 'e2e-bulk-44' : 'e2e-bulk-12';
    const subject = deepLink ? 'E2E Bulk 44' : 'E2E Bulk 12';
    const target = deepLink ? page.getByRole('region', { name: '邮件详情' }) : row(page, subject);
    if (deepLink) await page.goto('/?folder=inbox&message=' + id);
    if (bulk) await target.getByRole('checkbox').check();
    const archive = await holdArchiveRequest(page);
    const recover = page.getByRole('button', { name: '检查登录状态' });
    const archiveAction = (bulk ? page.getByLabel('批量邮件操作') : target).getByRole('button', { name: '归档', exact: true });
    try {
      const requested = page.waitForRequest(archiveMutationPath);
      if (!deepLink && !bulk) await target.hover();
      await archiveAction.press('Enter');
      await requested;

      await page.evaluate(() => window.dispatchEvent(new CustomEvent('flaremail:auth-expired', { detail: { source: 'other-tab' } })));
      await expect(recover).toBeVisible();
      const recovered = page.waitForResponse((response) => mailboxResponse(response, 'all'));
      await recover.click();
      await (await recovered).finished();
      await expect(recover).toBeHidden();
      await expect(target).toBeVisible();
      if (deepLink) await expect(archiveAction).toBeVisible();
      if (settledStatus === 404) {
        const movedElsewhere = await page.request.post('/api/workspace/mailbox/mutate', {
          headers: { origin: new URL(page.url()).origin },
          data: {
            action: 'archive', ids: [id], threadKeys: [],
            scope: { section: 'inbox', identityFilter: null, threadScope: 'selected' }
          }
        });
        expect(movedElsewhere.ok()).toBe(true);
      }

      const settled = page.waitForResponse(archiveMutationPath);
      archive.release();
      expect((await settled).status()).toBe(settledStatus);
      if (deepLink) await expect(target.getByRole('button', { name: '移回收件箱', exact: true })).toBeVisible();
      else await expect(target).toHaveCount(0);
      await expect(page.getByRole('status').filter({ hasText: '已归档所选邮件' })).toHaveCount(0);
      await expect(page.getByText(/所选邮件不存在或不属于声明的邮件范围|批量更新邮件失败/u)).toHaveCount(0);
    } finally {
      await archive.finish();
      await restoreArchivedFixture(page, id);
    }
  });
}

for (const from of ['deep link', 'bulk toolbar', 'bulk toolbar on page two', 'bulk toolbar on page two during a flag response', 'bulk toolbar on page two in split view']) {
  test(`refreshes the ${from} when an archive conflicts with another device`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'This scenario covers desktop archive controls.');
    await login(page);
    const reader = from === 'deep link';
    const secondPage = from.startsWith('bulk toolbar on page two');
    const settleReadDuringRecovery = from.endsWith('during a flag response');
    const emptySplitReader = from.endsWith('in split view');
    const id = reader || secondPage ? 'e2e-bulk-44' : 'e2e-bulk-14';
    const target = row(page, secondPage ? 'E2E Bulk 44' : 'E2E Bulk 14');
    const validSelection = row(page, 'E2E Bulk 45').getByRole('checkbox');
    const detail = page.getByRole('region', { name: '邮件详情' });
    const toolbar = page.getByLabel('批量邮件操作');
    if (reader) await page.goto('/?folder=inbox&message=' + id);
    else {
      if (emptySplitReader) {
        await page.getByRole('button', { name: '显示分栏预览', exact: true }).click();
        await expect(page.getByRole('button', { name: '关闭分栏预览', exact: true })).toBeVisible();
      }
      if (secondPage) {
        await page.getByRole('button', { name: '下一页', exact: true }).click();
        await validSelection.check();
      }
      await target.getByRole('checkbox').check();
    }
    const archive = (reader ? detail : toolbar).getByRole('button', { name: '归档', exact: true });
    await expect(archive).toBeVisible();
    const recoveryRequests: string[] = [];
    const flagWrites: string[] = [];
    const readPath = '/api/workspace/messages/e2e-bulk-45/flags';
    const badge = page.locator('#fm-main-sidebar').getByRole('button', { name: /^收件箱(?:\s|$)/u }).locator('.count');
    let finishRead = () => {};
    const holdRead = new Promise<void>((resolve) => { finishRead = resolve; });
    let finishCursor = () => {};
    let signalCursor = () => {};
    const holdCursor = new Promise<void>((resolve) => { finishCursor = resolve; });
    const cursorStarted = new Promise<void>((resolve) => { signalCursor = resolve; });
    let optimisticUnread = '';
    const watchRecovery = (request: { url(): string; method(): string }) => {
      const { pathname } = new URL(request.url());
      if (request.method() === 'PATCH' && pathname.endsWith('/flags')) flagWrites.push(pathname);
      if (pathname === '/api/workspace/mailbox' || pathname === '/api/workspace/mailbox/metrics') {
        recoveryRequests.push(pathname);
      }
    };
    try {
      if (emptySplitReader) {
        await expect(detail.getByText('选择一封邮件开始阅读', { exact: true })).toBeVisible();
        expect((await readMessages(page)).find(({ id }) => id === 'e2e-bulk-45')?.read).toBe(false);
      }
      if (secondPage && !emptySplitReader) {
        await page.route('**' + readPath, async (route) => {
          await holdRead;
          if (settleReadDuringRecovery) await route.continue().catch(() => {});
          else await route.abort().catch(() => {});
        });
        optimisticUnread = String(Number(await badge.textContent()) - 1);
        const readStarted = page.waitForRequest((request) => new URL(request.url()).pathname === readPath);
        const selectedRow = row(page, 'E2E Bulk 45');
        await selectedRow.hover();
        await selectedRow.getByRole('button', { name: '标为已读', exact: true }).click();
        await readStarted;
        await expect(badge).toHaveText(optimisticUnread);
      }
      if (settleReadDuringRecovery) {
        let held = false;
        await page.route('**/api/workspace/mailbox?**', async (route) => {
          if (!held && new URL(route.request().url()).searchParams.has('cursor')) {
            held = true;
            signalCursor();
            await holdCursor;
          }
          await route.continue().catch(() => {});
        });
      }
      const movedElsewhere = await page.request.post('/api/workspace/mailbox/mutate', {
        headers: { origin: new URL(page.url()).origin },
        data: {
          action: 'archive', ids: [id], threadKeys: [],
          scope: { section: 'inbox', identityFilter: null, threadScope: 'selected' }
        }
      });
      expect(movedElsewhere.ok()).toBe(true);
      const conflict = page.waitForResponse((response) =>
        response.url().endsWith('/api/workspace/mailbox/mutate') && response.status() === 404);
      if (secondPage) page.on('request', watchRecovery);
      await archive.press('Enter');
      await conflict;
      if (settleReadDuringRecovery) {
        await cursorStarted;
        const readFinished = page.waitForResponse((response) => new URL(response.url()).pathname === readPath && response.ok());
        finishRead();
        await readFinished;
      }
      if (reader) await expect(detail.getByRole('button', { name: '移回收件箱', exact: true })).toBeVisible();
      else {
        await expect(target).toHaveCount(0);
        if (secondPage) {
          await expect(validSelection).toBeChecked();
          await expect(toolbar).toContainText('已选 1 封');
          await expect(page.getByRole('button', { name: '上一页', exact: true })).toBeEnabled();
          await expect(archive).toBeEnabled();
          if (emptySplitReader) {
            await expect(detail.getByText('选择一封邮件开始阅读', { exact: true })).toBeVisible();
            expect((await readMessages(page)).find(({ id }) => id === 'e2e-bulk-45')?.read).toBe(false);
            expect(flagWrites).toEqual([]);
          } else await expect(badge).toHaveText(optimisticUnread);
          expect(recoveryRequests).toEqual(Array(settleReadDuringRecovery ? 4 : 2).fill('/api/workspace/mailbox'));
          if (emptySplitReader) {
            await page.locator('#mail-search-desktop').fill('subject:"E2E Bulk 18"');
            await expect(detail.getByRole('heading', { name: 'E2E Bulk 18', exact: true })).toBeVisible();
          }
        } else {
          await expect(toolbar).not.toContainText('已选 1 封');
        }
      }
      await expect(page.getByRole('status').filter({ hasText: '已归档所选邮件' })).toHaveCount(0);
    } finally {
      page.off('request', watchRecovery);
      finishRead();
      finishCursor();
      if (secondPage) await page.unrouteAll({ behavior: 'wait' });
      await restoreArchivedFixture(page, id);
      if (settleReadDuringRecovery) await mutateLocal(page, readPath, 'PATCH', { read: false });
    }
  });
}

for (const { openFrom, target, updated } of [
  { openFrom: 'deep link', target: '44', updated: '08' },
  { openFrom: 'deep link', target: '44', updated: '44' },
  { openFrom: 'current page', target: '16', updated: '16' }
]) {
  test(`closes a list reader after confirmed archive from ${openFrom} and a cross-tab update to bulk ${updated}`, async ({ page }, testInfo) => {
    test.skip(!['desktop', 'mobile'].includes(testInfo.project.name), 'This scenario covers desktop and phone readers.');
    await login(page);
    const id = 'e2e-bulk-' + target;
    const subject = 'E2E Bulk ' + target;
    if (openFrom === 'deep link') await page.goto('/?folder=inbox&message=' + id);
    else await row(page, subject).getByRole('button', { name: new RegExp(subject, 'u') }).first().click();
    const detail = page.getByRole('region', { name: '邮件详情' });
    await expect(detail.getByRole('heading', { name: subject, exact: true })).toBeVisible();
    const archive = await holdArchiveRequest(page);

    try {
      const mutation = page.waitForRequest(archiveMutationPath);
      await detail.getByRole('button', { name: '归档', exact: true }).click();
      await mutation;
      const refreshed = page.waitForResponse((response) => mailboxResponse(response, 'all'));
      await page.evaluate((id) => {
        const channel = new BroadcastChannel('flaremail-workspace-v1');
        channel.postMessage({ type: 'message-updated', id });
        channel.close();
      }, 'e2e-bulk-' + updated);
      await (await refreshed).finished();

      archive.release();
      await expect(page.getByRole('status').filter({ hasText: '已归档所选邮件' })).toBeVisible();
      await expect(detail).toBeHidden();
      await expect(page).not.toHaveURL(/message=/u);
    } finally {
      await archive.finish();
      await restoreArchivedFixture(page, id);
    }
  });
}

test('keeps a mobile reader open and manually unread on an archive conflict', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'This scenario covers the phone reader.');
  await login(page);
  const message = (await readMessages(page)).find(({ id }) => id === 'e2e-bulk-16')!;
  const rowLocator = row(page, message.subject);
  const detail = page.getByRole('region', { name: '邮件详情' });
  const flagsPath = '/api/workspace/messages/' + encodeURIComponent(message.id) + '/flags';
  const metadata = '**/api/workspace/messages/' + encodeURIComponent(message.id);
  let releaseMetadata = () => {};
  const holdMetadata = new Promise<void>((resolve) => { releaseMetadata = resolve; });
  await rowLocator.getByRole('button', { name: new RegExp(message.subject, 'u') }).first().click();
  await expect(detail.getByRole('heading', { name: message.subject, exact: true })).toBeVisible();
  try {
    const unread = page.waitForResponse((response) => new URL(response.url()).pathname === flagsPath && response.ok());
    await detail.getByRole('button', { name: '标为未读', exact: true }).click();
    await unread;
    const currentPage = page.waitForResponse((response) => mailboxResponse(response, 'all'));
    await page.evaluate(() => {
      const channel = new BroadcastChannel('flaremail-workspace-v1');
      channel.postMessage({ type: 'mailbox-refresh' });
      channel.close();
    });
    await (await currentPage).finished();
    await expect(detail.getByRole('button', { name: '标为已读', exact: true })).toBeVisible();

    const movedElsewhere = await page.request.post('/api/workspace/mailbox/mutate', {
      headers: { origin: new URL(page.url()).origin },
      data: {
        action: 'archive', ids: [message.id], threadKeys: [],
        scope: { section: 'inbox', identityFilter: null, threadScope: 'selected' }
      }
    });
    expect(movedElsewhere.ok()).toBe(true);
    await page.route(metadata, async (route) => {
      await holdMetadata;
      await route.continue().catch(() => {});
    });
    const metadataStarted = page.waitForRequest(metadata);
    const conflict = page.waitForResponse((response) => response.url().endsWith('/api/workspace/mailbox/mutate') && response.status() === 404);
    await detail.getByRole('button', { name: '归档', exact: true }).click();
    await conflict;
    await metadataStarted;
    await expect(detail.getByRole('heading', { name: message.subject, exact: true })).toBeVisible();
    releaseMetadata();
    await expect(detail.getByRole('button', { name: '移回收件箱', exact: true })).toBeVisible();
    const archived = await page.request.get('/api/workspace/mailbox?folder=archive&limit=100');
    const payload = await archived.json() as { data: { page: { messages: Message[] } } };
    expect(payload.data.page.messages.find(({ id }) => id === message.id)?.read).toBe(false);
  } finally {
    releaseMetadata();
    await page.unroute(metadata);
    await restoreArchivedFixture(page, message.id);
    await mutateLocal(page, flagsPath, 'PATCH', { read: message.read });
  }
});

test('keeps a split reader on a sent message when Starred changes during archive', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'The simultaneous preview is desktop-only.');
  await login(page);
  const sentResponse = await page.request.get('/api/workspace/mailbox?folder=sent&limit=40');
  const sent = (await sentResponse.json() as { data: { page: { messages: Message[] } } }).data.page.messages[0];
  const inbox = await readMessages(page);
  const target = inbox.find(({ id }) => id === 'e2e-bulk-44')!;
  const replacement = inbox.find(({ id }) => id === 'e2e-bulk-14')!;
  const flagsPath = (message: Message) => '/api/workspace/messages/' + encodeURIComponent(message.id) + '/flags';
  try {
    await mutateLocal(page, flagsPath(sent), 'PATCH', { starred: true });
    await mutateLocal(page, flagsPath(target), 'PATCH', { starred: true });
    await page.getByRole('button', { name: '显示分栏预览', exact: true }).click();
    await openFolder(page, '星标邮件');
    const detail = page.getByRole('region', { name: '邮件详情' });
    await row(page, sent.subject).getByRole('button', { name: new RegExp(sent.subject, 'u') }).first().click();
    await expect(detail.getByRole('heading', { name: sent.subject, exact: true })).toBeVisible();
    await row(page, target.subject).getByRole('checkbox').check();

    await mutateLocal(page, flagsPath(sent), 'PATCH', { starred: false });
    await mutateLocal(page, flagsPath(target), 'PATCH', { starred: false });
    await mutateLocal(page, flagsPath(replacement), 'PATCH', { starred: true, read: false });
    const conflict = page.waitForResponse((response) => response.url().endsWith('/api/workspace/mailbox/mutate') && response.status() === 404);
    await page.getByLabel('批量邮件操作').getByRole('button', { name: '归档', exact: true }).press('Enter');
    await conflict;
    await expect(row(page, replacement.subject)).toBeVisible();
    await expect(detail.getByRole('heading', { name: sent.subject, exact: true })).toBeVisible();
    expect((await readMessages(page)).find(({ id }) => id === replacement.id)?.read).toBe(false);
  } finally {
    for (const item of [sent, target, replacement]) {
      await mutateLocal(page, flagsPath(item), 'PATCH', { starred: item.starred, read: item.read });
    }
  }
});

test('keeps a split reader on the original message when its archive conflicts', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'The simultaneous preview is desktop-only.');
  await login(page);
  const [first, next] = await readMessages(page);
  const nextFlags = `/api/workspace/messages/${encodeURIComponent(next.id)}/flags`;
  const readerMetadata = '**/api/workspace/messages/' + encodeURIComponent(first.id);
  const mailboxList = '**/api/workspace/mailbox?**';
  let releaseList = () => {};
  const holdList = new Promise<void>((resolve) => { releaseList = resolve; });
  let releaseMetadata = () => {};
  const holdMetadata = new Promise<void>((resolve) => { releaseMetadata = resolve; });
  try {
    await page.getByRole('button', { name: '显示分栏预览', exact: true }).click();
    await page.goto('/?folder=inbox');
    const detail = page.getByRole('region', { name: '邮件详情' });
    await expect(detail.getByRole('heading', { name: first.subject, exact: true })).toBeVisible();
    await mutateLocal(page, nextFlags, 'PATCH', { read: false });
    await page.getByRole('button', { name: '刷新邮件列表', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: '邮件列表已刷新。' })).toBeVisible();
    await expect(detail.getByRole('heading', { name: first.subject, exact: true })).toBeVisible();
    expect((await readMessages(page)).find((message) => message.id === next.id)?.read).toBe(false);

    const movedElsewhere = await page.request.post('/api/workspace/mailbox/mutate', {
      headers: { origin: new URL(page.url()).origin },
      data: {
        action: 'archive', ids: [first.id], threadKeys: [],
        scope: { section: 'inbox', identityFilter: null, threadScope: 'selected' }
      }
    });
    expect(movedElsewhere.ok()).toBe(true);
    await page.route(mailboxList, async (route) => {
      await holdList;
      await route.continue().catch(() => {});
    });
    await page.route(readerMetadata, async (route) => {
      await holdMetadata;
      await route.continue().catch(() => {});
    });
    const metadataStarted = page.waitForRequest(readerMetadata);
    const listStarted = page.waitForRequest(mailboxList);
    const conflict = page.waitForResponse((response) => response.url().endsWith('/api/workspace/mailbox/mutate') && response.status() === 404);
    const archive = detail.getByRole('button', { name: '归档', exact: true });
    await archive.click();
    await conflict;
    await listStarted;
    await expect(page.getByRole('status').filter({ hasText: '正在更新邮件…' })).toBeVisible();
    await expect(page.locator('#mail-search-desktop')).toBeEnabled();
    await expect(archive).toBeEnabled();
    releaseList();
    await metadataStarted;
    await expect(row(page, first.subject)).toHaveCount(0);
    await expect(detail.getByRole('heading', { name: first.subject, exact: true })).toBeVisible();
    await expect(archive).toBeEnabled();
    releaseMetadata();
    await expect(detail.getByRole('button', { name: '移回收件箱', exact: true })).toBeVisible();
    expect((await readMessages(page)).find((message) => message.id === next.id)?.read).toBe(false);
  } finally {
    releaseList();
    releaseMetadata();
    await page.unroute(mailboxList);
    await page.unroute(readerMetadata);
    await restoreArchivedFixture(page, first.id);
    await mutateLocal(page, nextFlags, 'PATCH', { read: next.read });
    await mutateLocal(page, `/api/workspace/messages/${encodeURIComponent(first.id)}/flags`, 'PATCH', { read: first.read });
  }
});

test('does not retain a split reader after clearing search after a late archive conflict', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'The simultaneous preview is desktop-only.');
  await login(page);
  const inbox = await readMessages(page);
  const original = inbox.find(({ id }) => id === 'e2e-bulk-18')!;
  const [next] = inbox;
  await page.getByRole('button', { name: '显示分栏预览', exact: true }).click();
  await page.goto('/?folder=inbox&q=' + encodeURIComponent('subject:"E2E Bulk 18"'));
  const detail = page.getByRole('region', { name: '邮件详情' });
  await expect(detail.getByRole('heading', { name: original.subject, exact: true })).toBeVisible();
  const matchesSearch = (request: { url(): string }) => {
    const url = new URL(request.url());
    return url.pathname === '/api/workspace/mailbox' && url.searchParams.get('folder') === 'inbox' && !url.searchParams.has('q');
  };
  const archive = await holdArchiveRequest(page);
  let releaseSearch = () => {};
  const holdSearch = new Promise<void>((resolve) => { releaseSearch = resolve; });
  await page.route('**/api/workspace/mailbox?**', async (route) => {
    if (matchesSearch(route.request())) await holdSearch;
    await route.continue().catch(() => {});
  });

  try {
    const started = page.waitForRequest(archiveMutationPath);
    await detail.getByRole('button', { name: '归档', exact: true }).click();
    await started;
    const movedElsewhere = await page.request.post('/api/workspace/mailbox/mutate', {
      headers: { origin: new URL(page.url()).origin },
      data: {
        action: 'archive', ids: [original.id], threadKeys: [],
        scope: { section: 'inbox', identityFilter: null, threadScope: 'selected' }
      }
    });
    expect(movedElsewhere.ok()).toBe(true);

    const firstSearch = page.waitForRequest(matchesSearch);
    await page.getByRole('button', { name: '清除搜索', exact: true }).click();
    await firstSearch;
    await expect(detail.getByRole('heading', { name: original.subject, exact: true })).toBeVisible();
    const retrySearch = page.waitForRequest(matchesSearch);
    const conflict = page.waitForResponse((response) => response.url().endsWith('/api/workspace/mailbox/mutate') && response.status() === 404);
    archive.release();
    await conflict;
    await retrySearch;
    releaseSearch();
    await expect(row(page, next.subject)).toBeVisible();
    await expect(detail.getByRole('heading', { name: next.subject, exact: true })).toBeVisible();
    await expect(detail.getByRole('heading', { name: original.subject, exact: true })).toHaveCount(0);
  } finally {
    releaseSearch();
    await archive.finish();
    await restoreArchivedFixture(page, original.id);
    await mutateLocal(page, `/api/workspace/messages/${encodeURIComponent(original.id)}/flags`, 'PATCH', { read: original.read });
    await mutateLocal(page, `/api/workspace/messages/${encodeURIComponent(next.id)}/flags`, 'PATCH', { read: next.read });
  }
});

test('starts a previous search at page one when a late archive conflicts', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'This scenario uses the desktop split reader.');
  await login(page);
  const [message] = await readMessages(page);
  const query = 'from:bulk@flaremail.test';
  const isSearch = (request: { url(): string }) => new URL(request.url()).searchParams.get('q') === query;
  const search = page.locator('#mail-search-desktop');
  const detail = page.getByRole('region', { name: '邮件详情' });
  await page.getByRole('button', { name: '显示分栏预览', exact: true }).click();
  await search.fill(query);
  await expect(row(page, 'E2E Bulk 01')).toBeVisible();
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(page.getByRole('button', { name: '上一页', exact: true })).toBeEnabled();
  await openFolder(page, '已发送');
  await openFolder(page, '收件箱');
  await expect(detail.getByRole('heading', { name: message.subject, exact: true })).toBeVisible();

  let signalConflict = () => {};
  let releaseConflict = () => {};
  const conflictReady = new Promise<void>((resolve) => { signalConflict = resolve; });
  const holdConflict = new Promise<void>((resolve) => { releaseConflict = resolve; });
  await page.route(archiveMutationPath, async (route) => {
    const response = await route.fetch();
    signalConflict();
    await holdConflict;
    await route.fulfill({ response }).catch(() => {});
  });

  try {
    const movedElsewhere = await page.request.post('/api/workspace/mailbox/mutate', {
      headers: { origin: new URL(page.url()).origin },
      data: {
        action: 'archive', ids: [message.id], threadKeys: [],
        scope: { section: 'inbox', identityFilter: null, threadScope: 'selected' }
      }
    });
    expect(movedElsewhere.ok()).toBe(true);
    await page.clock.install();
    await detail.getByRole('button', { name: '归档', exact: true }).click();
    await conflictReady;
    await page.clock.pauseAt(new Date(Date.now() + 1_000));
    await page.evaluate(() => history.go(-2));
    await expect(search).toHaveValue(query);

    const requestForSearch = page.waitForRequest(isSearch);
    const conflict = page.waitForResponse(archiveMutationPath);
    releaseConflict();
    expect((await conflict).status()).toBe(404);
    const request = await requestForSearch;
    expect(new URL(request.url()).searchParams.has('cursor')).toBe(false);
    await page.clock.resume();
    await expect(row(page, 'E2E Bulk 01')).toBeVisible();
    await expect(page.getByRole('button', { name: '上一页', exact: true })).toBeDisabled();
  } finally {
    releaseConflict();
    await page.unroute(archiveMutationPath);
    await restoreArchivedFixture(page, message.id);
  }
});

test('keeps the split reader from selecting an old page while search is debounced despite a late Trash response', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'The simultaneous preview is desktop-only.');
  await login(page);
  await page.getByRole('button', { name: '显示分栏预览', exact: true }).click();
  const nextPage = page.getByRole('button', { name: '下一页', exact: true });
  const previousPage = page.getByRole('button', { name: '上一页', exact: true });
  const detail = page.getByRole('region', { name: '邮件详情' });
  const emptyReader = detail.getByText('选择一封邮件开始阅读', { exact: true });
  let signalTrash = () => {};
  let releaseTrash = () => {};
  const trashReady = new Promise<void>((resolve) => { signalTrash = resolve; });
  const holdTrash = new Promise<void>((resolve) => { releaseTrash = resolve; });
  const trashPattern = '**/api/workspace/trash?**';
  let signalCursor = () => {};
  let releaseCursor = () => {};
  let releaseSearch = () => {};
  const cursorReady = new Promise<void>((resolve) => { signalCursor = resolve; });
  const holdCursor = new Promise<void>((resolve) => { releaseCursor = resolve; });
  const holdSearch = new Promise<void>((resolve) => { releaseSearch = resolve; });
  const query = 'subject:"E2E Bulk 18"';
  const mailboxPattern = '**/api/workspace/mailbox?**';
  const readWrites: string[] = [];
  const watchFlags = (request: { url(): string; method(): string }) => {
    const pathname = new URL(request.url()).pathname;
    if (request.method() === 'PATCH' && pathname.endsWith('/flags')) readWrites.push(pathname);
  };
  await page.route(trashPattern, async (route) => {
    const response = await route.fetch();
    signalTrash();
    await holdTrash;
    await route.fulfill({ response }).catch(() => {});
  });

  try {
    await openFolder(page, '垃圾箱');
    await trashReady;
    await openFolder(page, '收件箱');
    await nextPage.click();
    await previousPage.click();
    await expect(emptyReader).toBeVisible();
    const firstPageRefreshed = page.waitForResponse((response) => mailboxResponse(response, 'all'));
    await page.evaluate(() => {
      const channel = new BroadcastChannel('flaremail-workspace-v1');
      channel.postMessage({ type: 'mailbox-refresh' });
      channel.close();
    });
    await (await firstPageRefreshed).finished();
    await expect(page.getByRole('status').filter({ hasText: '正在更新邮件…' })).toHaveCount(0);
    await expect(emptyReader).toBeVisible();

    await page.route(mailboxPattern, async (route) => {
      const { searchParams } = new URL(route.request().url());
      if (searchParams.has('cursor')) {
        const response = await route.fetch();
        signalCursor();
        await holdCursor;
        await route.fulfill({ response }).catch(() => {});
      } else {
        if (searchParams.get('q') === query) await holdSearch;
        await route.continue().catch(() => {});
      }
    });

    await nextPage.click();
    await cursorReady;
    page.on('request', watchFlags);
    const searchStarted = page.waitForRequest((request) => new URL(request.url()).searchParams.get('q') === query);
    await page.locator('#mail-search-desktop').fill(query);
    const trashReturned = page.waitForResponse(trashPattern);
    releaseCursor();
    releaseTrash();
    await (await trashReturned).finished();
    await searchStarted;
    await expect(emptyReader).toBeVisible();
    releaseSearch();
    await expect(detail.getByRole('heading', { name: 'E2E Bulk 18', exact: true })).toBeVisible();
    expect(readWrites).toEqual([]);
  } finally {
    page.off('request', watchFlags);
    releaseTrash();
    releaseCursor();
    releaseSearch();
    await page.unrouteAll({ behavior: 'wait' });
  }
});

test('keeps a split reader from auto-reading a cached replacement outside the refreshed Inbox', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'The simultaneous preview is desktop-only.');
  await login(page);
  const [first, next] = await readMessages(page);
  await page.getByRole('button', { name: '显示分栏预览', exact: true }).click();
  await page.goto('/?folder=inbox');
  const detail = page.getByRole('region', { name: '邮件详情' });
  await expect(detail.getByRole('heading', { name: first.subject, exact: true })).toBeVisible();

  const mailboxUrl = '**/api/workspace/mailbox?**';
  const nextFlags = `/api/workspace/messages/${encodeURIComponent(next.id)}/flags`;
  let releaseRefresh = () => {};
  const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });
  try {
    await mutateLocal(page, nextFlags, 'PATCH', { read: false });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(detail.getByRole('heading', { name: first.subject, exact: true })).toBeVisible();
    await expect(row(page, next.subject).locator('button[aria-label="标为已读"]')).toHaveCount(1);
    const removedElsewhere = await page.request.post('/api/workspace/mailbox/mutate', {
      headers: { origin: new URL(page.url()).origin },
      data: {
        action: 'archive', ids: [next.id], threadKeys: [],
        scope: { section: 'inbox', identityFilter: null, threadScope: 'selected' }
      }
    });
    expect(removedElsewhere.ok()).toBe(true);
    expect(await removedElsewhere.json()).toMatchObject({ data: { result: { summaries: [{ id: next.id, read: false }] } } });

    await page.route(mailboxUrl, async (route) => {
      await refreshGate;
      await route.continue();
    });
    const refill = page.waitForResponse((response) => mailboxResponse(response, 'all'));
    await detail.getByRole('button', { name: '归档', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: '已归档所选邮件' })).toBeVisible();
    await expect(detail.getByRole('heading', { name: first.subject, exact: true })).toBeVisible();
    releaseRefresh();
    await (await refill).finished();
    await expect(row(page, first.subject)).toHaveCount(0);
    await expect(row(page, next.subject)).toHaveCount(0);
    await expect(detail.getByRole('heading', { name: next.subject, exact: true })).toHaveCount(0);
    const archive = await page.request.get('/api/workspace/mailbox?folder=archive&limit=100');
    const payload = await archive.json() as { data: { page: { messages: Message[] } } };
    expect(payload.data.page.messages.find((message) => message.id === next.id)?.read).toBe(false);
  } finally {
    releaseRefresh();
    await page.unroute(mailboxUrl);
    await restoreArchivedFixture(page, first.id);
    await restoreArchivedFixture(page, next.id);
    await mutateLocal(page, nextFlags, 'PATCH', { read: next.read });
  }
});

test('formats returning list rows in the current system time zone', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Changing the browser time zone requires Chromium CDP.');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setTimezoneOverride', { timezoneId: 'UTC' });
  await login(page);
  const date = row(page, 'E2E Inbox Welcome').locator('time');
  const previousDate = await date.textContent();
  await cdp.send('Emulation.setTimezoneOverride', { timezoneId: 'Pacific/Honolulu' });
  await openFolder(page, '已发送');
  await openFolder(page, '收件箱');
  const currentDate = await date.evaluate((element) =>
    new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' })
      .format(new Date(element.getAttribute('datetime')!))
  );
  expect(currentDate).not.toBe(previousDate);
  await expect(date).toHaveText(currentDate);
});

test('ignores a slower category response after newer category navigation', async ({ page, consoleErrors }) => {
  await login(page);
  await setCategory(page, ['e2e-bulk-01'], 'promotions');
  await setCategory(page, ['e2e-bulk-02'], 'security');
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
    await page.getByRole('tab', { name: '营销推广', exact: true }).click();
    await requested;
    await clickCategory(page, '账号安全', 'security');
    await expect(row(page, 'E2E Bulk 02')).toBeVisible();
    releasePromotions();
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL(/category=security/u);
    await expect(page.getByRole('tab', { name: '账号安全', exact: true })).toHaveAttribute('aria-selected', 'true');
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
  await expect(page.getByRole('tab', { name: '主要往来', exact: true })).toHaveAttribute('aria-selected', 'true');
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
  await clickCategory(page, '主要往来', 'primary');
  const nextPage = page.waitForResponse((response) => mailboxResponse(response, 'primary', true));
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await nextPage;
  await expect(row(page, 'E2E Bulk 45')).toBeAttached();
  await page.getByRole('button', { name: '上一页', exact: true }).click();
  const scroller = page.locator('.fm-list-scroll');
  await scroller.evaluate((element) => { element.scrollTop = 280; });
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBe(280);
  await clickCategory(page, '订阅资讯', 'subscriptions');
  await page.waitForLoadState('networkidle');
  const requested: string[] = [];
  page.on('request', (request) => { if (new URL(request.url()).pathname === '/api/workspace/mailbox') requested.push(request.url()); });
  await clickCategory(page, '主要往来', 'primary');
  await expect(row(page, 'E2E Bulk 45')).toHaveCount(0);
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
      const count = page.locator('#fm-main-sidebar').getByRole('button', { name: /^收件箱(?:\s|$)/u }).locator('.count');
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


test('shows only navigation counts needing attention across identity changes', async ({ page, consoleErrors }, testInfo) => {
  await verifyNavigationAttention(page, consoleErrors, testInfo);
});

test('keeps scoped attention counts after undoing a draft trash action', async ({ page, consoleErrors }, testInfo) => {
  await login(page);
  const subject = `E2E Scoped Undo ${crypto.randomUUID()}`;
  const created = await mutateLocal(page, '/api/workspace/drafts', 'POST', {
    to: [{ email: 'draft-recipient@flaremail.test', name: 'Draft Fixture' }], senderAddressId: supportAddressId,
    subject, body: 'Only this synthetic draft is restored.'
  }) as { data: { message: Message } };
  const id = created.data.message.id;
  const scope = `address:${supportAddressId}`;
  try {
    await page.goto(`/?folder=drafts&identity=${encodeURIComponent(scope)}`);
    const { data: scopedBefore } = await (await page.request.get(`/api/workspace/mailbox/metrics?identity=${scope}`)).json();
    // Cache another folder before writing; its old metrics must not undo the write.
    await openFolder(page, '收件箱');
    await openFolder(page, '草稿箱');
    const item = row(page, subject);
    await expect(item).toBeVisible();
    await page.evaluate(() => {
      const seen: number[] = [];
      (window as unknown as { attentionCountsObserved: number[] }).attentionCountsObserved = seen;
      new MutationObserver(() => {
        const text = document.querySelector('#sidebar-drafts-count, #mobile-drafts-count')?.textContent;
        if (text && /^\d+$/u.test(text)) seen.push(Number(text));
      }).observe(document.body, { subtree: true, childList: true, characterData: true });
    });
    await item.getByRole('button', { name: '移入垃圾箱', exact: true }).click();
    await expect(item).toHaveCount(0);
    await openFolder(page, '收件箱');
    const compact = testInfo.project.name !== 'desktop';
    if (compact) await page.getByRole('button', { name: '打开导航' }).click();
    const navigation = page.getByRole('navigation', { name: compact ? '移动端导航' : '主导航', exact: true });
    const count = navigation.getByRole('button', { name: /^草稿箱(?:\s|$)/u }).locator(compact ? 'small' : '.count');
    await expect(count).toHaveCount(0);
    if (compact) await page.keyboard.press('Escape');
    await page.getByRole('status').filter({ hasText: '已移入垃圾箱' }).getByRole('button', { name: '撤销' }).click();
    await openFolder(page, '草稿箱');
    await expect(item).toBeVisible();
    const { data: owner } = await (await page.request.get('/api/workspace/mailbox/metrics')).json();
    expect(owner.metrics.draftsCount).toBeGreaterThan(scopedBefore.metrics.draftsCount);
    if (compact) await page.getByRole('button', { name: '打开导航' }).click();
    await expect(count).toHaveText(String(scopedBefore.metrics.draftsCount));
    const seen = await page.evaluate(() => (window as unknown as { attentionCountsObserved: number[] }).attentionCountsObserved);
    expect(seen.every((count) => count <= scopedBefore.metrics.draftsCount)).toBe(true);
    await expect(page).toHaveURL(/identity=address/u);
    await assertNoConsoleErrors(consoleErrors);
  } finally {
    await mutateLocal(page, `/api/workspace/messages/${id}`, 'DELETE');
  }
});
