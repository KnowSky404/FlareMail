import AxeBuilder from '@axe-core/playwright';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test, expect, login, openFolder, assertNoConsoleErrors, assertNoHorizontalOverflow } from './fixtures';

test('trash replaces record pages, retains a failed page, and returns to the first page', async ({ page, consoleErrors }, testInfo) => {
  await login(page);
  const { data: { page: mailbox } } = await (await page.request.get('/api/workspace/mailbox?folder=inbox&limit=1')).json();
  const items = Array.from({ length: 41 }, (_, i) => ({
    id: `synthetic-trash-${i}`, kind: 'workspace', deletedAt: '2026-10-01T00:00:00Z', originalFolder: 'inbox',
    message: { ...mailbox.messages[0], id: `synthetic-trash-${i}`, subject: `Synthetic trash ${i}`, read: true }
  }));
  await page.route('**/api/workspace/messages/synthetic-trash-*/body', (route) => route.fulfill({ json: { ok: true, data: { body: 'Synthetic trash body', attachments: [] } } }));
  let failNext = true;
  await page.route('**/api/workspace/trash?**', async (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get('limit')).toBe('40');
    const second = url.searchParams.has('cursor');
    if (second && failNext) {
      failNext = false;
      return route.fulfill({ status: 503, json: { ok: false, error: { code: 'TEST_OFFLINE', message: 'Synthetic failure' } } });
    }
    return route.fulfill({ json: { ok: true, data: { items: second ? items.slice(40) : items.slice(0, 40), hasMore: !second, nextCursor: second ? null : 'synthetic-next', metrics: mailbox.metrics } } });
  });
  await openFolder(page, '垃圾箱');
  const list = page.locator('.fm-list-scroll');
  const rows = list.getByRole('listitem');
  const next = list.getByRole('button', { name: '下一页', exact: true });
  const previous = list.getByRole('button', { name: '上一页', exact: true });
  await expect(rows).toHaveCount(40);
  await expect(previous).toBeDisabled();
  await next.click();
  await expect(list.getByRole('alert')).toBeVisible();
  await expect(rows).toHaveCount(40);
  await expect(previous).toBeDisabled();
  await next.click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Synthetic trash 40');
  await expect(next).toBeDisabled();
  await expect(previous).toBeEnabled();
  await expect(page).not.toHaveURL(/message=/u);
  await page.screenshot({ path: join(tmpdir(), `flaremail-trash-pages-${testInfo.project.name}.png`), fullPage: false });
  await previous.click();
  await expect(rows).toHaveCount(40);
  await expect(previous).toBeDisabled();
  await assertNoHorizontalOverflow(page);
  await assertNoConsoleErrors(consoleErrors.filter((entry) => !/^Failed to load resource: the server responded with a status of 503/u.test(entry)));
});

test('settings tabs preserve drafts, save only the active fields, and support deep links and keyboard navigation', async ({ page, consoleErrors }, testInfo) => {
  await login(page);
  await page.goto('/?folder=settings#settings-notifications');
  await expect(page).toHaveURL(/tab=notifications/u);
  const tabs = page.getByRole('tablist', { name: '设置分区' });
  await expect(tabs.getByRole('tab')).toHaveText(['个人资料', '通知', '诊断', 'Telegram 通知', '黑名单']);
  await expect(page.getByRole('tabpanel')).toHaveCount(1);
  await tabs.getByRole('tab', { name: '个人资料', exact: true }).click();
  const original = await (await page.request.get('/api/workspace/profile')).json();
  const baseline = original.data.profile;
  const submissions: Array<Record<string, unknown>> = [];
  await page.route('**/api/workspace/profile', async (route) => {
    if (route.request().method() === 'PUT') submissions.push(route.request().postDataJSON());
    await route.continue();
  });
  await page.getByLabel('显示姓名').fill('  Separate tab draft  ');
  await page.getByLabel('显示邮箱').fill('invalid');
  await tabs.getByRole('tab', { name: '通知', exact: true }).click();
  await page.locator('#profile-forwarding').click();
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect.poll(() => submissions.length).toBe(1);
  await expect(page.getByRole('button', { name: '保存设置', exact: true })).toBeEnabled();
  expect(submissions[0]).toMatchObject({ name: baseline.name, email: baseline.email, forwardingEnabled: !baseline.forwardingEnabled });
  // A new notification draft must survive saving the profile, too.
  await page.locator('#profile-forwarding').click();
  await tabs.getByRole('tab', { name: '个人资料', exact: true }).click();
  await expect(page.getByLabel('显示姓名')).toHaveValue('  Separate tab draft  ');
  await expect(page.getByLabel('显示邮箱')).toHaveValue('invalid');
  await page.getByLabel('显示邮箱').fill(baseline.email);
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect.poll(() => submissions.length).toBe(2);
  await expect(page.getByRole('button', { name: '保存设置', exact: true })).toBeEnabled();
  expect(submissions[1]).toMatchObject({ forwardingEnabled: !baseline.forwardingEnabled });
  await expect(page.getByLabel('显示姓名')).toHaveValue('Separate tab draft');
  await tabs.getByRole('tab', { name: '个人资料', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(tabs.getByRole('tab', { name: '通知', exact: true })).toBeFocused();
  await expect(tabs.getByRole('tab', { name: '个人资料', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  await expect(page.locator('#profile-forwarding')).toHaveAttribute('aria-checked', String(baseline.forwardingEnabled));
  await expect(page.getByLabel('显示姓名')).toHaveCount(0);
  await page.keyboard.press('ArrowRight');
  await expect(tabs.getByRole('tab', { name: '诊断', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: '保存设置', exact: true })).toHaveCount(0);
  await page.goBack();
  await expect(tabs.getByRole('tab', { name: '通知', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.settings-header').getByRole('combobox')).toHaveCount(0);
  expect((await new AxeBuilder({ page }).include('main').analyze()).violations).toEqual([]);
  await assertNoHorizontalOverflow(page);
  await page.screenshot({ path: join(tmpdir(), `flaremail-tabs-${testInfo.project.name}.png`), fullPage: false });
  await assertNoConsoleErrors(consoleErrors);
});

test('removed appearance links open profile while global display preferences keep working', async ({ page, consoleErrors }, testInfo) => {
  await login(page);
  for (const suffix of ['&tab=appearance', '#settings-appearance']) {
    // Navigate from another route so each case exercises a direct legacy link,
    // including a full Kit navigation for the old hash-only bookmark.
    await page.goto('/?folder=inbox', { waitUntil: 'domcontentloaded' });
    // Let pending reads finish before another full navigation: WebKit reports
    // interrupted label reads as access-control console errors.
    if (testInfo.project.name.startsWith('webkit')) await page.waitForLoadState('networkidle');
    await page.goto(`/?folder=settings${suffix}`, { waitUntil: 'domcontentloaded' });
    if (testInfo.project.name.startsWith('webkit')) await page.waitForLoadState('networkidle');
    await expect(page).toHaveTitle('FlareMail');
    const tabs = page.getByRole('tablist', { name: '设置分区' });
    await expect(tabs.getByRole('tab', { name: '个人资料', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByLabel('显示姓名')).toBeVisible();
    await expect.poll(() => new URL(page.url()).searchParams.has('tab')).toBe(false);
    await expect.poll(() => new URL(page.url()).hash).toBe('');
    await expect(tabs.getByRole('tab', { name: '外观', exact: true })).toHaveCount(0);
    await expect(page.locator('#profile-theme')).toHaveCount(0);
  }
  const preferences = page.getByRole('button', { name: '显示偏好', exact: true });
  if (await preferences.isVisible()) {
    await preferences.click();
    await page.getByRole('radiogroup', { name: '颜色主题', exact: true }).getByRole('radio', { name: '深色', exact: true }).press('Enter');
  } else {
    await page.getByRole('button', { name: '打开导航', exact: true }).click();
    await page.getByRole('navigation', { name: '移动端导航', exact: true }).getByRole('combobox', { name: '颜色主题', exact: true }).selectOption('dark');
  }
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.keyboard.press('Escape');
  await page.reload({ waitUntil: 'domcontentloaded' });
  if (testInfo.project.name.startsWith('webkit')) await page.waitForLoadState('networkidle');
  await expect(page.getByLabel('显示姓名')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect((await new AxeBuilder({ page }).include('main').analyze()).violations).toEqual([]);
  await assertNoHorizontalOverflow(page);
  await page.screenshot({ path: join(tmpdir(), `flaremail-settings-no-appearance-${testInfo.project.name}.png`), fullPage: false });
  await assertNoConsoleErrors(consoleErrors);
});

test('mobile theme control follows the applied preference when storage is blocked', async ({ page, consoleErrors }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    const getItem = Storage.prototype.getItem;
    const setItem = Storage.prototype.setItem;
    Storage.prototype.getItem = function (key: string) {
      if (key === 'flaremail-theme') throw new DOMException('Storage blocked', 'SecurityError');
      return getItem.call(this, key);
    };
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key === 'flaremail-theme') throw new DOMException('Storage blocked', 'SecurityError');
      return setItem.call(this, key, value);
    };
  });
  await login(page);
  await page.getByRole('button', { name: '打开导航', exact: true }).click();
  const theme = page.getByRole('navigation', { name: '移动端导航', exact: true }).getByRole('combobox', { name: '颜色主题', exact: true });
  for (const preference of ['dark', 'light', 'system']) {
    await theme.selectOption(preference);
    await expect(theme).toHaveValue(preference);
    await expect(page.locator('html')).toHaveAttribute('data-theme-preference', preference);
  }
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('button', { name: '显示偏好', exact: true }).click();
  await page.getByRole('radiogroup', { name: '颜色主题', exact: true }).getByRole('radio', { name: '深色', exact: true }).press('Enter');
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '打开导航', exact: true }).click();
  await expect(theme).toHaveValue('dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await assertNoConsoleErrors(consoleErrors);
});

test('serializes profile saves across tabs while a slow request is pending', async ({ page, consoleErrors }) => {
  await login(page);
  await page.goto('/?folder=settings');
  const { data: { profile: baseline } } = await (await page.request.get('/api/workspace/profile')).json();
  const tabs = page.getByRole('tablist', { name: '设置分区' });
  const save = page.getByRole('tabpanel').locator('button[type="submit"]');
  await tabs.getByRole('tab', { name: '通知', exact: true }).click();
  await page.locator('#profile-forwarding').click();
  await tabs.getByRole('tab', { name: '个人资料', exact: true }).click();
  await page.getByLabel('显示姓名').fill('Serialized profile save');
  const submissions: Array<Record<string, unknown>> = [];
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/workspace/profile', async (route) => {
    if (route.request().method() === 'PUT') {
      submissions.push(route.request().postDataJSON());
      if (submissions.length === 1) await delayed;
    }
    await route.continue();
  });
  try {
    await save.click();
    await expect.poll(() => submissions.length).toBe(1);
    await tabs.getByRole('tab', { name: '通知', exact: true }).click();
    await expect(page.locator('#profile-forwarding')).toBeDisabled();
    await expect(save).toBeDisabled();
    // Native form submission must also respect the shared in-flight save.
    await page.locator('#settings-panel-notifications form').evaluate((form) => (form as HTMLFormElement).requestSubmit());
    release();
    await expect(save).toBeEnabled();
    await expect(page.locator('#profile-forwarding')).toHaveAttribute('aria-checked', String(!baseline.forwardingEnabled));
    await save.click();
    await expect(save).toBeEnabled();
    expect(submissions).toHaveLength(2);
    expect(submissions[1]).toMatchObject({ name: 'Serialized profile save', forwardingEnabled: !baseline.forwardingEnabled });
    const { data: { profile: saved } } = await (await page.request.get('/api/workspace/profile')).json();
    expect(saved).toMatchObject({ name: 'Serialized profile save', forwardingEnabled: !baseline.forwardingEnabled });
    await assertNoConsoleErrors(consoleErrors);
  } finally {
    release();
  }
});

test('Telegram history pages independently and keeps binding links while the hidden tab stops polling', async ({ page, consoleErrors }, testInfo) => {
  await login(page);
  let settingsReads = 0;
  const deliveries = Array.from({ length: 21 }, (_, i) => ({ id: `synthetic-${i}`, subject: `Synthetic delivery ${i}`, status: 'sent', receivedAt: '2026-10-01T00:00:00Z', createdAt: '2026-10-01T00:00:00Z', completedAt: null, attempts: 1, maxAttempts: 5, lastErrorCode: null, manualRetryWarning: false }));
  await page.route('**/api/workspace/notifications/telegram/**', async (route) => {
    const url = new URL(route.request().url());
    let data: unknown;
    if (url.pathname.endsWith('/settings')) {
      settingsReads++;
      data = { globalEnabled: true, configReady: true, schemaReady: true, botUsername: 'synthetic_bot', timezone: 'UTC', userBound: false, userEnabled: false, binding: null, recentDeliveries: [] };
    } else if (url.pathname.endsWith('/deliveries')) {
      const second = url.searchParams.has('cursor');
      data = { deliveries: second ? deliveries.slice(20) : deliveries.slice(0, 20), hasMore: !second, nextCursor: second ? null : 'synthetic-next' };
    } else if (url.pathname.endsWith('/bind')) {
      data = { state: 'pending', expiresAt: '2099-01-01T00:00:00Z', deepLink: 'https://t.me/synthetic_bot?start=synthetic-challenge' };
    } else return route.continue();
    await route.fulfill({ json: { ok: true, data } });
  });
  await page.goto('/?folder=settings');
  const tabs = page.getByRole('tablist', { name: '设置分区' });
  expect(settingsReads).toBe(0);
  await tabs.getByRole('tab', { name: 'Telegram 通知', exact: true }).click();
  const panel = page.getByRole('tabpanel');
  await expect(panel.locator('.delivery-row')).toHaveCount(20);
  await panel.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(panel.locator('.delivery-row')).toHaveCount(1);
  await expect(panel).toContainText('Synthetic delivery 20');
  await panel.getByRole('button', { name: '生成 Telegram 绑定链接', exact: true }).click();
  await expect(panel.getByRole('link', { name: '打开 Telegram 继续绑定' })).toBeVisible();
  await tabs.getByRole('tab', { name: '诊断', exact: true }).click();
  const readsWhileHidden = settingsReads;
  await page.waitForTimeout(5500);
  expect(settingsReads).toBe(readsWhileHidden);
  await tabs.getByRole('tab', { name: 'Telegram 通知', exact: true }).click();
  await expect(page.getByRole('tabpanel').getByRole('link', { name: '打开 Telegram 继续绑定' })).toHaveAttribute('href', /synthetic-challenge/u);
  await expect(page.getByRole('tabpanel').locator('.delivery-row')).toHaveCount(1);
  await page.getByRole('tabpanel').getByRole('button', { name: '上一页', exact: true }).click();
  await expect(page.getByRole('tabpanel').locator('.delivery-row')).toHaveCount(20);
  await assertNoHorizontalOverflow(page);
  await page.screenshot({ path: join(tmpdir(), `flaremail-telegram-pages-${testInfo.project.name}.png`), fullPage: false });
  await assertNoConsoleErrors(consoleErrors);
});

test('domain and address tables paginate complete collections and reset pagination when filtered', async ({ page, consoleErrors }, testInfo) => {
  await login(page);
  const response = await page.request.get('/api/workspace/mail-identities');
  const { data } = await response.json();
  const domains = Array.from({ length: 26 }, (_, i) => ({ ...data.domains[0], id: `synthetic-domain-${i}`, domain_name: `domain-${String(i).padStart(2, '0')}.example.test`, enabled: 1 }));
  const addresses = Array.from({ length: 21 }, (_, i) => ({ ...data.addresses[0], id: `synthetic-address-${i}`, domain_id: domains[0].id, email: `mail-${String(i).padStart(2, '0')}@example.test`, display_name: '', lifecycle_status: 'active', is_default_sender: 0 }));
  await page.route('**/api/workspace/mail-identities', (route) => route.fulfill({ json: { ok: true, data: { ...data, domains, addresses } } }));
  await page.goto('/?folder=settings&view=domains');
  const domainRows = page.locator('[data-resource-kind="domain"]');
  await expect(domainRows).toHaveCount(10);
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(domainRows).toHaveCount(10);
  await expect(domainRows.first()).toContainText('domain-10.example.test');
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(domainRows).toHaveCount(6);
  await expect(domainRows.first()).toContainText('domain-20.example.test');
  await page.locator('#mail-resource-search').fill('domain-25');
  await expect(page.getByRole('button', { name: '上一页', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '下一页', exact: true })).toBeDisabled();
  await page.goto('/?folder=settings&view=addresses');
  const addressRows = page.locator('[data-resource-kind="address"]');
  await expect(addressRows).toHaveCount(10);
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(addressRows.first()).toContainText('mail-10@example.test');
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(addressRows).toHaveCount(1);
  await expect(addressRows.first()).toContainText('mail-20@example.test');
  await page.screenshot({ path: join(tmpdir(), `flaremail-resource-pagination-${testInfo.project.name}.png`), fullPage: false });
  await page.getByRole('button', { name: '上一页', exact: true }).click();
  await expect(addressRows).toHaveCount(10);
  await assertNoHorizontalOverflow(page);
  await page.screenshot({ path: join(tmpdir(), `flaremail-resource-pages-${testInfo.project.name}.png`), fullPage: false });
  await assertNoConsoleErrors(consoleErrors);
});

test('blocked sender quarantine keeps mail until an explicit release', async ({ page, consoleErrors }, testInfo) => {
  await login(page);
  await page.goto('/?folder=settings&tab=blocked');
  const tabs = page.getByRole('tablist', { name: '设置分区' });
  await expect(tabs.getByRole('tab', { name: '黑名单' })).toHaveAttribute('aria-selected', 'true');
  await tabs.getByRole('tab', { name: '个人资料' }).focus();
  await page.keyboard.press('End');
  await expect(tabs.getByRole('tab', { name: '黑名单' })).toBeFocused();
  const sender = `blocked-${testInfo.project.name}@sender.test`;
  const subject = `Quarantine regression ${testInfo.project.name}`;
  await page.getByLabel('发件人邮箱地址').fill(sender);
  await page.getByRole('button', { name: '加入黑名单' }).click();
  await expect(page.getByRole('status').filter({ hasText: '发件人已加入黑名单' })).toBeVisible();
  const raw = [
    `From: Test Sender <${sender}>`, 'To: e2e-admin@flaremail.test',
    `Message-ID: <quarantine-${testInfo.project.name}@sender.test>`,
    `Subject: ${subject}`, 'Content-Type: text/plain; charset=utf-8', '', 'Local fake message.'
  ].join('\r\n');
  const delivery = await page.request.post('/cdn-cgi/local/email?from=bounce%40sender.test&to=e2e-admin%40flaremail.test', {
    data: raw, headers: { 'content-type': 'message/rfc822' }
  });
  expect(delivery.ok()).toBeTruthy();
  await page.getByRole('button', { name: '刷新隔离区' }).click();
  const message = page.getByRole('link', { name: subject });
  await expect(message).toBeVisible();
  const inboxBefore = await (await page.request.get(`/api/workspace/mailbox?folder=inbox&q=${encodeURIComponent(subject)}`)).json();
  expect(inboxBefore.data.page.messages.some((item: { subject: string }) => item.subject === subject)).toBe(false);
  const readerPath = new URL((await message.getAttribute('href'))!, page.url()).pathname;
  await page.goto(readerPath);
  await expect(page).toHaveURL(/\/messages\//u);
  await expect(page.getByText('Local fake message.')).toBeVisible();
  await expect(page.getByText('如需回复或转发，请先返回隔离区并释放邮件。')).toBeVisible();
  await expect(page.getByRole('button', { name: '回复', exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: /返回工作台/u }).click();
  await expect(page.getByRole('button', { name: `释放到收件箱 ${subject}` })).toBeVisible();
  await page.screenshot({ path: join(tmpdir(), `flaremail-blocked-${testInfo.project.name}.png`), fullPage: false });
  expect((await new AxeBuilder({ page }).include('main').analyze()).violations).toEqual([]);
  await assertNoHorizontalOverflow(page);
  await page.getByRole('button', { name: `释放到收件箱 ${subject}` }).click();
  await expect(page.getByText('邮件已释放到收件箱。')).toBeVisible();
  const inboxAfter = await (await page.request.get(`/api/workspace/mailbox?folder=inbox&q=${encodeURIComponent(subject)}`)).json();
  expect(inboxAfter.data.page.messages.some((item: { subject: string }) => item.subject === subject)).toBe(true);
  await expect(page.getByRole('button', { name: `移除 ${sender}` })).toBeVisible();
  await page.getByRole('button', { name: `移除 ${sender}` }).click();
  await expect(page.getByText('规则已移除；隔离邮件仍保留。')).toBeVisible();
  await assertNoConsoleErrors(consoleErrors);
});

test('blocked sender controls wait for the initial lists', async ({ page }) => {
  await login(page);
  let resume!: () => void;
  const ready = new Promise<void>((resolve) => { resume = resolve; });
  await page.route('**/api/workspace/blocked-senders', async (route) => {
    if (route.request().method() === 'GET') await ready;
    await route.continue();
  });
  await page.goto('/?folder=settings&tab=blocked');
  await expect(page.getByLabel('发件人邮箱地址')).toBeDisabled();
  resume();
  await expect(page.getByLabel('发件人邮箱地址')).toBeEnabled();
});

test('refresh during quarantine navigation keeps the committed page', async ({ page }) => {
  await login(page);
  let resumeNext!: () => void;
  let nextStarted!: () => void;
  let resumeStale!: () => void;
  const nextGate = new Promise<void>((resolve) => { resumeNext = resolve; });
  const nextReady = new Promise<void>((resolve) => { nextStarted = resolve; });
  const staleGate = new Promise<void>((resolve) => { resumeStale = resolve; });
  let firstRequests = 0;
  let nextRequests = 0;
  await page.route('**/api/workspace/quarantine**', async (route) => {
    const cursor = new URL(route.request().url()).searchParams.get('cursor');
    if (cursor === 'page_two' && ++nextRequests === 1) { nextStarted(); await nextGate; }
    if (!cursor && ++firstRequests > 1) await staleGate;
    await route.fulfill({ json: { ok: true, data: {
      items: [{ id: cursor ? 'second' : 'first', sender: 'test@example.test', subject: cursor ? 'Race page two' : 'Race page one', timestamp: '2026-08-01T00:00:00Z' }],
      previousCursor: cursor ? 'previous' : null, nextCursor: cursor ? null : 'page_two'
    } } });
  });
  await page.goto('/?folder=settings&tab=blocked');
  await expect(page.getByRole('link', { name: 'Race page one' })).toBeVisible();
  await page.getByRole('button', { name: '下一页' }).click();
  await nextReady;
  await page.evaluate(async () => {
    const channel = new BroadcastChannel('flaremail-workspace-v1');
    channel.postMessage({ type: 'blocked-senders-changed' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    channel.close();
  });
  resumeNext();
  await expect(page).toHaveURL(/quarantineCursor=page_two/u);
  await page.waitForTimeout(250);
  resumeStale();
  await expect(page.getByRole('link', { name: 'Race page two' })).toBeVisible();
  await page.waitForTimeout(300);
  await expect(page.getByRole('link', { name: 'Race page one' })).toHaveCount(0);
  expect(firstRequests).toBe(1);
});

test('leaving the blocked tab invalidates an in-flight page navigation', async ({ page }) => {
  await login(page);
  let resume!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  const intercepted = new Promise<void>((resolve) => { started = resolve; });
  await page.route('**/api/workspace/quarantine**', async (route) => {
    const cursor = new URL(route.request().url()).searchParams.get('cursor');
    if (cursor === 'page_two') { started(); await gate; }
    await route.fulfill({ json: { ok: true, data: {
      items: [{ id: cursor ? 'second' : 'first', sender: 'test@example.test', subject: cursor ? 'Stale page two' : 'Current page one', timestamp: '2026-08-01T00:00:00Z' }],
      previousCursor: cursor ? 'previous' : null, nextCursor: cursor ? null : 'page_two'
    } } });
  });
  await page.goto('/?folder=settings&tab=blocked');
  await expect(page.getByRole('link', { name: 'Current page one' })).toBeVisible();
  await page.getByRole('button', { name: '下一页' }).click();
  await intercepted;
  await page.getByRole('tab', { name: '个人资料' }).click();
  await page.getByRole('tab', { name: '黑名单' }).click();
  const staleResponse = page.waitForResponse((response) => new URL(response.url()).searchParams.get('cursor') === 'page_two');
  resume();
  await staleResponse;
  await expect(page.getByRole('button', { name: '下一页' })).toBeEnabled();
  await expect(page.getByRole('link', { name: 'Current page one' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Stale page two' })).toHaveCount(0);
  await expect(page).not.toHaveURL(/quarantineCursor/u);
});

test('keyboard focus survives removing rules and releasing mail', async ({ page }, testInfo) => {
  await login(page);
  await page.goto('/?folder=settings&tab=blocked');
  const sender = `focus-${testInfo.project.name}@sender.test`;
  const subject = `Focus quarantine ${testInfo.project.name}`;
  await page.getByLabel('发件人邮箱地址').fill(sender);
  await page.getByRole('button', { name: '加入黑名单' }).click();
  const remove = page.getByRole('button', { name: `移除 ${sender}` });
  await remove.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('规则已移除；隔离邮件仍保留。')).toBeVisible();
  await expect(page.getByLabel('发件人邮箱地址')).toBeFocused();
  await page.getByLabel('发件人邮箱地址').fill(sender);
  await page.getByRole('button', { name: '加入黑名单' }).click();
  const raw = [
    `From: Test Sender <${sender}>`, 'To: e2e-admin@flaremail.test',
    `Message-ID: <focus-${testInfo.project.name}@sender.test>`,
    `Subject: ${subject}`, 'Content-Type: text/plain; charset=utf-8', '', 'Local fake message.'
  ].join('\r\n');
  expect((await page.request.post('/cdn-cgi/local/email?from=bounce%40sender.test&to=e2e-admin%40flaremail.test', {
    data: raw, headers: { 'content-type': 'message/rfc822' }
  })).ok()).toBeTruthy();
  await page.getByRole('button', { name: '刷新隔离区' }).click();
  const release = page.getByRole('button', { name: `释放到收件箱 ${subject}` });
  await release.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('邮件已释放到收件箱。')).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toMatch(/^(blocked-quarantine-refresh|blocked-operation-status)$/u);
});

test('quarantine retries the requested page and returns to it from the reader', async ({ page }) => {
  await page.addInitScript(() => { Reflect.deleteProperty(URLSearchParams.prototype, 'size'); });
  await login(page);
  let failNext = true;
  let pageOneSubject = '';
  const requests: Array<string | null> = [];
  await page.route('**/api/workspace/quarantine**', async (route) => {
    const url = new URL(route.request().url());
    const cursor = url.searchParams.get('cursor');
    const direction = url.searchParams.get('direction');
    requests.push(cursor);
    if (cursor === 'page_two' && failNext) {
      failNext = false;
      return route.fulfill({ status: 503, json: { ok: false, error: { code: 'OFFLINE', message: 'Offline' } } });
    }
    const number = cursor === 'page_four' ? 4 : cursor === 'page_three' || (cursor === 'back_four' && direction === 'previous') ? 3 : cursor ? 2 : 1;
    return route.fulfill({ json: { ok: true, data: {
      items: number === 1 && !pageOneSubject ? [] : [{ id: 'e2e-deep-inbound-message', sender: 'test@example.test', subject: number === 1 ? pageOneSubject : `Quarantine page ${number}`, timestamp: '2026-08-01T08:00:00.000Z' }],
      previousCursor: number === 1 ? null : `back_${number === 4 ? 'four' : number === 3 ? 'three' : 'two'}`,
      nextCursor: number === 4 ? null : number === 3 ? 'page_four' : number === 2 ? 'page_three' : 'page_two'
    } } });
  });
  await page.goto('/?folder=settings&tab=blocked');
  await page.getByRole('button', { name: '下一页' }).click();
  await expect(page.getByRole('alert')).toContainText('无法读取');
  await page.getByRole('button', { name: '重试' }).click();
  await expect(page.getByRole('link', { name: 'Quarantine page 2' })).toBeVisible();
  expect(requests.filter((cursor) => cursor === 'page_two')).toHaveLength(2);
  await page.getByRole('button', { name: '下一页' }).click();
  await expect(page.getByRole('link', { name: 'Quarantine page 3' })).toBeVisible();
  await page.getByRole('button', { name: '下一页' }).click();
  await page.getByRole('link', { name: 'Quarantine page 4' }).click();
  await expect(page).toHaveURL(/\/messages\//u);
  await page.getByRole('link', { name: /返回工作台/u }).click();
  await expect(page).toHaveURL(/quarantineCursor=page_four/u);
  await expect(page.getByRole('link', { name: 'Quarantine page 4' })).toBeVisible();
  await assertNoHorizontalOverflow(page);
  await page.getByRole('button', { name: '上一页' }).click();
  await expect(page.getByRole('link', { name: 'Quarantine page 3' })).toBeVisible();
  await page.getByRole('button', { name: '上一页' }).click();
  await expect(page.getByRole('link', { name: 'Quarantine page 2' })).toBeVisible();
  await expect(page.getByRole('button', { name: '上一页' })).toBeEnabled();

  const tabs = page.getByRole('tablist', { name: '设置分区' });
  await tabs.getByRole('tab', { name: '个人资料' }).click();
  pageOneSubject = 'New quarantine arrival';
  await tabs.getByRole('tab', { name: '黑名单' }).click();
  await expect(page.getByRole('link', { name: pageOneSubject })).toBeVisible();
  await page.getByRole('button', { name: '下一页' }).click();
  await expect(page.getByRole('link', { name: 'Quarantine page 2' })).toBeVisible();
  await page.getByRole('button', { name: '下一页' }).click();
  await expect(page.getByRole('link', { name: 'Quarantine page 3' })).toBeVisible();
  await page.goBack();
  await expect(tabs.getByRole('tab', { name: '个人资料' })).toHaveAttribute('aria-selected', 'true');
  await page.goBack();
  await expect(page.getByRole('link', { name: 'Quarantine page 2' })).toBeVisible();
});

test('reader reconciles a release after an in-flight read update', async ({ page, context }, testInfo) => {
  await login(page);
  await page.goto('/?folder=settings&tab=blocked');
  const sender = `blocked-race-${testInfo.project.name}@sender.test`;
  const subject = `Quarantine release race ${testInfo.project.name}`;
  await page.getByLabel('发件人邮箱地址').fill(sender);
  await page.getByRole('button', { name: '加入黑名单' }).click();
  await expect(page.getByText('发件人已加入黑名单。')).toBeVisible();
  const raw = [
    `From: Test Sender <${sender}>`, 'To: e2e-admin@flaremail.test',
    `Message-ID: <quarantine-race-${testInfo.project.name}@sender.test>`,
    `Subject: ${subject}`, 'Content-Type: text/plain; charset=utf-8', '', 'Local fake message.'
  ].join('\r\n');
  expect((await page.request.post('/cdn-cgi/local/email?from=bounce%40sender.test&to=e2e-admin%40flaremail.test', {
    data: raw, headers: { 'content-type': 'message/rfc822' }
  })).ok()).toBeTruthy();
  await page.getByRole('button', { name: '刷新隔离区' }).click();
  const message = page.getByRole('link', { name: subject });
  await expect(message).toBeVisible();
  const reader = await context.newPage();
  let resume!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  const intercepted = new Promise<void>((resolve) => { started = resolve; });
  await reader.route('**/api/workspace/messages/*/flags', async (route) => {
    started();
    await gate;
    await route.continue();
  });
  await reader.goto((await message.getAttribute('href'))!, { waitUntil: 'domcontentloaded' });
  await intercepted;
  await expect(reader.getByText('如需回复或转发，请先返回隔离区并释放邮件。')).toBeVisible();
  await reader.evaluate(() => {
    sessionStorage.removeItem('test-quarantine-refresh');
    const channel = new BroadcastChannel('flaremail-workspace-v1');
    channel.onmessage = (event) => {
      if (event.data.type === 'mailbox-refresh') {
        sessionStorage.setItem('test-quarantine-refresh', 'received');
        channel.close();
      }
    };
  });
  await page.getByRole('button', { name: `释放到收件箱 ${subject}` }).click();
  await expect(page.getByText('邮件已释放到收件箱。')).toBeVisible();
  await reader.waitForFunction(() => sessionStorage.getItem('test-quarantine-refresh') === 'received');
  resume();
  await expect(reader.getByText('如需回复或转发，请先返回隔离区并释放邮件。')).toHaveCount(0);
  await expect(reader.getByRole('button', { name: '回复', exact: true })).toBeVisible();
  await reader.close();
});

test('reader reconciles a release before its page finishes loading', async ({ page, context }, testInfo) => {
  await login(page);
  await page.goto('/?folder=settings&tab=blocked');
  const sender = `blocked-load-${testInfo.project.name}@sender.test`;
  const subject = `Quarantine load race ${testInfo.project.name}`;
  await page.getByLabel('发件人邮箱地址').fill(sender);
  await page.getByRole('button', { name: '加入黑名单' }).click();
  await expect(page.getByText('发件人已加入黑名单。')).toBeVisible();
  const raw = [
    `From: Test Sender <${sender}>`, 'To: e2e-admin@flaremail.test',
    `Message-ID: <quarantine-load-${testInfo.project.name}@sender.test>`,
    `Subject: ${subject}`, 'Content-Type: text/plain; charset=utf-8', '', 'Local fake message.'
  ].join('\r\n');
  expect((await page.request.post('/cdn-cgi/local/email?from=bounce%40sender.test&to=e2e-admin%40flaremail.test', {
    data: raw, headers: { 'content-type': 'message/rfc822' }
  })).ok()).toBeTruthy();
  await page.getByRole('button', { name: '刷新隔离区' }).click();
  const message = page.getByRole('link', { name: subject });
  await expect(message).toBeVisible();
  const reader = await context.newPage();
  let resume!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  const intercepted = new Promise<void>((resolve) => { started = resolve; });
  await reader.route('**/messages/**', async (route) => {
    if (route.request().resourceType() !== 'document') return route.continue();
    const response = await route.fetch();
    started();
    await gate;
    await route.fulfill({ response });
  });
  const navigation = reader.goto((await message.getAttribute('href'))!, { waitUntil: 'load' });
  await intercepted;
  await page.getByRole('button', { name: `释放到收件箱 ${subject}` }).click();
  await expect(page.getByText('邮件已释放到收件箱。')).toBeVisible();
  resume();
  await navigation;
  await expect(reader.getByText('如需回复或转发，请先返回隔离区并释放邮件。')).toHaveCount(0);
  await expect(reader.getByRole('button', { name: '回复', exact: true })).toBeVisible();
  await reader.close();
});

test('an emptied quarantine page returns to the first page', async ({ page }) => {
  await login(page);
  let firstPageHasMessage = true;
  let lastPageHasMessage = true;
  await page.route('**/api/workspace/quarantine**', async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === 'POST') {
      if (url.pathname.endsWith('/first')) firstPageHasMessage = false;
      else lastPageHasMessage = false;
      return route.fulfill({ json: { ok: true, data: {} } });
    }
    const second = url.searchParams.has('cursor');
    const item = (id: string, subject: string) => ({ id, subject, sender: 'test@example.test', timestamp: '2026-11-01T00:00:00.000Z' });
    return route.fulfill({ json: { ok: true, data: {
      items: second ? (lastPageHasMessage ? [item('last', 'Last message')] : [])
        : firstPageHasMessage ? [item('first', 'Earlier message')] : lastPageHasMessage ? [item('last', 'Last message')] : [],
      previousCursor: second && lastPageHasMessage ? 'page_one' : null,
      nextCursor: !second && firstPageHasMessage && lastPageHasMessage ? 'page_two' : null
    } } });
  });
  await page.goto('/?folder=settings&tab=blocked');
  await expect(page.getByRole('link', { name: 'Earlier message' })).toBeVisible();
  await page.getByRole('button', { name: '下一页' }).click();
  await page.getByRole('button', { name: '释放到收件箱 Last message' }).click();
  await expect(page.getByRole('link', { name: 'Earlier message' })).toBeVisible();
  await expect(page).not.toHaveURL(/quarantineCursor/u);
  await page.goto('/?folder=settings&tab=blocked&quarantineCursor=page_two&quarantinePage=2');
  await expect(page.getByRole('link', { name: 'Earlier message' })).toBeVisible();
  await expect(page).not.toHaveURL(/quarantineCursor/u);
  lastPageHasMessage = true;
  await page.getByRole('button', { name: '刷新隔离区' }).click();
  await page.getByRole('button', { name: '释放到收件箱 Earlier message' }).click();
  await expect(page.getByRole('link', { name: 'Last message' })).toBeVisible();
  await expect(page.getByRole('button', { name: '下一页' })).toBeDisabled();
});

test('blocked sender rules and quarantine releases sync between tabs', async ({ page, context }, testInfo) => {
  await login(page);
  await page.goto('/?folder=settings&tab=blocked');
  const other = await context.newPage();
  await other.goto('/?folder=settings&tab=blocked');
  await expect(other.getByLabel('发件人邮箱地址')).toBeEnabled();
  const sender = `blocked-tabs-${testInfo.project.name}@sender.test`;
  const subject = `Cross-tab quarantine ${testInfo.project.name}`;
  await page.getByLabel('发件人邮箱地址').fill(sender);
  await page.getByRole('button', { name: '加入黑名单' }).click();
  await expect(other.getByRole('button', { name: `移除 ${sender}` })).toBeVisible();
  await other.getByRole('button', { name: `移除 ${sender}` }).click();
  await expect(page.getByRole('button', { name: `移除 ${sender}` })).toHaveCount(0);
  await page.getByLabel('发件人邮箱地址').fill(sender);
  await page.getByRole('button', { name: '加入黑名单' }).click();
  await expect(other.getByRole('button', { name: `移除 ${sender}` })).toBeVisible();
  const raw = [
    `From: ${sender}`, 'To: e2e-admin@flaremail.test',
    `Message-ID: <quarantine-tabs-${testInfo.project.name}@sender.test>`,
    `Subject: ${subject}`, 'Content-Type: text/plain; charset=utf-8', '', 'Local fake message.'
  ].join('\r\n');
  expect((await page.request.post('/cdn-cgi/local/email?from=bounce%40sender.test&to=e2e-admin%40flaremail.test', {
    data: raw, headers: { 'content-type': 'message/rfc822' }
  })).ok()).toBeTruthy();
  await page.getByRole('button', { name: '刷新隔离区' }).click();
  await other.getByRole('button', { name: '刷新隔离区' }).click();
  await expect(other.getByRole('button', { name: `释放到收件箱 ${subject}` })).toBeVisible();
  await page.getByRole('button', { name: `释放到收件箱 ${subject}` }).click();
  await expect(other.getByRole('button', { name: `释放到收件箱 ${subject}` })).toHaveCount(0);
  await expect(other.getByRole('button', { name: `移除 ${sender}` })).toBeVisible();
  await other.close();
});

test('blocked sender requests cannot update the next authentication session', async ({ page }) => {
  await login(page);
  await page.goto('/?folder=settings&tab=blocked');
  await expect(page.getByLabel('发件人邮箱地址')).toBeEnabled();
  let resume!: () => void;
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => { resume = resolve; });
  const posted = new Promise<void>((resolve) => { started = resolve; });
  await page.route('**/api/workspace/blocked-senders', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    started();
    await waiting;
    await route.fulfill({ json: { ok: true, data: { email: 'stale@example.test' } } }).catch(() => undefined);
  });
  await page.getByLabel('发件人邮箱地址').fill('draft@example.test');
  await page.getByRole('button', { name: '加入黑名单' }).click();
  await posted;
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('flaremail:auth-expired', { detail: { source: 'worker-session' } })));
  resume();
  await expect(page.getByLabel('发件人邮箱地址')).toHaveValue('draft@example.test');
  await expect(page.getByText('stale@example.test')).toHaveCount(0);
  await expect(page.getByLabel('发件人邮箱地址')).toBeDisabled();
  await expect(page.getByRole('button', { name: '刷新隔离区' })).toBeDisabled();
  await page.getByRole('button', { name: '检查登录状态' }).click();
  await expect(page.getByLabel('发件人邮箱地址')).toBeEnabled();
  await expect(page.getByLabel('发件人邮箱地址')).toHaveValue('draft@example.test');
  await expect(page.getByText('stale@example.test')).toHaveCount(0);
});


test('failed block keeps its error and input until the owner retries the action', async ({ page }) => {
  await login(page);
  await page.goto('/?folder=settings&tab=blocked');
  await expect(page.getByLabel('发件人邮箱地址')).toBeEnabled();
  let failNext = true;
  let resume!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  const intercepted = new Promise<void>((resolve) => { started = resolve; });
  await page.route('**/api/workspace/blocked-senders', async (route) => {
    if (route.request().method() === 'POST' && failNext) {
      failNext = false;
      started();
      await gate;
      return route.fulfill({ status: 503, json: { ok: false, error: { code: 'OFFLINE', message: 'Offline' } } });
    }
    return route.continue();
  });
  await page.getByLabel('发件人邮箱地址').fill('retry@example.test');
  await page.getByRole('button', { name: '加入黑名单' }).click();
  await intercepted;
  await page.evaluate(() => {
    const channel = new BroadcastChannel('flaremail-workspace-v1');
    channel.postMessage({ type: 'blocked-senders-changed' });
    channel.close();
  });
  await page.getByRole('tab', { name: '个人资料' }).click();
  const failed = page.waitForResponse((response) => response.url().endsWith('/api/workspace/blocked-senders') && response.status() === 503);
  resume();
  await failed;
  await page.getByRole('tab', { name: '黑名单' }).click();
  await expect(page.getByRole('alert')).toContainText('无法保存');
  await expect(page.getByRole('button', { name: '重试', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('发件人邮箱地址')).toHaveValue('retry@example.test');
  await page.getByRole('button', { name: '加入黑名单' }).click();
  await expect(page.getByText('发件人已加入黑名单。')).toBeVisible();
  await page.getByRole('button', { name: '移除 retry@example.test' }).click();
});
