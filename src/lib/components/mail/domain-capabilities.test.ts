import { describe, expect, test } from 'bun:test';
import { summarizeDomainCapabilities, type DomainCapabilityInput } from './domain-capabilities';

const nowMs = Date.parse('2026-09-28T12:00:00.000Z');
const ready: DomainCapabilityInput = {
  enabled: true,
  cloudflareHealth: 'fresh',
  catchAllCollects: false,
  resendStatus: 'verified',
  resendSendingStatus: 'enabled',
  resendCheckedAt: '2026-09-28T11:00:00.000Z',
  resendCheckFailed: false,
  addresses: [{ lifecycleStatus: 'active', routingState: 'active', receiveEnabled: true, sendEnabled: true }]
};

describe('domain dashboard capability summary', () => {
  test('shows readiness only when an active receive route and sender pass their checks', () => {
    expect(summarizeDomainCapabilities(ready, nowMs)).toEqual({ receiving: 'ready', sending: 'ready' });
    expect(summarizeDomainCapabilities({ ...ready, enabled: false }, nowMs))
      .toEqual({ receiving: 'not_ready', sending: 'not_ready' });
  });

  test('does not mistake an enabled provider for an available address', () => {
    expect(summarizeDomainCapabilities({ ...ready, addresses: [] }, nowMs))
      .toEqual({ receiving: 'not_ready', sending: 'not_ready' });
    expect(summarizeDomainCapabilities({ ...ready, addresses: [
      { lifecycleStatus: 'active', routingState: 'error', receiveEnabled: true, sendEnabled: false }
    ] }, nowMs)).toEqual({ receiving: 'not_ready', sending: 'not_ready' });
  });

  test('marks stale provider evidence for recheck without claiming failure', () => {
    expect(summarizeDomainCapabilities({
      ...ready, cloudflareHealth: 'stale', resendCheckedAt: '2026-09-26T11:00:00.000Z'
    }, nowMs)).toEqual({ receiving: 'needs_check', sending: 'needs_check' });
    expect(summarizeDomainCapabilities({ ...ready, cloudflareHealth: 'degraded' }, nowMs).receiving)
      .toBe('needs_check');
  });

  test('recognizes an explicitly collecting Worker catch-all and imported routes', () => {
    expect(summarizeDomainCapabilities({ ...ready, catchAllCollects: true, addresses: [] }, nowMs))
      .toEqual({ receiving: 'ready', sending: 'not_ready' });
    expect(summarizeDomainCapabilities({ ...ready, addresses: [
      { lifecycleStatus: 'active', routingState: 'imported', receiveEnabled: true, sendEnabled: false }
    ] }, nowMs)).toEqual({ receiving: 'ready', sending: 'not_ready' });
  });
});
