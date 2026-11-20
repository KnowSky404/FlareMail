import type { CloudflareEnv } from '../cloudflare';
import { parseInboundRecipient } from './recipient';

export type InboundRoutingEnvironment = 'production' | 'preview';
export type InboundRoutingKind = 'mailbox' | 'catch_all';
type RoutingEnv = Pick<CloudflareEnv, 'INBOUND_ROUTING_DB' | 'INBOUND_ROUTING_SCOPE'>;

export function readInboundRouting(env: RoutingEnv) {
  const db = env.INBOUND_ROUTING_DB;
  const scope = env.INBOUND_ROUTING_SCOPE;
  const hasDatabase = typeof db?.prepare === 'function';
  const absentOrSecret = scope === undefined || typeof scope === 'string' || scope instanceof CryptoKey;
  if (!hasDatabase && absentOrSecret) return null;
  const environment = scope?.environment;
  if (!hasDatabase || !db || (environment !== 'production' && environment !== 'preview')) {
    throw new Error('INBOUND_ROUTING_CONFIGURATION_INVALID');
  }
  return { db, environment };
}

export function inboundRoutingKey(kind: InboundRoutingKind, value: string) {
  const key = kind === 'mailbox' ? parseInboundRecipient(value)?.base : value.trim().toLowerCase();
  if (!key) throw new Error('INBOUND_ROUTING_KEY_INVALID');
  return key;
}

export async function findInboundRoutingOwner(db: D1Database, kind: InboundRoutingKind, value: string) {
  const row = await db.prepare(`
    SELECT environment FROM inbound_routing_ownership WHERE kind = ? AND route_key = ?
  `).bind(kind, inboundRoutingKey(kind, value)).first<{ environment: InboundRoutingEnvironment }>();
  return row?.environment ?? null;
}

export async function claimInboundRoutingOwner(
  db: D1Database, kind: InboundRoutingKind, value: string, environment: InboundRoutingEnvironment, limit?: number
) {
  const key = inboundRoutingKey(kind, value);
  const claimed = await db.prepare(`
    INSERT INTO inbound_routing_ownership (kind, route_key, environment)
    SELECT ?, ?, ? WHERE ? IS NULL OR (
      SELECT count(*) FROM inbound_routing_ownership WHERE kind = ? AND environment = ? AND route_key <> ?
    ) < ?
    ON CONFLICT (kind, route_key) DO UPDATE SET environment = excluded.environment
      WHERE inbound_routing_ownership.environment = excluded.environment
    RETURNING environment
  `).bind(kind, key, environment, limit ?? null, kind, environment, key, limit ?? null).first<{ environment: InboundRoutingEnvironment }>();
  return claimed?.environment === environment;
}

export async function resolveInboundRoutingOwner(db: D1Database, rawRecipient: string) {
  const address = parseInboundRecipient(rawRecipient);
  if (!address) return null;
  return db.prepare(`
    SELECT environment, kind FROM inbound_routing_ownership
    WHERE (kind = 'mailbox' AND route_key = ?) OR (kind = 'catch_all' AND route_key = ?)
    ORDER BY CASE WHEN kind = 'mailbox' THEN 0 ELSE 1 END
    LIMIT 1
  `).bind(address.base, address.domain).first<{ environment: InboundRoutingEnvironment; kind: InboundRoutingKind }>();
}
