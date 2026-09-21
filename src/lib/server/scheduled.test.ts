import { describe, expect, test } from 'bun:test';
import type { CloudflareEnv } from '$lib/server/cloudflare';
import { scheduleMaintenance } from './scheduled';

describe('Worker scheduled maintenance task isolation', () => {
  test('runs mail checks when Telegram fails and captures each task separately', async () => {
    const waiters: Promise<unknown>[] = [];
    const failures: string[] = [];
    let telegramCalls = 0;
    let healthCalls = 0;
    scheduleMaintenance({} as CloudflareEnv, { waitUntil: (promise) => waiters.push(promise) }, {
      dispatchTelegram: async () => { telegramCalls += 1; throw new Error('provider details must not escape'); },
      refreshMailHealth: async () => { healthCalls += 1; return { checked: 1 }; },
      onFailure: (task) => failures.push(task)
    });

    await Promise.all(waiters);
    expect(telegramCalls).toBe(1);
    expect(healthCalls).toBe(1);
    expect(failures).toEqual(['telegram_outbox']);
  });

  test('runs Telegram when the mail health task fails', async () => {
    const waiters: Promise<unknown>[] = [];
    const failures: string[] = [];
    let telegramCalls = 0;
    scheduleMaintenance({} as CloudflareEnv, { waitUntil: (promise) => waiters.push(promise) }, {
      dispatchTelegram: async () => { telegramCalls += 1; return undefined; },
      refreshMailHealth: async () => { throw new Error('provider details must not escape'); },
      onFailure: (task) => failures.push(task)
    });

    await Promise.all(waiters);
    expect(telegramCalls).toBe(1);
    expect(failures).toEqual(['mail_domain_health']);
  });
});
