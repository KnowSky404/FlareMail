import AxeBuilder from '@axe-core/playwright';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import { assertNoConsoleErrors, assertNoHorizontalOverflow, expect, login, selectSettings, test } from './fixtures';

const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };

test('opens a centered accessible About dialog in both themes without navigation or external requests', async ({ page, consoleErrors }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem('flaremail-theme', 'system'));
  await page.emulateMedia({ colorScheme: 'light' });
  await login(page);
  await page.bringToFront();
  await expect(page).toHaveTitle('FlareMail');
  await expect(page.getByRole('main', { name: '邮件工作区' })).toBeVisible();
  const externalRequests: string[] = [];
  const writes: string[] = [];
  const origin = new URL(page.url()).origin;
  page.on('request', (request) => {
    if (new URL(request.url()).origin !== origin) externalRequests.push(request.url());
    if (!['GET', 'HEAD'].includes(request.method())) writes.push(request.url());
  });
  const originalUrl = page.url();
  const account = page.getByRole('button', { name: '账号菜单' });
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await account.focus();
    await expect(account).toBeFocused();
    await page.keyboard.press('Enter');
    const menu = page.getByRole('menu');
    await expect(menu.getByRole('menuitem')).toHaveText(['关于', '退出登录']);
    await expect(menu.getByRole('menuitem', { name: /打开设置|Open settings/u })).toHaveCount(0);
    await expect(menu).toContainText('E2E Administrator');
    const about = menu.getByRole('menuitem', { name: '关于', exact: true });
    await about.focus();
    await expect(about).toBeFocused();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: '关于 FlareMail', exact: true });
    await expect(dialog).toBeVisible();
    await expect(menu).toBeHidden();
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    await expect(dialog.getByText(`v${version}`, { exact: true })).toBeVisible();
    await expect(dialog.getByText('© KnowSky404', { exact: true })).toBeVisible();
    const repository = dialog.getByRole('link', { name: 'https://github.com/KnowSky404/FlareMail', exact: true });
    await expect(repository).toHaveAttribute('href', 'https://github.com/KnowSky404/FlareMail');
    await expect(repository).toHaveAttribute('target', '_blank');
    await expect(repository).toHaveAttribute('rel', 'noopener noreferrer');
    const close = dialog.getByRole('button', { name: '关闭', exact: true });
    await expect(close).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(repository).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(close).toBeFocused();
    const bounds = await dialog.boundingBox();
    const viewport = page.viewportSize()!;
    expect(Math.abs(bounds!.x + bounds!.width / 2 - viewport.width / 2)).toBeLessThanOrEqual(2);
    expect(Math.abs(bounds!.y + bounds!.height / 2 - viewport.height / 2)).toBeLessThanOrEqual(2);
    expect(bounds!.width).toBeLessThanOrEqual(384);
    await assertNoHorizontalOverflow(page);
    expect((await new AxeBuilder({ page }).include('#about-dialog').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
    await page.screenshot({ path: join(tmpdir(), `flaremail-about-${testInfo.project.name}-${theme}.png`), fullPage: false });
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(account).toBeFocused();
    await expect(page).toHaveURL(originalUrl);
  }
  expect(externalRequests).toEqual([]);
  expect(writes).toEqual([]);
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  await assertNoConsoleErrors(consoleErrors);
});

test('preserves unsaved settings when About closes by button or backdrop and retains sign out', async ({ page, consoleErrors }) => {
  await login(page);
  await selectSettings(page);
  const name = page.getByLabel('显示姓名');
  await name.fill('Unsaved About regression');
  const originalUrl = page.url();
  const account = page.getByRole('button', { name: '账号菜单' });
  const dialog = page.getByRole('dialog', { name: '关于 FlareMail', exact: true });
  for (const dismissal of ['button', 'backdrop'] as const) {
    await account.press('Enter');
    // Exercise the pointer path as well as keyboard activation.
    await page.getByRole('menuitem', { name: '关于', exact: true }).click();
    await expect(dialog).toBeVisible();
    if (dismissal === 'button') await dialog.getByRole('button', { name: '关闭', exact: true }).press('Enter');
    else await page.mouse.click(2, 2);
    await expect(dialog).toBeHidden();
    await expect(account).toBeFocused();
    await expect(name).toHaveValue('Unsaved About regression');
    await expect(page).toHaveURL(originalUrl);
  }
  await account.press('Enter');
  await page.getByRole('menuitem', { name: '退出登录', exact: true }).press('Enter');
  await expect(page.getByRole('heading', { name: '登录邮件工作台' })).toBeVisible();
  await assertNoConsoleErrors(consoleErrors);
});

test('localizes the About menu and dialog in English', async ({ page, consoleErrors }) => {
  await login(page);
  const preferences = page.getByRole('button', { name: '显示偏好' });
  if (await preferences.isVisible()) {
    await preferences.press('Enter');
    await page.getByRole('radio', { name: 'English', exact: true }).press('Enter');
  } else {
    await page.getByRole('button', { name: '打开导航' }).press('Enter');
    await page.getByRole('navigation', { name: '移动端导航' }).getByLabel('切换语言').selectOption('en');
  }
  await page.keyboard.press('Escape');
  const account = page.getByRole('button', { name: 'Account menu' });
  await account.press('Enter');
  await expect(page.getByRole('menu').getByRole('menuitem')).toHaveText(['About', 'Sign out']);
  await page.getByRole('menuitem', { name: 'About', exact: true }).press('Enter');
  const dialog = page.getByRole('dialog', { name: 'About FlareMail', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Project version', { exact: true })).toBeVisible();
  await expect(dialog.getByText('GitHub repository', { exact: true })).toBeVisible();
  await expect(dialog.getByText(`v${version}`, { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Close', exact: true }).press('Enter');
  await expect(dialog).toBeHidden();
  await expect(account).toBeFocused();
  await assertNoConsoleErrors(consoleErrors);
});
