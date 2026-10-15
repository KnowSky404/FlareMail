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
  await tabs.getByRole('tab', { name: '外观', exact: true }).click();
  await expect(page.getByRole('button', { name: '保存设置', exact: true })).toHaveCount(0);
  await page.getByLabel('颜色主题').selectOption('dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.goBack();
  await expect(tabs.getByRole('tab', { name: '通知', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.settings-header').getByRole('combobox')).toHaveCount(0);
  expect((await new AxeBuilder({ page }).include('main').analyze()).violations).toEqual([]);
  await assertNoHorizontalOverflow(page);
  await page.screenshot({ path: join(tmpdir(), `flaremail-tabs-${testInfo.project.name}.png`), fullPage: false });
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
  await tabs.getByRole('tab', { name: '外观', exact: true }).click();
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
