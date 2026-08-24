import type { TrashListResult } from '$lib/domain/mail';
import { LatestRequest } from './latest-request';

type TrashFetcher = (signal: AbortSignal) => Promise<TrashListResult>;

export class TrashController {
  private readonly request = new LatestRequest();

  constructor(
    private readonly fetcher: TrashFetcher,
    private readonly callbacks: {
      onResult: (result: TrashListResult) => void;
      onLoading: (loading: boolean) => void;
      onError: (message: string) => void;
    }
  ) {}

  async load(): Promise<boolean> {
    const request = this.request.begin();
    this.callbacks.onLoading(true);
    try {
      const result = await this.fetcher(request.signal);
      if (!request.isCurrent()) return false;
      this.callbacks.onResult(result);
      return true;
    } catch (error) {
      if (!request.signal.aborted) {
        this.callbacks.onError(error instanceof Error ? error.message : '加载垃圾箱失败。');
      }
      return false;
    } finally {
      if (request.isCurrent()) this.callbacks.onLoading(false);
    }
  }

  cancel(): void {
    this.request.cancel();
  }
}
