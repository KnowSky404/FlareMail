import type { DeliveryAttentionAction, DeliveryAttentionKind, DeliveryAttentionNotice, DeliveryAttentionPage, DeliveryAttentionSummary } from '$lib/domain/mail';
import type { SystemHealth } from '$lib/domain/runtime-state';
import { ClientApiError, requestJson } from './api';
import { LatestRequest } from './latest-request';
import { mutateDeliveryAttention } from './workspace-api';

const checkedDependencyCodes = new Set([
  'CONFIG_INVALID', 'D1_UNAVAILABLE', 'SCHEMA_NOT_READY', 'R2_UNAVAILABLE', 'INBOUND_ROUTING_NOT_READY'
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
  mutation = $state<DeliveryAttentionAction | null>(null);
  actionError = $state<'changed' | 'failed' | null>(null);
  health = $state<SystemHealth>('unknown');

  private enabled = false;
  private read = new LatestRequest();
  private write = new LatestRequest();
  private readiness = new LatestRequest();
  private readAt = 0;
  private pageAt = 0;
  private checkedAt = 0;

  start() {
    this.enabled = true;
    void this.refresh();
    void this.checkHealth();
  }

  reset() {
    this.enabled = false;
    this.read.cancel();
    this.write.cancel();
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
    this.readAt = this.pageAt = this.checkedAt = 0;
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

  async refresh(force = false, more = false) {
    if (!this.enabled || this.mutation || (more && (this.loading || !this.cursor))) return;
    const list = this.open;
    if (!force && !more && Date.now() - (list ? this.pageAt : this.readAt) < freshness) return;
    const request = this.read.begin();
    // Mark the request at dispatch to coalesce focus and open refreshes.
    if (list) this.pageAt = Date.now();
    this.readAt = Date.now();
    this.loading = list;
    this.loadError = false;
    try {
      if (list) {
        const params = new URLSearchParams({ view: this.view });
        if (this.kind) params.set('kind', this.kind);
        if (more && this.cursor) params.set('cursor', this.cursor);
        const result = await requestJson<DeliveryAttentionPage>('/api/workspace/attention?' + params, { signal: request.signal });
        if (!request.isCurrent()) return;
        this.notices = more
          ? [...this.notices, ...result.notices.filter((notice) => !this.notices.some(({ id }) => id === notice.id))]
          : result.notices;
        this.cursor = result.nextCursor;
        this.summary = result.summary;
      } else {
        const result = await requestJson<DeliveryAttentionSummary>('/api/workspace/attention/summary', { signal: request.signal });
        if (request.isCurrent()) this.summary = result;
      }
    } catch {
      if (!request.isCurrent()) return;
      this.loadError = true;
      this.readAt = this.pageAt = 0;
    } finally {
      if (request.isCurrent()) this.loading = false;
    }
  }

  invalidate() {
    this.pageAt = this.readAt = 0;
    void this.refresh(true);
  }

  async act(action: DeliveryAttentionAction) {
    if (!this.enabled || this.mutation) return false;
    const request = this.write.begin();
    this.read.cancel();
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
        if (reload) {
          this.pageAt = 0;
          if (this.open || this.actionError || this.readAt === 0) void this.refresh(true);
        }
      }
    }
  }
}
