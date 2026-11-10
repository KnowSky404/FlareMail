import AxeBuilder from '@axe-core/playwright';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test, expect, login, openFolder, selectSettings, assertNoConsoleErrors, assertNoHorizontalOverflow, E2E_USERNAME, E2E_PASSWORD } from './fixtures';

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
  const senderName = 'Test "<Sender';
  await page.getByLabel('发件人邮箱地址').fill(sender);
  await page.getByRole('button', { name: '加入黑名单' }).click();
  await expect(page.getByRole('status').filter({ hasText: '发件人已加入黑名单' })).toBeVisible();
  const raw = [
    `From: =?UTF-8?B?${Buffer.from(senderName).toString('base64')}?= <${sender}>`, 'To: e2e-admin@flaremail.test',
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
  expect(inboxAfter.data.page.messages.find((item: { subject: string }) => item.subject === subject)).toMatchObject({ fromName: senderName, fromEmail: sender });
  await expect(page.getByRole('button', { name: `移除 ${sender}` })).toBeVisible();
  await page.getByRole('button', { name: `移除 ${sender}` }).click();
  await expect(page.getByText('规则已移除；隔离邮件仍保留。')).toBeVisible();
  await assertNoConsoleErrors(consoleErrors);
});

for (const recovery of ['retry', 'refresh'] as const) {
  test(`reconciles an uncertain quarantine release after reconnecting with ${recovery}`, async ({ page, context }, testInfo) => {
  await login(page);
  await page.goto('/?folder=settings&tab=blocked');
  const sender = `release-${recovery}-${testInfo.project.name}@sender.test`;
  const subject = `Quarantine ${recovery} ${testInfo.project.name}`;
  await page.getByLabel('发件人邮箱地址').fill(sender);
  await page.getByRole('button', { name: '加入黑名单' }).click();
  await expect(page.getByText('发件人已加入黑名单。')).toBeVisible();
  const raw = [
    `From: Test Sender <${sender}>`, 'To: e2e-admin@flaremail.test',
    `Message-ID: <release-${recovery}-${testInfo.project.name}@sender.test>`,
    `Subject: ${subject}`, 'Content-Type: text/plain; charset=utf-8', '', 'Local fake message.'
  ].join('\r\n');
  expect((await page.request.post('/cdn-cgi/local/email?from=bounce%40sender.test&to=e2e-admin%40flaremail.test', {
    data: raw, headers: { 'content-type': 'message/rfc822' }
  })).ok()).toBeTruthy();
  await page.getByRole('button', { name: '刷新隔离区' }).click();
  const message = page.getByRole('link', { name: subject });
  await expect(message).toBeVisible();
  const readerPath = (await message.getAttribute('href'))!;
  const messageId = decodeURIComponent(new URL(readerPath, page.url()).pathname.slice('/messages/'.length));
  const reader = await context.newPage();
  await reader.goto(readerPath);
  await expect(reader.getByText('如需回复或转发，请先返回隔离区并释放邮件。')).toBeVisible();
  await reader.waitForLoadState('networkidle');
  await reader.evaluate(() => {
    sessionStorage.removeItem('uncertain-release-refresh');
    const channel = new BroadcastChannel('flaremail-workspace-v1');
    channel.onmessage = (event) => {
      if (event.data.type === 'mailbox-refresh') {
        sessionStorage.setItem('uncertain-release-refresh', 'received');
        channel.close();
      }
    };
  });
  let mode: 'forbidden' | 'before' | 'lost' | 'normal' = 'forbidden';
  let offline = false;
  await page.route('**/api/workspace/messages/**', (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    if (offline) return route.abort('failed');
    if (mode === 'forbidden' && decodeURIComponent(new URL(route.request().url()).pathname) === `/api/workspace/messages/${messageId}`) {
      return route.fulfill({ json: { ok: true, data: { message: { quarantinedAt: null, archivedAt: null } } } });
    }
    return route.continue();
  });
  await page.route('**/api/workspace/quarantine**', async (route) => {
    if (route.request().method() === 'GET' && offline) return route.abort('failed');
    if (route.request().method() !== 'POST' || mode === 'normal') return route.continue();
    if (mode === 'forbidden') return route.fulfill({ status: 403, json: { ok: false, error: { code: 'FORBIDDEN', message: 'Forbidden' } } });
    if (mode === 'lost') {
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      offline = true;
    }
    return route.abort('failed');
  });
  const release = page.getByRole('button', { name: `释放到收件箱 ${subject}` });
  await release.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(message).toBeVisible();
  await expect(release).toBeEnabled();
  await expect(release).toBeFocused();
  mode = 'before';
  await release.click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(message).toBeVisible();
  await expect(release).toBeEnabled();
  mode = 'lost';
  await release.click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(release).toBeEnabled();
  offline = false;
  mode = 'normal';
  if (recovery === 'retry') {
    await release.click();
    await expect(page.getByText('邮件已释放到收件箱。')).toBeVisible();
  } else {
    await page.getByRole('button', { name: '刷新隔离区' }).click();
  }
  await expect(message).toHaveCount(0);
  await reader.waitForFunction(() => sessionStorage.getItem('uncertain-release-refresh') === 'received');
  await expect(reader.getByText('如需回复或转发，请先返回隔离区并释放邮件。')).toHaveCount(0);
  await expect(reader.getByRole('button', { name: '回复', exact: true })).toBeVisible();
  await reader.close();
  });
}

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

test('release still syncs after leaving settings during its response', async ({ page, context }, testInfo) => {
  await login(page);
  await page.goto('/?folder=settings&tab=blocked');
  const sender = `release-leave-${testInfo.project.name}@sender.test`;
  const subject = `Release while leaving ${testInfo.project.name}`;
  await page.getByLabel('发件人邮箱地址').fill(sender);
  await page.getByRole('button', { name: '加入黑名单' }).click();
  await expect(page.getByText('发件人已加入黑名单。')).toBeVisible();
  const raw = [
    `From: ${sender}`, 'To: e2e-admin@flaremail.test',
    `Message-ID: <release-leave-${testInfo.project.name}@sender.test>`,
    `Subject: ${subject}`, 'Content-Type: text/plain; charset=utf-8', '', 'Local fake message.'
  ].join('\r\n');
  expect((await page.request.post('/cdn-cgi/local/email?from=bounce%40sender.test&to=e2e-admin%40flaremail.test', {
    data: raw, headers: { 'content-type': 'message/rfc822' }
  })).ok()).toBeTruthy();
  await page.getByRole('button', { name: '刷新隔离区' }).click();
  const link = page.getByRole('link', { name: subject });
  await expect(link).toBeVisible();
  const reader = await context.newPage();
  await reader.goto((await link.getAttribute('href'))!);
  await expect(reader.getByText('如需回复或转发，请先返回隔离区并释放邮件。')).toBeVisible();
  await reader.waitForLoadState('networkidle');
  await reader.evaluate(() => {
    sessionStorage.removeItem('release-after-leaving');
    const channel = new BroadcastChannel('flaremail-workspace-v1');
    channel.onmessage = (event) => {
      if (event.data.type === 'mailbox-refresh') {
        sessionStorage.setItem('release-after-leaving', 'received');
        channel.close();
      }
    };
  });
  let resume!: () => void;
  let committed!: () => void;
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  const committedOnServer = new Promise<void>((resolve) => { committed = resolve; });
  await page.route('**/api/workspace/quarantine/*', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch();
    committed();
    await gate;
    try { await route.fulfill({ response }); } catch { /* An aborted request cannot receive its response. */ }
  });
  try {
    await page.getByRole('button', { name: `释放到收件箱 ${subject}` }).click();
    await committedOnServer;
    await openFolder(page, '收件箱');
    expect(await reader.evaluate(() => sessionStorage.getItem('release-after-leaving'))).toBeNull();
    resume();
    await reader.waitForFunction(() => sessionStorage.getItem('release-after-leaving') === 'received');
    await expect(reader.getByText('如需回复或转发，请先返回隔离区并释放邮件。')).toHaveCount(0);
    await expect(reader.getByRole('button', { name: '回复', exact: true })).toBeVisible();
    await expect(page.getByText(subject).first()).toBeVisible();
  } finally {
    resume();
    await reader.close();
  }
});

for (const sessionEnd of ['expiry', 'logout'] as const) {
  test(`late release response cannot expire a restored session after ${sessionEnd}`, async ({ page }) => {
  await login(page);
  await page.route('**/api/workspace/quarantine', (route) => route.fulfill({ json: { ok: true, data: {
    items: [{ id: 'delayed-release', sender: 'sender@example.test', subject: 'Delayed release', timestamp: '2026-08-01T08:00:00.000Z' }],
    previousCursor: null, nextCursor: null
  } } }));
  await page.goto('/?folder=settings&tab=blocked');
  if (sessionEnd === 'logout') await page.evaluate(() => Reflect.deleteProperty(window, 'BroadcastChannel'));
  const release = page.getByRole('button', { name: '释放到收件箱 Delayed release' });
  await expect(release).toBeVisible();
  let resume!: () => void;
  let started!: () => void;
  let finished!: () => void;
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  const requestStarted = new Promise<void>((resolve) => { started = resolve; });
  const responseFinished = new Promise<void>((resolve) => { finished = resolve; });
  await page.route('**/api/workspace/quarantine/*', async (route) => {
    started();
    await gate;
    try {
      await route.fulfill({ status: 401, json: { ok: false, error: { code: 'AUTHENTICATION_REQUIRED', message: 'Expired' } } });
    } catch { /* The expired session aborts this request. */ }
    finished();
  });
  try {
    await release.click();
    await requestStarted;
    await openFolder(page, '收件箱');
    const recover = page.getByRole('button', { name: '检查登录状态' });
    if (sessionEnd === 'expiry') {
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('flaremail:auth-expired', { detail: { source: 'worker-session' } })));
      await expect(recover).toBeVisible();
      await recover.click();
      await expect(recover).toBeHidden();
    } else {
      await page.getByRole('button', { name: '账号菜单' }).click();
      await page.getByRole('menuitem', { name: '退出登录' }).click();
      await expect(page.getByRole('heading', { name: '登录邮件工作台' })).toBeVisible();
      await page.getByLabel('管理员用户名').fill(E2E_USERNAME);
      await page.getByLabel('密码').fill(E2E_PASSWORD);
      await page.getByRole('button', { name: '登录', exact: true }).click();
      await expect(page.getByRole('main', { name: '邮件工作区' })).toBeVisible();
    }
    resume();
    await responseFinished;
    await page.waitForLoadState('networkidle');
    await expect(recover).toBeHidden();
  } finally {
    resume();
  }
  });
}

test('release invalidates a pending workspace deep-link read', async ({ page, context }, testInfo) => {
  await login(page);
  await page.goto('/?folder=settings&tab=blocked');
  const sender = `pending-deep-link-${testInfo.project.name}@sender.test`;
  const subject = `Pending deep link ${testInfo.project.name}`;
  await page.getByLabel('发件人邮箱地址').fill(sender);
  await page.getByRole('button', { name: '加入黑名单' }).click();
  await expect(page.getByText('发件人已加入黑名单。')).toBeVisible();
  const raw = [
    `From: Test Sender <${sender}>`, 'To: e2e-admin@flaremail.test',
    `Message-ID: <pending-deep-link-${testInfo.project.name}@sender.test>`,
    `Subject: ${subject}`, 'Content-Type: text/plain; charset=utf-8', '', 'Local fake message.'
  ].join('\r\n');
  expect((await page.request.post('/cdn-cgi/local/email?from=bounce%40sender.test&to=e2e-admin%40flaremail.test', {
    data: raw, headers: { 'content-type': 'message/rfc822' }
  })).ok()).toBeTruthy();
  await page.getByRole('button', { name: '刷新隔离区' }).click();
  const link = page.getByRole('link', { name: subject });
  await expect(link).toBeVisible();
  const id = decodeURIComponent(new URL((await link.getAttribute('href'))!, page.url()).pathname.slice('/messages/'.length));
  const reader = await context.newPage();
  let resumeOld!: () => void;
  let oldStarted!: () => void;
  let latestStarted!: () => void;
  let resumeMailbox!: () => void;
  const oldGate = new Promise<void>((resolve) => { resumeOld = resolve; });
  const oldReady = new Promise<void>((resolve) => { oldStarted = resolve; });
  const latestReady = new Promise<void>((resolve) => { latestStarted = resolve; });
  const mailboxGate = new Promise<void>((resolve) => { resumeMailbox = resolve; });
  let first = true;
  let released = false;
  await reader.route('**/api/workspace/messages/**', async (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname);
    if (first && route.request().method() === 'GET' && path === `/api/workspace/messages/${id}`) {
      first = false;
      const response = await route.fetch();
      oldStarted();
      await oldGate;
      try { await route.fulfill({ response }); } catch { /* Superseded reads may be aborted. */ }
      return;
    }
    if (released && route.request().method() === 'GET' && path === `/api/workspace/messages/${id}`) latestStarted();
    return route.continue();
  });
  await reader.route('**/api/workspace/mailbox?**', async (route) => {
    if (released) await mailboxGate;
    return route.continue();
  });
  try {
    const navigation = reader.goto(`/?folder=inbox&message=${encodeURIComponent(id)}`, { waitUntil: 'domcontentloaded' });
    await oldReady;
    released = true;
    await page.getByRole('button', { name: `释放到收件箱 ${subject}` }).click();
    await expect(page.getByText('邮件已释放到收件箱。')).toBeVisible();
    await latestReady;
    resumeOld();
    await navigation;
    const detail = reader.locator('.fm-detail-shell').filter({ hasText: subject });
    await expect(detail.getByRole('button', { name: '回复', exact: true }).first()).toBeVisible();
    await expect(detail.getByText('如需回复或转发，请先返回隔离区并释放邮件。')).toHaveCount(0);
  } finally {
    resumeOld();
    resumeMailbox();
    await reader.close();
  }
});

test('readers can retry a failed cross-tab release status refresh', async ({ page, context }, testInfo) => {
  await login(page);
  await page.goto('/?folder=settings&tab=blocked');
  const sender = `status-retry-${testInfo.project.name}@sender.test`;
  const subject = `Status retry ${testInfo.project.name}`;
  await page.getByLabel('发件人邮箱地址').fill(sender);
  await page.getByRole('button', { name: '加入黑名单' }).click();
  await expect(page.getByText('发件人已加入黑名单。')).toBeVisible();
  const raw = [
    `From: Test Sender <${sender}>`, 'To: e2e-admin@flaremail.test',
    `Message-ID: <status-retry-${testInfo.project.name}@sender.test>`,
    `Subject: ${subject}`, 'Content-Type: text/plain; charset=utf-8', '', 'Local fake message.'
  ].join('\r\n');
  expect((await page.request.post('/cdn-cgi/local/email?from=bounce%40sender.test&to=e2e-admin%40flaremail.test', {
    data: raw, headers: { 'content-type': 'message/rfc822' }
  })).ok()).toBeTruthy();
  await page.getByRole('button', { name: '刷新隔离区' }).click();
  const link = page.getByRole('link', { name: subject });
  await expect(link).toBeVisible();
  const href = (await link.getAttribute('href'))!;
  const id = decodeURIComponent(new URL(href, page.url()).pathname.slice('/messages/'.length));
  const standalone = await context.newPage();
  await standalone.goto(href);
  await expect(standalone.getByText('如需回复或转发，请先返回隔离区并释放邮件。')).toBeVisible();
  await standalone.waitForLoadState('networkidle');
  const workspace = await context.newPage();
  await workspace.goto(`/?folder=inbox&message=${encodeURIComponent(id)}`);
  const detail = workspace.locator('.fm-detail-shell').filter({ hasText: subject });
  await expect(detail.getByText('如需回复或转发，请先返回隔离区并释放邮件。')).toBeVisible();
  await workspace.waitForLoadState('networkidle');
  for (const target of [standalone, workspace]) {
    let fail = true;
    await target.route('**/api/workspace/messages/**', (route) => {
      const path = decodeURIComponent(new URL(route.request().url()).pathname);
      if (fail && route.request().method() === 'GET' && path === `/api/workspace/messages/${id}`) {
        fail = false;
        return route.fulfill({ status: 503, json: { ok: false, error: { code: 'TEST_REFRESH_FAILED', message: 'Synthetic refresh failure' } } });
      }
      return route.continue();
    });
  }
  await page.getByRole('button', { name: `释放到收件箱 ${subject}` }).click();
  await expect(page.getByText('邮件已释放到收件箱。')).toBeVisible();
  const standaloneError = standalone.getByRole('alert').filter({ hasText: '邮件状态更新失败，请重试。' });
  const workspaceError = detail.getByRole('alert').filter({ hasText: '邮件状态更新失败，请重试。' });
  await expect(standaloneError).toBeVisible();
  await expect(workspaceError).toBeVisible();
  expect((await new AxeBuilder({ page: standalone }).include('main').analyze()).violations).toEqual([]);
  expect((await new AxeBuilder({ page: workspace }).include('.fm-detail-shell').analyze()).violations).toEqual([]);
  const standaloneRetry = standaloneError.getByRole('button', { name: '重试' });
  await standaloneRetry.focus();
  await standalone.keyboard.press('Enter');
  const workspaceRetry = workspaceError.getByRole('button', { name: '重试' });
  await workspaceRetry.focus();
  await workspace.keyboard.press('Enter');
  await expect(standaloneError).toHaveCount(0);
  await expect(workspaceError).toHaveCount(0);
  await expect(standalone.getByText('如需回复或转发，请先返回隔离区并释放邮件。')).toHaveCount(0);
  await expect(detail.getByText('如需回复或转发，请先返回隔离区并释放邮件。')).toHaveCount(0);
  await expect(standalone.getByRole('button', { name: '回复', exact: true })).toBeVisible();
  await expect(detail.getByRole('button', { name: '回复', exact: true }).first()).toBeVisible();
  await workspace.evaluate(() => window.dispatchEvent(new CustomEvent('flaremail:auth-expired', { detail: { source: 'other-tab' } })));
  await expect(workspace.getByRole('button', { name: '检查登录状态' })).toBeVisible();
  const recovered = workspace.waitForResponse((response) => response.request().method() === 'GET' &&
    decodeURIComponent(new URL(response.url()).pathname) === `/api/workspace/messages/${id}` && response.ok());
  await workspace.getByRole('button', { name: '检查登录状态' }).click();
  await recovered;
  await expect(workspace.getByRole('button', { name: '检查登录状态' })).toBeHidden();
  await standalone.close();
  await workspace.close();
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

test('a failed read of quarantined mail does not add an unread badge', async ({ page }, testInfo) => {
  await login(page);
  const mailbox = await (await page.request.get('/api/workspace/mailbox?folder=inbox&limit=100')).json();
  const unread = mailbox.data.page.messages.filter((item: { read: boolean }) => !item.read).map((item: { id: string }) => item.id);
  const mutate = async (action: 'read' | 'unread') => page.evaluate(async ({ action, ids }) => {
    const response = await fetch('/api/workspace/mailbox/mutate', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'XMLHttpRequest' },
      body: JSON.stringify({ action, ids, threadKeys: [], scope: { section: 'inbox', identityFilter: null, threadScope: 'selected' } })
    });
    return response.ok;
  }, { action, ids: unread });
  if (unread.length) expect(await mutate('read')).toBe(true);
  try {
    const metrics = await (await page.request.get('/api/workspace/mailbox/metrics')).json();
    expect(metrics.data.metrics.unreadCount).toBe(0);
    await page.goto('/?folder=settings&tab=blocked');
    const sender = `unread-quarantine-${testInfo.project.name}@sender.test`;
    const subject = `Unread quarantine ${testInfo.project.name}`;
    await page.getByLabel('发件人邮箱地址').fill(sender);
    await page.getByRole('button', { name: '加入黑名单' }).click();
    await expect(page.getByText('发件人已加入黑名单。')).toBeVisible();
    const raw = [
      `From: Test Sender <${sender}>`, 'To: e2e-admin@flaremail.test',
      `Message-ID: <unread-quarantine-${testInfo.project.name}@sender.test>`,
      `Subject: ${subject}`, 'Content-Type: text/plain; charset=utf-8', '', 'Local fake message.'
    ].join('\r\n');
    expect((await page.request.post('/cdn-cgi/local/email?from=bounce%40sender.test&to=e2e-admin%40flaremail.test', {
      data: raw, headers: { 'content-type': 'message/rfc822' }
    })).ok()).toBeTruthy();
    await page.getByRole('button', { name: '刷新隔离区' }).click();
    const link = page.getByRole('link', { name: subject });
    await expect(link).toBeVisible();
    const id = decodeURIComponent(new URL((await link.getAttribute('href'))!, page.url()).pathname.slice('/messages/'.length));
    await page.route('**/api/workspace/mailbox/metrics**', (route) => route.fulfill({ status: 503, json: { ok: false, error: { code: 'TEST_METRICS_FAILED', message: 'Synthetic metrics failure' } } }));
    await page.route('**/api/workspace/mailbox?**', async (route) => {
      const response = await route.fetch();
      const payload = await response.json();
      if (payload.data?.page) delete payload.data.page.metrics;
      await route.fulfill({ response, json: payload });
    });
    await page.route('**/api/workspace/messages/*/flags**', (route) => route.request().method() === 'PATCH'
      ? route.fulfill({ status: 503, json: { ok: false, error: { code: 'TEST_READ_FAILED', message: 'Synthetic read failure' } } })
      : route.continue());
    const failedRead = page.waitForResponse((response) => response.request().method() === 'PATCH' && response.url().includes('/flags') && response.status() === 503);
    await page.goto(`/?folder=inbox&message=${encodeURIComponent(id)}`);
    await failedRead;
    await expect(page.getByText('Synthetic read failure')).toBeVisible();
    await expect(page.locator('#sidebar-inbox-count')).toHaveCount(0);
  } finally {
    if (unread.length) expect(await mutate('unread')).toBe(true);
  }
});

test('same-tab release clears a cached deep-linked quarantine state', async ({ page }, testInfo) => {
  await login(page);
  await page.goto('/?folder=settings&tab=blocked');
  const sender = `same-tab-release-${testInfo.project.name}@sender.test`;
  const subject = `Same tab release ${testInfo.project.name}`;
  await page.getByLabel('发件人邮箱地址').fill(sender);
  await page.getByRole('button', { name: '加入黑名单' }).click();
  await expect(page.getByText('发件人已加入黑名单。')).toBeVisible();
  const raw = [
    `From: Test Sender <${sender}>`, 'To: e2e-admin@flaremail.test',
    `Message-ID: <same-tab-release-${testInfo.project.name}@sender.test>`,
    `Subject: ${subject}`, 'Content-Type: text/plain; charset=utf-8', '', 'Local fake message.'
  ].join('\r\n');
  expect((await page.request.post('/cdn-cgi/local/email?from=bounce%40sender.test&to=e2e-admin%40flaremail.test', {
    data: raw, headers: { 'content-type': 'message/rfc822' }
  })).ok()).toBeTruthy();
  await page.getByRole('button', { name: '刷新隔离区' }).click();
  const link = page.getByRole('link', { name: subject });
  await expect(link).toBeVisible();
  const id = decodeURIComponent(new URL((await link.getAttribute('href'))!, page.url()).pathname.slice('/messages/'.length));
  await page.goto(`/?folder=inbox&message=${encodeURIComponent(id)}`);
  const detail = page.locator('.fm-detail-shell').filter({ hasText: subject });
  await expect(detail.getByText('如需回复或转发，请先返回隔离区并释放邮件。')).toBeVisible();
  const back = page.getByRole('button', { name: '返回邮件列表' });
  if (await back.isVisible().catch(() => false)) await back.click();
  await selectSettings(page);
  await page.getByRole('tablist', { name: '设置分区' }).getByRole('tab', { name: '黑名单' }).click();
  await page.getByRole('button', { name: `释放到收件箱 ${subject}` }).click();
  await expect(page.getByText('邮件已释放到收件箱。')).toBeVisible();
  await openFolder(page, '收件箱');
  const row = page.getByRole('listitem').filter({ hasText: subject });
  await row.getByRole('button').first().click();
  await expect(detail.getByText('如需回复或转发，请先返回隔离区并释放邮件。')).toHaveCount(0);
  await expect(detail.getByRole('button', { name: '回复', exact: true }).first()).toBeVisible();
  await expect(detail.getByRole('button', { name: '归档', exact: true })).toHaveCount(1);
});

test('cross-tab release refreshes an unselected cached deep link', async ({ page, context }, testInfo) => {
  await login(page);
  await page.goto('/?folder=settings&tab=blocked');
  const sender = `unselected-release-${testInfo.project.name}@sender.test`;
  const subject = `Unselected release ${testInfo.project.name}`;
  await page.getByLabel('发件人邮箱地址').fill(sender);
  await page.getByRole('button', { name: '加入黑名单' }).click();
  await expect(page.getByText('发件人已加入黑名单。')).toBeVisible();
  const raw = [
    `From: Test Sender <${sender}>`, 'To: e2e-admin@flaremail.test',
    `Message-ID: <unselected-release-${testInfo.project.name}@sender.test>`,
    `Subject: ${subject}`, 'Content-Type: text/plain; charset=utf-8', '', 'Local fake message.'
  ].join('\r\n');
  expect((await page.request.post('/cdn-cgi/local/email?from=bounce%40sender.test&to=e2e-admin%40flaremail.test', {
    data: raw, headers: { 'content-type': 'message/rfc822' }
  })).ok()).toBeTruthy();
  await page.getByRole('button', { name: '刷新隔离区' }).click();
  const link = page.getByRole('link', { name: subject });
  await expect(link).toBeVisible();
  const id = decodeURIComponent(new URL((await link.getAttribute('href'))!, page.url()).pathname.slice('/messages/'.length));
  await page.goto(`/?folder=inbox&message=${encodeURIComponent(id)}`);
  const detail = page.locator('.fm-detail-shell').filter({ hasText: subject });
  await expect(detail.getByText('如需回复或转发，请先返回隔离区并释放邮件。')).toBeVisible();
  const back = page.getByRole('button', { name: '返回邮件列表' });
  if (await back.isVisible().catch(() => false)) await back.click();
  const otherRow = page.getByRole('listitem').filter({ hasText: 'E2E Bulk 02' });
  await otherRow.getByRole('button').first().click();
  if (await back.isVisible().catch(() => false)) await back.click();
  await selectSettings(page);
  await page.getByRole('tablist', { name: '设置分区' }).getByRole('tab', { name: '黑名单' }).click();
  await expect(page.getByRole('link', { name: subject })).toBeVisible();
  const other = await context.newPage();
  await other.goto('/?folder=settings&tab=blocked');
  await other.getByRole('button', { name: `释放到收件箱 ${subject}` }).click();
  await expect(other.getByText('邮件已释放到收件箱。')).toBeVisible();
  await expect(page.getByRole('link', { name: subject })).toHaveCount(0);
  await openFolder(page, '收件箱');
  await page.getByRole('listitem').filter({ hasText: subject }).getByRole('button').first().click();
  await expect(detail.getByText('如需回复或转发，请先返回隔离区并释放邮件。')).toHaveCount(0);
  await expect(detail.getByRole('button', { name: '回复', exact: true }).first()).toBeVisible();
  await other.close();
});

test('workspace deep link reconciles release and hides archive while quarantined', async ({ page, context }, testInfo) => {
  await login(page);
  await page.goto('/?folder=settings&tab=blocked');
  const sender = `deep-link-${testInfo.project.name}@sender.test`;
  const subject = `Quarantine deep link ${testInfo.project.name}`;
  await page.getByLabel('发件人邮箱地址').fill(sender);
  await page.getByRole('button', { name: '加入黑名单' }).click();
  await expect(page.getByRole('button', { name: `移除 ${sender}` })).toBeVisible();
  const raw = [
    `From: Test Sender <${sender}>`, 'To: e2e-admin@flaremail.test',
    `Message-ID: <deep-link-${testInfo.project.name}@sender.test>`,
    `Subject: ${subject}`, 'Content-Type: text/plain; charset=utf-8', '', 'Local fake message.'
  ].join('\r\n');
  expect((await page.request.post('/cdn-cgi/local/email?from=bounce%40sender.test&to=e2e-admin%40flaremail.test', {
    data: raw, headers: { 'content-type': 'message/rfc822' }
  })).ok()).toBeTruthy();
  await page.getByRole('button', { name: '刷新隔离区' }).click();
  const link = page.getByRole('link', { name: subject });
  await expect(link).toBeVisible();
  const path = new URL((await link.getAttribute('href'))!, page.url()).pathname;
  const id = decodeURIComponent(path.slice('/messages/'.length));
  const reader = await context.newPage();
  await reader.goto(`/?folder=inbox&message=${encodeURIComponent(id)}`);
  const detail = reader.locator('.fm-detail-shell').filter({ hasText: subject });
  await expect(detail.getByText('如需回复或转发，请先返回隔离区并释放邮件。')).toBeVisible();
  await expect(detail.getByRole('button', { name: '归档', exact: true })).toHaveCount(0);
  await reader.waitForLoadState('networkidle');
  const readAction = detail.locator('button[aria-label="标为已读"], button[aria-label="标为未读"]').first();
  await expect(readAction).toHaveCount(1);
  const remoteRead = (await readAction.getAttribute('aria-label')) === '标为已读';
  let resumeRefresh!: () => void;
  let refreshStarted!: () => void;
  const refreshGate = new Promise<void>((resolve) => { resumeRefresh = resolve; });
  const refreshReady = new Promise<void>((resolve) => { refreshStarted = resolve; });
  await reader.route('**/api/workspace/messages/**', async (route) => {
    const target = new URL(route.request().url());
    if (route.request().method() !== 'GET' || decodeURIComponent(target.pathname) !== `/api/workspace/messages/${id}`) return route.continue();
    const response = await route.fetch();
    const payload = await response.json();
    payload.data.message.read = remoteRead;
    refreshStarted();
    await refreshGate;
    await route.fulfill({ response, json: payload });
  });
  await page.getByRole('button', { name: `释放到收件箱 ${subject}` }).click();
  await expect(page.getByText('邮件已释放到收件箱。')).toBeVisible();
  await refreshReady;
  const flagged = reader.waitForResponse((response) => response.request().method() === 'PATCH' && response.url().includes('/flags'));
  await detail.getByRole('button', { name: '加星', exact: true }).click();
  await flagged;
  await expect(detail.getByRole('button', { name: '取消星标', exact: true })).toBeVisible();
  resumeRefresh();
  await expect(detail.getByText('如需回复或转发，请先返回隔离区并释放邮件。')).toHaveCount(0);
  await expect(detail.getByRole('button', { name: '取消星标', exact: true })).toBeVisible();
  await expect(readAction).toHaveAttribute('aria-label', remoteRead ? '标为未读' : '标为已读');
  await expect(detail.getByRole('button', { name: '回复', exact: true }).first()).toBeVisible();
  await expect(detail.getByRole('button', { name: '归档', exact: true })).toHaveCount(1);

  await reader.unroute('**/api/workspace/messages/**');
  let resumeSecond!: () => void;
  let secondStarted!: () => void;
  const secondGate = new Promise<void>((resolve) => { resumeSecond = resolve; });
  const secondReady = new Promise<void>((resolve) => { secondStarted = resolve; });
  await reader.route('**/api/workspace/messages/**', async (route) => {
    const target = new URL(route.request().url());
    if (route.request().method() !== 'GET' || decodeURIComponent(target.pathname) !== `/api/workspace/messages/${id}`) return route.continue();
    const response = await route.fetch();
    const payload = await response.json();
    payload.data.message.starred = false;
    secondStarted();
    await secondGate;
    await route.fulfill({ response, json: payload });
  });
  await page.evaluate((messageId) => {
    const channel = new BroadcastChannel('flaremail-workspace-v1');
    channel.postMessage({ type: 'mailbox-refresh', id: messageId });
    channel.close();
  }, id);
  await secondReady;
  const nextRead = !remoteRead;
  const readPatched = reader.waitForResponse((response) => response.request().method() === 'PATCH' && response.url().includes('/flags'));
  if (await readAction.isVisible()) await readAction.click();
  else {
    await detail.getByRole('button', { name: '更多邮件操作' }).click();
    await reader.getByRole('menuitem', { name: remoteRead ? '标为未读' : '标为已读' }).click();
  }
  await readPatched;
  await expect(readAction).toHaveAttribute('aria-label', nextRead ? '标为未读' : '标为已读');
  resumeSecond();
  await expect(detail.getByRole('button', { name: '加星', exact: true })).toBeVisible();
  await expect(readAction).toHaveAttribute('aria-label', nextRead ? '标为未读' : '标为已读');
  await reader.close();
});

test('cross-tab updates refresh the lists without erasing a failed operation', async ({ page, context }, testInfo) => {
  await login(page);
  await page.goto('/?folder=settings&tab=blocked');
  await expect(page.getByLabel('发件人邮箱地址')).toBeEnabled();
  await page.route('**/api/workspace/blocked-senders', (route) => route.request().method() === 'POST'
    ? route.fulfill({ status: 503, json: { ok: false, error: { code: 'OFFLINE', message: 'Offline' } } })
    : route.continue());
  const unsaved = `failed-${testInfo.project.name}@sender.test`;
  const otherSender = `synced-${testInfo.project.name}@sender.test`;
  await page.getByLabel('发件人邮箱地址').fill(unsaved);
  await page.getByRole('button', { name: '加入黑名单' }).click();
  await expect(page.getByRole('alert')).toContainText('无法保存');
  const other = await context.newPage();
  await other.goto('/?folder=settings&tab=blocked');
  await other.getByLabel('发件人邮箱地址').fill(otherSender);
  await other.getByRole('button', { name: '加入黑名单' }).click();
  await expect(page.getByRole('button', { name: `移除 ${otherSender}` })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('无法保存');
  await expect(page.getByLabel('发件人邮箱地址')).toHaveValue(unsaved);
  await other.close();
});

test('cross-tab changes retry a failed quarantine page', async ({ page, context }) => {
  await login(page);
  let failNext = true;
  await page.route('**/api/workspace/quarantine**', (route) => {
    const cursor = new URL(route.request().url()).searchParams.get('cursor');
    if (cursor === 'page_two' && failNext) {
      failNext = false;
      return route.fulfill({ status: 503, json: { ok: false, error: { code: 'OFFLINE', message: 'Offline' } } });
    }
    return route.fulfill({ json: { ok: true, data: {
      items: cursor ? [{ id: 'next', sender: 'test@example.test', subject: 'Retried page', timestamp: '2026-08-01T08:00:00Z' }] : [],
      previousCursor: cursor ? 'back' : null, nextCursor: cursor ? null : 'page_two'
    } } });
  });
  await page.goto('/?folder=settings&tab=blocked');
  await page.getByRole('button', { name: '下一页' }).click();
  await expect(page.getByRole('alert')).toContainText('无法读取');
  const other = await context.newPage();
  await other.goto('/');
  await other.evaluate(() => {
    const channel = new BroadcastChannel('flaremail-workspace-v1');
    channel.postMessage({ type: 'blocked-senders-changed' });
    channel.close();
  });
  await expect(page.getByRole('link', { name: 'Retried page' })).toBeVisible();
  await expect(page).toHaveURL(/quarantineCursor=page_two/u);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await other.close();
});

test('moving a quarantined deep link to trash refreshes another tab', async ({ page, context }, testInfo) => {
  await login(page);
  await page.goto('/?folder=settings&tab=blocked');
  const sender = `trash-sync-${testInfo.project.name}@sender.test`;
  const subject = `Quarantine trash ${testInfo.project.name}`;
  await page.getByLabel('发件人邮箱地址').fill(sender);
  await page.getByRole('button', { name: '加入黑名单' }).click();
  await expect(page.getByRole('button', { name: `移除 ${sender}` })).toBeVisible();
  const raw = [`From: ${sender}`, 'To: e2e-admin@flaremail.test', `Message-ID: <trash-sync-${testInfo.project.name}@sender.test>`, `Subject: ${subject}`, 'Content-Type: text/plain; charset=utf-8', '', 'Local fake message.'].join('\r\n');
  const accepted = await page.request.post('/cdn-cgi/local/email?from=bounce%40sender.test&to=e2e-admin%40flaremail.test', {
    data: raw, headers: { 'content-type': 'message/rfc822' }
  });
  expect(accepted.status()).toBe(200);
  await page.getByRole('button', { name: '刷新隔离区' }).click();
  const link = page.getByRole('link', { name: subject });
  await expect(link).toBeVisible();
  const path = new URL((await link.getAttribute('href'))!, page.url()).pathname;
  const id = decodeURIComponent(path.slice('/messages/'.length));
  const reader = await context.newPage();
  await reader.goto(`/?folder=inbox&message=${encodeURIComponent(id)}`);
  const detail = reader.locator('.fm-detail-shell').filter({ hasText: subject });
  await detail.getByRole('button', { name: '移入垃圾箱', exact: true }).click();
  await reader.getByRole('dialog', { name: '移入垃圾箱？' }).getByRole('button', { name: '移入垃圾箱', exact: true }).click();
  await expect(page.getByRole('button', { name: `释放到收件箱 ${subject}` })).toHaveCount(0);
  await reader.close();
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
