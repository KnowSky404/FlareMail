import type { DeliveryAttentionAction, DeliveryAttentionKind, DeliveryAttentionNotice, DeliveryAttentionPage, DeliveryAttentionSummary } from '$lib/domain/mail';
import type { SystemHealth } from '$lib/domain/runtime-state';
import { ClientApiError, requestJson } from './api';
import { LatestRequest } from './latest-request';
import { mutateDeliveryAttention } from './workspace-api';

const checkedDependencyCodes = new Set([
  'CONFIG_INVALID', 'AUTHENTICATION_UNAVAILABLE', 'ACCESS_UNAVAILABLE',
  'OWNER_MAPPING_REQUIRED', 'D1_UNAVAILABLE', 'SCHEMA_NOT_READY', 'R2_UNAVAILABLE', 'INBOUND_ROUTING_NOT_READY'
]);
const freshness = 30_000;
type ReplayedSummary = DeliveryAttentionSummary & { replayed: number };

export class DeliveryNotifications {
  open = $state(false);
  summary = $state<DeliveryAttentionSummary | null>(null);
  notices = $state<DeliveryAttentionNotice[]>([]);
  cursor = $state<string | null>(null);
  view = $state<'pending' | 'history'>('pending');
  kind = $state<DeliveryAttentionKind | null>(null);
  loading = $state(false);
  loadError = $state(false);
  mutation = $state<DeliveryAttentionAction | null>(null);
  actionError = $state<'changed' | 'failed' | null>(null);
  health = $state<SystemHealth>('unknown');

  private enabled = false;
  private read = new LatestRequest();
  private write = new LatestRequest();
  private replay = new LatestRequest();
  private replayPromise: Promise<ReplayedSummary | undefined> | null = null;
  private readiness = new LatestRequest();
  private readAt = 0;
  private pageAt = 0;
  private replayAt = 0;
  private checkedAt = 0;
  private refreshAfterMutation = false;

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
    this.replayPromise = requestJson<ReplayedSummary>(
      '/api/workspace/attention/summary', { method: 'POST', signal: request.signal }
    ).then((result) => {
      if (!request.isCurrent()) return;
      this.replayAt = Date.now();
      return result;
    }).finally(() => {
      if (request.isCurrent()) this.replayPromise = null;
    });
    return this.replayPromise;
  }

  async refresh(force = false, more = false, forceReplay = false) {
    if (!this.enabled || (more && (this.loading || !this.cursor))) return;
    if (this.mutation) {
      if (force || this.open) {
        this.refreshAfterMutation = true;
        this.loading = this.open;
      }
      return;
    }
    const list = this.open;
    const now = Date.now();
    const replayDue = !more && (forceReplay || (!this.replayPromise && now - this.replayAt >= freshness));
    if (!force && !more && now - (list ? this.pageAt : this.readAt) < freshness) {
      if (!replayDue) return;
      if (list) {
        // Keep an open, fresh page in place when the only due work is replay.
        const result = await this.replaySummary().catch(() => undefined);
        if (result?.replayed && this.open) void this.refresh(true);
        return result?.replayed;
      }
    }
    const request = this.read.begin();
    // Mark the request at dispatch to coalesce focus and open refreshes.
    if (list) this.pageAt = now;
    this.readAt = now;
    this.loading = list;
    this.loadError = false;
    let replayed = 0;
    try {
      if (replayDue) {
        const result = await this.replaySummary();
        if (result) {
          const { replayed: count, ...summary } = result;
          replayed = count;
          if (request.isCurrent()) this.summary = summary;
        }
        if (!request.isCurrent()) {
          if (replayed) void this.refresh(true);
          return replayed;
        }
      } else if (!list) {
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

  invalidate(forceReplay = false) {
    this.pageAt = this.readAt = 0;
    return this.refresh(true, false, forceReplay);
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
