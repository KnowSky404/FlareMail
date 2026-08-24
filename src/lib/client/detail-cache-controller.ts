import { LatestRequest } from './latest-request';

export type DetailCacheSnapshot<T> = {
  values: Record<string, T>;
  errors: Record<string, string>;
  pendingId: string | null;
};

export type DetailCacheOptions = {
  capacity?: number;
  ttlMs?: number;
  now?: () => number;
};

type CacheEntry = { expiresAt: number; lastAccess: number };

const hasOwn = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);

export class DetailCacheController<T> {
  private readonly request = new LatestRequest();
  private readonly capacity: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private values: Record<string, T> = {};
  private errors: Record<string, string> = {};
  private pendingId: string | null = null;
  private entries = new Map<string, CacheEntry>();
  private accessSequence = 0;

  constructor(
    private readonly fallbackError: string,
    private readonly onChange: (snapshot: DetailCacheSnapshot<T>) => void,
    options: DetailCacheOptions = {}
  ) {
    this.capacity = Number.isSafeInteger(options.capacity) && (options.capacity ?? 0) > 0
      ? options.capacity!
      : 32;
    this.ttlMs = Number.isFinite(options.ttlMs) && (options.ttlMs ?? 0) > 0
      ? options.ttlMs!
      : 5 * 60 * 1000;
    this.now = options.now ?? Date.now;
  }

  async load(id: string, loader: (signal: AbortSignal) => Promise<T>, force = false) {
    if (!force && hasOwn(this.values, id)) {
      const entry = this.entries.get(id);
      if (entry && entry.expiresAt > this.now()) {
        entry.lastAccess = ++this.accessSequence;
        return true;
      }
      this.remove(id);
    }

    const request = this.request.begin();
    this.pendingId = id;
    this.errors = { ...this.errors, [id]: '' };
    this.emit();

    try {
      const value = await loader(request.signal);
      if (request.isCurrent()) {
        this.values = { ...this.values, [id]: value };
        this.errors = { ...this.errors, [id]: '' };
        const now = this.now();
        this.entries.set(id, { expiresAt: now + this.ttlMs, lastAccess: ++this.accessSequence });
        this.evict();
        this.emit();
        return true;
      }
      return false;
    } catch (error) {
      if (request.signal.aborted) return false;
      if (request.isCurrent()) {
        this.errors = {
          ...this.errors,
          [id]: error instanceof Error ? error.message : this.fallbackError
        };
        this.emit();
      }
      return false;
    } finally {
      if (request.isCurrent() && this.pendingId === id) {
        this.pendingId = null;
        this.emit();
      }
    }
  }

  invalidate(id: string) {
    this.remove(id);
    if (this.pendingId === id) {
      this.request.cancel();
      this.pendingId = null;
    }
    this.emit();
  }

  reset() {
    this.request.cancel();
    this.values = {};
    this.errors = {};
    this.pendingId = null;
    this.entries.clear();
    this.accessSequence = 0;
    this.emit();
  }

  private emit() {
    this.onChange({
      values: { ...this.values },
      errors: { ...this.errors },
      pendingId: this.pendingId
    });
  }

  private evict() {
    while (this.entries.size > this.capacity) {
      const oldest = [...this.entries].reduce((candidate, current) =>
        current[1].lastAccess < candidate[1].lastAccess ? current : candidate
      );
      this.remove(oldest[0]);
    }
  }

  private remove(id: string) {
    if (hasOwn(this.values, id)) {
      const { [id]: _removed, ...remaining } = this.values;
      this.values = remaining;
    }
    if (hasOwn(this.errors, id)) {
      const { [id]: _removed, ...remaining } = this.errors;
      this.errors = remaining;
    }
    this.entries.delete(id);
  }
}
