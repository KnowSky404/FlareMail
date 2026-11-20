import { inboundRoutingKey, type InboundRoutingEnvironment, type InboundRoutingKind } from '../src/lib/server/inbound/routing-ownership.ts';
import { resolvePreInboundMatch } from '../src/lib/server/inbound/pre-inbound.ts';

export interface Claim {
  kind: InboundRoutingKind;
  key: string;
  environment: InboundRoutingEnvironment;
}

export const identityClaimsSql = `
  SELECT 'mailbox' AS kind, email AS route_key, (lifecycle_status = 'active' AND receive_enabled = 1) AS receiving FROM mail_addresses
  UNION ALL
  SELECT 'catch_all' AS kind, domain_name AS route_key, 0 AS receiving FROM mail_domains
  WHERE enabled = 1 AND unknown_recipient_policy = 'collect'
`;

export const ownershipClaimsSql = 'SELECT kind, route_key, environment FROM inbound_routing_ownership';

function parseClaims(rows: Record<string, unknown>[], registered = false) {
  return rows.map((row): Claim => {
    if ((row.kind !== 'mailbox' && row.kind !== 'catch_all') || typeof row.route_key !== 'string' ||
        (row.environment !== 'production' && row.environment !== 'preview')) {
      throw new Error('INBOUND_ROUTING_BACKFILL_INVALID_ROW');
    }
    const key = inboundRoutingKey(row.kind, row.route_key);
    if (registered && key !== row.route_key) throw new Error('INBOUND_ROUTING_BACKFILL_INVALID_ROW');
    return { kind: row.kind, key, environment: row.environment };
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

export function planIdentityClaims(
  production: Record<string, unknown>[], preview: Record<string, unknown>[], ownership: Record<string, unknown>[], reservation: string | null
) {
  if (reservation && preview.some(row => row.kind === 'mailbox' && row.receiving === 1 &&
      typeof row.route_key === 'string' && resolvePreInboundMatch(reservation, row.route_key) === 'subaddress')) {
    throw new Error('INBOUND_ROUTING_RESERVED_SUBADDRESS_PRESENT');
  }
  const requested: Record<string, unknown>[] = [
    ...production.map(row => ({ ...row, environment: 'production' })),
    ...preview.map(row => ({ ...row, environment: 'preview' }))
  ];
  if (reservation) requested.push({ kind: 'mailbox', route_key: reservation, environment: 'preview' });
  return buildInboundRoutingPlan(parseClaims(ownership, true), parseClaims(requested));
}
