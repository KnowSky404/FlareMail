import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page, Route } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import {
  assertNoConsoleErrors,
  assertNoHorizontalOverflow,
  expect,
  login,
  test
} from './fixtures';

type IdentityPayload = {
  domains: Array<Record<string, unknown>>;
  addresses: Array<Record<string, unknown>>;
  providerConfiguration: { cloudflare: boolean; resend: boolean };
  domainOnboarding: { available: boolean; workerName: string | null; canManageRouting: boolean };
};

const identitiesUrl = /\/api\/workspace\/mail-identities(?:\?.*)?$/u;
const evidenceDirectory = '/tmp/flaremail-management-evidence';

async function prepareEvidenceDirectory() {
  await mkdir(evidenceDirectory, { recursive: true });
}

async function dismissNotifications(page: Page) {
  for (const button of await page.getByRole('button', { name: /^(?:关闭通知|Close notification)$/u }).all()) {
    if (await button.isVisible()) await button.click();
  }
}

function managementHeading(page: Page, view: 'domains' | 'addresses') {
  return page.getByRole('heading', {
    name: view === 'domains' ? /域名|Domains/u : /邮箱地址|Email addresses/u,
    exact: false
  });
}

function managementTable(page: Page, view?: 'domains' | 'addresses') {
  return page.getByRole('table', {
    name: view === 'domains' ? /域名|Domains/u : view === 'addresses' ? /邮箱地址|Email addresses/u : undefined
  }).first();
}

function addButton(page: Page, resource: 'domain' | 'address') {
  return page.locator(resource === 'domain' ? '#add-mail-domain' : '#add-mail-address');
}

function moreButton(scope: Page | Locator, identity?: string) {
  return scope.getByRole('button', { name: identity ? new RegExp(`^(?:更多操作|More actions): ${identity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'u') : /更多操作|More actions/u }).first();
}

async function gotoManagement(page: Page, url: string) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
}

async function readIdentities(page: Page) {
  const response = await page.request.get('/api/workspace/mail-identities');
  expect(response.ok()).toBe(true);
  return (await response.json() as { data: IdentityPayload }).data;
}

async function routeIdentities(page: Page, handler: (payload: IdentityPayload, route: Route) => Promise<void> | void) {
  await page.route(identitiesUrl, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const payload = (await response.json() as { data: IdentityPayload }).data;
    await handler(payload, route);
  });
}

test.describe('mail resource management', () => {
  test('restores ReaderDialog focus after its menu closes', async ({ page }) => {
    await login(page);
    await page.goto('/?folder=inbox', { waitUntil: 'domcontentloaded' });

    const item = page.getByRole('listitem').filter({ hasText: 'E2E Inbox Welcome' });
    await expect(item).toBeVisible();
    await item.getByRole('button', { name: /E2E Inbox Welcome/u }).first().click();

    const detail = page.getByRole('region', { name: '邮件详情' });
    await expect(detail).toBeVisible();
    const openReader = detail.getByRole('button', { name: '展开专注阅读' });
    await openReader.click();

    const reader = page.getByRole('dialog', { name: 'E2E Inbox Welcome' });
    await expect(reader).toBeVisible();
    const moreActions = reader.getByRole('button', { name: '更多邮件操作', exact: true });

    await moreActions.focus();
    await page.keyboard.press('Enter');
    const initialMenu = reader.getByRole('menu');
    await expect(initialMenu).toBeVisible();
    await expect(initialMenu.getByRole('menuitem').first()).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(reader).toBeVisible();
    await expect(reader.getByRole('menu')).toBeHidden();
    await expect(moreActions).toBeFocused();

    await moreActions.press('Enter');
    const menu = reader.getByRole('menu');
    await expect(menu).toBeVisible();
    const markRead = menu.getByRole('menuitem', { name: /标为(?:已读|未读)/u });
    await expect(markRead).toBeVisible();
    const updatedReadState = page.waitForResponse((response) =>
      response.request().method() === 'PATCH' && new URL(response.url()).pathname.endsWith('/flags')
    );
    await markRead.click();
    await updatedReadState;
    await expect(reader).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(1);
    await expect(menu).toBeHidden();
    await expect(moreActions).toBeFocused();
  });

  test('opens with configured tables and keeps refresh read-only', async ({ page, consoleErrors }) => {
    await login(page);
    let syncPosts = 0;
    let identityGets = 0;
    page.on('request', (request) => {
      if (request.url().endsWith('/api/workspace/mail-identities/sync') && request.method() === 'POST') syncPosts++;
      if (identitiesUrl.test(request.url()) && request.method() === 'GET') identityGets++;
    });

    await gotoManagement(page, '/?folder=settings&view=domains');
    await expect(managementHeading(page, 'domains')).toBeVisible();
    await expect(managementTable(page, 'domains')).toBeVisible();
    await expect(managementTable(page, 'domains')).toContainText('flaremail.test');
    await expect(page.locator('form').filter({ has: page.getByLabel(/域名|domain name/u) })).toHaveCount(0);
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(page.getByText(/同步完成|Sync complete/u)).toHaveCount(0);
    expect(syncPosts).toBe(0);

    const refresh = page.locator('#refresh-mail-resources');
    await refresh.click();
    await expect.poll(() => identityGets).toBeGreaterThan(1);
    expect(syncPosts).toBe(0);

    await gotoManagement(page, '/?folder=settings&view=addresses');
    await expect(managementHeading(page, 'addresses')).toBeVisible();
    await expect(managementTable(page, 'addresses')).toContainText('e2e-admin@flaremail.test');
    expect(syncPosts).toBe(0);
    await assertNoHorizontalOverflow(page);
    expect((await new AxeBuilder({ page }).include('main').analyze()).violations).toEqual([]);
    await assertNoConsoleErrors(consoleErrors);
  });

  test('keeps domain context as a real address filter and does not open a modal from the URL', async ({ page }) => {
    await login(page);
    await gotoManagement(page, '/?folder=settings&view=domains');
    const domainRow = page.locator('[data-domain-id="00000000-0000-4000-8000-000000000011"]');
    await expect(domainRow).toBeVisible();
    await domainRow.getByRole('button', { name: /更多操作|More actions/u }).click();
    await page.getByRole('menuitem', { name: /查看地址|View addresses/u }).click();
    await expect(page).toHaveURL(/folder=settings.*view=addresses.*domain=00000000-0000-4000-8000-000000000011/u);
    await expect(managementHeading(page, 'addresses')).toBeVisible();
    const rows = managementTable(page, 'addresses').getByRole('row');
    await expect(rows.filter({ hasText: 'e2e-admin@flaremail.test' })).toHaveCount(1);
    await expect(rows.filter({ hasText: 'support@flaremail.test' })).toHaveCount(1);
    await expect(rows.filter({ hasText: 'postmaster@example.test' })).toHaveCount(0);
    await expect(page.getByRole('dialog')).toBeHidden();

    await page.goBack();
    await expect(page).toHaveURL(/view=domains/u);
    await expect(managementTable(page)).toContainText('flaremail.test');

    await gotoManagement(page, '/?folder=settings&view=addresses&domain=missing-domain');
    await expect(page.getByRole('status').filter({ hasText: /此域名筛选已失效|This domain filter is no longer valid/u })).toBeVisible();
    await expect(managementTable(page, 'addresses').locator('tbody tr[data-address-id]')).toHaveCount(0);
    await page.getByRole('status').filter({ hasText: /此域名筛选已失效|This domain filter is no longer valid/u }).getByRole('button', { name: /清除筛选|Clear filters/u }).click();
    await expect(page).not.toHaveURL(/domain=/u);
    await expect(managementTable(page, 'addresses')).toContainText('postmaster@example.test');
    await gotoManagement(page, '/?folder=settings&view=addresses&domain=%2Finvalid');
    await expect(page).not.toHaveURL(/domain=/u);
    await expect(managementTable(page, 'addresses')).toContainText('postmaster@example.test');
    await expect(page.getByRole('dialog')).toBeHidden();
  });

  test('closes clean management dialogs across one Back or Forward traversal', async ({ page }) => {
    await login(page);
    await gotoManagement(page, '/?folder=settings&view=domains');
    const domainRow = page.locator('[data-domain-id="00000000-0000-4000-8000-000000000011"]');
    await moreButton(domainRow).click();
    await page.getByRole('menuitem', { name: /查看地址|View addresses/u }).click();
    await expect(page).toHaveURL(/view=addresses.*domain=00000000-0000-4000-8000-000000000011/u);

    await addButton(page, 'address').click();
    const addAddress = page.locator('#add-mail-address-dialog');
    await expect(addAddress).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(/view=domains/u);
    await expect(addAddress).toBeHidden();
    await page.goForward();
    await expect(page).toHaveURL(/view=addresses.*domain=00000000-0000-4000-8000-000000000011/u);
    await expect(addAddress).toBeHidden();

    const addressRow = page.locator('[data-address-id="00000000-0000-4000-8000-000000000022"]');
    await addressRow.getByRole('button', { name: /编辑名称与签名|Edit name and signature/u }).click();
    const editAddress = page.locator('#edit-mail-address');
    await expect(editAddress).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(/view=domains/u);
    await expect(editAddress).toBeHidden();
    await page.goForward();
    await expect(page).toHaveURL(/view=addresses.*domain=00000000-0000-4000-8000-000000000011/u);
    await expect(editAddress).toBeHidden();

    await page.goBack();
    await expect(page).toHaveURL(/view=domains/u);
    await domainRow.getByRole('button', { name: 'flaremail.test', exact: true }).click();
    const diagnostics = page.locator('#mail-diagnostics');
    await expect(diagnostics).toBeVisible();
    await page.goForward();
    await expect(page).toHaveURL(/view=addresses.*domain=00000000-0000-4000-8000-000000000011/u);
    await expect(diagnostics).toBeHidden();
  });

  test('opens add and edit dialogs, preserves invalid input, and ignores duplicate submit', async ({ page }) => {
    await login(page);
    await gotoManagement(page, '/?folder=settings&view=addresses');
    const posts: string[] = [];
    await page.route(identitiesUrl, async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      posts.push(route.request().postData() ?? '');
      await new Promise((resolve) => setTimeout(resolve, 100));
      await route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { message: '此地址已存在或待恢复' } }) });
    });

    const trigger = addButton(page, 'address');
    await trigger.click();
    const dialog = page.locator('#add-mail-address-dialog');
    await expect(dialog).toBeVisible();
    const addressInput = dialog.getByLabel(/地址前缀|Address prefix|邮件地址或本地部分|Mail address or local part/u);
    await addressInput.fill('duplicate-e2e');
    await dialog.locator('summary').click();
    const nameInput = dialog.getByLabel(/显示名称|Display name/u).first();
    await nameInput.fill('Preserved draft');
    const submit = dialog.getByRole('button', { name: /创建并配置收信规则|Create and configure|保存/u }).last();
    await Promise.all([submit.dispatchEvent('click'), submit.dispatchEvent('click')]);
    await expect(dialog.getByRole('alert')).toContainText(/已存在|exists|失败|failed/u);
    await expect(addressInput).toHaveValue('duplicate-e2e');
    await expect(nameInput).toHaveValue('Preserved draft');
    expect(posts).toHaveLength(1);

    await dialog.getByRole('button', { name: /取消|Cancel/u }).click();
    const discardAfterFailure = page.locator('#discard-mail-resource-changes');
    await expect(discardAfterFailure).toBeVisible();
    await discardAfterFailure.getByRole('button', { name: /放弃更改|Discard changes/u }).click();
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();

    const row = page.locator('[data-address-id="00000000-0000-4000-8000-000000000022"]');
    await row.getByRole('button', { name: /编辑名称与签名|Edit name and signature/u }).click();
    const editDialog = page.locator('#edit-mail-address');
    await expect(editDialog).toBeVisible();
    await expect(editDialog.locator('.readonly-mapping')).toContainText('support@flaremail.test');
    await expect(editDialog.locator('.readonly-mapping')).toContainText('flaremail.test');
  });

  test('protects dirty close and reports a saved address when the follow-up read fails', async ({ page }) => {
    await login(page);
    const original = await readIdentities(page);
    await gotoManagement(page, '/?folder=settings&view=domains');
    const domainRow = page.locator('[data-domain-id="00000000-0000-4000-8000-000000000011"]');
    await moreButton(domainRow).click();
    await page.getByRole('menuitem', { name: /查看地址|View addresses/u }).click();
    await expect(page).toHaveURL(/view=addresses.*domain=00000000-0000-4000-8000-000000000011/u);
    const trigger = page.locator('#add-mail-address');
    await trigger.click();
    const dialog = page.locator('#add-mail-address-dialog');
    const addressInput = dialog.getByLabel(/地址前缀|Address prefix|邮件地址或本地部分|Mail address or local part/u);
    await addressInput.fill('dirty-e2e');
    await page.goBack();
    await expect(page.locator('#discard-mail-resource-changes')).toBeVisible();
    await page.locator('#discard-mail-resource-changes').getByRole('button', { name: /继续编辑|Keep editing/u }).click();
    await expect(dialog).toBeVisible();
    const discard = page.locator('#discard-mail-resource-changes');
    await expect(page).toHaveURL(/view=addresses.*domain=00000000-0000-4000-8000-000000000011/u);
    await page.goBack();
    await expect(discard).toBeVisible();
    await discard.getByRole('button', { name: /放弃更改|Discard changes/u }).click();
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(/view=domains/u);
    await page.goForward();
    await expect(page).toHaveURL(/view=addresses.*domain=00000000-0000-4000-8000-000000000011/u);
    await expect(dialog).toBeHidden();

    let createPost = false;
    let failReadAfterCreate = false;
    await page.route(identitiesUrl, async (route) => {
      if (route.request().method() === 'POST') {
        createPost = true;
        const body = route.request().postDataJSON() as { domainId: string; address: string; displayName: string; signature: string };
        const domain = original.domains.find((item) => item.id === body.domainId);
        const created = {
          ...original.addresses[0], id: '00000000-0000-4000-8000-000000000097', domain_id: body.domainId,
          email: `${body.address.toLowerCase()}@${domain?.domain_name ?? 'flaremail.test'}`, display_name: body.displayName,
          local_part: body.address.toLowerCase(), signature: body.signature, receive_enabled: 1, send_enabled: 0,
          is_default_sender: 0, routing_state: 'active', routing_owner: 'flaremail', last_error_code: null
        };
        await route.fulfill({ status: 201, json: { ok: true, data: { address: created } } });
        return;
      }
      if (failReadAfterCreate && createPost) {
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { message: 'readback failed' } }) });
        return;
      }
      await route.continue();
    });
    await trigger.click();
    const createDialog = page.locator('#add-mail-address-dialog');
    await createDialog.getByLabel(/地址前缀|Address prefix|邮件地址或本地部分|Mail address or local part/u).fill('readback-known-e2e');
    failReadAfterCreate = true;
    await createDialog.getByRole('button', { name: /创建并配置收信规则|Create and configure|保存/u }).last().click();
    await expect.poll(() => createPost).toBe(true);
    await expect(page.locator('[role="status"]').filter({ hasText: /保存|readback|刷新/u }).first()).toBeVisible();
    await expect(page.getByRole('table', { name: /邮箱地址|Email addresses/u })).toContainText('readback-known-e2e@');
    await expect(createDialog).toBeHidden();
  });

  test('guards a dirty edit after a full Kit navigation history round trip', async ({ page }) => {
    await login(page);
    await gotoManagement(page, '/?folder=settings&view=addresses');
    await page.evaluate(() => {
      const link = document.createElement('a');
      link.id = 'e2e-full-navigation';
      link.href = '/?folder=inbox';
      link.textContent = 'Inbox navigation';
      document.body.appendChild(link);
    });
    await page.locator('#e2e-full-navigation').click();
    await expect(page).toHaveURL(/folder=inbox/u);
    await page.goBack();
    await expect(page).toHaveURL(/folder=settings.*view=addresses/u);
    await expect(managementTable(page, 'addresses')).toBeVisible();

    const row = page.locator('[data-address-id="00000000-0000-4000-8000-000000000022"]');
    await row.getByRole('button', { name: /编辑名称与签名|Edit name and signature/u }).click();
    const editDialog = page.locator('#edit-mail-address');
    const name = editDialog.getByLabel(/显示名称|Display name/u);
    await name.fill('Full navigation draft');
    await page.goForward();
    const discard = page.locator('#discard-mail-resource-changes');
    await expect(discard).toBeVisible();
    await discard.getByRole('button', { name: /继续编辑|Keep editing/u }).click();
    await expect(page).toHaveURL(/folder=settings.*view=addresses/u);
    await expect(editDialog).toBeVisible();
    await expect(name).toHaveValue('Full navigation draft');

    await page.goForward();
    await expect(discard).toBeVisible();
    await discard.getByRole('button', { name: /放弃更改|Discard changes/u }).click();
    await expect(page).toHaveURL(/folder=inbox/u);
    await expect(editDialog).toBeHidden();
    await expect(page.locator('#discard-mail-resource-changes')).toBeHidden();
  });

  test('keeps diagnostics and delete preview behind explicit menu gates', async ({ page }) => {
    await login(page);
    const original = await readIdentities(page);
    const addresses = original.addresses
      .filter((address) => ['00000000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-000000000022', '00000000-0000-4000-8000-000000000023'].includes(String(address.id)))
      .map((address) => ({ ...address }));
    const domains = original.domains.map((domain) => ({ ...domain }));
    const disabledDomain = domains.find((domain) => domain.id === '00000000-0000-4000-8000-000000000011');
    if (disabledDomain) Object.assign(disabledDomain, {
      enabled: 0, cloudflare_checked_at: '2020-01-01T00:00:00.000Z',
      cloudflare_check_expires_at: '2020-01-02T00:00:00.000Z', cloudflare_error_code: 'stale_check'
    });
    const disabled = addresses.find((address) => address.email === 'support@flaremail.test');
    const sendNotReady = addresses.find((address) => address.email === 'e2e-admin@flaremail.test');
    const deleted = addresses.find((address) => address.email === 'postmaster@example.test');
    if (disabledDomain) for (const address of addresses) address.domain_id = disabledDomain.id;
    if (disabled) Object.assign(disabled, { lifecycle_status: 'disabled', receive_enabled: 0, send_enabled: 0, routing_state: 'error', last_error_code: 'cloudflare_route_missing' });
    if (sendNotReady) Object.assign(sendNotReady, { lifecycle_status: 'active', receive_enabled: 1, send_enabled: 0, is_default_sender: 0, routing_state: 'active', last_error_code: null });
    if (deleted) Object.assign(deleted, { lifecycle_status: 'deleted', receive_enabled: 0, send_enabled: 0, routing_state: 'deleted' });
    await routeIdentities(page, (_payload, route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: { ...original, domains, addresses } }) }));
    await gotoManagement(page, '/?folder=settings&view=domains');
    const disabledDomainRow = page.locator('[data-domain-id="00000000-0000-4000-8000-000000000011"]');
    await expect(disabledDomainRow).toContainText(/停用|未启用|Disabled/u);
    await expect(disabledDomainRow).toContainText(/需重新检查|需检查|Needs attention|check/u);
    await expect(disabledDomainRow.getByRole('button', { name: /查看地址.*2|View addresses.*2/u }).first()).toBeVisible();
    await moreButton(disabledDomainRow).click();
    await expect(page.getByRole('menuitem', { name: /为此域名创建地址|Create address for this domain/u })).toBeDisabled();
    await expect(page.getByRole('menuitem', { name: /诊断|Diagnostics/u })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: /检查状态|Check status/u })).toBeVisible();
    await page.keyboard.press('Escape');
    await gotoManagement(page, '/?folder=settings&view=addresses');
    const table = managementTable(page, 'addresses');
    const disabledRow = page.locator('[data-address-id="00000000-0000-4000-8000-000000000022"]');
    await expect(disabledRow).toContainText(/停用|未启用|Disabled/u);
    await expect(disabledRow).toContainText(/需处理|需检查|Needs attention|check|错误|error/u);
    await moreButton(disabledRow).click();
    await expect(page.getByRole('menuitem', { name: /诊断|Diagnostics/u })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: /重试|Retry/u })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: /启用发信|Enable sending/u })).toBeHidden();
    await page.keyboard.press('Escape');

    const sendNotReadyRow = page.locator('[data-address-id="00000000-0000-4000-8000-000000000021"]');
    await expect(sendNotReadyRow).toContainText(/不可用|Not ready|未就绪/u);
    await moreButton(sendNotReadyRow).click();
    await expect(page.getByRole('menuitem', { name: /启用发信|Enable sending/u })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: /启用发信|Enable sending/u })).toBeDisabled();
    await page.keyboard.press('Escape');

    const deletedFilter = page.getByLabel(/状态筛选|State filter/u);
    await deletedFilter.selectOption('deleted');
    const deletedRow = page.locator('[data-address-id="00000000-0000-4000-8000-000000000023"]');
    await expect(deletedRow).toBeVisible();
    await moreButton(deletedRow).click();
    await expect(page.getByRole('menuitem', { name: /诊断|Diagnostics/u })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: /恢复|Restore/u })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: /设为默认|Make default/u })).toBeHidden();
    await page.getByRole('menuitem', { name: /诊断|Diagnostics/u }).click();
    await expect(page.getByRole('dialog', { name: /诊断|Diagnostics/u })).toBeVisible();
    await page.getByRole('dialog', { name: /诊断|Diagnostics/u }).getByRole('button', { name: /关闭|Close/u }).last().click();

    let previewCalls = 0;
    await page.route(/\/api\/workspace\/mail-identities\/[^/]+\/delete-preview$/u, async (route) => {
      previewCalls++;
      if (previewCalls === 1) {
        await route.fulfill({ json: { ok: true, data: { preview: {
          previewedAt: new Date(Date.now() - 120_000).toISOString(), expiresAt: new Date(Date.now() - 60_000).toISOString(), historyRetained: true,
          cloudflare: { state: 'unavailable', errorCode: 'provider_timeout', route: { observation: 'unknown', source: 'api', ruleId: null }, catchAll: { target: 'external', checkedAt: null, fresh: false, live: false } },
          policies: { remove_owned_route: { available: true, action: 'remove' }, retain_reject_route: { available: false, action: null }, preserve_imported_route: { available: false, action: null } },
          recommendedPolicy: 'remove_owned_route', canConfirm: true
      } } } });
        return;
      }
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { message: 'preview unavailable' } }) });
    });
    await deletedFilter.selectOption('current');
    await moreButton(disabledRow).click();
    await page.getByRole('menuitem', { name: /删除|Delete/u }).click();
    const deleteDialog = page.locator('#delete-mail-address');
    await expect(deleteDialog).toBeVisible();
    await expect(deleteDialog.getByText(/外部 catch-all|external catch-all|无法确认|cannot confirm|provider_timeout/iu).first()).toBeVisible();
    await expect(deleteDialog.getByRole('button', { name: /删除地址|Delete address/u })).toBeDisabled();
    await deleteDialog.getByRole('button', { name: /取消|Cancel/u }).click();
    await moreButton(disabledRow).click();
    await page.getByRole('menuitem', { name: /删除|Delete/u }).click();
    await expect(page.locator('#delete-mail-address').getByRole('alert')).toContainText(/预检|preview|unavailable|失败|failed/iu);
  });

  test('locks a failed domain check until an explicit successful refresh reconciles it', async ({ page }) => {
    await login(page);
    const original = await readIdentities(page);
    const domainId = String(original.domains[0].id);
    const refreshedDomain = {
      ...original.domains[0], cloudflare_checked_at: new Date().toISOString(),
      cloudflare_check_expires_at: new Date(Date.now() + 86_400_000).toISOString(), cloudflare_error_code: null
    };
    let identityGets = 0;
    let checkPosts = 0;
    await page.route(identitiesUrl, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      identityGets++;
      if (checkPosts === 1 && identityGets === 2) {
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { message: 'synthetic readback failure' } }) });
        return;
      }
      await route.fulfill({ json: { ok: true, data: { ...original, domains: original.domains.map((domain) => domain.id === domainId ? refreshedDomain : domain) } } });
    });
    await page.route(/\/api\/workspace\/mail-identities\/domains\/[^/]+\/check$/u, async (route) => {
      checkPosts++;
      if (checkPosts === 1) {
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { message: 'synthetic check timeout' } }) });
        return;
      }
      await route.fulfill({ json: { ok: true, data: { check: {
        cloudflare: { state: 'ready', errorCode: null, catchAllEnabled: true, catchAllTarget: 'this_worker', checkedAt: refreshedDomain.cloudflare_checked_at, addresses: [] },
        resend: { state: 'verified' }
      } } } });
    });
    await gotoManagement(page, '/?folder=settings&view=domains');
    const domainRow = page.locator(`[data-domain-id="${domainId}"]`);
    await moreButton(domainRow).click();
    await page.getByRole('menuitem', { name: /检查状态|Check status/u }).click();
    await expect(page.getByRole('alert')).toContainText(/结果未知|Write outcome unknown|读取失败|refresh failed|synthetic check timeout/u);
    await expect.poll(() => identityGets).toBe(2);
    await moreButton(domainRow).click();
    await expect(page.getByRole('menuitem', { name: /检查状态|Check status/u })).toBeDisabled();
    await page.keyboard.press('Escape');
    await page.locator('#refresh-mail-resources').click();
    await expect.poll(() => identityGets).toBe(3);
    await expect(page.locator('#refresh-mail-resources')).toBeEnabled();
    await moreButton(domainRow).click();
    await expect(page.getByRole('menuitem', { name: /检查状态|Check status/u })).toBeEnabled();
    expect(checkPosts).toBe(1);
  });

  test('uses newer recovered domain health after a failed check readback', async ({ page }) => {
    await login(page);
    const original = await readIdentities(page);
    const domainId = String(original.domains[0].id);
    const staleDomain = {
      ...original.domains[0], cloudflare_error_code: 'old_cloudflare_error',
      cloudflare_checked_at: new Date(Date.now() - 86_400_000).toISOString(),
      cloudflare_check_expires_at: new Date(Date.now() - 60_000).toISOString(),
      resend_error_code: 'old_resend_error', resend_checked_at: new Date(Date.now() - 86_400_000).toISOString()
    };
    const recoveredDomain = {
      ...staleDomain, cloudflare_error_code: null,
      cloudflare_checked_at: new Date().toISOString(),
      cloudflare_check_expires_at: null, resend_error_code: null, resend_checked_at: new Date().toISOString()
    };
    let identityGets = 0;
    let failReadback = false;
    let useStaleReadback = false;
    let checkError: string | null = 'old_cloudflare_error';
    await page.route(identitiesUrl, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      identityGets++;
      if (failReadback) {
        await route.fulfill({ status: 503, json: { ok: false, error: { message: 'synthetic check readback failed' } } });
        return;
      }
      const domain = useStaleReadback
        ? { ...staleDomain, cloudflare_check_expires_at: new Date(Date.now() + 60_000).toISOString(), resend_check_expires_at: new Date(Date.now() + 60_000).toISOString() }
        : identityGets === 1 ? staleDomain : recoveredDomain;
      await route.fulfill({ json: { ok: true, data: {
        ...original,
        providerConfiguration: { cloudflare: true, resend: true },
        domains: original.domains.map((item) => item.id === domainId ? domain : item)
      } } });
    });
    await page.route(/\/api\/workspace\/mail-identities\/domains\/[^/]+\/check$/u, async (route) => {
      await route.fulfill({ json: { ok: true, data: { check: {
        cloudflare: { state: checkError ? 'error' : 'ready', errorCode: checkError, catchAllEnabled: false, catchAllTarget: 'unknown', checkedAt: checkError ? staleDomain.cloudflare_checked_at : recoveredDomain.cloudflare_checked_at, addresses: [] },
        resend: { state: checkError ? 'error' : 'verified', errorCode: checkError ? 'resend_permission_denied' : null,
          checkedAt: checkError ? staleDomain.resend_checked_at : recoveredDomain.resend_checked_at }
      } } } });
    });

    await gotoManagement(page, '/?folder=settings&view=domains');
    const domainRow = page.locator(`[data-domain-id="${domainId}"]`);
    await moreButton(domainRow).click();
    await page.getByRole('menuitem', { name: /检查状态|Check status/u }).click();
    await expect.poll(() => identityGets).toBe(2);
    await expect(page.getByRole('status').filter({ hasText: /检查未完成|did not complete/u }).first()).toBeVisible();
    await expect(page.locator('#refresh-mail-resources')).toBeEnabled();

    await expect(domainRow).toContainText(/可用|Ready/u);
    await domainRow.getByRole('button', { name: original.domains[0].domain_name as string, exact: true }).click();
    const diagnostics = page.locator('#mail-diagnostics');
    await expect(diagnostics).toBeVisible();
    const cloudflareCard = diagnostics.locator('h4').filter({ hasText: 'Cloudflare' }).locator('..');
    await expect(cloudflareCard).toContainText(/自动检查有效|Fresh/u);
    await expect(cloudflareCard).not.toContainText(/检查需要处理|needs attention|old_cloudflare_error/u);

    await diagnostics.getByRole('button', { name: /关闭|Close/u, exact: true }).last().click();
    failReadback = true;
    checkError = 'cloudflare_permission_denied';
    await moreButton(domainRow).click();
    await page.getByRole('menuitem', { name: /检查状态|Check status/u }).click();
    await expect.poll(() => identityGets).toBe(3);
    await expect(page.locator('#refresh-mail-resources')).toBeEnabled();
    await domainRow.getByRole('button', { name: original.domains[0].domain_name as string, exact: true }).click();
    await expect(diagnostics).toBeVisible();
    await expect(cloudflareCard.locator('..')).toContainText(/检查无权访问|check access was denied/u);
    const resendCard = diagnostics.locator('h4').filter({ hasText: 'Resend' }).locator('../..');
    await expect(resendCard).toContainText(/检查无权访问|check access was denied/u);

    await diagnostics.getByRole('button', { name: /关闭|Close/u, exact: true }).last().click();
    failReadback = false;
    useStaleReadback = true;
    await page.locator('#refresh-mail-resources').click();
    await expect.poll(() => identityGets).toBe(4);
    await expect(page.locator('#refresh-mail-resources')).toBeEnabled();
    failReadback = true;
    checkError = null;
    await moreButton(domainRow).click();
    await page.getByRole('menuitem', { name: /检查状态|Check status/u }).click();
    await expect.poll(() => identityGets).toBe(5);
    await expect(page.locator('#refresh-mail-resources')).toBeEnabled();
    await domainRow.getByRole('button', { name: original.domains[0].domain_name as string, exact: true }).click();
    await expect(diagnostics).toBeVisible();
    await expect(cloudflareCard.locator('..')).not.toContainText(/检查需要处理|needs attention|检查无权访问|check access was denied/u);
    await expect(resendCard).not.toContainText(/Resend 检查需要处理|Resend check needs attention|检查无权访问|check access was denied/u);
    await expect(cloudflareCard).toContainText(/自动检查有效|Fresh/u);
    await expect(resendCard).toContainText(/自动检查有效|Fresh/u);
    await expect(cloudflareCard.locator('..')).not.toContainText(/检查失败或配置需要处理|Check failed or configuration needs attention|正在刷新|Refreshing/u);
    await expect(resendCard).not.toContainText(/检查失败或配置需要处理|Check failed or configuration needs attention|正在刷新|Refreshing/u);
  });

  test('keeps discovered Cloudflare rules when Resend is unconfigured', async ({ page }) => {
    await login(page);
    const original = await readIdentities(page);
    const now = new Date().toISOString();
    const domain: Record<string, unknown> = {
      ...original.domains[0], cloudflare_checked_at: now, cloudflare_check_expires_at: null,
      cloudflare_error_code: null, catch_all_target: 'this_worker',
      resend_checked_at: new Date(Date.now() - 60_000).toISOString(), resend_status: 'verified', resend_sending_status: 'enabled',
      resend_error_code: null, resend_check_expires_at: null
    };
    const address = original.addresses[1];
    if (!address) throw new Error('The management fixture needs an importable address.');
    Object.assign(address, { domain_id: domain.id, lifecycle_status: 'active', routing_state: 'error', routing_owner: 'flaremail', last_error_code: 'synthetic_route_error', send_enabled: 1, is_default_sender: 0 });
    const addressId = String(address.id);
    const actions: string[] = [];
    await page.route(identitiesUrl, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      await route.fulfill({ json: { ok: true, data: {
        ...original, providerConfiguration: { cloudflare: true, resend: false },
        domains: original.domains.map((item) => item.id === domain.id ? domain : item)
      } } });
    });
    await page.route(/\/api\/workspace\/mail-identities\/domains\/[^/]+\/check$/u, async (route) => {
      await route.fulfill({ json: { ok: true, data: { check: {
        cloudflare: { state: 'ready', errorCode: null, catchAllEnabled: true, catchAllTarget: 'this_worker', checkedAt: now,
          addresses: [{ addressId, status: 'importable' }] },
        resend: { state: 'not_configured', checkedAt: null }
      } } } });
    });
    await page.route(new RegExp(`/api/workspace/mail-identities/${addressId}$`), async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      actions.push((route.request().postDataJSON() as { action: string }).action);
      Object.assign(address, { routing_state: 'imported', routing_owner: 'imported', last_error_code: null });
      await route.fulfill({ json: { ok: true, data: { address } } });
    });

    await gotoManagement(page, '/?folder=settings&view=domains');
    const domainRow = page.locator(`[data-domain-id="${domain.id}"]`);
    await moreButton(domainRow).click();
    await page.getByRole('menuitem', { name: /检查状态|Check status/u }).click();
    await expect(page.getByRole('status').filter({ hasText: /状态检查已完成|status checks completed/u }).first()).toBeVisible();
    await expect(page.locator('#refresh-mail-resources')).toBeEnabled();
    await moreButton(domainRow).click();
    await page.getByRole('menuitem', { name: /查看地址|View addresses/u }).click();
    const addressRow = page.locator(`[data-address-id="${addressId}"]`);
    await expect(addressRow.getByRole('cell').nth(4)).toContainText(/需重新检查|Check again/u);
    await addressRow.getByRole('button', { name: String(address.email), exact: true }).click();
    const diagnostics = page.locator('#mail-diagnostics');
    await expect(diagnostics).toContainText(/可导入|Importable/u);
    await expect(diagnostics.locator('h4').filter({ hasText: 'Resend' }).locator('../..')).toContainText(/未配置|Not configured/u);
    await diagnostics.getByRole('button', { name: /关闭|Close/u, exact: true }).last().click();
    await moreButton(addressRow).click();
    await expect(page.getByRole('menuitem', { name: /设为默认|Make default/u })).toBeDisabled();
    await page.getByRole('menuitem', { name: /导入规则|Import rule/u }).click();
    await expect.poll(() => actions).toEqual(['import']);
  });

  test('retries deleted route reconciliation before exposing restore', async ({ page }) => {
    await login(page);
    const fixture = await readIdentities(page);
    const address = fixture.addresses[2];
    if (!address) throw new Error('The management fixture needs a tombstone address.');
    const addressId = String(address.id);
    const actions: string[] = [];
    await page.route(identitiesUrl, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      await route.fulfill({ json: { ok: true, data: fixture } });
    });
    await page.route(new RegExp(`/api/workspace/mail-identities/${addressId}$`), async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      const action = (route.request().postDataJSON() as { action: string }).action;
      actions.push(action);
      Object.assign(address, action === 'retry'
        ? { routing_state: 'deleted', last_error_code: null }
        : { lifecycle_status: 'active', routing_state: 'active', receive_enabled: 1 });
      await route.fulfill({ json: { ok: true, data: { address } } });
    });
    await gotoManagement(page, '/?folder=settings&view=addresses');
    await page.getByLabel(/状态筛选|State filter/u).selectOption('deleted');
    const row = page.locator(`[data-address-id="${addressId}"]`);
    for (const state of ['deleting', 'error', 'unknown', 'pending', 'provisioning', 'deleted', 'imported', 'active']) {
      Object.assign(address, { lifecycle_status: 'deleted', routing_state: state, last_error_code: null, receive_enabled: 0, send_enabled: 0,
        routing_owner: state === 'imported' ? 'imported' : 'flaremail',
        delete_route_policy: state === 'active' ? 'retain_reject_route' : state === 'imported' ? 'preserve_imported_route' : 'remove_owned_route' });
      await page.locator('#refresh-mail-resources').click();
      await expect(row).toBeVisible();
      await expect(page.locator('#refresh-mail-resources')).toBeEnabled();
      if (!['deleted', 'imported', 'active'].includes(state)) {
        await moreButton(row).click();
        await expect(page.getByRole('menuitem', { name: /恢复|Restore/u })).toHaveCount(0);
        const beforeRetry = actions.length;
        if (state === 'deleting') {
          await page.getByRole('menuitem', { name: /诊断|Diagnostics/u }).click();
          const diagnostics = page.locator('#mail-diagnostics');
          await diagnostics.getByRole('button', { name: /重试|Retry/u, exact: true }).click();
          await expect.poll(() => actions.length).toBe(beforeRetry + 1);
          await expect(diagnostics.getByRole('button', { name: /重试|Retry/u, exact: true })).toHaveCount(0);
          await diagnostics.getByRole('button', { name: /关闭|Close/u, exact: true }).last().click();
        } else {
          await page.getByRole('menuitem', { name: /重试|Retry/u, exact: true }).click();
          await expect.poll(() => actions.length).toBe(beforeRetry + 1);
        }
        expect(actions.at(-1)).toBe('retry');
        await expect(page.locator('#refresh-mail-resources')).toBeEnabled();
      }
      await moreButton(row).click();
      await expect(page.getByRole('menuitem', { name: /重试|Retry/u, exact: true })).toHaveCount(0);
      const beforeRestore = actions.length;
      await page.getByRole('menuitem', { name: /恢复|Restore/u }).click();
      await expect.poll(() => actions.length).toBe(beforeRestore + 1);
      expect(actions.at(-1)).toBe('restore');
      await expect(row).toBeHidden();
      await expect(page.locator('#refresh-mail-resources')).toBeEnabled();
    }
  });

  test('round trips every address management action through its guarded endpoint', async ({ page }) => {
    await login(page);
    const original = await readIdentities(page);
    const fixture = JSON.parse(JSON.stringify(original)) as IdentityPayload;
    const now = new Date().toISOString();
    const domain = fixture.domains[0];
    Object.assign(domain, {
      enabled: 1, cloudflare_checked_at: now, cloudflare_check_expires_at: null,
      cloudflare_error_code: null, resend_status: 'verified', resend_sending_status: 'enabled', resend_checked_at: now,
      resend_check_expires_at: null, resend_error_code: null
    });
    const [primary, actionAddress, deletedAddress] = fixture.addresses;
    if (!primary || !actionAddress || !deletedAddress) throw new Error('The management fixture needs three addresses.');
    const actionId = String(actionAddress.id);
    const deletedId = String(deletedAddress.id);
    Object.assign(primary, { domain_id: domain.id, lifecycle_status: 'active', routing_state: 'active', routing_owner: 'flaremail', receive_enabled: 1, send_enabled: 1, is_default_sender: 1 });
    Object.assign(actionAddress, { domain_id: domain.id, lifecycle_status: 'active', routing_state: 'error', routing_owner: 'flaremail', receive_enabled: 1, send_enabled: 1, is_default_sender: 0, last_error_code: 'synthetic_route_error' });
    Object.assign(deletedAddress, { domain_id: domain.id, lifecycle_status: 'deleted', routing_state: 'deleted', routing_owner: 'flaremail', receive_enabled: 0, send_enabled: 0, is_default_sender: 0 });
    const requests: string[] = [];

    await page.route(identitiesUrl, async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({ json: { ok: true, data: { ...fixture, providerConfiguration: { cloudflare: true, resend: true } } } });
        return;
      }
      await route.continue();
    });
    await page.route(new RegExp(`/api/workspace/mail-identities/${actionId}|/api/workspace/mail-identities/${deletedId}`), async (route) => {
      const request = route.request();
      const id = request.url().split('/').pop() ?? '';
      if (request.method() === 'POST') {
        const action = (request.postDataJSON() as { action: string }).action;
        requests.push(`${id}:${action}`);
        const target = fixture.addresses.find((address) => String(address.id) === id);
        if (!target) throw new Error(`Unknown action target ${id}`);
        if (action === 'retry') Object.assign(target, { routing_state: 'error', last_error_code: null });
        if (action === 'import') Object.assign(target, { routing_state: 'imported', routing_owner: 'imported', receive_enabled: 1, last_error_code: null });
        if (action === 'disable') Object.assign(target, { lifecycle_status: 'disabled', receive_enabled: 0, send_enabled: 0 });
        if (action === 'enable') Object.assign(target, { lifecycle_status: 'active', receive_enabled: 1 });
        if (action === 'disable_send') target.send_enabled = 0;
        if (action === 'enable_send') target.send_enabled = 1;
        if (action === 'make_default') {
          for (const address of fixture.addresses) address.is_default_sender = 0;
          target.is_default_sender = 1;
        }
        if (action === 'restore') Object.assign(target, { lifecycle_status: 'active', routing_state: 'active', receive_enabled: 1 });
        await route.fulfill({ json: { ok: true, data: { address: target } } });
        return;
      }
      if (request.method() === 'DELETE') {
        requests.push(`${id}:delete`);
        const target = fixture.addresses.find((address) => String(address.id) === id);
        if (target) Object.assign(target, { lifecycle_status: 'deleted', routing_state: 'deleted', receive_enabled: 0, send_enabled: 0, is_default_sender: 0 });
        await route.fulfill({ json: { ok: true, data: { address: target } } });
        return;
      }
      await route.continue();
    });
    await page.route(/\/api\/workspace\/mail-identities\/[^/]+\/delete-preview$/u, async (route) => {
      await route.fulfill({ json: { ok: true, data: { preview: {
        previewedAt: now, expiresAt: new Date(Date.now() + 60_000).toISOString(), historyRetained: true,
        cloudflare: { state: 'verified', errorCode: null, route: { observation: 'managed_worker', source: 'api', ruleId: 'synthetic-rule' }, catchAll: { target: 'this_worker', checkedAt: now, fresh: true, live: true } },
        policies: { remove_owned_route: { available: true, action: 'remove' }, retain_reject_route: { available: false, action: null }, preserve_imported_route: { available: false, action: null } },
        recommendedPolicy: 'remove_owned_route', canConfirm: true
      } } } });
    });
    await page.route(/\/api\/workspace\/mail-identities\/domains\/[^/]+\/check$/u, async (route) => {
      await route.fulfill({ json: { ok: true, data: { check: {
        cloudflare: { state: 'ready', errorCode: null, catchAllEnabled: true, catchAllTarget: 'this_worker', checkedAt: domain.cloudflare_checked_at as string,
          addresses: [{ addressId: actionId, status: 'importable' }] }, resend: { state: 'verified', checkedAt: domain.resend_checked_at as string }
      } } } });
    });

    await gotoManagement(page, '/?folder=settings&view=domains');
    const domainRow = page.locator(`[data-domain-id="${domain.id}"]`);
    await moreButton(domainRow).click();
    await page.getByRole('menuitem', { name: /检查状态|Check status/u }).click();
    await expect(page.getByRole('status').filter({ hasText: /状态检查已完成|检查未完成|status checks completed|did not complete/u }).first()).toBeVisible();
    await expect(page.locator('#refresh-mail-resources')).toBeEnabled();
    await moreButton(domainRow).click();
    await page.getByRole('menuitem', { name: /查看地址|View addresses/u }).click();
    await expect(page).toHaveURL(/view=addresses.*domain=/u);
    const actionRow = page.locator(`[data-address-id="${actionId}"]`);
    const deletedRow = page.locator(`[data-address-id="${deletedId}"]`);
    const clickAction = async (name: RegExp, action: string) => {
      await moreButton(actionRow).click();
      await page.getByRole('menuitem', { name }).click();
      await expect.poll(() => requests.at(-1)).toBe(`${actionId}:${action}`);
    };
    await clickAction(/重试|Retry/u, 'retry');

    await page.goBack();
    await expect(page).toHaveURL(/view=domains/u);
    await moreButton(domainRow).click();
    await page.getByRole('menuitem', { name: /检查状态|Check status/u }).click();
    await expect(page.getByRole('status').filter({ hasText: /状态检查已完成|检查未完成|status checks completed|did not complete/u }).first()).toBeVisible();
    await expect(page.locator('#refresh-mail-resources')).toBeEnabled();
    await moreButton(domainRow).click();
    await page.getByRole('menuitem', { name: /查看地址|View addresses/u }).click();
    await expect(page).toHaveURL(/view=addresses.*domain=/u);

    await clickAction(/导入规则|Import rule/u, 'import');
    await clickAction(/^(?:停用|Disable)$/u, 'disable');
    await clickAction(/^(?:启用|Enable)$/u, 'enable');
    await clickAction(/启用发信|Enable sending/u, 'enable_send');
    await clickAction(/停用发信|Disable sending/u, 'disable_send');
    await clickAction(/启用发信|Enable sending/u, 'enable_send');
    await clickAction(/设为默认|Make default/u, 'make_default');

    const stateFilter = page.getByLabel(/状态筛选|State filter/u);
    await stateFilter.selectOption('deleted');
    await expect(deletedRow).toBeVisible();
    await moreButton(deletedRow).click();
    await page.getByRole('menuitem', { name: /恢复|Restore/u }).click();
    await expect.poll(() => requests.at(-1)).toBe(`${deletedId}:restore`);
    await stateFilter.selectOption('current');
    await expect(deletedRow).toBeVisible();
    await moreButton(deletedRow).click();
    await page.getByRole('menuitem', { name: /删除|Delete/u }).click();
    const deleteDialog = page.locator('#delete-mail-address');
    await expect(deleteDialog).toBeVisible();
    await deleteDialog.getByRole('button', { name: /删除地址|Delete address/u }).click();
    await expect.poll(() => requests.at(-1)).toBe(`${deletedId}:delete`);
    expect(requests).toEqual(expect.arrayContaining([
      `${actionId}:retry`, `${actionId}:import`, `${actionId}:disable`, `${actionId}:enable`,
      `${actionId}:disable_send`, `${actionId}:enable_send`, `${actionId}:make_default`, `${deletedId}:restore`, `${deletedId}:delete`
    ]));
  });

  test('distinguishes zero configuration from a failed initial read', async ({ page }) => {
    await login(page);
    const original = await readIdentities(page);
    await page.route(identitiesUrl, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      await route.fulfill({ json: { ok: true, data: { ...original, domains: [], addresses: [], domainOnboarding: { available: false, workerName: null, canManageRouting: false } } } });
    });
    await gotoManagement(page, '/?folder=settings&view=addresses');
    await expect(managementTable(page, 'addresses')).toBeVisible();
    await expect(page.locator('[role="status"]').filter({ hasText: /没有可用域名|No available domains/u }).first()).toBeVisible();
    await expect(page.locator('#add-mail-address')).toBeDisabled();
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(page.getByText(/读取失败|Loading failed|Could not load/u)).toHaveCount(0);

    await page.unroute(identitiesUrl);
    await page.route(identitiesUrl, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { message: 'synthetic read failure' } }) });
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('alert')).toContainText(/加载失败|Loading failed|Could not load/u);
    await expect(page.getByText(/尚未配置|No mail addresses/u)).toHaveCount(0);
  });

  test('shows a saved but receive-pending address after a partial create', async ({ page }, testInfo) => {
    await login(page);
    const original = await readIdentities(page);
    let created: Record<string, unknown> | null = null;
    await page.route(identitiesUrl, async (route) => {
      const request = route.request();
      if (request.method() === 'POST') {
        const body = request.postDataJSON() as { domainId: string; address: string; displayName: string; signature: string };
        created = { ...original.addresses[0], id: '00000000-0000-4000-8000-000000000099', domain_id: body.domainId,
          email: `${body.address.toLowerCase()}@flaremail.test`, display_name: body.displayName, signature: body.signature,
          local_part: body.address.toLowerCase(), receive_enabled: 0, send_enabled: 0, is_default_sender: 0,
          routing_state: 'error', last_error_code: 'cloudflare_route_missing' };
        await route.fulfill({ status: 201, json: { ok: true, data: { address: created } } });
        return;
      }
      if (request.method() === 'GET') {
        const response = await route.fetch();
        const payload = await response.json() as { data: IdentityPayload };
        await route.fulfill({ response, json: { ...payload, data: { ...payload.data, addresses: created ? [...payload.data.addresses, created] : payload.data.addresses } } });
        return;
      }
      await route.continue();
    });
    await gotoManagement(page, '/?folder=settings&view=addresses');
    await page.locator('#add-mail-address').click();
    const dialog = page.locator('#add-mail-address-dialog');
    await dialog.locator('#mail-identity-domain').selectOption('00000000-0000-4000-8000-000000000011');
    await dialog.getByLabel(/地址前缀|Address prefix/u).fill('partial-e2e');
    await dialog.getByRole('button', { name: /创建并配置收信规则|Create and configure/u }).click();
    await expect(page.locator('[role="status"]').filter({ hasText: /地址已保存|saved/iu }).first()).toBeVisible();
    await expect(page.getByRole('table')).toContainText('partial-e2e@flaremail.test');
    await expect(page.getByRole('table')).toContainText(/需重新检查|Check again|需检查/u);
    await prepareEvidenceDirectory();
    if (testInfo.project.name === 'desktop') await page.screenshot({ path: `${evidenceDirectory}/partial-success.png`, fullPage: false });
  });

  test('locks an unknown create outcome and offers read-only verification instead of retrying', async ({ page }) => {
    await login(page);
    const original = await readIdentities(page);
    let posts = 0;
    await page.route(identitiesUrl, async (route) => {
      if (route.request().method() === 'POST') {
        posts++;
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { message: 'synthetic timeout' } }) });
        return;
      }
      if (route.request().method() === 'GET') {
        await route.fulfill({ json: { ok: true, data: original } });
        return;
      }
      await route.continue();
    });
    await gotoManagement(page, '/?folder=settings&view=addresses');
    await page.locator('#add-mail-address').click();
    const dialog = page.locator('#add-mail-address-dialog');
    await dialog.getByLabel(/地址前缀|Address prefix/u).fill('unknown-e2e');
    const submit = dialog.getByRole('button', { name: /创建并配置收信规则|Create and configure/u });
    await submit.click();
    await expect(dialog).toContainText(/结果未知|outcome unknown|核对|verify/iu);
    await expect(submit).toBeDisabled();
    expect(posts).toBe(1);
    await dialog.getByRole('button', { name: /核对写入结果|Verify the write result|核对/u }).click();
    await expect(dialog).toContainText(/未找到与此次提交一致的记录|No record matching this submission was found/u);
    await expect(submit).toBeEnabled();
    expect(posts).toBe(1);
  });

  test('preserves a draft when a failed create is found by readback and exposes diagnostics', async ({ page }) => {
    await login(page);
    const original = await readIdentities(page);
    let posts = 0;
    let postSeen = false;
    const selectedDomain = original.domains.find((domain) => domain.enabled === 1) ?? original.domains[0];
    const persisted = {
      ...original.addresses[0], id: '00000000-0000-4000-8000-000000000096', domain_id: selectedDomain?.id,
      email: `persisted-unknown-e2e@${String(selectedDomain?.domain_name ?? 'flaremail.test')}`,
      local_part: 'persisted-unknown-e2e', display_name: 'Readback pending', receive_enabled: 0, send_enabled: 0,
      is_default_sender: 0, routing_state: 'error', routing_owner: 'flaremail', last_error_code: 'cloudflare_route_missing'
    };
    await page.route(identitiesUrl, async (route) => {
      if (route.request().method() === 'POST') {
        posts++;
        postSeen = true;
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { message: 'synthetic timeout' } }) });
        return;
      }
      if (route.request().method() === 'GET') {
        await route.fulfill({ json: { ok: true, data: { ...original, addresses: postSeen ? [...original.addresses, persisted] : original.addresses } } });
        return;
      }
      await route.continue();
    });
    await gotoManagement(page, '/?folder=settings&view=addresses');
    await page.locator('#add-mail-address').click();
    const dialog = page.locator('#add-mail-address-dialog');
    const addressInput = dialog.getByLabel(/地址前缀|Address prefix|邮件地址或本地部分|Mail address or local part/u);
    const submit = dialog.getByRole('button', { name: /创建并配置收信规则|Create and configure/u });
    await addressInput.fill('persisted-unknown-e2e');
    await dialog.locator('summary').click();
    await dialog.getByLabel(/显示名称|Display name/u).fill('Draft retained after timeout');
    await submit.click();
    await expect(dialog).toContainText(/已找到此地址的记录|A record for this address was found/u);
    await expect(submit).toBeDisabled();
    await expect(page.getByRole('table', { name: /邮箱地址|Email addresses/u })).toContainText(persisted.email);
    await expect(page.getByRole('table', { name: /邮箱地址|Email addresses/u })).toContainText(/需重新检查|Check again|需检查|Needs attention/u);
    await expect(dialog.getByLabel(/显示名称|Display name/u)).toHaveValue('Draft retained after timeout');
    await expect(dialog).toContainText(/写入结果未知|write outcome unknown/iu);
    await expect(dialog.getByRole('button', { name: /诊断|Diagnostics/u })).toBeVisible();
    expect(posts).toBe(1);
    await dialog.getByRole('button', { name: /诊断|Diagnostics/u }).click();
    const discard = page.locator('#discard-mail-resource-changes');
    await expect(discard).toBeVisible();
    await discard.getByRole('button', { name: /放弃更改|Discard changes/u }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('#mail-diagnostics')).toContainText(persisted.email);
    await page.locator('#mail-diagnostics').getByRole('button', { name: /关闭|Close/u }).last().click();
    expect(posts).toBe(1);
  });

  for (const code of ['CLOUDFLARE_ROUTING_CONFLICT', 'MAIL_DOMAIN_DISABLED', 'MAIL_ADDRESS_OPERATION_CONFLICT']) {
    test(`keeps a conflict create as a saved partial address without replaying POST (${code})`, async ({ page }) => {
      await login(page);
      const original = await readIdentities(page);
      let posts = 0;
      let postSeen = false;
      let created: Record<string, unknown> | null = null;
      const selectedDomain = original.domains.find((domain) => domain.enabled === 1) ?? original.domains[0];
      await page.route(identitiesUrl, async (route) => {
        if (route.request().method() === 'POST') {
          posts++;
          postSeen = true;
          const body = route.request().postDataJSON() as { domainId: string; address: string; displayName: string; signature: string };
          const domain = original.domains.find((item) => item.id === body.domainId) ?? selectedDomain;
          created = {
            ...original.addresses[0], id: '00000000-0000-4000-8000-000000000095', domain_id: body.domainId,
            email: `${body.address.toLowerCase()}@${String(domain?.domain_name ?? 'flaremail.test')}`, local_part: body.address.toLowerCase(),
            display_name: body.displayName, signature: body.signature, receive_enabled: 0, send_enabled: 0,
            is_default_sender: 0, lifecycle_status: 'active', routing_state: 'unknown', routing_owner: 'flaremail',
            last_error_code: 'cloudflare_routing_conflict'
          };
          await route.fulfill({ status: 409, json: { ok: false, error: { code, message: 'synthetic routing conflict' } } });
          return;
        }
        if (route.request().method() === 'GET') {
          await route.fulfill({ json: { ok: true, data: { ...original,
            domains: postSeen && code === 'MAIL_DOMAIN_DISABLED'
              ? original.domains.map((domain) => domain.id === selectedDomain?.id ? { ...domain, enabled: 0 } : domain)
              : original.domains,
            addresses: postSeen && created ? [...original.addresses, created] : original.addresses } } });
          return;
        }
        await route.continue();
      });
      await gotoManagement(page, '/?folder=settings&view=addresses');
      await page.locator('#add-mail-address').click();
      const dialog = page.locator('#add-mail-address-dialog');
      const prefix = 'conflict-e2e';
      await dialog.getByLabel(/地址前缀|Address prefix|邮件地址或本地部分|Mail address or local part/u).fill(prefix);
      await dialog.getByRole('button', { name: /创建并配置收信规则|Create and configure/u }).click();
      const expectedEmail = `${prefix}@${String(selectedDomain?.domain_name ?? 'flaremail.test')}`;
      await expect(page.getByRole('status').filter({ hasText: /地址已保存，但收信规则配置未完成|address was saved, but its receiving rule is not ready/u }).first()).toBeVisible();
      await expect(dialog).toBeHidden();
      await expect(page.getByRole('table', { name: /邮箱地址|Email addresses/u })).toContainText(expectedEmail);
      expect(posts).toBe(1);
      const row = page.locator('[data-address-id="00000000-0000-4000-8000-000000000095"]');
      await moreButton(row).click();
      await expect(page.getByRole('menuitem', { name: /诊断|Diagnostics/u })).toBeVisible();
      await expect(page.getByRole('menuitem', { name: /重试|Retry/u })).toBeVisible();
      expect(posts).toBe(1);
    });
  }

  test('does not claim an existing partial address was created by a rejected duplicate request', async ({ page }) => {
    await login(page);
    const original = await readIdentities(page);
    let posts = 0;
    let existing: Record<string, unknown> | null = null;
    const domain = original.domains.find((item) => item.enabled === 1) ?? original.domains[0];
    await page.route(identitiesUrl, async (route) => {
      if (route.request().method() === 'POST') {
        posts++;
        const body = route.request().postDataJSON();
        existing = {
          ...original.addresses[0], id: '00000000-0000-4000-8000-000000000094', domain_id: body.domainId,
          email: `${body.address}@${String(domain.domain_name)}`, local_part: body.address,
          display_name: body.displayName, signature: body.signature, receive_enabled: 0, send_enabled: 0,
          lifecycle_status: 'active', routing_state: 'unknown', is_default_sender: 0
        };
        await route.fulfill({ status: 409, json: { ok: false, error: { code: 'MAIL_ADDRESS_ALREADY_EXISTS', message: 'Address already exists.' } } });
      } else if (route.request().method() === 'GET') {
        await route.fulfill({ json: { ok: true, data: { ...original, addresses: existing ? [...original.addresses, existing] : original.addresses } } });
      } else await route.continue();
    });
    await gotoManagement(page, '/?folder=settings&view=addresses');
    await page.locator('#add-mail-address').click();
    const dialog = page.locator('#add-mail-address-dialog');
    const prefix = dialog.getByLabel(/地址前缀|Address prefix/u);
    await prefix.fill('duplicate-race');
    await dialog.getByRole('button', { name: /创建并配置收信规则|Create and configure/u }).click();
    await expect(dialog.getByRole('alert')).toContainText(/本次请求没有新建地址|this request did not create another address/u);
    await expect(dialog).toBeVisible();
    await expect(prefix).toHaveValue('duplicate-race');
    await expect(dialog.getByRole('button', { name: /创建并配置收信规则|Create and configure/u })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: /诊断|Diagnostics/u })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: /地址已保存，但收信规则配置未完成|address was saved, but its receiving rule is not ready/u })).toHaveCount(0);
    expect(posts).toBe(1);
  });

  test('keeps a late create response in an unknown state after auth expiry without replaying POST', async ({ page }) => {
    await login(page);
    const original = await readIdentities(page);
    let posts = 0;
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    await page.route(identitiesUrl, async (route) => {
      if (route.request().method() !== 'POST') {
        if (route.request().method() === 'GET') await route.fulfill({ json: { ok: true, data: original } });
        else await route.continue();
        return;
      }
      posts++;
      await pending;
      await route.fulfill({ status: 201, json: { ok: true, data: { address: original.addresses[0] } } });
    });
    await gotoManagement(page, '/?folder=settings&view=addresses');
    await page.locator('#add-mail-address').click();
    const dialog = page.locator('#add-mail-address-dialog');
    const addressInput = dialog.getByLabel(/地址前缀|Address prefix|邮件地址或本地部分|Mail address or local part/u);
    await addressInput.fill('late-auth-e2e');
    await dialog.getByRole('button', { name: /创建并配置收信规则|Create and configure/u }).click();
    await expect(dialog.locator('[aria-busy="true"]')).toBeVisible();
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('flaremail:auth-expired', { detail: { source: 'worker-session' } })));
    release?.();
    await expect(dialog).toContainText(/结果未知|outcome unknown|核对|verify/iu);
    await expect(dialog).toBeVisible();
    await expect(addressInput).toHaveValue('late-auth-e2e');
    expect(posts).toBe(1);
  });

  test('keeps the existing table during a delayed refresh and applies the newest read once it arrives', async ({ page }) => {
    await login(page);
    const original = await readIdentities(page);
    let reads = 0;
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const refreshed = { ...original, addresses: original.addresses.map((address, index) => index === 0 ? { ...address, display_name: 'Race refreshed name' } : address) };
    await page.route(identitiesUrl, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      reads++;
      if (reads === 1) {
        await route.fulfill({ json: { ok: true, data: original } });
        return;
      }
      await pending;
      await route.fulfill({ json: { ok: true, data: refreshed } });
    });
    await gotoManagement(page, '/?folder=settings&view=addresses');
    const table = managementTable(page, 'addresses');
    await expect(table).toContainText(original.addresses[0].email as string);
    await page.locator('#refresh-mail-resources').click();
    await expect.poll(() => reads).toBe(2);
    await expect(table).toContainText(original.addresses[0].email as string);
    release?.();
    await expect(table).toContainText('Race refreshed name');
  });

  test('keeps modal focus and dirty navigation guarded while a save is pending', async ({ page }) => {
    await login(page);
    await gotoManagement(page, '/?folder=settings&view=addresses');
    const original = await readIdentities(page);
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    await page.route(identitiesUrl, async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      await pending;
      await route.fulfill({ status: 201, json: { ok: true, data: { address: original.addresses[0] } } });
    });
    await page.locator('#add-mail-address').click();
    const dialog = page.locator('#add-mail-address-dialog');
    await expect(dialog.getByLabel(/地址前缀|Address prefix/u)).toBeFocused();
    await dialog.focus();
    await page.keyboard.press('Shift+Tab');
    await expect.poll(() => page.evaluate(() => Boolean(document.activeElement?.closest('#add-mail-address-dialog')))).toBe(true);
    await dialog.getByLabel(/地址前缀|Address prefix/u).fill('pending-e2e');
    await dialog.getByRole('button', { name: /创建并配置收信规则|Create and configure/u }).click();
    await expect(dialog.locator('[aria-busy="true"]')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: /取消|Cancel/u })).toBeDisabled();
    await page.keyboard.press('Tab');
    await expect.poll(() => page.evaluate(() => {
      const active = document.activeElement;
      return Boolean(active && active.closest('#add-mail-address-dialog'));
    })).toBe(true);
    release?.();
    await expect(dialog).toBeHidden();
  });

  test('keeps the add-address modal usable at a short viewport', async ({ page }) => {
    await login(page);
    await gotoManagement(page, '/?folder=settings&view=addresses');
    await page.setViewportSize({ width: 390, height: 360 });
    await page.locator('#add-mail-address').click();
    const dialog = page.locator('#add-mail-address-dialog');
    await expect(dialog).toBeVisible();
    await dialog.locator('summary').click();
    await dialog.getByLabel(/显示名称|Display name/u).fill('Short viewport draft');
    const dialogBox = await dialog.boundingBox();
    const footerBox = await dialog.locator('footer').boundingBox();
    expect(dialogBox).not.toBeNull();
    expect(footerBox).not.toBeNull();
    expect((dialogBox?.x ?? 0) + (dialogBox?.width ?? 0)).toBeLessThanOrEqual(390);
    expect((footerBox?.y ?? 0) + (footerBox?.height ?? 0)).toBeLessThanOrEqual(360);
    await page.keyboard.press('Tab');
    await expect.poll(() => page.evaluate(() => Boolean(document.activeElement?.closest('#add-mail-address-dialog')))).toBe(true);
    await page.keyboard.press('Shift+Tab');
    await expect.poll(() => page.evaluate(() => Boolean(document.activeElement?.closest('#add-mail-address-dialog')))).toBe(true);
    await assertNoHorizontalOverflow(page);
    expect((await new AxeBuilder({ page }).include('#add-mail-address-dialog').analyze()).violations).toEqual([]);

    await dialog.getByRole('button', { name: /取消|Cancel/u }).click();
    const discard = page.locator('#discard-mail-resource-changes');
    await expect(discard).toBeVisible();
    await discard.getByRole('button', { name: /继续编辑|Keep editing/u }).click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: /取消|Cancel/u }).click();
    await discard.getByRole('button', { name: /放弃更改|Discard changes/u }).click();
    await expect(dialog).toBeHidden();
  });

  test('changes management table page sizes with accessible controls and preserved filters', async ({ page, consoleErrors }, testInfo) => {
    await login(page);
    const original = await readIdentities(page);
    const domains = Array.from({ length: 31 }, (_, index) => ({
      ...original.domains[0],
      id: `00000000-0000-4000-8000-${String(index + 100).padStart(12, '0')}`,
      domain_name: `pagination-${String(index + 1).padStart(2, '0')}.example.test`
    }));
    const addresses = domains.map((domain, index) => ({
      ...original.addresses[0],
      id: `00000000-0000-4000-8000-${String(index + 200).padStart(12, '0')}`,
      domain_id: domain.id,
      email: `pagination-${String(index + 1).padStart(2, '0')}@${domain.domain_name}`
    }));
    await page.route(identitiesUrl, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      await route.fulfill({ json: { ok: true, data: { ...original, domains, addresses } } });
    });

    for (const view of ['domains', 'addresses'] as const) {
      await gotoManagement(page, `/?folder=settings&view=${view}`);
      await expect(managementHeading(page, view)).toBeVisible();
      await expect(page).toHaveTitle(/FlareMail/u);
      await expect(page.locator('vite-error-overlay')).toHaveCount(0);
      const rows = managementTable(page, view).locator('tbody tr[data-domain-id], tbody tr[data-address-id]');
      const pageSize = page.getByRole('combobox', { name: /每页条数|Rows per page/u });
      const footer = page.locator('.resource-pagination');
      const next = footer.getByRole('button', { name: /下一页|Next page/u });
      const previous = footer.getByRole('button', { name: /上一页|Previous page/u });
      await expect(pageSize).toHaveValue('10');
      await expect(pageSize.locator('option')).toHaveText(['10', '20', '50', '100']);
      await expect(rows).toHaveCount(10);

      const search = page.locator('#mail-resource-search');
      await search.fill('pagination-');
      const state = view === 'domains' ? 'enabled' : 'active';
      await page.locator('#mail-state-filter').selectOption(state);
      const firstRow = await rows.first().getAttribute(view === 'domains' ? 'data-domain-id' : 'data-address-id');
      await next.click();
      await expect(footer).toContainText(/第 2 \/ 4 页|Page 2 of 4/u);

      await pageSize.focus();
      await pageSize.press('ArrowDown');
      await pageSize.press('Enter');
      await pageSize.press('Tab');
      await expect(pageSize).toHaveValue('20');
      await expect(rows).toHaveCount(20);
      await expect(previous).toBeDisabled();
      await expect(footer).toContainText(/第 1 \/ 2 页|Page 1 of 2/u);
      await expect(rows.first()).toHaveAttribute(view === 'domains' ? 'data-domain-id' : 'data-address-id', firstRow!);
      await expect(search).toHaveValue('pagination-');
      await expect(page.locator('#mail-state-filter')).toHaveValue(state);
      await next.click();
      await expect(rows).toHaveCount(11);
      await expect(next).toBeDisabled();

      for (const size of ['50', '100']) {
        await pageSize.selectOption(size);
        await expect(rows).toHaveCount(31);
        await expect(next).toHaveCount(0);
        await expect(pageSize).toBeVisible();
      }
      await search.fill('no-pagination-matches');
      await expect(rows).toHaveCount(0);
      await pageSize.selectOption('10');
      await expect(pageSize).toHaveValue('10');
      await search.fill('');
      await expect(rows).toHaveCount(10);
      await expect(previous).toBeDisabled();
      await expect(footer).toContainText(/显示 31 \/ 共 31|Showing 31 of 31/u);
      await assertNoHorizontalOverflow(page);
      expect((await new AxeBuilder({ page }).include('.resource-pagination').analyze()).violations).toEqual([]);
      await dismissNotifications(page);
      await footer.scrollIntoViewIfNeeded();
      const directory = '/tmp/flaremail-table-page-size-evidence';
      await mkdir(directory, { recursive: true });
      await page.screenshot({ path: `${directory}/${view}-${testInfo.project.name}.png`, fullPage: false });
      await pageSize.selectOption('20');
      await page.locator('#refresh-mail-resources').click();
      await expect(rows).toHaveCount(20);
      await expect(pageSize).toHaveValue('20');
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(pageSize).toHaveValue('10');
      await expect(rows).toHaveCount(10);
    }
    await assertNoConsoleErrors(consoleErrors);
  });

  test('covers long management collections at narrow widths and records table evidence', async ({ page, browser }, testInfo) => {
    await login(page);
    await prepareEvidenceDirectory();
    const original = await readIdentities(page);
    await gotoManagement(page, '/?folder=settings&view=domains');
    await expect(managementTable(page, 'domains')).toBeVisible();
    await dismissNotifications(page);
    if (testInfo.project.name === 'desktop') await page.screenshot({ path: `${evidenceDirectory}/domains-desktop.png`, fullPage: false });
    if (testInfo.project.name === 'mobile') await page.screenshot({ path: `${evidenceDirectory}/domains-mobile.png`, fullPage: false });
    if (testInfo.project.name === 'narrow') await page.screenshot({ path: `${evidenceDirectory}/domains-narrow.png`, fullPage: false });
    await gotoManagement(page, '/?folder=settings&view=addresses');
    await expect(managementTable(page, 'addresses')).toBeVisible();
    await dismissNotifications(page);
    if (testInfo.project.name === 'desktop') await page.screenshot({ path: `${evidenceDirectory}/addresses-desktop.png`, fullPage: false });
    if (testInfo.project.name === 'mobile') await page.screenshot({ path: `${evidenceDirectory}/addresses-mobile.png`, fullPage: false });
    if (testInfo.project.name === 'narrow') await page.screenshot({ path: `${evidenceDirectory}/addresses-narrow.png`, fullPage: false });
    const domains = Array.from({ length: 30 }, (_, index) => ({
      ...original.domains[index % original.domains.length],
      id: `00000000-0000-4000-8000-${String(index + 100).padStart(12, '0')}`,
      domain_name: `${'very-long-management-domain-'.repeat(index % 3 + 1)}${index}.example.test`
    }));
    const addresses = domains.map((domain, index) => ({
      ...original.addresses[index % original.addresses.length],
      id: `00000000-0000-4000-8000-${String(index + 200).padStart(12, '0')}`,
      domain_id: domain.id,
      email: `${'long-address-'.repeat(index % 2 + 1)}${index}@${domain.domain_name}`,
      display_name: `Long display name ${'with additional context '.repeat(3)}${index}`,
      lifecycle_status: index === 29 ? 'deleted' : 'active',
      routing_state: index === 29 ? 'deleted' : 'active',
      receive_enabled: index === 29 ? 0 : 1
    }));
    await page.route(identitiesUrl, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      await route.fulfill({ json: { ok: true, data: { ...original, domains, addresses } } });
    });
    await gotoManagement(page, '/?folder=settings&view=domains');
    await expect(managementTable(page, 'domains')).toBeVisible();
    await expect(page.getByText(/显示 30 \/ 共 30|Showing 30 of 30/iu)).toBeVisible();
    await expect(managementTable(page, 'domains').locator('tbody tr[data-domain-id]')).toHaveCount(10);
    await expect(page.getByRole('button', { name: /下一页|Next page/u })).toBeEnabled();
    const domainSearch = page.locator('#mail-resource-search');
    await domainSearch.fill('very-long-management-domain-29');
    await expect(managementTable(page, 'domains').locator('tbody tr[data-domain-id]')).toHaveCount(1);
    await expect(page.getByText(/显示 1 \/ 共 30|Showing 1 of 30/iu)).toBeVisible();
    await domainSearch.fill('');
    await assertNoHorizontalOverflow(page);
    await dismissNotifications(page);
    if (testInfo.project.name === 'desktop') await page.screenshot({ path: `${evidenceDirectory}/domains-long-desktop.png`, fullPage: false });
    if (testInfo.project.name === 'mobile') await page.screenshot({ path: `${evidenceDirectory}/domains-long-mobile.png`, fullPage: false });
    if (testInfo.project.name === 'narrow') await page.screenshot({ path: `${evidenceDirectory}/domains-long-narrow.png`, fullPage: false });
    await gotoManagement(page, '/?folder=settings&view=addresses');
    await expect(managementTable(page, 'addresses')).toBeVisible();
    await expect(managementTable(page, 'addresses')).toContainText('long-address-');
    await expect(managementTable(page, 'addresses').locator('tbody tr[data-address-id]')).toHaveCount(10);
    await domainSearch.fill('long-address-29');
    await page.locator('#mail-state-filter').selectOption('all');
    await expect(managementTable(page, 'addresses').locator('tbody tr[data-address-id]')).toHaveCount(1);
    await page.locator('#mail-domain-filter').selectOption(domains[29].id as string);
    await expect(managementTable(page, 'addresses').locator('tbody tr[data-address-id]')).toHaveCount(1);
    await page.locator('#mail-state-filter').selectOption('deleted');
    await expect(managementTable(page, 'addresses').locator('tbody tr[data-address-id]')).toHaveCount(1);
    await expect(page.getByText(/显示 1 \/ 共 1|Showing 1 of 1/iu)).toBeVisible();
    await domainSearch.fill('');
    await page.locator('#mail-domain-filter').selectOption('');
    await page.locator('#mail-state-filter').selectOption('current');
    await assertNoHorizontalOverflow(page);
    await dismissNotifications(page);
    if (testInfo.project.name === 'desktop') await page.screenshot({ path: `${evidenceDirectory}/addresses-long-desktop.png`, fullPage: false });
    if (testInfo.project.name === 'mobile') await page.screenshot({ path: `${evidenceDirectory}/addresses-long-mobile.png`, fullPage: false });
    if (testInfo.project.name === 'narrow') await page.screenshot({ path: `${evidenceDirectory}/addresses-long-narrow.png`, fullPage: false });
    for (const width of [320, 390, 768, 1280]) {
      await page.setViewportSize({ width, height: width < 900 ? 720 : 900 });
      await assertNoHorizontalOverflow(page);
    }
    await page.evaluate(() => localStorage.setItem('flaremail-theme', 'dark'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await assertNoHorizontalOverflow(page);
    await expect(managementTable(page, 'addresses')).toBeVisible();
    await page.getByRole('button', { name: /显示偏好|Display preferences/u }).click();
    const preferences = page.locator('#display-preferences-content');
    await preferences.getByRole('radio', { name: /跟随系统|System/u }).click();
    await page.keyboard.press('Escape');
    await expect(preferences).toBeHidden();
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect.poll(() => page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(true);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.locator('html')).toHaveAttribute('data-theme-preference', 'system');
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.emulateMedia({ colorScheme: null });
    // Firefox drops protocol media overrides across a COOP browsing-context
    // switch. Use its native dark preference to test reload persistence while
    // retaining the application's same-origin security header.
    const systemBrowser = browser.browserType().name() === 'firefox'
      ? await browser.browserType().launch({
        executablePath: process.env.PLAYWRIGHT_FIREFOX_EXECUTABLE_PATH,
        firefoxUserPrefs: { 'layout.css.prefers-color-scheme.content-override': 0 }
      }) : null;
    const darkContext = await (systemBrowser ?? browser).newContext({
      baseURL: new URL(page.url()).origin, viewport: { width: 1280, height: 900 }, locale: 'zh-CN',
      colorScheme: 'dark', storageState: await page.context().storageState()
    });
    try {
      const darkPage = await darkContext.newPage();
      await darkPage.route(identitiesUrl, async (route) => {
        if (route.request().method() !== 'GET') return route.continue();
        await route.fulfill({ json: { ok: true, data: { ...original, domains, addresses } } });
      });
      await darkPage.goto('/?folder=settings&view=addresses', { waitUntil: 'domcontentloaded' });
      await expect(managementTable(darkPage, 'addresses')).toBeVisible();
      await expect.poll(() => darkPage.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(true);
      await expect(darkPage.locator('html')).toHaveAttribute('data-theme', 'dark');
      await expect(darkPage.locator('html')).toHaveAttribute('data-theme-preference', 'system');
      await assertNoHorizontalOverflow(darkPage);
      await darkPage.reload({ waitUntil: 'domcontentloaded' });
      await expect(managementTable(darkPage, 'addresses')).toBeVisible();
      await expect.poll(() => darkPage.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(true);
      await expect(darkPage.locator('html')).toHaveAttribute('data-theme', 'dark');
      await expect(darkPage.locator('html')).toHaveAttribute('data-theme-preference', 'system');
    } finally {
      await darkContext.close();
      await systemBrowser?.close();
    }
    await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
    await assertNoHorizontalOverflow(page);
    await expect(page.locator('#add-mail-address')).toBeEnabled();
    await page.locator('#add-mail-address').click();
    const zoomDialog = page.locator('#add-mail-address-dialog');
    await expect(zoomDialog).toBeVisible();
    const zoomInput = zoomDialog.getByLabel(/地址前缀|Address prefix|邮件地址或本地部分|Mail address or local part/u);
    await zoomInput.fill('zoom-interaction');
    await expect(zoomInput).toHaveValue('zoom-interaction');
    await zoomInput.fill('');
    await zoomDialog.getByRole('button', { name: /取消|Cancel/u }).click();
    await expect(zoomDialog).toBeHidden();
    await assertNoHorizontalOverflow(page);
    await page.evaluate(() => { document.documentElement.style.zoom = ''; });
  });

  test('keeps management labels and dialogs usable after switching to English', async ({ page }, testInfo) => {
    await login(page);
    await gotoManagement(page, '/?folder=settings&view=addresses');
    if (testInfo.project.name.includes('desktop')) {
      await page.getByRole('button', { name: '显示偏好' }).click();
      const preferences = page.locator('#display-preferences-content');
      await preferences.getByRole('radiogroup', { name: '切换语言' }).getByRole('radio', { name: 'English', exact: true }).click();
    } else {
      await page.evaluate(() => {
        localStorage.setItem('flaremail-locale', 'en');
        document.cookie = 'flaremail-locale=en; Path=/';
        window.dispatchEvent(new CustomEvent('flaremail:locale-change', { detail: { locale: 'en', preference: 'en' } }));
      });
    }
    await expect(page.getByRole('heading', { name: /Email addresses/u })).toBeVisible();
    await expect(page.getByRole('table', { name: 'Email addresses', exact: true })).toBeVisible();
    if (testInfo.project.name.includes('desktop')) {
      await page.keyboard.press('Escape');
      await expect(page.locator('#display-preferences-content')).toBeHidden();
    }
    await page.locator('#add-mail-address').click();
    const dialog = page.locator('#add-mail-address-dialog');
    await expect(dialog).toHaveAccessibleName(/Add address/u);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  });

  test('captures modal evidence and restores the menu trigger focus', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'The focused modal evidence set is captured once on desktop.');
    await prepareEvidenceDirectory();
    await login(page);
    await gotoManagement(page, '/?folder=settings&view=domains');
    const domainRow = page.locator('[data-domain-id="00000000-0000-4000-8000-000000000011"]');
    await domainRow.getByRole('button', { name: /域名设置|Domain settings/u }).click();
    const domainSettings = page.locator('#domain-settings');
    await expect(domainSettings).toBeVisible();
    await domainSettings.screenshot({ path: `${evidenceDirectory}/domain-settings.png` });
    await domainSettings.getByRole('button', { name: /取消|Cancel/u }).click();
    await expect(domainSettings).toBeHidden();
    await expect(domainRow.getByRole('button', { name: /域名设置|Domain settings/u })).toBeFocused();

    const domainMenuTrigger = domainRow.getByRole('button', { name: /更多操作|More actions/u });
    await domainMenuTrigger.focus();
    await domainMenuTrigger.press('ArrowDown');
    const viewAddressesItem = page.getByRole('menuitem', { name: /查看地址|View addresses/u });
    await expect(viewAddressesItem).toBeFocused();
    await page.keyboard.press('ArrowDown');
    const createAddressItem = page.getByRole('menuitem', { name: /为此域名创建地址|Create address for this domain/u });
    await expect(createAddressItem).toBeFocused();
    await page.keyboard.press('Enter');
    const addAddress = page.locator('#add-mail-address-dialog');
    await expect(addAddress).toBeVisible();
    await expect(addAddress.getByLabel(/地址前缀|Address prefix|邮件地址或本地部分|Mail address or local part/u)).toBeFocused();
    await page.keyboard.press('Tab');
    await expect.poll(() => page.evaluate(() => Boolean(document.activeElement?.closest('#add-mail-address-dialog')))).toBe(true);
    await page.keyboard.press('Shift+Tab');
    await expect.poll(() => page.evaluate(() => Boolean(document.activeElement?.closest('#add-mail-address-dialog')))).toBe(true);
    await addAddress.screenshot({ path: `${evidenceDirectory}/add-address.png` });
    await page.keyboard.press('Escape');
    await expect(addAddress).toBeHidden();
    await expect(domainMenuTrigger).toBeFocused();

    await gotoManagement(page, '/?folder=settings&view=addresses');
    const addressRow = page.locator('[data-address-id="00000000-0000-4000-8000-000000000022"]');
    await addressRow.getByRole('button', { name: /编辑名称与签名|Edit name and signature/u }).click();
    const edit = page.locator('#edit-mail-address');
    await edit.screenshot({ path: `${evidenceDirectory}/edit-address.png` });
    await edit.getByRole('button', { name: /取消|Cancel/u }).click();
    await gotoManagement(page, '/?folder=settings&view=domains');
    await domainRow.getByRole('button', { name: 'flaremail.test', exact: true }).click();
    const diagnostics = page.locator('#mail-diagnostics');
    await expect(diagnostics).toBeVisible();
    await diagnostics.screenshot({ path: `${evidenceDirectory}/diagnostics.png` });
    await diagnostics.getByRole('button', { name: /关闭|Close/u }).last().click();
    await page.locator('#add-mail-domain').click();
    const addDomain = page.locator('#add-mail-domain-dialog');
    await expect(addDomain).toBeVisible();
    await addDomain.screenshot({ path: `${evidenceDirectory}/add-domain.png` });
    await addDomain.getByRole('button', { name: /取消|Cancel/u }).click();
    await expect(addDomain).toBeHidden();
  });
});
