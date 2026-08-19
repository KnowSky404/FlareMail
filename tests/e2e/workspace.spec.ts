import { assertNoConsoleErrors, assertNoHorizontalOverflow, expect, login, openFolder, test } from './fixtures';
import AxeBuilder from '@axe-core/playwright';

test.describe.configure({ mode: 'serial' });

const webhookSecretBytes = new TextEncoder().encode('FlareMail E2E webhook secret 2026');

async function signWebhook(id: string, timestamp: number, body: string) {
  const key = await crypto.subtle.importKey('raw', webhookSecretBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${timestamp}.${body}`));
  return Buffer.from(digest).toString('base64');
}

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
      await expect(page.getByRole('status')).toContainText('已加入星标邮件');
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

test('autosaves a compose draft and restores it after refresh', async ({ page, consoleErrors }) => {
  await login(page);
  await page.getByRole('button', { name: '写邮件', exact: true }).first().click();
  await expect(page.getByRole('dialog', { name: '新邮件' })).toBeVisible();
  await page.getByLabel('收件人').fill('draft-recipient@flaremail.test');
  await page.getByRole('textbox', { name: '主题', exact: true }).fill('E2E autosaved draft');
  await page.getByRole('textbox', { name: '正文', exact: true }).fill('This draft must survive a page refresh.');
  await expect(page.getByRole('status').filter({ hasText: '已自动保存于' })).toBeVisible({ timeout: 8_000 });
  await page.reload();
  await expect(page.getByRole('main', { name: '邮件工作区' })).toBeVisible();
  await openFolder(page, '草稿箱');
  await expect(page.getByText('E2E autosaved draft', { exact: true }).first()).toBeVisible();
  await assertNoConsoleErrors(consoleErrors);
});

test('sends through the local fake provider and applies a signed delivered webhook', async ({ page, consoleErrors }, testInfo) => {
  const externalRequests: string[] = [];
  page.on('request', (request) => {
    if (/resend\.com/iu.test(request.url())) externalRequests.push(request.url());
  });
  await login(page);
  await page.getByRole('button', { name: '写邮件', exact: true }).first().click();
  const subject = 'E2E fake send';
  await page.getByLabel('收件人').fill('send-recipient@flaremail.test');
  await page.getByRole('textbox', { name: '主题', exact: true }).fill(subject);
  await page.getByRole('textbox', { name: '正文', exact: true }).fill('This message is sent by the local fake provider.');
  await page.getByRole('button', { name: '发送邮件' }).click();
  const detail = page.getByRole('region', { name: '邮件详情' });
  await expect(detail.getByRole('heading', { name: subject, exact: true })).toBeVisible();
  await expect(detail.getByText('已提交', { exact: true }).first()).toBeVisible();
  expect(externalRequests).toEqual([]);

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
