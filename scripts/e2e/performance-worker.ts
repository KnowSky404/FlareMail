import target from '../../cloudflare.local.json';

export const performanceMarkerTable = 'flaremail_e2e_perf_run';

export function readPerformanceRunId() {
  const id = process.env.FLAREMAIL_PERF_RUN_ID;
  if (id !== undefined && !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu.test(id)) {
    throw new Error('FLAREMAIL_PERF_RUN_ID must be a UUID generated for the isolated benchmark run.');
  }
  return id;
}

export async function requirePerformanceWorker(origin: URL) {
  const id = readPerformanceRunId();
  if (!id) throw new Error('Set FLAREMAIL_PERF_RUN_ID to the ID used to start the isolated benchmark Worker.');
  const endpoint = new URL(`/cdn-cgi/local/explorer/api/d1/database/${target.databaseId}/raw`, origin);
  const response = await fetch(endpoint, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(5_000),
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sql: `SELECT id FROM ${performanceMarkerTable} WHERE id = ?`, params: [id] })
  });
  const body = await response.json() as {
    success?: boolean;
    result?: { success?: boolean; results?: { rows: string[][] } }[];
  };
  const marker = body.result?.[0];
  if (!response.ok || !body.success || !marker?.success || marker.results?.rows[0]?.[0] !== id) {
    throw new Error('The local Worker does not own this benchmark run. Mailbox data has not been touched.');
  }
}
