import { describe, expect, test } from 'bun:test';
import { softDeleteInboundState } from './messages';

describe('message repository statements', () => {
  test('soft delete preserves newer read and starred values on conflict', () => {
    let sql = '';
    let bindings: unknown[] = [];
    const statement = {
      bind(...values: unknown[]) {
        bindings = values;
        return this;
      }
    };
    const db = {
      prepare(query: string) {
        sql = query;
        return statement;
      }
    } as unknown as D1Database;

    softDeleteInboundState(
      db,
      'user-1',
      'message-1',
      false,
      true,
      '2026-08-13T00:00:00.000Z'
    );

    const conflictUpdate = sql.split('DO UPDATE SET')[1] ?? '';
    expect(conflictUpdate).toContain('deleted_at = excluded.deleted_at');
    expect(conflictUpdate).not.toContain('is_read');
    expect(conflictUpdate).not.toContain('is_starred');
    expect(bindings.slice(1)).toEqual([
      'user-1',
      'message-1',
      0,
      1,
      '2026-08-13T00:00:00.000Z',
      '2026-08-13T00:00:00.000Z',
      '2026-08-13T00:00:00.000Z'
    ]);
  });
});
