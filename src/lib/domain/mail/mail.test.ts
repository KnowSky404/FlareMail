import { describe, expect, test } from 'bun:test';
import { createForwardComposeInput, createReplyComposeInput } from './compose';
import { applyDeliveryEvent, getDeliveryRetryEligibility, isDeliveryRetryable, transitionDeliveryStatus } from './delivery';
import { buildMailThreads, getMailThreadKey } from './thread';
import type { MailMessage } from './types';
import { isValidEmail, sanitizeContentDisposition, sanitizeFilename, validateComposeInput } from './validation';

const message = (overrides: Partial<MailMessage> = {}): MailMessage => ({
  id: crypto.randomUUID(),
  folder: 'inbox',
  source: 'inbound',
  fromName: 'Ada',
  fromEmail: 'ada@example.com',
  toName: 'FlareMail',
  toEmail: 'owner@example.com',
  subject: 'Status',
  preview: 'Hello',
  body: 'Hello',
  sentAt: '2026-08-13T00:00:00.000Z',
  labels: [],
  read: false,
  starred: false,
  ...overrides
});

describe('mail thread domain', () => {
  test('prefers RFC identifiers and connects a reply chain', () => {
    const first = message({ id: 'first', messageId: '<root@example.com>' });
    const reply = message({
      id: 'reply',
      folder: 'sent',
      source: 'workspace',
      fromEmail: 'owner@example.com',
      toEmail: 'ada@example.com',
      inReplyTo: '<root@example.com>',
      references: '<root@example.com>',
      sentAt: '2026-08-13T00:01:00.000Z'
    });
    const followUp = message({
      id: 'follow-up',
      inReplyTo: '<reply@example.com>',
      references: '<root@example.com> <reply@example.com>',
      messageId: '<follow-up@example.com>',
      sentAt: '2026-08-13T00:02:00.000Z'
    });
    const mailbox = { inbox: [first, followUp], sent: [reply], drafts: [] };
    expect(buildMailThreads(mailbox, 'inbox')).toHaveLength(1);
    expect(buildMailThreads(mailbox, 'inbox')[0].messageCount).toBe(3);
    expect(getMailThreadKey(first)).toBe('rfc:root@example.com');
  });

  test('falls back to normalized subject and counterparty for legacy mail', () => {
    expect(getMailThreadKey(message({ subject: ' Re:  Hello ' }))).toBe('hello::ada@example.com');
  });
});

describe('compose domain', () => {
  test('reply preserves RFC threading headers while forward starts a new thread', () => {
    const source = message({
      messageId: '<current@example.com>',
      references: '<root@example.com>'
    });
    const reply = createReplyComposeInput(source);
    const forward = createForwardComposeInput(source);
    expect(reply.inReplyTo).toBe('<current@example.com>');
    expect(reply.references).toBe('<root@example.com> <current@example.com>');
    expect(forward.inReplyTo).toBeUndefined();
    expect(forward.references).toBeUndefined();
  });
});

describe('delivery domain', () => {
  test('shares conservative retry eligibility across every status and result kind', () => {
    const now = '2026-08-19T12:00:00.000Z';
    const retryableStatuses = new Set(['submitting', 'delayed', 'failed']);
    const resultKinds = [null, 'accepted', 'queued', 'temporary_failure', 'permanent_failure', 'rate_limited'] as const;
    const statuses = ['draft', 'queued', 'submitting', 'submitted', 'sent', 'delivered', 'delayed', 'bounced', 'failed', 'complained', 'suppressed'] as const;

    for (const status of statuses) {
      expect(isDeliveryRetryable(status)).toBe(retryableStatuses.has(status));
      for (const resultKind of resultKinds) {
        const eligibility = getDeliveryRetryEligibility({
          status,
          resultKind,
          idempotencyKey: 'flaremail:send:user-1:request-1',
          attemptStartedAt: '2026-08-19T11:59:00.000Z',
          now
        });
        expect(eligibility.eligible).toBe(retryableStatuses.has(status) && !['accepted', 'queued'].includes(resultKind ?? ''));
      }
    }
  });

  test('requires a durable key and a current attempt age before retrying', () => {
    const base = { status: 'failed' as const, resultKind: 'temporary_failure' as const, attemptStartedAt: '2026-08-19T11:59:00.000Z', now: '2026-08-19T12:00:00.000Z' };
    expect(getDeliveryRetryEligibility(base).code).toBe('idempotency_key_missing');
    expect(getDeliveryRetryEligibility({ ...base, idempotencyKey: 'key', attemptStartedAt: null }).code).toBe('attempt_age_missing');
    expect(getDeliveryRetryEligibility({ ...base, idempotencyKey: 'key', attemptStartedAt: '2026-08-18T12:00:00.000Z' }).code).toBe('idempotency_window_expired');
    expect(getDeliveryRetryEligibility({ ...base, idempotencyKey: 'key', attemptStartedAt: 'not-a-date' }).code).toBe('attempt_age_invalid');
  });

  test('does not regress terminal delivery state or let engagement overwrite it', () => {
    const delivered = { status: 'delivered' as const, lastEvent: null, lastEventAt: null };
    expect(transitionDeliveryStatus('delivered', 'failed')).toBe('delivered');
    expect(applyDeliveryEvent(delivered, { type: 'email.opened' }).status).toBe('delivered');
    expect(applyDeliveryEvent(delivered, { type: 'email.clicked' }).status).toBe('delivered');
  });

  test('API submission is not delivery', () => {
    const state = { status: 'queued' as const, lastEvent: null, lastEventAt: null };
    expect(applyDeliveryEvent(state, { type: 'submission' }).status).toBe('submitted');
    expect(applyDeliveryEvent(state, { type: 'email.delivered', createdAt: '2026-08-13T00:00:00Z' }).status).toBe('delivered');
  });

  test('suppression is terminal and unknown events preserve status', () => {
    const submitted = { status: 'submitted' as const, lastEvent: null, lastEventAt: null };
    const suppressed = applyDeliveryEvent(submitted, { type: 'email.suppressed' });
    expect(suppressed.status).toBe('suppressed');
    expect(applyDeliveryEvent(suppressed, { type: 'email.future_event' }).status).toBe('suppressed');
  });
});

describe('mail validation domain', () => {
  test('validates compose recipients and bounds', () => {
    expect(isValidEmail('person@example.com')).toBe(true);
    expect(isValidEmail('person@example')).toBe(false);
    expect(validateComposeInput({ toEmail: 'bad', subject: '', body: '' }).ok).toBe(false);
  });

  test('sanitizes attachment paths and content disposition', () => {
    expect(sanitizeFilename('../secret\\report?.txt')).toBe('secret_report_.txt');
    expect(sanitizeContentDisposition('你好.txt')).toContain("filename*=UTF-8''");
    expect(sanitizeContentDisposition('x\"\r\n.txt')).not.toMatch(/[\r\n]/);
  });
});
