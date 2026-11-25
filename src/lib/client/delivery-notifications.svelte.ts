import type { DeliveryAttentionAction, DeliveryAttentionKind, DeliveryAttentionNotice, DeliveryAttentionPage, DeliveryAttentionSummary } from '$lib/domain/mail';
import type { SystemHealth } from '$lib/domain/runtime-state';
import { ClientApiError, requestJson } from './api';
import { LatestRequest } from './latest-request';
import { mutateDeliveryAttention, refreshDeliveryAttentionSummary, type DeliveryAttentionRefresh } from './workspace-api';

const checkedDependencyCodes = new Set([
  'CONFIG_INVALID', 'AUTHENTICATION_UNAVAILABLE', 'ACCESS_UNAVAILABLE',
  'OWNER_MAPPING_REQUIRED', 'D1_UNAVAILABLE', 'SCHEMA_NOT_READY', 'R2_UNAVAILABLE', 'INBOUND_ROUTING_NOT_READY'
]);
const freshness = 30_000;

export class DeliveryNotifications {
  open = $state(false);
  summary = $state<DeliveryAttentionSummary | null>(null);
  notices = $state<DeliveryAttentionNotice[]>([]);
  cursor = $state<string | null>(null);
  view = $state<'pending' | 'history'>('pending');
  kind = $state<DeliveryAttentionKind | null>(null);
  loading = $state(false);
  loadError = $state(false);
  replayError = $state(false);
  mutation = $state<DeliveryAttentionAction | null>(null);
  actionError = $state<'changed' | 'failed' | null>(null);
  health = $state<SystemHealth>('unknown');

  private enabled = false;
  private read = new LatestRequest();
  private readRequest: ReturnType<LatestRequest['begin']> | null = null;
  private write = new LatestRequest();
  private replay = new LatestRequest();
  private replayPromise: Promise<DeliveryAttentionRefresh | undefined> | null = null;
  private readiness = new LatestRequest();
  private readAt = 0;
  private pageAt = 0;
  private replayAt = 0;
  private checkedAt = 0;
  private refreshAfterMutation = false;

  constructor(private readonly onReplay: () => void) {}

  start() {
    this.enabled = true;
    void this.refresh();
    void this.checkHealth();
  }

  reset() {
    this.enabled = false;
    this.read.cancel();
    this.write.cancel();
    this.replay.cancel();
    this.replayPromise = null;
    this.readiness.cancel();
    this.open = false;
    this.summary = null;
    this.notices = [];
    this.cursor = null;
    this.view = 'pending';
    this.kind = null;
    this.loading = false;
    this.loadError = false;
    this.replayError = false;
    this.mutation = null;
    this.actionError = null;
    this.health = 'unknown';
    this.readAt = this.pageAt = this.replayAt = this.checkedAt = 0;
    this.refreshAfterMutation = false;
  }

  setOpen(open: boolean) {
    this.open = open && this.enabled;
    if (!this.open) return;
    if (this.view !== 'pending' || this.kind) this.setScope('pending');
    else void this.refresh();
    void this.checkHealth();
  }

  setScope(view: 'pending' | 'history', kind: DeliveryAttentionKind | null = null) {
    if (view === this.view && kind === this.kind) return;
    this.view = view;
    this.kind = kind;
    this.notices = [];
    this.cursor = null;
    this.actionError = null;
    this.pageAt = 0;
    void this.refresh(true);
  }

  async checkHealth(force = false) {
    if (!this.enabled || (!force && Date.now() - this.checkedAt < freshness)) return;
    const request = this.readiness.begin();
    this.checkedAt = Date.now();
    if (this.health === 'unknown') this.health = 'checking';
    try {
      const result = await requestJson<{ ok: boolean }>('/api/readiness?scope=system', { signal: request.signal });
      if (request.isCurrent()) this.health = result.ok ? 'ready' : 'unknown';
    } catch (error) {
      if (!request.isCurrent()) return;
      if (error instanceof ClientApiError && error.status === 503 && checkedDependencyCodes.has(error.code)) {
        this.health = 'degraded';
      } else if (this.health !== 'degraded') {
        this.health = 'unknown';
      }
    }
  }

  private replaySummary() {
    if (this.replayPromise) return this.replayPromise;
    const request = this.replay.begin();
    this.replayPromise = refreshDeliveryAttentionSummary({ signal: request.signal }).then((result) => {
      if (!request.isCurrent()) return;
      this.replayAt = Date.now();
      this.replayError = result.replayFailed === true;
      if (result.replayed) this.onReplay();
      return result;
    }).catch(() => {
      if (request.isCurrent()) this.replayError = true;
      return undefined;
    }).finally(() => {
      if (request.isCurrent()) this.replayPromise = null;
    });
    return this.replayPromise;
  }

  async refresh(force = false, more = false, replay: boolean | 'stored' = false) {
    const forceReplay = replay === true;
    if (!this.enabled || (more && (this.loading || !this.cursor))) return;
    if (this.mutation) {
      if (force || this.open) {
        this.refreshAfterMutation = true;
        this.loading = this.open;
      }
      if (forceReplay) {
        const result = await this.replaySummary();
        if (result?.replayed && !this.mutation) void this.refresh(true);
      }
      return;
    }
    const list = this.open;
    const now = Date.now();
    const replayDue = replay !== 'stored' && !more && (forceReplay || (!this.replayPromise && now - this.replayAt >= freshness));
    if (!force && !more && ((list && this.loading) || now - (list ? this.pageAt : this.readAt) < freshness)) {
      if (!replayDue) return;
      if (list) {
        // Keep a fresh or loading page in place when the only due work is replay.
        const request = this.readRequest;
        const previous = this.summary;
        const result = await this.replaySummary();
        if (!result) return;
        const { replayed, pendingCount, snapshot } = result;
        const summary = { pendingCount, snapshot };
        let summaryChanged = false;
        if (request?.isCurrent() && this.summary === previous) {
          summaryChanged = summary.pendingCount !== previous?.pendingCount || summary.snapshot.version !== previous?.snapshot.version;
          this.summary = summary;
        }
        if (this.open && (replayed || summaryChanged)) void this.refresh(true);
        return replayed;
      }
    }
    const request = this.read.begin();
    this.readRequest = request;
    // Coalesce summary reads at dispatch. A list only becomes fresh after it loads.
    this.readAt = now;
    this.loading = list;
    this.loadError = false;
    let replayed = 0;
    try {
      const result = replayDue ? await this.replaySummary() : undefined;
      if (result) {
        const { replayed: count, pendingCount, snapshot } = result;
        replayed = count;
        if (request.isCurrent()) this.summary = { pendingCount, snapshot };
      }
      if (!request.isCurrent()) {
        if (replayed) void this.refresh(true);
        return replayed;
      }
      if (!list && !result) {
        const summary = await requestJson<DeliveryAttentionSummary>('/api/workspace/attention/summary', { signal: request.signal });
        if (request.isCurrent()) this.summary = summary;
      }
      if (list) {
        const params = new URLSearchParams({ view: this.view });
        if (this.kind) params.set('kind', this.kind);
        if (more && this.cursor) params.set('cursor', this.cursor);
        const result = await requestJson<DeliveryAttentionPage>('/api/workspace/attention?' + params, { signal: request.signal });
        if (!request.isCurrent()) return replayed;
        this.notices = more
          ? [...this.notices, ...result.notices.filter((notice) => !this.notices.some(({ id }) => id === notice.id))]
          : result.notices;
        this.cursor = result.nextCursor;
        this.summary = result.summary;
        if (!more) this.pageAt = Date.now();
      }
      return replayed;
    } catch {
      if (request.isCurrent()) {
        this.loadError = true;
        this.readAt = this.pageAt = 0;
      }
      return replayed;
    } finally {
      if (request.isCurrent()) this.loading = false;
    }
  }

  invalidate(replay: boolean | 'stored' = false) {
    this.pageAt = this.readAt = 0;
    return this.refresh(true, false, replay);
  }

  async act(action: DeliveryAttentionAction) {
    if (!this.enabled || this.mutation) return false;
    const request = this.write.begin();
    this.read.cancel();
    this.readAt = this.pageAt = 0;
    this.loading = false;
    this.mutation = action;
    this.actionError = null;
    let reload = false;
    try {
      const result = await mutateDeliveryAttention(action, request.signal);
      if (!request.isCurrent()) return false;
      this.summary = result.summary;
      this.readAt = Date.now();
      this.notices = this.notices.filter((notice) => action.action === 'acknowledge_all'
        ? this.view !== 'pending' || notice.version > action.snapshot.version || notice.occurredAt > action.snapshot.asOf
        : notice.id !== action.incident.id);
      reload = true;
      return true;
    } catch (error) {
      if (!request.isCurrent()) return false;
      this.actionError = error instanceof ClientApiError && [404, 409].includes(error.status) ? 'changed' : 'failed';
      reload = this.actionError === 'changed';
      return false;
    } finally {
      if (request.isCurrent()) {
        this.mutation = null;
        const refreshAfterMutation = this.refreshAfterMutation;
        this.refreshAfterMutation = false;
        if (reload || refreshAfterMutation) {
          this.pageAt = 0;
          if (this.open || this.actionError || refreshAfterMutation) void this.refresh(true);
        }
      }
    }
  }
}
