import AxeBuilder from '@axe-core/playwright';
import { mkdir } from 'node:fs/promises';
import { test, expect, login, assertNoHorizontalOverflow, assertNoConsoleErrors } from './fixtures';
import type { MailAiSettingsView } from '../../src/lib/domain/mail/ai';

test('AI settings accessible Owner form saves both API formats, keeps secrets blank and persists configuration', async ({ page, consoleErrors }, info) => {
  let state: MailAiSettingsView = { settings: { enabled: false, baseUrl: '', model: '', apiFormat: 'chat-completions', timeoutMs: 15000, maxInputChars: 16000 }, hasApiKey: false, canSave: true, revision: '', source: 'server' };
  let saves = 0;
  let analysisCalls = 0;
  await page.route('**/api/workspace/messages/*/ai*', async (route) => { analysisCalls++; await route.abort(); });
  await page.route('**/api/workspace/ai/settings', async (route) => {
    if (route.request().method() === 'PATCH') {
      const body = route.request().postDataJSON();
      expect(body.revision).toBe(state.revision);
      if (saves === 0) expect(body.apiKey).toBe('synthetic-provider-key');
      else expect(body.apiKey).toBeUndefined();
      saves++;
      state = { settings: { enabled: body.enabled, baseUrl: body.baseUrl, model: body.model, apiFormat: body.apiFormat, timeoutMs: body.timeoutMs, maxInputChars: body.maxInputChars }, hasApiKey: body.clearApiKey ? false : Boolean(body.apiKey) || state.hasApiKey, canSave: true, revision: String(saves), source: 'workspace' };
    }
    await route.fulfill({ json: { ok: true, data: state, requestId: 'ai-settings-fixture' } });
  });
  await login(page);
  await page.goto('/?folder=settings&tab=ai', { waitUntil: 'domcontentloaded' });
  const tab = page.getByRole('tab', { name: 'AI 设置', exact: true });
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  const panel = page.getByRole('tabpanel', { name: 'AI 设置', exact: true });
  await panel.getByLabel('API 基础地址').fill('https://vendor.com/v1');
  await panel.getByLabel('模型名称').fill('fixture-model');
  await panel.getByLabel('接口格式').selectOption('responses');
  await panel.getByLabel(/^API Key/u).fill('synthetic-provider-key');
  await panel.getByRole('switch', { name: '启用 AI 邮件辅助', exact: true }).click();
  await panel.getByRole('button', { name: '保存', exact: true }).click();
  await expect(panel.getByRole('status')).toContainText('已保存');
  await expect(panel.getByLabel(/^API Key/u)).toHaveValue('');
  await expect(panel.getByText('已配置 Key', { exact: false })).toBeVisible();
  expect(saves).toBe(1); expect(analysisCalls).toBe(0);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(panel.getByLabel('模型名称')).toHaveValue('fixture-model');
  await expect(panel.getByLabel('接口格式')).toHaveValue('responses');
  await expect(panel.getByLabel(/^API Key/u)).toHaveValue('');
  await panel.getByLabel('接口格式').selectOption('chat-completions');
  await panel.getByRole('button', { name: '保存', exact: true }).click();
  await expect(panel.getByRole('status')).toContainText('已保存'); expect(saves).toBe(2);
  await page.emulateMedia({ colorScheme: 'dark' });
  await assertNoHorizontalOverflow(page);
  expect((await new AxeBuilder({ page }).include('#settings-panel-ai').analyze()).violations).toEqual([]);
  await mkdir('/tmp/flaremail-ai-settings-evidence', { recursive: true });
  await page.screenshot({ path: `/tmp/flaremail-ai-settings-evidence/${info.project.name}.png` });
  await panel.getByRole('switch', { name: '启用 AI 邮件辅助', exact: true }).click();
  await panel.getByRole('switch', { name: '删除已保存的 API Key', exact: true }).click();
  await panel.getByRole('button', { name: '保存', exact: true }).click();
  await expect(panel.getByText('尚未配置 Key', { exact: false })).toBeVisible(); expect(saves).toBe(3); expect(analysisCalls).toBe(0);
  await tab.focus(); await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('tab', { name: '黑名单', exact: false })).toBeFocused();
  await assertNoConsoleErrors(consoleErrors);
});

test('AI settings fail closed until one-time encryption initialization', async ({ page, consoleErrors }) => {
  let writes = 0;
  await page.route('**/api/workspace/ai/settings', async (route) => {
    if (route.request().method() !== 'GET') writes++;
    await route.fulfill({ json: { ok: true, data: { settings: { enabled: false, baseUrl: '', model: '', apiFormat: 'chat-completions', timeoutMs: 15000, maxInputChars: 16000 }, hasApiKey: false, canSave: false, revision: '', source: 'server' }, requestId: 'ai-settings-fixture' } });
  });
  await login(page); await page.goto('/?folder=settings&tab=ai', { waitUntil: 'domcontentloaded' });
  const panel = page.getByRole('tabpanel', { name: 'AI 设置', exact: true });
  await expect(panel.getByText('配置保存暂不可用', { exact: false })).toBeVisible();
  await expect(panel.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
  await expect(panel.getByLabel(/^API Key/u)).toBeDisabled(); expect(writes).toBe(0);
  await assertNoConsoleErrors(consoleErrors);
});
