import { LatestRequest } from './latest-request';

export type DetailCacheSnapshot<T> = {
  values: Record<string, T>;
  errors: Record<string, string>;
  pendingId: string | null;
};

export class DetailCacheController<T> {
  private readonly request = new LatestRequest();
  private values: Record<string, T> = {};
  private errors: Record<string, string> = {};
  private pendingId: string | null = null;

  constructor(
    private readonly fallbackError: string,
    private readonly onChange: (snapshot: DetailCacheSnapshot<T>) => void
  ) {}

  async load(id: string, loader: (signal: AbortSignal) => Promise<T>, force = false) {
    if (!force && this.values[id]) return true;

    const request = this.request.begin();
    this.pendingId = id;
    this.errors = { ...this.errors, [id]: '' };
    this.emit();

    try {
      const value = await loader(request.signal);
      if (request.isCurrent()) {
        this.values = { ...this.values, [id]: value };
        this.emit();
      }
      return true;
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

  reset() {
    this.request.cancel();
    this.values = {};
    this.errors = {};
    this.pendingId = null;
    this.emit();
  }

  private emit() {
    this.onChange({
      values: this.values,
      errors: this.errors,
      pendingId: this.pendingId
    });
  }
}
