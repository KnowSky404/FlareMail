import { LatestRequest } from './latest-request';

export type CursorPage = { nextCursor: string | null; hasMore: boolean };

/** Session-local pages. A failed request never commits a new position. */
export class CursorPager<T extends CursorPage> {
  private readonly request = new LatestRequest();
  private readonly pages = new Map<number, { value: T; updatedAt: number }>();
  private readonly cursors = new Map<number, string | null>([[1, null]]);
  private active: T | null = null;
  private index = 1;
  private pending = false;
  private loadingPaging = false;
  private flight: { index: number; promise: Promise<boolean> } | null = null;

  constructor(
    private readonly fetcher: (cursor: string | null, signal: AbortSignal) => Promise<T>,
    private readonly callbacks: {
      onResult: (page: T, pageNumber: number) => void;
      onLoading: (loading: boolean, paging: boolean) => void;
      onError: (message: string) => void;
      onRefreshing?: (refreshing: boolean) => void;
    },
    private readonly now: () => number = Date.now
  ) {}

  get firstPage() { return this.pages.get(1)?.value ?? null; }
  get pageNumber() { return this.index; }
  get isPending() { return this.pending; }

  seed(page: T) { this.reset(); this.remember(1, page); this.active = page; this.index = 1; }

  load(index = 1, force = false, resetChain = false): Promise<boolean> {
    if (this.flight?.index === index && !force) return this.flight.promise;
    if (!this.cursors.has(index)) return Promise.resolve(false);
    const previousIndex = this.index;
    this.cancel();
    const cursor = this.cursors.get(index)!;
    const cached = this.pages.get(index);
    if (cached && !force) {
      this.publish(cached.value, index);
      if (this.now() - cached.updatedAt < 30_000) return Promise.resolve(true);
    }
    const request = this.request.begin();
    const paging = index !== this.index || index > 1;
    this.pending = true;
    this.loadingPaging = paging;
    this.callbacks.onLoading(!this.active || paging, paging);
    this.callbacks.onRefreshing?.(Boolean(this.active) && !paging);
    const promise = (async () => {
      try {
        const page = await this.fetcher(cursor, request.signal);
        if (!request.isCurrent()) return false;
        if (resetChain) { this.pages.clear(); this.cursors.clear(); this.cursors.set(1, null); }
        // A changed boundary invalidates every subsequent page.
        if (this.pages.get(index)?.value.nextCursor !== page.nextCursor) {
          for (const key of this.pages.keys()) if (key > index) this.pages.delete(key);
          for (const key of this.cursors.keys()) if (key > index) this.cursors.delete(key);
        }
        this.remember(index, page);
        this.publish(page, index);
        return true;
      } catch (error) {
        if (request.isCurrent()) this.callbacks.onError(error instanceof Error ? error.message : 'Unable to load page.');
        // The cached page was already accepted; revalidation errors must not
        // prevent its selection reset and scroll restoration.
        return Boolean(request.isCurrent() && cached && !force && index !== previousIndex);
      } finally {
        if (request.isCurrent()) {
          this.flight = null;
          this.pending = false;
          this.callbacks.onLoading(false, paging);
          this.callbacks.onRefreshing?.(false);
        }
      }
    })();
    this.flight = { index, promise };
    return promise;
  }

  next() {
    if (this.pending || !this.active?.hasMore || !this.active.nextCursor) return Promise.resolve(false);
    this.cursors.set(this.index + 1, this.active.nextCursor);
    return this.load(this.index + 1);
  }
  previous() { return this.pending || this.index <= 1 ? Promise.resolve(false) : this.load(this.index - 1); }
  refresh() { return this.load(1, true, true); }

  invalidate() {
    this.cancel();
    for (const page of this.pages.values()) page.updatedAt = Number.NEGATIVE_INFINITY;
  }
  patch(transform: (page: T) => T) {
    this.invalidate();
    for (const entry of this.pages.values()) entry.value = transform(entry.value);
    if (this.active) this.active = transform(this.active);
  }
  cancel() {
    this.request.cancel();
    this.flight = null;
    if (this.pending) { this.pending = false; this.callbacks.onLoading(false, this.loadingPaging); }
    this.callbacks.onRefreshing?.(false);
  }
  reset() { this.cancel(); this.pages.clear(); this.cursors.clear(); this.cursors.set(1, null); this.active = null; this.index = 1; }

  private remember(index: number, value: T) {
    this.pages.delete(index);
    this.pages.set(index, { value, updatedAt: this.now() });
    while (this.pages.size > 16) this.pages.delete(this.pages.keys().next().value!);
  }
  private publish(value: T, index: number) { this.active = value; this.index = index; this.callbacks.onResult(value, index); }
}
