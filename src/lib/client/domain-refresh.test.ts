import { expect, test } from 'bun:test';
import { domainCheckNeedsAttention, refreshDomains } from './domain-refresh';

test('refreshes the full collection with at most two in flight and retains partial failures', async () => {
  let running = 0;
  let peak = 0;
  const results: Array<[string, string]> = [];
  await refreshDomains(['a', 'b', 'c', 'd'], async (id) => {
    peak = Math.max(peak, ++running);
    await new Promise((resolve) => setTimeout(resolve, 1));
    running--;
    if (id === 'b') throw new Error('failure');
    return id;
  }, (id, result) => results.push([id, result.status]), () => true);
  expect(peak).toBe(2);
  expect(results).toHaveLength(4);
  expect(results).toContainEqual(['b', 'rejected']);
  expect(results).toContainEqual(['d', 'fulfilled']);
});

test('stops queued work and discards late results after the session ends', async () => {
  let active = true;
  let calls = 0;
  let results = 0;
  await refreshDomains(['a', 'b', 'c'], async () => {
    calls++;
    active = false;
  }, () => results++, () => active);
  expect(calls).toBe(1);
  expect(results).toBe(0);
});

test('classifies provider errors in successful HTTP responses and accepts absent Resend configuration', () => {
  expect(domainCheckNeedsAttention({ cloudflare: { state: 'ready' }, resend: { state: 'not_configured' } })).toBe(false);
  expect(domainCheckNeedsAttention({ cloudflare: { state: 'ready', errorCode: 'route_drift' }, resend: { state: 'verified' } })).toBe(true);
  expect(domainCheckNeedsAttention({ cloudflare: { state: 'ready' }, resend: { state: 'pending' } })).toBe(true);
});
