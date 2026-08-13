import { describe, expect, test } from 'bun:test';
import { LatestRequest } from './latest-request';

describe('LatestRequest', () => {
  test('aborts and invalidates stale work', () => {
    const requests = new LatestRequest();
    const first = requests.begin();
    const second = requests.begin();
    expect(first.signal.aborted).toBe(true);
    expect(first.isCurrent()).toBe(false);
    expect(second.signal.aborted).toBe(false);
    expect(second.isCurrent()).toBe(true);
  });
});
