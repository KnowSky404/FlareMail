export class LatestRequest {
  private controller: AbortController | null = null;
  private sequence = 0;

  begin() {
    this.controller?.abort();
    this.controller = new AbortController();
    const sequence = ++this.sequence;
    return {
      signal: this.controller.signal,
      isCurrent: () => sequence === this.sequence && !this.controller?.signal.aborted
    };
  }

  cancel() {
    this.controller?.abort();
    this.controller = null;
    this.sequence += 1;
  }
}
