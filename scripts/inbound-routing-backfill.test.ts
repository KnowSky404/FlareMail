import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildInboundRoutingPlan, identityClaimsSql, inboundRoutingBackfillStatements } from './inbound-routing-backfill';
import { executeD1 } from './cloudflare-target';
import { extractD1Rows } from './bootstrap-owner';

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
  db.exec(inboundRoutingBackfillStatements([production])[0]!.sql);
  expect(() => db.exec(inboundRoutingBackfillStatements([catchAll, preview])[0]!.sql)).toThrow();
  expect(db.query('SELECT kind, route_key AS key, environment FROM inbound_routing_ownership').all()).toEqual([production]);
});

test('a disabled domain preference does not add or conflict with a catch-all claim', () => {
  using db = new Database(':memory:');
  db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  db.exec(`INSERT INTO mail_domains (id, owner_user_id, domain_name, cloudflare_zone_id, worker_name, enabled, unknown_recipient_policy)
    VALUES ('paused', 'fixture', 'example.test', 'zone', 'worker', 0, 'collect'),
           ('active', 'fixture', 'active.example.test', 'zone', 'worker', 1, 'collect')`);
  const rows = db.query<{ kind: typeof catchAll.kind; route_key: string }, []>(identityClaimsSql).all();
  expect(rows).toEqual([{ kind: 'catch_all', route_key: 'active.example.test' }]);
  const requested = rows.map(({ kind, route_key: key }) => ({ kind, key, environment: production.environment }));
  expect(buildInboundRoutingPlan([catchAll], requested)).toEqual({ additions: requested, conflicts: [] });
});

test('a large local D1 backfill stays atomic across SQL statements', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'flaremail-routing-backfill-test-'));
  const target = { persistTo: join(directory, 'state') };
  const batchFile = join(directory, 'backfill.json');
  const claims = Array.from({ length: 2_200 }, (_, index) => ({
    ...preview, key: `mailbox-number-${index}@example.test`
  }));
  const rows = () => executeD1(target, 'SELECT count(*) AS count FROM inbound_routing_ownership').then(extractD1Rows);
  try {
    const migration = readFileSync(new URL('../routing-migrations/0001_ownership.sql', import.meta.url), 'utf8');
    await writeFile(batchFile, JSON.stringify([{ sql: migration }, ...inboundRoutingBackfillStatements([production])]), { mode: 0o600 });
    await executeD1(target, { batchFile });
    const competingBatch = inboundRoutingBackfillStatements([...claims, preview]);
    expect(competingBatch.length).toBeGreaterThan(1);
    await writeFile(batchFile, JSON.stringify(competingBatch));
    await expect(executeD1(target, { batchFile })).rejects.toThrow('cf D1 command failed');
    expect(await rows()).toEqual([{ count: 1 }]);
    await writeFile(batchFile, JSON.stringify(inboundRoutingBackfillStatements(claims)));
    await executeD1(target, { batchFile });
    expect(await rows()).toEqual([{ count: 2_201 }]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
