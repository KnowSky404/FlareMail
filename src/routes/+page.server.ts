import type { PageServerLoad } from './$types';
import type { CloudflareEnv } from '$lib/server/cloudflare';
import { serializeWorkspace } from '$lib/server/workspace';

type DashboardRow = {
  total: number;
  last_subject: string | null;
  last_timestamp: string | null;
};

export const load: PageServerLoad = async ({ platform, locals }) => {
  const env = platform?.env as CloudflareEnv | undefined;
  const dbBound = Boolean(env?.DB);
  const bucketBound = Boolean(env?.BUCKET);
  const workspace = locals.workspaceSession ? serializeWorkspace(locals.workspaceSession) : null;

  if (!env?.DB) {
    return {
      dbBound,
      bucketBound,
      workspace,
      schemaReady: false,
      totalMessages: 0,
      lastSubject: null,
      lastTimestamp: null
    };
  }

  try {
    const stats = await env.DB.prepare(
      `
        SELECT
          COUNT(*) AS total,
          (
            SELECT subject
            FROM email_messages
            ORDER BY "timestamp" DESC
            LIMIT 1
          ) AS last_subject,
          (
            SELECT "timestamp"
            FROM email_messages
            ORDER BY "timestamp" DESC
            LIMIT 1
          ) AS last_timestamp
        FROM email_messages
      `
    ).first<DashboardRow>();

    return {
      dbBound,
      bucketBound,
      workspace,
      schemaReady: true,
      totalMessages: stats?.total ?? 0,
      lastSubject: stats?.last_subject ?? null,
      lastTimestamp: stats?.last_timestamp ?? null
    };
  } catch {
    return {
      dbBound,
      bucketBound,
      workspace,
      schemaReady: false,
      totalMessages: 0,
      lastSubject: null,
      lastTimestamp: null
    };
  }
};
