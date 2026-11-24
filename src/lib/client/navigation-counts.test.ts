import { expect, test } from 'bun:test';
import { getMailboxMetrics, type WorkspaceMetrics } from '$lib/domain/mail';
import { describeNavigationCount, formatNavigationCount, navigationCounts } from './navigation-counts';

const metrics: WorkspaceMetrics = {
  ...getMailboxMetrics({ inbox: [], sent: [], drafts: [] }),
  inboxCount: 200, unreadCount: 3, draftsCount: 5, sentCount: 1000,
  starredCount: 80, archiveCount: 60, trashCount: 70,
  queuedCount: 3, delayedCount: 1, failedCount: 2, bouncedCount: 1, complainedCount: 1,
  staleDeliveryCount: 2
};

test('only inbox and drafts produce badges even when sent mail needs attention', () => {
  expect(navigationCounts(metrics, null, null)).toEqual({ inbox: 3, drafts: 5 });
});

test('never displays another identity scope while its metrics are loading', () => {
  const address = { kind: 'address', id: 'a' } as const;
  const unknown = { inbox: null, drafts: null };
  expect(navigationCounts(metrics, null, address)).toEqual(unknown);
  expect(navigationCounts(metrics, address, null)).toEqual(unknown);
  expect(navigationCounts(metrics, address, { kind: 'address', id: 'b' })).toEqual(unknown);
  expect(navigationCounts(metrics, address, { kind: 'domain', id: 'a' })).toEqual(unknown);
  expect(navigationCounts(metrics, address, { ...address })).toEqual({ inbox: 3, drafts: 5 });
});

test('capped visuals retain exact counts and explain unread and draft counts in both languages', () => {
  expect(formatNavigationCount('zh-CN', 99)).toBe('99');
  expect(formatNavigationCount('en', 120)).toBe('99+');
  expect(describeNavigationCount('en', 'drafts', 1)).toBe('1 message');
  expect(describeNavigationCount('en', 'inbox', 1)).toBe('1 unread');
});
