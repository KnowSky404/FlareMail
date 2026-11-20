import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { extractD1Rows } from './bootstrap-owner';
import { executeD1, readCloudflareTarget } from './cloudflare-target';
import { normalizePreInboundRecipient } from '../src/lib/server/inbound/pre-inbound';
import { identityClaimsSql, ownershipClaimsSql, planIdentityClaims, type Claim } from './inbound-routing-inventory';

export function inboundRoutingBackfillStatements(claims: Claim[]) {
  const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const prefix = 'INSERT INTO inbound_routing_ownership (kind, route_key, environment) VALUES ';
  // A concurrent foreign claim aborts the entire D1 batch.
  const suffix = `
    ON CONFLICT (kind, route_key) DO UPDATE SET environment =
      CASE WHEN inbound_routing_ownership.environment = excluded.environment THEN excluded.environment ELSE NULL END;`;
  const maxStatementBytes = 100_000;
  const fixedBytes = Buffer.byteLength(prefix) + Buffer.byteLength(suffix);
  const statements: string[] = [];
  let rows: string[] = [];
  let byteLength = fixedBytes;
  for (const { kind, key, environment } of claims) {
    const row = `(${literal(kind)}, ${literal(key)}, ${literal(environment)})`;
    const rowBytes = Buffer.byteLength(row);
    if (fixedBytes + rowBytes > maxStatementBytes) throw new Error('INBOUND_ROUTING_BACKFILL_ROW_TOO_LARGE');
    if (byteLength + (rows.length ? 2 : 0) + rowBytes > maxStatementBytes) {
      statements.push(prefix + rows.join(', ') + suffix);
      rows = [];
      byteLength = fixedBytes;
    }
    byteLength += (rows.length ? 2 : 0) + rowBytes;
    rows.push(row);
  }
  if (rows.length) statements.push(prefix + rows.join(', ') + suffix);
  return statements.map(sql => ({ sql }));
}

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
    executeD1(registry, ownershipClaimsSql)
  ]);
  const plan = planIdentityClaims(extractD1Rows(prodRows), extractD1Rows(preRows), extractD1Rows(ownershipRows), reservation);
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
      const batchFile = join(directory, 'ownership.json');
      await writeFile(batchFile, JSON.stringify(inboundRoutingBackfillStatements(plan.additions)), { mode: 0o600 });
      await executeD1(registry, { batchFile });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  console.log(JSON.stringify({ status: values.apply ? 'applied' : 'dry-run', additions: plan.additions.length, conflicts: 0 }));
}

if (import.meta.main) await backfill();
