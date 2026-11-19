import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { extractD1Rows } from './bootstrap-owner';
import { executeD1, readCloudflareTarget } from './cloudflare-target';
import { normalizePreInboundRecipient } from '../src/lib/server/inbound/pre-inbound';
import { inboundRoutingKey, type InboundRoutingEnvironment, type InboundRoutingKind } from '../src/lib/server/inbound/routing-ownership';

interface Claim {
  kind: InboundRoutingKind;
  key: string;
  environment: InboundRoutingEnvironment;
}

function parseClaims(rows: Record<string, unknown>[]) {
  return rows.map((row): Claim => {
    if ((row.kind !== 'mailbox' && row.kind !== 'catch_all') || typeof row.route_key !== 'string' ||
        (row.environment !== 'production' && row.environment !== 'preview')) {
      throw new Error('INBOUND_ROUTING_BACKFILL_INVALID_ROW');
    }
    return { kind: row.kind, key: inboundRoutingKey(row.kind, row.route_key), environment: row.environment };
  });
}

export function buildInboundRoutingPlan(existing: Claim[], requested: Claim[]) {
  const id = (claim: Claim) => JSON.stringify([claim.kind, claim.key]);
  const current = new Map(existing.map((claim) => [id(claim), claim]));
  const additions = new Map<string, Claim>();
  const conflicts = new Map<string, Claim>();
  for (const claim of requested) {
    const key = id(claim);
    const previous = current.get(key) ?? additions.get(key);
    if (previous && previous.environment !== claim.environment) conflicts.set(key, claim);
    if (!previous) additions.set(key, claim);
  }
  return { additions: [...additions.values()], conflicts: [...conflicts.values()] };
}

export function inboundRoutingBackfillSql(claims: Claim[]) {
  const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const rows = claims.map(({ kind, key, environment }) => `(${literal(kind)}, ${literal(key)}, ${literal(environment)})`);
  // A concurrent claim by the other environment aborts the entire statement.
  return `INSERT INTO inbound_routing_ownership (kind, route_key, environment) VALUES ${rows.join(', ')}
    ON CONFLICT (kind, route_key) DO UPDATE SET environment =
      CASE WHEN inbound_routing_ownership.environment = excluded.environment THEN excluded.environment ELSE NULL END;`;
}

export const identityClaimsSql = `
  SELECT 'mailbox' AS kind, email AS route_key FROM mail_addresses
  UNION ALL
  SELECT 'catch_all' AS kind, domain_name AS route_key FROM mail_domains
  WHERE enabled = 1 AND unknown_recipient_policy = 'collect'
`;

async function backfill() {
  const { values } = parseArgs({ options: {
    production: { type: 'string' },
    preview: { type: 'string' },
    apply: { type: 'boolean' }
  } });
  if (!values.production || !values.preview) throw new Error('Specify --production and --preview local target files.');
  const production = readCloudflareTarget(values.production);
  const preview = readCloudflareTarget(values.preview);
  const fixedRecipient = (value?: string) => value === undefined ? null : normalizePreInboundRecipient(value);
  const reservation = fixedRecipient(production.vars.PRE_INBOUND_RECIPIENT);
  if (production.inboundRouting?.environment !== 'production' || preview.inboundRouting?.environment !== 'preview' ||
      production.inboundRouting.databaseId !== preview.inboundRouting.databaseId ||
      production.preInbound?.databaseId !== preview.databaseId || production.preInbound.bucket !== preview.bucket ||
      reservation !== fixedRecipient(preview.vars.PRE_INBOUND_RECIPIENT)) {
    throw new Error('INBOUND_ROUTING_BACKFILL_TARGET_MISMATCH');
  }

  const registry = { config: values.production, inboundRouting: true };
  const [prodRows, preRows, ownershipRows] = await Promise.all([
    executeD1({ config: values.production }, identityClaimsSql),
    executeD1({ config: values.preview }, identityClaimsSql),
    executeD1(registry, 'SELECT kind, route_key, environment FROM inbound_routing_ownership')
  ]);
  const requested: Record<string, unknown>[] = [
    ...extractD1Rows(prodRows).map((row) => ({ ...row, environment: 'production' })),
    ...extractD1Rows(preRows).map((row) => ({ ...row, environment: 'preview' }))
  ];
  if (reservation) {
    requested.push({ kind: 'mailbox', route_key: reservation, environment: 'preview' });
  }
  const plan = buildInboundRoutingPlan(parseClaims(extractD1Rows(ownershipRows)), parseClaims(requested));
  if (plan.conflicts.length > 0) {
    const conflicts = plan.conflicts.map(({ kind, key }) => ({
      kind,
      fingerprint: createHash('sha256').update(JSON.stringify([kind, key])).digest('hex')
    }));
    console.log(JSON.stringify({ status: 'conflict', conflicts, applied: 0 }));
    process.exitCode = 1;
    return;
  }
  if (values.apply && plan.additions.length) {
    const directory = await mkdtemp(join(tmpdir(), 'flaremail-inbound-routing-'));
    try {
      const path = join(directory, 'ownership.sql');
      await writeFile(path, inboundRoutingBackfillSql(plan.additions), { mode: 0o600 });
      await executeD1(registry, `@${path}`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  console.log(JSON.stringify({ status: values.apply ? 'applied' : 'dry-run', additions: plan.additions.length, conflicts: 0 }));
}

if (import.meta.main) await backfill();
