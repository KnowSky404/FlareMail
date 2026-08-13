import { describe, expect, test } from 'bun:test';
import { insertOutboundEvent } from './deliveries';

describe('delivery repository statements', () => {
  test('binds a missing optional provider message id as D1 null', () => {
    let bindings: unknown[] = [];
    const statement = {
      bind(...values: unknown[]) {
        bindings = values;
        return this;
      }
    };
    const db = {
      prepare() {
        return statement;
      }
    } as unknown as D1Database;

    insertOutboundEvent(db, {
      svixId: 'local:message-1:submission:1',
      messageId: 'message-1',
      userId: 'user-1',
      provider: 'fake',
      eventType: 'submission',
      eventCreatedAt: '2026-08-13T00:00:00.000Z',
      summary: 'Accepted for delivery.',
      payloadJson: '{}',
      createdAt: '2026-08-13T00:00:00.000Z'
    });

    expect(bindings[4]).toBeNull();
    expect(bindings).not.toContain(undefined);
  });
});
