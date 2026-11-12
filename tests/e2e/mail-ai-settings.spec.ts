import AxeBuilder from '@axe-core/playwright';
import { mkdir } from 'node:fs/promises';
import { test, expect, login, assertNoHorizontalOverflow, assertNoConsoleErrors } from './fixtures';
import type { MailAiSettingsView } from '../../src/lib/domain/mail/ai';

test('AI settings accessible Owner form saves both API formats, keeps secrets blank and persists configuration', async ({ page, consoleErrors }, info) => {
  let state: MailAiSettingsView = { settings: { enabled: false, baseUrl: '', model: '', apiFormat: 'chat-completions', timeoutMs: 15000, maxInputChars: 16000, summaryLanguage: 'auto', backgroundLanguage: 'zh-CN' }, hasApiKey: false, canSave: true, revision: '', source: 'server' };
  let saves = 0;
  let analysisCalls = 0;
  await page.route('**/api/workspace/messages/*/ai*', async (route) => { analysisCalls++; await route.abort(); });
  await page.route('**/api/workspace/ai/settings', async (route) => {
    if (route.request().method() === 'PATCH') {
      const body = route.request().postDataJSON();
      expect(body.revision).toBe(state.revision);
      expect(body.backgroundLanguage).toBe('zh-CN');
      expect(body.summaryLanguage).toBe('zh-TW');
      if (saves === 0) expect(body.apiKey).toBe('synthetic-provider-key');
      else expect(body.apiKey).toBeUndefined();
      saves++;
      state = { settings: { enabled: body.enabled, baseUrl: body.baseUrl, model: body.model, apiFormat: body.apiFormat, timeoutMs: body.timeoutMs, maxInputChars: body.maxInputChars, summaryLanguage: body.summaryLanguage, backgroundLanguage: body.backgroundLanguage }, hasApiKey: body.clearApiKey ? false : Boolean(body.apiKey) || state.hasApiKey, canSave: true, revision: String(saves), source: 'workspace' };
    }
    await route.fulfill({ json: { ok: true, data: state, requestId: 'ai-settings-fixture' } });
  });
  await login(page);
  await page.goto('/?folder=settings&tab=ai', { waitUntil: 'domcontentloaded' });
  const tab = page.getByRole('tab', { name: 'AI 设置', exact: true });
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  const panel = page.getByRole('tabpanel', { name: 'AI 设置', exact: true });
  await expect(panel.getByRole('combobox', { name: '摘要语言', exact: true })).toHaveValue('auto');
  await panel.getByRole('combobox', { name: '摘要语言', exact: true }).selectOption('custom');
  await panel.getByRole('button', { name: '保存', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('请输入有效的语言代码');
  expect(saves).toBe(0);
  await panel.getByRole('textbox', { name: /^语言代码/u }).fill('zh-tw');
  await panel.getByLabel('API 基础地址').fill('https://vendor.com/v1');
  await panel.getByLabel('模型名称').fill('fixture-model');
  await panel.getByRole('combobox', { name: '接口格式', exact: true }).selectOption('responses');
  await panel.getByLabel(/^API Key/u).fill('synthetic-provider-key');
  await panel.getByRole('switch', { name: '启用 AI 邮件辅助', exact: true }).click();
  await panel.getByRole('button', { name: '保存', exact: true }).click();
  await expect(panel.getByRole('status')).toContainText('已保存');
  await expect(panel.getByLabel(/^API Key/u)).toHaveValue('');
  await expect(panel.getByText('已配置 Key', { exact: false })).toBeVisible();
  expect(saves).toBe(1); expect(analysisCalls).toBe(0);
  await expect(panel.getByRole('textbox', { name: /^语言代码/u })).toHaveValue('zh-TW');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(panel.getByLabel('模型名称')).toHaveValue('fixture-model');
  await expect(panel.getByRole('combobox', { name: '接口格式', exact: true })).toHaveValue('responses');
  await expect(panel.getByRole('combobox', { name: '摘要语言', exact: true })).toHaveValue('custom');
  await expect(panel.getByRole('textbox', { name: /^语言代码/u })).toHaveValue('zh-TW');
  await expect(panel.getByText('当前后台语言：zh-CN', { exact: false })).toBeVisible();
  await expect(panel.getByLabel(/^API Key/u)).toHaveValue('');
  await panel.getByRole('combobox', { name: '接口格式', exact: true }).selectOption('chat-completions');
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
    await route.fulfill({ json: { ok: true, data: { settings: { enabled: false, baseUrl: '', model: '', apiFormat: 'chat-completions', timeoutMs: 15000, maxInputChars: 16000, summaryLanguage: 'auto', backgroundLanguage: 'zh-CN' }, hasApiKey: false, canSave: false, revision: '', source: 'server' }, requestId: 'ai-settings-fixture' } });
  });
  await login(page); await page.goto('/?folder=settings&tab=ai', { waitUntil: 'domcontentloaded' });
  const panel = page.getByRole('tabpanel', { name: 'AI 设置', exact: true });
  await expect(panel.getByText('配置保存暂不可用', { exact: false })).toBeVisible();
  await expect(panel.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
  await expect(panel.getByLabel(/^API Key/u)).toBeDisabled(); expect(writes).toBe(0);
  await assertNoConsoleErrors(consoleErrors);
});

test('Telegram AI summaries accessible consent is independent of short summaries and privacy mode', async ({ page, consoleErrors }, info) => {
  const binding = {
    state: 'active', enabled: true, privacyMode: false, summaryEnabled: false, aiSummaryEnabled: false,
    telegramUsername: 'synthetic_user', telegramDisplayName: 'Synthetic user', candidateExpiresAt: null,
    boundAt: '2026-11-12T00:00:00Z', confirmedAt: '2026-11-12T00:00:00Z', lastSentAt: null, lastErrorCode: null, lastErrorAt: null
  };
  let modelCalls = 0;
  let writes = 0;
  await page.route('**/api/workspace/messages/*/ai*', async (route) => { modelCalls++; await route.abort(); });
  await page.route('**/api/workspace/notifications/telegram/**', async (route) => {
    if (new URL(route.request().url()).pathname.endsWith('/deliveries')) {
      await route.fulfill({ json: { ok: true, data: { deliveries: [], hasMore: false, nextCursor: null } } }); return;
    }
    if (route.request().method() === 'PATCH') {
      writes++;
      Object.assign(binding, route.request().postDataJSON());
      await route.fulfill({ json: { ok: true, data: { settings: binding } } }); return;
    }
    await route.fulfill({ json: { ok: true, data: {
      globalEnabled: true, configReady: true, schemaReady: true, botUsername: 'synthetic_bot', timezone: 'UTC',
      userBound: true, userEnabled: binding.enabled, binding, recentDeliveries: []
    } } });
  });
  await login(page); await page.goto('/?folder=settings&tab=telegram', { waitUntil: 'domcontentloaded' });
  const panel = page.getByRole('tabpanel', { name: 'Telegram 通知', exact: true });
  const ai = panel.getByRole('switch', { name: '自动生成 AI 摘要', exact: true });
  const summary = panel.getByRole('switch', { name: '包含短摘要', exact: true });
  const privacy = panel.getByRole('switch', { name: '隐私模式', exact: true });
  await expect(ai).toBeDisabled(); await expect(ai).toHaveAttribute('aria-checked', 'false');
  await summary.click();
  await expect(ai).toBeEnabled(); await expect(ai).toHaveAttribute('aria-checked', 'false');
  await ai.focus(); await page.keyboard.press('Space');
  await expect(ai).toHaveAttribute('aria-checked', 'true');
  await expect(panel.getByText('开启即同意', { exact: false })).toBeVisible();
  await privacy.click();
  await expect(ai).toBeDisabled(); await expect(ai).toHaveAttribute('aria-checked', 'true');
  await privacy.click(); await expect(ai).toBeEnabled();
  await summary.click(); await expect(ai).toBeDisabled(); await expect(ai).toHaveAttribute('aria-checked', 'true');
  await summary.click(); await expect(ai).toBeEnabled();
  await ai.click(); await expect(ai).toHaveAttribute('aria-checked', 'false');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(ai).toHaveAttribute('aria-checked', 'false');
  expect(writes).toBe(7); expect(modelCalls).toBe(0);
  await assertNoHorizontalOverflow(page);
  expect((await new AxeBuilder({ page }).include('#settings-panel-telegram').analyze()).violations).toEqual([]);
  await mkdir('/tmp/flaremail-ai-settings-evidence', { recursive: true });
  await page.screenshot({ path: `/tmp/flaremail-ai-settings-evidence/${info.project.name}-telegram.png` });
  await assertNoConsoleErrors(consoleErrors);
});

test('AI settings persist the effective interface language for background follow mode', async ({ page, consoleErrors }) => {
  let backgroundLanguage = 'zh-CN';
  let saves = 0;
  await page.route('**/api/workspace/ai/settings', async (route) => {
    if (route.request().method() === 'PATCH') {
      const body = route.request().postDataJSON();
      expect(body.summaryLanguage).toBe('auto');
      expect(body.backgroundLanguage).toBe('en');
      backgroundLanguage = body.backgroundLanguage; saves++;
    }
    await route.fulfill({ json: { ok: true, data: {
      settings: { enabled: false, baseUrl: '', model: '', apiFormat: 'chat-completions', timeoutMs: 15000, maxInputChars: 16000, summaryLanguage: 'auto', backgroundLanguage },
      hasApiKey: false, canSave: true, revision: String(saves), source: 'workspace'
    } } });
  });
  await login(page); await page.goto('/?folder=settings&tab=ai', { waitUntil: 'domcontentloaded' });
  const preferences = page.getByRole('button', { name: '显示偏好', exact: true });
  const mobileNavigation = page.getByRole('button', { name: '打开导航', exact: true });
  await expect(preferences.or(mobileNavigation)).toBeVisible();
  if (await preferences.isVisible()) {
    await preferences.click();
    await page.getByRole('dialog').getByRole('radiogroup', { name: '切换语言' }).getByRole('radio', { name: 'English', exact: true }).click();
  } else {
    await mobileNavigation.click();
    await page.getByRole('navigation', { name: '移动端导航' }).getByRole('combobox', { name: '切换语言', exact: true }).selectOption('en');
  }
  await page.keyboard.press('Escape');
  const panel = page.getByRole('tabpanel', { name: 'AI settings', exact: true });
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(panel.getByRole('status')).toContainText('Saved');
  await expect(panel.getByText('current background language: en', { exact: false })).toBeVisible();
  expect(saves).toBe(1);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(panel.getByRole('combobox', { name: 'Summary language', exact: true })).toHaveValue('auto');
  await expect(panel.getByText('current background language: en', { exact: false })).toBeVisible();
  await assertNoConsoleErrors(consoleErrors);
});
