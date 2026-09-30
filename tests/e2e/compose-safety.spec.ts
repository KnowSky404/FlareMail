import { assertNoConsoleErrors, expect, login, test } from './fixtures';

// Each project shares its local database across spec files. Do not change the
// seeded counts expected by the general workspace suite that runs afterwards.
test.afterEach(async ({ page }) => {
  await page.goto('about:blank');
  for (const folder of ['drafts', 'sent']) {
    const response = await page.request.get(`/api/workspace/mailbox?folder=${folder}&q=E2E%20Compose%20Safety&limit=100`);
    if (!response.ok()) continue;
    const messages = (await response.json()).data.page.messages as Array<{ id: string; subject: string }>;
    for (const message of messages.filter((entry) => entry.subject.startsWith('E2E Compose Safety'))) {
      const deleted = await page.request.delete(`/api/workspace/messages/${encodeURIComponent(message.id)}`);
      expect(deleted.ok()).toBe(true);
    }
  }
});

test('keeps send shortcuts separate from recipient suggestions and IME input', async ({ page, consoleErrors }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Desktop keyboard handling covers both Control and Command shortcuts.');
  await login(page);
  await page.getByRole('button', { name: '写邮件', exact: true }).first().click();
  const compose = page.getByRole('dialog', { name: '新邮件' });
  const recipient = compose.getByLabel('收件人');
  const body = compose.getByRole('textbox', { name: '正文', exact: true });
  await compose.getByRole('textbox', { name: '主题', exact: true }).fill('E2E Compose Safety shortcut');
  await body.fill('Only send to the address explicitly entered by the user.');
  await recipient.fill('html-sen');
  const suggestion = compose.getByRole('option', { name: /html-sender@flaremail\.test/u });
  await expect(suggestion).toBeVisible();

  const sentPayloads: Array<{ to: Array<{ email: string }> }> = [];
  let releaseSend!: () => void;
  const sendGate = new Promise<void>((resolve) => (releaseSend = resolve));
  await page.route('**/api/send', async (route) => {
    sentPayloads.push(route.request().postDataJSON());
    await sendGate;
    await route.continue();
  });
  try {
    for (const shortcut of ['Control+Enter', 'Meta+Enter']) {
      await recipient.press(shortcut);
      await expect(recipient).toHaveValue('html-sen');
      await expect(suggestion).toBeVisible();
      await expect(compose.getByRole('button', { name: '移除收件人 html-sender@flaremail.test' })).toHaveCount(0);
      expect(sentPayloads).toHaveLength(0);
    }
    // Confirming an IME candidate must neither commit a recipient nor send.
    await recipient.dispatchEvent('keydown', { key: 'Enter', isComposing: true });
    await expect(recipient).toHaveValue('html-sen');
    await expect(suggestion).toBeVisible();

    await recipient.fill('shortcut-recipient@flaremail.test');
    await body.focus();
    const sendButton = compose.getByRole('button', { name: '发送邮件', exact: true });
    await expect(sendButton).toBeEnabled();
    await body.dispatchEvent('keydown', { key: 'Enter', ctrlKey: true, isComposing: true });
    await body.dispatchEvent('keydown', { key: 'Enter', ctrlKey: true, repeat: true });
    expect(sentPayloads).toHaveLength(0);
    await body.evaluate((element) => {
      // Same-tick clicks/shortcuts exercise the local guard before props update.
      element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }));
      element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
    });
    await expect.poll(() => sentPayloads.length).toBe(1);
    await expect(sendButton).toBeDisabled();
    expect(sentPayloads[0].to.map((address) => address.email)).toEqual(['shortcut-recipient@flaremail.test']);
  } finally {
    releaseSend();
  }
  await expect(compose).toBeHidden();
  expect(sentPayloads).toHaveLength(1);
  await assertNoConsoleErrors(consoleErrors);
});

test('preserves newer draft edits while preparing an attachment', async ({ page, consoleErrors }) => {
  await login(page);
  await page.getByRole('button', { name: '写邮件', exact: true }).first().click();
  const compose = page.getByRole('dialog', { name: '新邮件' });
  const subject = compose.getByRole('textbox', { name: '主题', exact: true });
  const body = compose.getByRole('textbox', { name: '正文', exact: true });
  await compose.getByLabel('收件人').fill('attachment-race@flaremail.test');
  await subject.fill('E2E Compose Safety preparation old subject');
  await body.fill('Body before attachment preparation');
  await expect(compose.getByRole('status').filter({ hasText: '已自动保存于' })).toBeVisible();

  let releasePrepare!: () => void;
  const prepareGate = new Promise<void>((resolve) => (releasePrepare = resolve));
  let intercepted = 0;
  await page.route('**/api/workspace/drafts', async (route) => {
    if (route.request().method() === 'POST' && intercepted++ === 0) await prepareGate;
    await route.continue();
  });
  try {
    await compose.getByLabel('选择附件').setInputFiles({
      name: 'race-safe.txt', mimeType: 'text/plain', buffer: Buffer.from('Attachment preparation race fixture')
    });
    await expect.poll(() => intercepted).toBe(1);
    await subject.fill('E2E Compose Safety preparation latest subject');
    await body.fill('Latest body typed while preparing the attachment');
    await compose.getByLabel('收件人').fill('added-during-prepare@flaremail.test');
    await compose.getByLabel('收件人').press('Enter');
  } finally {
    releasePrepare();
  }
  await expect(compose.getByLabel('附件名称 race-safe.txt')).toBeVisible({ timeout: 15_000 });
  await expect(subject).toHaveValue('E2E Compose Safety preparation latest subject');
  await expect(body).toHaveValue('Latest body typed while preparing the attachment');
  await expect(compose.getByRole('button', { name: '移除收件人 added-during-prepare@flaremail.test' })).toBeVisible();
  await expect(compose.getByRole('status').filter({ hasText: '已自动保存于' })).toBeVisible();
  await page.unroute('**/api/workspace/drafts');

  const response = await page.request.get('/api/workspace/mailbox?folder=drafts&q=E2E%20Compose%20Safety%20preparation%20latest%20subject&limit=10');
  expect(response.ok()).toBe(true);
  const payload = await response.json();
  const draft = payload.data.page.messages.find((message: { subject: string }) => message.subject === 'E2E Compose Safety preparation latest subject');
  expect(draft?.id).toBeTruthy();
  const savedResponse = await page.request.get(`/api/workspace/drafts/${encodeURIComponent(draft.id)}`);
  expect(savedResponse.ok()).toBe(true);
  const saved = (await savedResponse.json()).data;
  expect(saved.message.body).toBe('Latest body typed while preparing the attachment');
  expect(saved.message.toAddresses.map((address: { email: string }) => address.email)).toEqual([
    'attachment-race@flaremail.test', 'added-during-prepare@flaremail.test'
  ]);
  expect(saved.attachments.map((attachment: { filename: string }) => attachment.filename)).toEqual(['race-safe.txt']);
  await assertNoConsoleErrors(consoleErrors);
});

test('blocks compose exits during upload and restores saving when it completes', async ({ page, consoleErrors }) => {
  await login(page);
  await page.getByRole('button', { name: '写邮件', exact: true }).first().click();
  const compose = page.getByRole('dialog', { name: '新邮件' });
  const body = compose.getByRole('textbox', { name: '正文', exact: true });
  await compose.getByRole('textbox', { name: '主题', exact: true }).fill('E2E Compose Safety upload exit');
  await body.fill('Keep the editor until its upload settles.');
  let releaseUpload!: () => void;
  const uploadGate = new Promise<void>((resolve) => (releaseUpload = resolve));
  let intercepted = 0;
  await page.route('**/api/workspace/drafts/*/attachments/*', async (route) => {
    if (route.request().method() === 'PUT') { intercepted += 1; await uploadGate; }
    await route.continue();
  });
  try {
    await compose.getByLabel('选择附件').setInputFiles({ name: 'wait-for-upload.txt', mimeType: 'text/plain', buffer: Buffer.from('Upload exit fixture') });
    await expect.poll(() => intercepted).toBe(1);
    await expect(compose.getByRole('button', { name: '保存草稿', exact: true })).toBeDisabled();
    await expect(compose.getByRole('button', { name: '取消', exact: true })).toBeDisabled();
    await expect(compose.getByRole('button', { name: '关闭', exact: true })).toBeDisabled();
    await body.focus();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect(compose).toBeVisible();
    await expect(page.getByRole('dialog', { name: '未保存的改动' })).toHaveCount(0);
    await body.fill('An edit made during the upload must also survive.');
  } finally {
    releaseUpload();
  }
  await expect(compose.getByLabel('附件名称 wait-for-upload.txt')).toBeVisible();
  await expect(compose.getByRole('button', { name: '保存草稿', exact: true })).toBeEnabled();
  await expect(body).toHaveValue('An edit made during the upload must also survive.');
  await compose.getByRole('button', { name: '保存草稿', exact: true }).click();
  await expect(compose).toBeHidden();
  await assertNoConsoleErrors(consoleErrors);
});

test('cancels during attachment preparation without resuming a ghost upload', async ({ page, consoleErrors }) => {
  await login(page);
  await page.getByRole('button', { name: '写邮件', exact: true }).first().click();
  const compose = page.getByRole('dialog', { name: '新邮件' });
  let releasePrepare!: () => void;
  const prepareGate = new Promise<void>((resolve) => (releasePrepare = resolve));
  let intercepted = 0;
  let uploadRequests = 0;
  page.on('request', (request) => { if (request.method() === 'PUT' && request.url().includes('/attachments/')) uploadRequests += 1; });
  await page.route('**/api/workspace/drafts', async (route) => {
    if (route.request().method() === 'POST' && intercepted++ === 0) await prepareGate;
    await route.continue();
  });
  await compose.getByRole('textbox', { name: '主题', exact: true }).fill('E2E Compose Safety cancelled preparation');
  await compose.getByRole('textbox', { name: '正文', exact: true }).fill('Cancel the file, preserve the draft.');
  try {
    await compose.getByLabel('选择附件').setInputFiles({ name: 'cancel-before-upload.txt', mimeType: 'text/plain', buffer: Buffer.from('Never upload this file') });
    await expect.poll(() => intercepted).toBe(1);
    await compose.getByRole('button', { name: '取消上传 cancel-before-upload.txt' }).click();
    await expect(compose.getByRole('button', { name: '取消上传 cancel-before-upload.txt' })).toBeDisabled();
    await expect(compose.getByRole('button', { name: '关闭', exact: true })).toBeDisabled();
    await expect(compose.getByRole('button', { name: '保存草稿', exact: true })).toBeDisabled();
  } finally {
    releasePrepare();
  }
  await expect(compose.getByRole('list', { name: '附件上传状态' })).toHaveCount(0);
  await expect(compose.getByRole('button', { name: '关闭', exact: true })).toBeEnabled();
  await expect(compose.getByRole('button', { name: '保存草稿', exact: true })).toBeEnabled();
  await expect(compose.getByRole('textbox', { name: '正文', exact: true })).toHaveValue('Cancel the file, preserve the draft.');
  await compose.getByRole('button', { name: '保存草稿', exact: true }).click();
  await expect(compose).toBeHidden();
  expect(uploadRequests).toBe(0);
  await assertNoConsoleErrors(consoleErrors);
});
