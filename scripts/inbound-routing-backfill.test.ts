import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { buildInboundRoutingPlan, inboundRoutingBackfillSql } from './inbound-routing-backfill';

const production = { kind: 'mailbox', key: 'company@example.test', environment: 'production' } as const;
const preview = { ...production, environment: 'preview' } as const;
const catchAll = { kind: 'catch_all', key: 'example.test', environment: 'preview' } as const;

test('backfill detects cross-environment conflicts and treats already assigned routes as idempotent', () => {
  expect(buildInboundRoutingPlan([], [production, preview, catchAll]).conflicts).toEqual([preview]);
  expect(buildInboundRoutingPlan([production], [production, production, catchAll]))
    .toEqual({ additions: [catchAll], conflicts: [] });
});

test('a competing claim after the audit aborts all registry writes', () => {
  using db = new Database(':memory:');
  db.exec(readFileSync(new URL('../routing-migrations/0001_ownership.sql', import.meta.url), 'utf8'));
  db.exec(inboundRoutingBackfillSql([production]));
  expect(() => db.exec(inboundRoutingBackfillSql([catchAll, preview]))).toThrow();
  expect(db.query('SELECT kind, route_key AS key, environment FROM inbound_routing_ownership').all()).toEqual([production]);
});
