import { describe, expect, test } from 'bun:test';
import type { TrashListResult } from '$lib/domain/mail';
import { TrashController } from './trash-controller';

const emptyResult: TrashListResult = {
  items: [],
  hasMore: false,
  metrics: {
    inboxCount: 0, sentCount: 0, draftsCount: 0, trashCount: 0, unreadCount: 0, starredCount: 0,
    queuedCount: 0, delayedCount: 0, failedCount: 0, bouncedCount: 0, complainedCount: 0, staleDeliveryCount: 0
  }
};

describe('TrashController', () => {
  test('publishes the latest owned trash result and loading state', async () => {
    const loading: boolean[] = [];
    const published: { result: TrashListResult | null } = { result: null };
    const controller = new TrashController(async () => emptyResult, {
      onResult: (next) => (published.result = next),
      onLoading: (value) => loading.push(value),
      onError: () => undefined
    });

    expect(await controller.load()).toBe(true);
    expect(published.result).toBe(emptyResult);
    expect(loading).toEqual([true, false]);
  });

  test('cancels stale loads without publishing errors', async () => {
    const errors: string[] = [];
    const controller = new TrashController(
      (signal) => new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      }),
      { onResult: () => undefined, onLoading: () => undefined, onError: (message) => errors.push(message) }
    );
    const pending = controller.load();
    controller.cancel();
    expect(await pending).toBe(false);
    expect(errors).toEqual([]);
  });
});
