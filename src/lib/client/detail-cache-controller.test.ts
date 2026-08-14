import { describe, expect, test } from 'bun:test';
import { DetailCacheController } from './detail-cache-controller';

describe('DetailCacheController', () => {
  test('caches successful details and exposes loading errors', async () => {
    const snapshots: Array<{ pendingId: string | null; value?: string; error?: string }> = [];
    const controller = new DetailCacheController<string>('fallback', (snapshot) => {
      snapshots.push({ pendingId: snapshot.pendingId, value: snapshot.values.one, error: snapshot.errors.one });
    });
    let calls = 0;
    expect(await controller.load('one', async () => { calls += 1; return 'detail'; })).toBe(true);
    expect(await controller.load('one', async () => { calls += 1; return 'other'; })).toBe(true);
    expect(calls).toBe(1);
    expect(snapshots.at(-1)).toEqual({ pendingId: null, value: 'detail', error: '' });
    expect(await controller.load('one', async () => { throw new Error('failed'); }, true)).toBe(false);
    expect(snapshots.at(-1)?.error).toBe('failed');
  });
});
