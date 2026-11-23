import { chromium, type Locator, type Page, type Request } from '@playwright/test';
import { E2E_PASSWORD, E2E_USERNAME, expect, login } from '../../tests/e2e/fixtures';

const perfOrigin = process.env.FLAREMAIL_PERF_ORIGIN;
if (!perfOrigin) throw new Error('Set FLAREMAIL_PERF_ORIGIN to the isolated local E2E Worker.');
const origin = new URL(perfOrigin);
if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || !origin.port) {
  throw new Error('The mailbox benchmark requires an isolated local E2E Worker.');
}
const iterations = Number(process.env.FLAREMAIL_PERF_SAMPLES ?? 12);
if (!Number.isSafeInteger(iterations) || iterations < 1) throw new Error('Invalid sample count.');

const browser = await chromium.launch();
const profiles = [
  { name: 'local', rtt: 0, download: -1, upload: -1 },
  { name: 'slow', rtt: 150, download: 1_600_000 / 8, upload: 750_000 / 8 }
];
type Target = { selector: string; text?: string };
type ActionMeasurement = {
  feedback: number;
  ready: number;
  longTasks: number;
  longTaskMs: number;
  domNodes: number;
  probeMs: number;
};
type RequestMeasurement = { operation: string; method: string; status?: number; ttfb?: number; duration?: number; bytes?: number; timing?: string };
const panel = '.mail-list-panel';
const skeleton = { selector: '[aria-label="正在加载邮件"]' };
const managementSkeleton = { selector: '[data-management-loading]' };
const row = (text: string) => ({ selector: panel + ' [role="listitem"], ' + panel + ' li', text });
const listHeading = (text: string) => ({ selector: '.fm-workspace-main h1, .fm-workspace-main h2', text });
const toast = (text: string) => ({ selector: '[role="status"]', text });
const folders = (page: Page, name: string) => page.getByRole('navigation', { name: '主导航' })
  .getByRole('button', { name: new RegExp('^' + name + '(?:\\s|$)', 'u') });
const message = (page: Page, subject: string) => page.locator(panel).getByRole('listitem')
  .filter({ hasText: subject }).getByRole('button', { name: new RegExp(subject, 'u') }).first();

function requestOperation(request: Request) {
  const url = new URL(request.url());
  if (url.origin !== origin.origin) return null;
  const path = url.pathname;
  if (path.startsWith('/_app/')) return 'asset:' + request.resourceType();
  if (!path.startsWith('/api/')) return null;
  return path.replace(/^\/api\/workspace\/messages\/[^/]+/u, '/api/workspace/messages/:id')
    .replace(/^\/api\/workspace\/mail-identities\/domains\/[^/]+/u, '/api/workspace/mail-identities/domains/:id');
}

function recordRequests(page: Page) {
  const requests = new Map<Request, Promise<RequestMeasurement>>();
  const track = (request: Request) => {
    const operation = requestOperation(request);
    if (!operation) return;
    requests.set(request, (async () => {
      const response = await request.response();
      const basic = { operation, method: request.method() };
      if (!response) return basic;
      await response.finished();
      const timing = request.timing();
      return {
        ...basic, status: response.status(), ttfb: timing.responseStart,
        duration: timing.responseEnd, bytes: (await request.sizes()).responseBodySize,
        timing: response.headers()['server-timing']
      };
    })().catch(() => ({ operation, method: request.method() })));
  };
  page.on('request', track);
  return async () => {
    page.off('request', track);
    return Promise.all(requests.values());
  };
}

async function act(page: Page, name: string, control: Locator, ready: Target, feedback: Target[], options: { input?: string; keyboard?: boolean } = {}) {
  const { input, keyboard } = options;
  const stopRecording = recordRequests(page);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  await control.evaluate((element, { ready, feedback, eventType }) => {
    const state = window as unknown as { measuredAction: Promise<ActionMeasurement> };
    const visible = (target: { selector: string; text?: string }) =>
      [...document.querySelectorAll<HTMLElement>(target.selector)].some((node) =>
        !node.closest('[hidden], [aria-hidden="true"]') && (!target.text || node.textContent?.includes(target.text))
      );
    state.measuredAction = new Promise((resolve, reject) => {
      element.addEventListener(eventType, () => {
        const start = performance.now();
        let firstFeedback: number | undefined;
        let probeMs = 0;
        let pendingFrame = 0;
        const sample = () => {
          pendingFrame = 0;
          const now = performance.now();
          const elapsed = now - start;
          const isReady = visible(ready);
          if (firstFeedback === undefined && (isReady || feedback.some(visible))) firstFeedback = elapsed;
          probeMs += performance.now() - now;
          if (isReady) {
            observer.disconnect();
            window.clearTimeout(timeout);
            requestAnimationFrame(() => {
              const end = performance.now();
              const tasks = (performance.getEntriesByName('mailbox-long-task')).filter(({ startTime, duration }) =>
                startTime + duration > start && startTime < end);
              const domNodes = document.getElementsByTagName('*').length;
              probeMs += performance.now() - end;
              resolve({ feedback: firstFeedback!, ready: elapsed, longTasks: tasks.length,
                longTaskMs: tasks.reduce((sum, task) => sum + task.duration, 0), domNodes, probeMs });
            });
          }
        };
        const scheduleSample = () => {
          if (!pendingFrame) pendingFrame = requestAnimationFrame(sample);
        };
        const observer = new MutationObserver(scheduleSample);
        const timeout = window.setTimeout(() => {
          observer.disconnect();
          cancelAnimationFrame(pendingFrame);
          reject(new Error('The expected mailbox content did not render.'));
        }, 8_000);
        observer.observe(document.documentElement, { childList: true, attributes: true, characterData: true, subtree: true });
        scheduleSample();
      }, { capture: true, once: true });
    });
  }, { ready, feedback, eventType: input === undefined ? 'click' : 'input' });
  const before = await cdp.send('Performance.getMetrics');
  if (input !== undefined) await control.fill(input);
  else if (keyboard) await control.press('Enter');
  else await control.click({ timeout: 5_000 });
  const elapsed = await page.evaluate(() => (window as unknown as { measuredAction: Promise<ActionMeasurement> }).measuredAction)
    .catch((error) => { throw new Error(`Mailbox action ${name} failed: ${error.message}`); });
  const after = await cdp.send('Performance.getMetrics');
  await cdp.detach();
  const previous = new Map(before.metrics.map(({ name, value }) => [name, value]));
  const mainThreadMs = Object.fromEntries(after.metrics
    .filter(({ name }) => ['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration'].includes(name))
    .map(({ name, value }) => {
      const probeMs = name === 'ScriptDuration' || name === 'TaskDuration' ? elapsed.probeMs : 0;
      return [name, Math.max(0, (value - (previous.get(name) ?? 0)) * 1000 - probeMs)];
    }));
  return { name, elapsed, mainThreadMs, requests: await stopRecording() };
}

async function measure(profile: typeof profiles[number]) {
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1280, height: 900 }, baseURL: origin.origin });
  await context.addInitScript(() => {
    new PerformanceObserver((entries) => {
      for (const { startTime, duration } of entries.getEntries()) {
        performance.measure('mailbox-long-task', { start: startTime, duration });
      }
    }).observe({ type: 'longtask', buffered: true });
  });
  const page = await context.newPage();
  const apiLogin = await context.request.post('/api/workspace/session', {
    data: { username: E2E_USERNAME, password: E2E_PASSWORD },
    headers: { origin: origin.origin }
  });
  expect(apiLogin.ok(), 'The local synthetic Owner must authenticate').toBe(true);
  const resetReadFlag = await context.request.patch('/api/workspace/messages/e2e-inbox-message/flags', {
    data: { read: false },
    headers: { origin: origin.origin }
  });
  expect(resetReadFlag.ok(), 'Reset the synthetic message before opening it').toBe(true);
  const network = await context.newCDPSession(page);
  await network.send('Network.enable');
  if (profile.rtt) await network.send('Network.emulateNetworkConditions', {
    offline: false, latency: profile.rtt, downloadThroughput: profile.download, uploadThroughput: profile.upload
  });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.name));
  await login(page);
  const initial = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
    const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    return {
      ttfb: nav.responseStart, responseEnd: nav.responseEnd, domContentLoaded: nav.domContentLoadedEventEnd,
      firstContentfulPaint: performance.getEntriesByName('first-contentful-paint')[0]?.startTime,
      requests: resources.length + 1, transferredBytes: nav.transferSize + resources.reduce((sum, resource) => sum + resource.transferSize, 0),
      longTasks: performance.getEntriesByName('mailbox-long-task').map(({ duration }) => duration)
    };
  });
  const actions = [];
  actions.push(await act(page, 'sent-first', folders(page, '已发送'), row('E2E Seeded Sent'), [skeleton, listHeading('已发送')]));
  actions.push(await act(page, 'drafts-first', folders(page, '草稿箱'), row('E2E Existing Concurrent'), [skeleton, listHeading('草稿箱')]));
  actions.push(await act(page, 'inbox-cached', folders(page, '收件箱'), row('E2E Inbox Welcome'), [skeleton, listHeading('收件箱')]));
  actions.push(await act(page, 'next-page', page.getByRole('button', { name: '下一页', exact: true }), row('E2E Bulk 45'), [skeleton]));
  actions.push(await act(page, 'previous-page', page.getByRole('button', { name: '上一页', exact: true }), row('E2E Inbox Welcome'), [skeleton]));
  actions.push(await act(page, 'read-first', message(page, 'E2E Inbox Welcome'),
    { selector: '[aria-label="邮件正文详情"]', text: 'This message is seeded' }, [{ selector: '[aria-label="邮件详情"]' }]));
  const back = page.getByRole('button', { name: '返回邮件列表' });
  actions.push(await act(page, 'back-to-list', back, row('E2E Inbox Welcome'), []));
  actions.push(await act(page, 'read-cached', message(page, 'E2E Inbox Welcome'),
    { selector: '[aria-label="邮件正文详情"]', text: 'This message is seeded' }, [{ selector: '[aria-label="邮件详情"]' }]));
  await back.click();
  actions.push(await act(page, 'archive-first', folders(page, '归档'), { selector: panel + ' h2, ' + panel + ' h3', text: '为空' }, [skeleton, listHeading('归档')]));
  actions.push(await act(page, 'starred-first', folders(page, '星标邮件'), { selector: panel + ' h2, ' + panel + ' h3', text: '为空' }, [skeleton, listHeading('星标邮件')]));
  await folders(page, '收件箱').click();
  const inboxRow = page.locator(panel).getByRole('listitem').filter({ hasText: 'E2E Inbox Welcome' });
  await inboxRow.hover();
  actions.push(await act(page, 'archive-message', inboxRow.getByRole('button', { name: '归档', exact: true }),
    toast('已归档所选邮件'), [
      { selector: panel + ' [role="listitem"] button[aria-label="归档"]:disabled' }
    ], { keyboard: true }));
  await expect(inboxRow).toBeHidden();
  await folders(page, '归档').click();
  await inboxRow.hover();
  actions.push(await act(page, 'unarchive-message', inboxRow.getByRole('button', { name: '移回收件箱', exact: true }),
    toast('已将所选邮件移回收件箱'), [
      { selector: panel + ' [role="listitem"] button[aria-label="移回收件箱"]:disabled' }
    ], { keyboard: true }));
  await folders(page, '收件箱').click();
  const search = page.locator('#mail-search-desktop');
  actions.push(await act(page, 'search', search, { selector: '.mail-list-panel span', text: '1 个结果' }, [skeleton], { input: 'subject:"E2E Inbox Welcome"' }));
  actions.push(await act(page, 'settings-first', folders(page, '设置'), { selector: '.settings-main [role="tabpanel"]' }, [managementSkeleton]));
  actions.push(await act(page, 'domains-first', folders(page, '域名'), { selector: 'table', text: 'flaremail.test' }, [managementSkeleton, listHeading('域名')]));
  actions.push(await act(page, 'addresses-first', folders(page, '邮箱地址'), { selector: 'table', text: 'e2e-admin@flaremail.test' }, [listHeading('邮箱地址')]));
  expect(errors).toEqual([]);
  await context.close();
  return { initial, actions };
}

try {
  const results = [];
  for (const profile of profiles) {
    for (let sample = 0; sample < iterations; sample += 1) {
      results.push({ profile: profile.name, sample: sample + 1, ...await measure(profile) });
      console.error(`Measured ${profile.name} sample ${sample + 1}/${iterations}`);
    }
  }
  console.log(JSON.stringify({ browser: browser.version(), viewport: [1280, 900], profiles, results }, null, 2));
} finally {
  await browser.close();
}
