import { expect, test as base, type Page } from '@playwright/test';

export const E2E_EMAIL = process.env.FLAREMAIL_E2E_EMAIL ?? 'e2e-admin@flaremail.test';
export const E2E_PASSWORD = process.env.FLAREMAIL_E2E_PASSWORD ?? 'FlareMail-E2E-password-2026!';

export const test = base.extend<{ consoleErrors: string[] }>({
  consoleErrors: async ({ page }, use) => {
    const errors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    page.on('pageerror', (error) => errors.push(error.message));
    await use(errors);
  }
});

export { expect };

export async function login(page: Page) {
  await page.goto('/');
  const loginHeading = page.getByRole('heading', { name: '登录邮件工作台' });
  if (await loginHeading.isVisible().catch(() => false)) {
    await page.getByLabel('邮箱地址').fill(E2E_EMAIL);
    await page.getByLabel('密码').fill(E2E_PASSWORD);
    await page.getByRole('button', { name: '登录' }).click();
  }
  await expect(page.getByRole('main', { name: '邮件工作区' })).toBeVisible();
  const backButton = page.getByRole('button', { name: '返回邮件列表' });
  if (await backButton.isVisible().catch(() => false)) await backButton.click();
}

export async function assertNoHorizontalOverflow(page: import('@playwright/test').Page) {
  const overflow = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth)
  }));
  expect(overflow.scrollWidth, `horizontal overflow: ${JSON.stringify(overflow)}`).toBeLessThanOrEqual(overflow.viewport + 1);
}

export async function assertNoConsoleErrors(consoleErrors: string[]) {
  expect(consoleErrors, `browser console errors: ${consoleErrors.join('\n')}`).toEqual([]);
}

export async function openFolder(page: Page, folder: '收件箱' | '已发送' | '草稿箱' | '归档') {
  const folderValue = { 收件箱: 'inbox', 已发送: 'sent', 草稿箱: 'drafts', 归档: 'archive' }[folder];
  const direct = page.getByRole('button', { name: folder, exact: true }).first();
  if (await direct.isVisible().catch(() => false)) {
    await direct.click();
    await expect(page).toHaveURL(new RegExp(`folder=${folderValue}`, 'u'));
    return;
  }
  await page.getByRole('button', { name: '打开导航' }).click();
  await page.getByRole('navigation', { name: '移动端导航' })
    .getByRole('button')
    .filter({ hasText: folder })
    .click();
  await expect(page).toHaveURL(new RegExp(`folder=${folderValue}`, 'u'));
}
