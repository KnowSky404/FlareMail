import { request } from '@playwright/test';
import target from '../../cloudflare.local.json';
import { E2E_PASSWORD, E2E_USERNAME } from '../../tests/e2e/fixtures';
import { performanceMarkerTable, requirePerformanceWorker } from './performance-worker';

const perfOrigin = process.env.FLAREMAIL_PERF_ORIGIN;
if (!perfOrigin) throw new Error('Set FLAREMAIL_PERF_ORIGIN to the isolated local E2E Worker.');
const origin = new URL(perfOrigin);
if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || !origin.port ||
    process.env.FLAREMAIL_PERF_REPLACE_E2E_MAIL !== 'yes') {
  throw new Error('Use a dedicated local E2E Worker and explicitly allow replacing its synthetic mailbox.');
}
const samples = Number(process.env.FLAREMAIL_PERF_SAMPLES ?? 20);
if (!Number.isSafeInteger(samples) || samples < 1) throw new Error('Invalid sample count.');

const explorer = origin.origin + '/cdn-cgi/local/explorer/api';
const client = await request.newContext({ baseURL: origin.origin });
const sqlLiteral = (value: string) => "'" + value.replaceAll("'", "''") + "'";
const spanAttribute = (name: string) => `json_extract(attributes, '$."${name}"')`;
const day = '2026-08-01T00:00:00.000Z';
const addresses = [
  '00000000-0000-4000-8000-000000000021',
  '00000000-0000-4000-8000-000000000022',
  '00000000-0000-4000-8000-000000000023'
];
const owner = 'e2e-admin-user';
const label = 'perf-label';
type RawQuery = { sql: string; params?: (string | number | null)[] };

async function localApi(path: string, data: unknown) {
  const response = await fetch(explorer + path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data)
  });
  const body = await response.json() as { success?: boolean; result?: unknown };
  if (!response.ok || !body.success) throw new Error(`Local Explorer ${path} failed (${response.status})`);
  return body.result;
}

async function d1(query: RawQuery | { batch: RawQuery[] }) {
  return await localApi(`/d1/database/${target.databaseId}/raw`, query) as {
    success: boolean; results: { rows: (string | number | null)[][] };
  }[];
}

async function writeFixtures(runId: string, statements: RawQuery[]) {
  const scope = `EXISTS (SELECT 1 FROM ${performanceMarkerTable} WHERE id = ?)
    AND EXISTS (SELECT 1 FROM workspace_owner WHERE singleton = 1 AND user_id = ?)`;
  // Checking the marker in each write also protects a batch API that executes statements separately.
  const result = await d1({ batch: [
    { sql: `SELECT 1 WHERE ${scope}`, params: [runId, owner] },
    ...statements.map(({ sql, params = [] }) => ({ sql: `${sql} AND ${scope}`, params: [...params, runId, owner] }))
  ] });
  if (result.length !== statements.length + 1 || result.some(({ success }) => !success) || result[0]?.results.rows[0]?.[0] !== 1) {
    throw new Error('Fixture batch did not match its benchmark run and synthetic Owner.');
  }
}

async function seed(size: number) {
  const runId = await requirePerformanceWorker(origin);
  await writeFixtures(runId, [
    ...['workspace_messages', 'workspace_drafts', 'workspace_email_states', 'mail_labels'].map((table) =>
      ({ sql: `DELETE FROM ${table} WHERE ${table === 'mail_labels' ? 'owner_user_id' : 'user_id'} = ?`, params: [owner] })),
    { sql: 'DELETE FROM email_messages WHERE owner_user_id = ?', params: [owner] },
    { sql: 'INSERT INTO mail_labels (id, owner_user_id, name, name_key, created_at, updated_at) SELECT ?, ?, ?, ?, ?, ? WHERE 1',
      params: [label, owner, 'Performance fixture', 'performance fixture', day, day] }
  ]);
  for (let start = 1; start <= size; start += 250) {
    const end = Math.min(size, start + 249);
    const numbers = `WITH RECURSIVE n(i) AS (VALUES(${start}) UNION ALL SELECT i+1 FROM n WHERE i < ${end})`;
    const address = `CASE i%3 WHEN 0 THEN '${addresses[0]}' WHEN 1 THEN '${addresses[1]}' ELSE '${addresses[2]}' END`;
    const domain = `CASE i%3 WHEN 2 THEN '00000000-0000-4000-8000-000000000012' ELSE '00000000-0000-4000-8000-000000000011' END`;
    const sentAt = `strftime('%Y-%m-%dT%H:%M:%fZ', '${day}', '+'||i||' seconds')`;
    await writeFixtures(runId, [
      { sql: `${numbers}
        INSERT INTO workspace_messages (id, user_id, folder, direction, from_name, from_email, to_name, to_email, subject,
          preview, sent_at, thread_key, is_read, is_starred, archived_at, deleted_at, sender_address_id, recipient_address_id)
        SELECT 'perf-w-'||i, '${owner}', CASE WHEN i%3=0 THEN 'sent' ELSE 'inbox' END,
          CASE WHEN i%3=0 THEN 'outbound' ELSE 'inbound' END, 'Fixture', 'sender@fixture.test', 'Fixture', 'recipient@fixture.test',
          'Performance fixture '||i, CASE WHEN i%4=0 THEN 'benchmark match' ELSE 'fixture' END, ${sentAt},
          'perf-w-'||i, i%4=3, i%11=0, CASE WHEN i%10=1 AND i%3<>0 THEN ${sentAt} END,
          CASE WHEN i%19=0 THEN ${sentAt} END, CASE WHEN i%3=0 THEN ${address} END, CASE WHEN i%3<>0 THEN ${address} END
        FROM n WHERE i%2=1` },
      { sql: `${numbers}
        INSERT INTO email_messages (id, owner_user_id, "from", "to", subject, snippet, raw_key, "timestamp", mail_address_id, mail_domain_id, recipient_status)
        SELECT 'perf-i-'||i, '${owner}', 'sender@fixture.test', 'recipient@fixture.test',
          'Performance fixture '||i, CASE WHEN i%4=0 THEN 'benchmark match' ELSE 'fixture' END,
          'fixture/'||i, ${sentAt}, ${address}, ${domain}, 'managed' FROM n WHERE i%2=0` },
      { sql: `${numbers}
        INSERT INTO workspace_email_states (id, user_id, email_message_id, is_read, is_starred, archived_at, deleted_at)
        SELECT 'perf-state-'||i, '${owner}', 'perf-i-'||i, i%4=0, i%11=0,
          CASE WHEN i%10=0 THEN ${sentAt} END, CASE WHEN i%19=0 THEN ${sentAt} END
        FROM n WHERE i%2=0` },
      { sql: `${numbers}
        INSERT INTO mail_message_labels (owner_user_id, label_id, message_kind, message_id, created_at)
        SELECT '${owner}', '${label}', CASE WHEN i%2=0 THEN 'inbound' ELSE 'workspace' END,
          CASE WHEN i%2=0 THEN 'perf-i-'||i ELSE 'perf-w-'||i END, ${sentAt} FROM n WHERE i%5=0` }
    ]);
  }
  const counts = await d1({ sql: `SELECT (SELECT count(*) FROM workspace_messages WHERE user_id=?) +
    (SELECT count(*) FROM email_messages WHERE owner_user_id=?)`, params: [owner, owner] });
  if (counts[0].results.rows[0][0] !== size) throw new Error('Synthetic mailbox size differs from the requested size.');
}

type TraceRow = [string, number, number, number | null, number | null, number | null, string | null];
async function trace(url: URL, method: string): Promise<TraceRow[]> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const result = await localApi('/local/observability/query', { sql: `
      WITH invocation AS (
        SELECT MIN(trace_id) AS trace_id FROM spans WHERE parent_id IS NULL AND name = ${sqlLiteral(method)}
          AND ${spanAttribute('url.full')} = ${sqlLiteral(url.href)}
        HAVING COUNT(DISTINCT trace_id) = 1
      )
      SELECT name, start_ms, duration_ms, ${spanAttribute('cloudflare.d1.response.rows_read')},
        ${spanAttribute('cloudflare.d1.response.rows_written')}, ${spanAttribute('cloudflare.d1.response.sql_duration_ms')},
        ${spanAttribute('db.query.text')}
      FROM spans WHERE trace_id = (SELECT trace_id FROM invocation)
        AND (parent_id IS NULL OR name LIKE 'd1_%') ORDER BY start_ms
    ` }) as { rows: TraceRow[] };
    if (result.rows.some(([name]) => name.startsWith('d1_'))) return result.rows;
    await Bun.sleep(30);
  }
  throw new Error('Expected one matching invocation with D1 operations for the local benchmark sample.');
}

function sqlPhase(sql: string | null) {
  if (!sql) return 'unavailable';
  if (sql.includes('workspace_schema_metadata')) return 'schema';
  if (sql.includes('UPDATE workspace_sessions')) return 'auth.touch';
  if (sql.includes('workspace_sessions AS s')) return 'auth.session';
  if (sql.includes('FROM workspace_owner')) return 'auth.owner';
  if (sql.includes('message_counts AS')) return 'metrics';
  if (sql.includes('MATCH')) return 'search';
  if (sql.includes('mail_message_labels')) return 'label';
  return 'other';
}

async function sampleEndpoint(path: string, method = 'GET', data?: object) {
  if (method !== 'GET') await requirePerformanceWorker(origin);
  const url = new URL(path, origin);
  const sampleId = crypto.randomUUID();
  url.searchParams.set('perf_sample', sampleId);
  const start = Date.now();
  const response = await client.fetch(url.href, { method, data, headers: { origin: origin.origin } });
  let body: Buffer;
  let wallMs: number;
  let timing: string | undefined;
  try {
    if (!response.ok()) throw new Error(`Local benchmark returned ${response.status()}`);
    body = await response.body();
    wallMs = Date.now() - start;
    timing = response.headers()['server-timing'];
  } finally {
    await response.dispose();
  }
  const rows = await trace(url, method);
  const statements = rows.filter(([name]) => name.startsWith('d1_'));
  const sessionIndex = statements.findIndex(([, , , , , , sql]) => sqlPhase(sql) === 'auth.session');
  return {
    result: JSON.parse(body.toString()),
    measurement: {
      sampleId, wallMs, bytes: body.byteLength, timing,
      queries: statements.map(([name, , wallMs, rowsRead, rowsWritten, sqlMs, sql], index) => {
        const group = sqlPhase(sql);
        const phase = group === 'schema' ? (index < sessionIndex ? 'auth.schema' : 'workspace.schema') : group;
        return { name, phase, wallMs, rowsRead, rowsWritten, sqlMs };
      })
    },
    sql: rows.flatMap(([, , , , , , sql]) => sql ? [sql] : [])
  };
}

async function explain(statements: string[]) {
  const result: { phase: string; plan: unknown }[] = [];
  for (const sql of new Set(statements)) {
    if (!/^\s*(SELECT|WITH)\b/iu.test(sql)) continue;
    try {
      const query = await d1({ sql: 'EXPLAIN QUERY PLAN ' + sql,
        params: Array.from(sql.matchAll(/\?/gu), () => '') });
      result.push({ phase: sqlPhase(sql), plan: query[0].results.rows.map((row) => row.at(-1)) });
    } catch (error) {
      result.push({ phase: sqlPhase(sql), plan: (error as Error).message });
    }
  }
  return result;
}

try {
  await requirePerformanceWorker(origin);
  const login = await client.post('/api/workspace/session', {
    data: { username: E2E_USERNAME, password: E2E_PASSWORD },
    headers: { origin: origin.origin }
  });
  if (!login.ok()) throw new Error('Synthetic local E2E login failed.');
  const reports = [];
  for (const size of [0, 100, 1_000, 10_000]) {
    await seed(size);
    const mailbox = '/api/workspace/mailbox?limit=40&folder=';
    const endpoints = {
      inbox: mailbox + 'inbox',
      sent: mailbox + 'sent',
      drafts: mailbox + 'drafts',
      archive: mailbox + 'archive',
      starred: mailbox + 'starred',
      label: mailbox + 'label&label=' + label,
      trash: '/api/workspace/trash?limit=40',
      metrics: '/api/workspace/mailbox/metrics',
      identity: mailbox + 'inbox&identity=address:' + addresses[1],
      domain: mailbox + 'inbox&identity=domain:00000000-0000-4000-8000-000000000011',
      search: mailbox + 'inbox&q=subject:Performance',
      category: mailbox + 'inbox&category=primary'
    };
    const measurements = [];
    for (const [operation, path] of Object.entries(endpoints)) {
      const first = await sampleEndpoint(path);
      const values = [];
      for (let index = 0; index < samples; index += 1) values.push((await sampleEndpoint(path)).measurement);
      measurements.push({ operation, first: first.measurement, samples: values, plans: await explain(first.sql) });
      const cursor = first.result.data.page?.nextCursor;
      if (operation === 'inbox' && cursor) {
        const pathWithCursor = path + '&cursor=' + encodeURIComponent(cursor);
        const values = [];
        for (let index = 0; index < samples; index += 1) values.push((await sampleEndpoint(pathWithCursor)).measurement);
        measurements.push({ operation: 'inbox-page-two', samples: values });
      }
    }
    if (size) {
      const detail = '/api/workspace/messages/perf-w-1';
      const values = [];
      const flags = [];
      for (let index = 0; index < samples; index += 1) {
        values.push((await sampleEndpoint(detail)).measurement);
        flags.push((await sampleEndpoint(detail + '/flags', 'PATCH', { starred: index % 2 === 0 })).measurement);
      }
      measurements.push({ operation: 'detail', samples: values }, { operation: 'flags', samples: flags });
    }
    reports.push({ size, measurements });
  }
  console.log(JSON.stringify({ environment: 'isolated local D1', reports }, null, 2));
} finally {
  await client.dispose();
}
