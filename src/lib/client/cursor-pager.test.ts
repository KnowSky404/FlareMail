import { describe, expect, test } from 'bun:test';
import { CursorPager } from './cursor-pager';

type Page = { ids: string[]; hasMore: boolean; nextCursor: string | null };
const first: Page = { ids: ['first'], hasMore: true, nextCursor: 'next' };
const last: Page = { ids: ['last'], hasMore: false, nextCursor: null };
const callbacks = (shown: Array<{ page: Page; index: number }>, errors: string[] = []) => ({
  onResult: (page: Page, index: number) => shown.push({ page, index }),
  onLoading: () => {}, onError: (error: string) => errors.push(error)
});

describe('cursor pagination', () => {
  test('replaces pages, reuses previous pages and blocks both end boundaries', async () => {
    const shown: Array<{ page: Page; index: number }> = [];
    const cursors: Array<string | null> = [];
    const pager = new CursorPager(async (cursor) => { cursors.push(cursor); return cursor ? last : first; }, callbacks(shown));
    expect(await pager.previous()).toBe(false);
    await pager.load(); await pager.next();
    expect(shown[1]).toEqual({ page: last, index: 2 });
    expect(await pager.next()).toBe(false);
    await pager.previous();
    expect(shown[2]).toEqual({ page: first, index: 1 });
    expect(cursors).toEqual([null, 'next']);
  });
  test('retains the current page on failure and permits an explicit retry', async () => {
    let failing = true;
    const shown: Array<{ page: Page; index: number }> = [];
    const errors: string[] = [];
    const pager = new CursorPager(async (cursor) => { if (cursor && failing) throw new Error('offline'); return cursor ? last : first; }, callbacks(shown, errors));
    await pager.load();
    expect(await pager.next()).toBe(false);
    expect(pager.pageNumber).toBe(1);
    expect(shown).toHaveLength(1);
    expect(errors).toEqual(['offline']);
    failing = false;
    expect(await pager.next()).toBe(true);
    expect(pager.pageNumber).toBe(2);
  });
  test('deduplicates pending reads and discards an uncancellable stale response', async () => {
    let resolve!: (value: Page) => void;
    const shown: Array<{ page: Page; index: number }> = [];
    let calls = 0;
    const pager = new CursorPager(() => { calls++; return new Promise<Page>((done) => { resolve = done; }); }, callbacks(shown));
    const pending = pager.load(); const duplicate = pager.load();
    pager.reset(); resolve(first);
    expect(await pending).toBe(false); expect(await duplicate).toBe(false);
    expect(calls).toBe(1); expect(shown).toHaveLength(0);
  });
  test('refresh invalidates the old successor chain and returns to the first page', async () => {
    let refreshed = false;
    const seen: Array<string | null> = [];
    const pager = new CursorPager(async (cursor) => { seen.push(cursor); return cursor ? last : { ...first, nextCursor: refreshed ? 'new-next' : 'next' }; }, callbacks([]));
    await pager.load(); await pager.next(); refreshed = true; await pager.refresh(); await pager.next();
    expect(seen).toEqual([null, 'next', null, 'new-next']);
  });
  test('accepts a cached previous page even if its stale revalidation fails', async () => {
    let now = 0;
    let failing = false;
    const shown: Array<{ page: Page; index: number }> = [];
    const errors: string[] = [];
    const pager = new CursorPager(async (cursor) => {
      if (failing) throw new Error('offline');
      return cursor ? last : first;
    }, callbacks(shown, errors), () => now);
    await pager.load();
    await pager.next();
    now = 30_001;
    failing = true;
    expect(await pager.previous()).toBe(true);
    expect(pager.pageNumber).toBe(1);
    expect(shown.at(-1)).toEqual({ page: first, index: 1 });
    expect(errors).toEqual(['offline']);
  });
});

test('seeding a new first page invalidates cached successors', async () => {
  const seen: Array<string | null> = [];
  const pager = new CursorPager(async (cursor) => { seen.push(cursor); return cursor ? last : first; }, callbacks([]));
  await pager.load(); await pager.next();
  pager.seed({ ...first, nextCursor: 'new-boundary' });
  await pager.next();
  expect(seen).toEqual([null, 'next', 'new-boundary']);
});
