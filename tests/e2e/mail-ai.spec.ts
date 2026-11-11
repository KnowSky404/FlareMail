import AxeBuilder from '@axe-core/playwright';
import { mkdir } from 'node:fs/promises';
import { test, expect, login, assertNoHorizontalOverflow, assertNoConsoleErrors } from './fixtures';

const title = 'AI 摘要与分类建议';
const path = '/api/workspace/messages/e2e-inbox-message/ai';

test('AI accessible summary, explicit category application and cached refresh', async ({ page, consoleErrors }, info) => {
  let generations = 0;
  let cached = false;
  await page.route(`**${path}*`, async (route) => {
    if (route.request().method() === 'POST') { generations++; cached = true; }
    await route.fulfill({ json: { ok: true, data: cached ? { status: 'ready', truncated: true, analysis: {
      summary: '会议邀请：请确认参会。<script>window.aiInjected = true</script>', keyPoints: ['会议地点待确认'], actionItems: ['确认参会'], dates: ['November 12'], language: 'zh-CN',
      suggestion: { category: 'updates', confidence: 0.8, reason: '会议安排更新' }
    } } : { status: 'empty', analysis: null }, requestId: 'fake-ai' } });
  });
  await login(page);
  await page.locator('.mail-list-panel').getByRole('listitem').filter({ hasText: 'E2E Inbox Welcome' }).getByRole('button', { name: /E2E Inbox Welcome/u }).first().click();
  const panel = page.getByRole('region', { name: title });
  const toggle = panel.getByRole('button', { name: title, exact: true }).first();
  await toggle.focus(); await page.keyboard.press('Enter');
  await expect(panel.getByRole('button', { name: '同意并生成分析' })).toBeVisible();
  expect(generations).toBe(0);
  await panel.getByRole('button', { name: '同意并生成分析' }).click();
  await expect(panel.getByText('会议邀请：', { exact: false })).toBeVisible();
  expect(await page.evaluate(() => 'aiInjected' in window)).toBe(false);
  await panel.getByRole('button', { name: '分类建议', exact: true }).click();
  expect(generations).toBe(1);
  await panel.getByRole('button', { name: '确认应用此分类' }).click();
  await expect(panel.getByText(/已有手动分类|已应用分类/u)).toBeVisible();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('region', { name: title }).getByRole('button', { name: title, exact: true }).first().click();
  await expect(page.getByText('会议邀请：', { exact: false })).toBeVisible();
  expect(generations).toBe(1);
  await assertNoHorizontalOverflow(page);
  const accessibility = await new AxeBuilder({ page }).include('.message-content').analyze();
  expect(accessibility.violations).toEqual([]);
  await mkdir('/tmp/flaremail-ai-evidence', { recursive: true });
  await page.screenshot({ path: `/tmp/flaremail-ai-evidence/${info.project.name}-summary.png` });
  await assertNoConsoleErrors(consoleErrors);
});

test('AI disabled state does not generate and standalone reader shares the panel', async ({ page, consoleErrors }) => {
  let posts = 0;
  await page.route(`**${path}*`, async (route) => {
    if (route.request().method() === 'POST') posts++;
    await route.fulfill({ json: { ok: true, data: { status: 'disabled', analysis: null }, requestId: 'fake-ai' } });
  });
  await login(page);
  await page.goto('/messages/e2e-inbox-message?folder=inbox', { waitUntil: 'domcontentloaded' });
  const panel = page.getByRole('region', { name: title });
  await panel.getByRole('button', { name: title, exact: true }).first().click();
  await expect(panel.getByText('AI 默认关闭', { exact: false })).toBeVisible();
  await expect(panel.getByRole('button', { name: '同意并生成分析' })).toHaveCount(0);
  expect(posts).toBe(0);
  await assertNoHorizontalOverflow(page); await assertNoConsoleErrors(consoleErrors);
});
