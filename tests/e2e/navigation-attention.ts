import AxeBuilder from '@axe-core/playwright';
import type { Page, TestInfo } from '@playwright/test';
import { assertNoConsoleErrors, assertNoHorizontalOverflow, expect, login } from './fixtures';

// The flow under test is login -> change identity -> inspect attention badges ->
// open Sent, including delayed metrics, zero counts and compact navigation.
export async function verifyNavigationAttention(page: Page, consoleErrors: string[], testInfo: TestInfo) {
  await login(page);
  await expect(page).toHaveTitle('FlareMail');
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  const compact = page.viewportSize()!.width < 901;
  const navigation = page.getByRole('navigation', { name: compact ? '移动端导航' : '主导航', exact: true });
  const badgeSelector = compact ? 'small' : '.count';
  async function showNavigation() {
    if (compact && !await navigation.isVisible()) {
      const trigger = page.getByRole('button', { name: '打开导航' });
      await trigger.focus();
      await trigger.press('Enter');
      await expect(navigation).toBeVisible();
    }
  }
  const button = (label: string) => navigation.getByRole('button', { name: label, exact: true });
  const badge = (label: string) => button(label).locator(badgeSelector);
  await showNavigation();
  const response = await page.request.get('/api/workspace/mailbox/metrics');
  const { data } = await response.json();
  const expectedSending = data.metrics.queuedCount + data.metrics.delayedCount + data.metrics.failedCount
    + data.metrics.bouncedCount + data.metrics.complainedCount;
  for (const [label, count] of [['收件箱', data.metrics.unreadCount], ['草稿箱', data.metrics.draftsCount], ['已发送', expectedSending]] as const) {
    if (count) await expect(badge(label)).toHaveText(count > 99 ? '99+' : String(count));
    else await expect(badge(label)).toHaveCount(0);
  }
  for (const label of ['星标邮件', '归档', '垃圾箱']) await expect(badge(label)).toHaveCount(0);
  if (compact) await page.keyboard.press('Escape');

  const support = 'address:00000000-0000-4000-8000-000000000022';
  const primary = 'address:00000000-0000-4000-8000-000000000021';
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route(/\/api\/workspace\/mailbox(?:\/metrics)?(?:\?|$)/u, async (route) => {
    const scope = new URL(route.request().url()).searchParams.get('identity');
    const response = await route.fetch();
    const payload = await response.json();
    const target = payload.data.page ?? payload.data;
    if (target.metrics && (scope === support || scope === primary)) {
      target.metrics = { ...target.metrics, inboxCount: 400, sentCount: 500, draftsCount: scope === support ? 101 : 0,
        unreadCount: scope === support ? 120 : 0, starredCount: 300, archiveCount: 200, trashCount: 100,
        queuedCount: scope === support ? 2 : 0, delayedCount: scope === support ? 1 : 0,
        failedCount: scope === support ? 2 : 0, bouncedCount: scope === support ? 1 : 0,
        complainedCount: scope === support ? 1 : 0, staleDeliveryCount: scope === support ? 1 : 0 };
    }
    if (scope === primary) await held;
    await route.fulfill({ response, json: payload });
  });
  try {
    await page.getByLabel('按邮件身份筛选').selectOption(support);
    await expect(page).toHaveURL(/identity=address/u);
    await showNavigation();
    await expect(badge('收件箱')).toHaveText('99+');
    await expect(badge('收件箱')).toHaveAttribute('title', '120 未读');
    await expect(badge('草稿箱')).toHaveText('99+');
    await expect(badge('已发送')).toHaveText('7');
    await expect(button('已发送')).toHaveAccessibleDescription('7 封发送中或需处理');
    for (const label of ['星标邮件', '归档', '垃圾箱']) await expect(badge(label)).toHaveCount(0);
    expect((await new AxeBuilder({ page }).include(compact ? '.mobile-nav-list' : '#fm-main-sidebar')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()).violations).toEqual([]);
    await assertNoHorizontalOverflow(page);
    await page.screenshot({ path: `/tmp/flaremail-attention-${testInfo.project.name}.png` });
    await button('已发送').focus();
    await button('已发送').press('Enter');
    await expect(page).toHaveURL(/folder=sent/u);
    if (!compact) {
      await page.getByRole('button', { name: '折叠侧边栏' }).click();
      await expect(page.locator('#fm-main-sidebar')).toHaveClass(/collapsed/u);
      await expect(button('已发送')).toHaveAttribute('aria-describedby', /.+/u);
      await page.getByRole('button', { name: '展开侧边栏' }).click();
    }
    await page.getByLabel('按邮件身份筛选').selectOption(primary);
    const currentMetrics = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === '/api/workspace/mailbox/metrics' && url.searchParams.get('identity') === primary;
    });
    await showNavigation();
    // The previous address's badges must disappear before the new response.
    for (const label of ['收件箱', '草稿箱', '已发送']) await expect(badge(label)).toHaveCount(0);
    release();
    await currentMetrics;
    for (const label of ['收件箱', '草稿箱', '已发送']) await expect(badge(label)).toHaveCount(0);
    await assertNoHorizontalOverflow(page);
    await assertNoConsoleErrors(consoleErrors);
  } finally {
    release();
    await page.unroute(/\/api\/workspace\/mailbox(?:\/metrics)?(?:\?|$)/u);
  }
}
