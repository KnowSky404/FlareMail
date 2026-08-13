import type { CloudflareEnv } from '$lib/server/cloudflare';

export function hasD1Binding(env: CloudflareEnv | undefined): env is CloudflareEnv {
  return Boolean(env?.DB);
}

export function requireD1(env: CloudflareEnv | undefined): D1Database {
  if (!hasD1Binding(env)) {
    throw new Error('运行时缺少 D1 绑定。');
  }

  return env.DB;
}

export async function batchD1(
  db: D1Database,
  statements: D1PreparedStatement[]
): Promise<D1Result<unknown>[]> {
  if (!statements.length) {
    return [];
  }

  return db.batch(statements);
}
