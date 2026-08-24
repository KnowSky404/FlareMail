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

  test('bounds values with LRU eviction and supports explicit invalidation', async () => {
    let current: Record<string, string> = {};
    const controller = new DetailCacheController<string>('fallback', (snapshot) => {
      current = snapshot.values;
    }, { capacity: 2, ttlMs: 1_000 });
    let calls = 0;
    const load = (id: string) => controller.load(id, async () => { calls += 1; return id; });

    await load('one');
    await load('two');
    await load('one');
    await load('three');
    expect(current).toEqual({ one: 'one', three: 'three' });
    await load('two');
    expect(calls).toBe(4);
    controller.invalidate('two');
    expect(current.two).toBeUndefined();
  });

  test('expires cached values by TTL and does not publish stale request results', async () => {
    let now = 100;
    let current: Record<string, string> = {};
    const controller = new DetailCacheController<string>('fallback', (snapshot) => {
      current = snapshot.values;
    }, { ttlMs: 10, now: () => now });
    let calls = 0;
    await controller.load('one', async () => `value-${++calls}`);
    now = 109;
    await controller.load('one', async () => `value-${++calls}`);
    expect(calls).toBe(1);
    now = 110;
    await controller.load('one', async () => `value-${++calls}`);
    expect(calls).toBe(2);
    expect(current.one).toBe('value-2');

    let release!: (value: string) => void;
    const stale = controller.load('stale', () => new Promise<string>((resolve) => (release = resolve)));
    const fresh = controller.load('fresh', async () => 'fresh-value');
    release('stale-value');
    expect(await stale).toBe(false);
    expect(await fresh).toBe(true);
    expect(current.stale).toBeUndefined();
    expect(current.fresh).toBe('fresh-value');
  });
});
