import type { TrashListResult } from '$lib/domain/mail';
import { CursorPager } from './cursor-pager';

export class TrashController extends CursorPager<TrashListResult> {
  constructor(fetcher: (signal: AbortSignal, cursor?: string | null) => Promise<TrashListResult>, callbacks: {
    onResult: (result: TrashListResult, pageNumber: number) => void;
    onLoading: (loading: boolean, paging: boolean) => void;
    onError: (message: string) => void;
  }) { super((cursor, signal) => fetcher(signal, cursor), callbacks); }
}
