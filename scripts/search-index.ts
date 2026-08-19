import { createLocalWranglerEnvironment, inheritWranglerEnvironment } from './wrangler-environment';

export type SearchIndexMode = 'verify' | 'rebuild' | 'prepare-export' | 'restore-export';

export interface SearchIndexOptions {
  mode: SearchIndexMode;
  remote: boolean;
  apply: boolean;
  json: boolean;
  config: string;
  database: string;
}

const usage = `Usage: bun scripts/search-index.ts [options]

Options:
  --mode <verify|rebuild|prepare-export|restore-export>
  --remote             Target remote D1 (default: local)
  --apply              Required for rebuild or export preparation/restoration
  --config <path>      Wrangler config path
  --database <name>    D1 database name (default: flaremail-db)
  --json                Print machine-readable output
  --help                Show this help
`;

function optionValue(args: string[], flag: string) {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value.`);
  return value;
}

export function parseSearchIndexArgs(args: string[]): SearchIndexOptions {
  if (args.includes('--help')) {
    console.log(usage);
    process.exit(0);
  }
  const mode = optionValue(args, '--mode') ?? 'verify';
  if (!['verify', 'rebuild', 'prepare-export', 'restore-export'].includes(mode)) {
    throw new Error('--mode must be verify, rebuild, prepare-export, or restore-export.');
  }
  const remote = args.includes('--remote');
  const apply = args.includes('--apply');
  if (mode !== 'verify' && !apply) throw new Error(`${mode} requires explicit --apply.`);
  return {
    mode: mode as SearchIndexMode,
    remote,
    apply,
    json: args.includes('--json'),
    config: optionValue(args, '--config') ?? (remote ? 'wrangler.deploy.toml' : 'wrangler.toml'),
    database: optionValue(args, '--database') ?? 'flaremail-db'
  };
}

export const verifySearchIndexSql = `
SELECT
  (SELECT COUNT(*) FROM email_messages WHERE owner_user_id IS NOT NULL)
    + (SELECT COUNT(*) FROM workspace_messages)
    + (SELECT COUNT(*) FROM workspace_drafts) AS expected_documents,
  (SELECT COUNT(*) FROM workspace_search_documents) AS projected_documents,
  (SELECT COUNT(*) FROM workspace_search_documents AS d WHERE
    (d.entity_kind = 'inbound' AND NOT EXISTS (SELECT 1 FROM email_messages AS e WHERE e.id = d.entity_id AND e.owner_user_id = d.user_id)) OR
    (d.entity_kind = 'message' AND NOT EXISTS (SELECT 1 FROM workspace_messages AS m WHERE m.id = d.entity_id AND m.user_id = d.user_id)) OR
    (d.entity_kind = 'draft' AND NOT EXISTS (SELECT 1 FROM workspace_drafts AS w WHERE w.id = d.entity_id AND w.user_id = d.user_id))
  ) AS orphaned_documents,
  (SELECT COUNT(*) FROM email_messages AS e WHERE e.owner_user_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM workspace_search_documents AS d WHERE d.user_id = e.owner_user_id AND d.entity_kind = 'inbound' AND d.entity_id = e.id
  )) + (SELECT COUNT(*) FROM workspace_messages AS m WHERE NOT EXISTS (
    SELECT 1 FROM workspace_search_documents AS d WHERE d.user_id = m.user_id AND d.entity_kind = 'message' AND d.entity_id = m.id
  )) + (SELECT COUNT(*) FROM workspace_drafts AS w WHERE NOT EXISTS (
    SELECT 1 FROM workspace_search_documents AS d WHERE d.user_id = w.user_id AND d.entity_kind = 'draft' AND d.entity_id = w.id
  )) AS missing_documents;
`;

const inboundProjection = `
INSERT INTO workspace_search_documents
  (user_id, entity_kind, entity_id, from_text, to_text, cc_text, subject_text, body_text, labels_text, indexed_at)
SELECT owner_user_id, 'inbound', id,
  substr("from", 1, 2048), substr("to" || ' ' || to_json, 1, 4096), substr(cc || ' ' || cc_json, 1, 4096),
  substr(subject, 1, 1024), substr(CASE WHEN text_body <> '' THEN text_body ELSE snippet END, 1, 16384),
  'Inbound Cloudflare', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM email_messages WHERE owner_user_id IS NOT NULL
ON CONFLICT(user_id, entity_kind, entity_id) DO UPDATE SET
  from_text = excluded.from_text, to_text = excluded.to_text, cc_text = excluded.cc_text,
  subject_text = excluded.subject_text, body_text = excluded.body_text, labels_text = excluded.labels_text,
  indexed_at = excluded.indexed_at;`;

const messageProjection = `
INSERT INTO workspace_search_documents
  (user_id, entity_kind, entity_id, from_text, to_text, cc_text, subject_text, body_text, labels_text, indexed_at)
SELECT user_id, 'message', id,
  substr(from_name || ' ' || from_email, 1, 2048), substr(to_name || ' ' || to_email || ' ' || to_json, 1, 4096),
  substr(cc || ' ' || cc_json, 1, 4096), substr(subject, 1, 1024),
  substr(CASE WHEN text_body <> '' THEN text_body WHEN body <> '' THEN body ELSE preview END, 1, 16384),
  substr(labels_json, 1, 4096), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM workspace_messages WHERE 1 = 1
ON CONFLICT(user_id, entity_kind, entity_id) DO UPDATE SET
  from_text = excluded.from_text, to_text = excluded.to_text, cc_text = excluded.cc_text,
  subject_text = excluded.subject_text, body_text = excluded.body_text, labels_text = excluded.labels_text,
  indexed_at = excluded.indexed_at;`;

const draftProjection = `
INSERT INTO workspace_search_documents
  (user_id, entity_kind, entity_id, from_text, to_text, cc_text, subject_text, body_text, labels_text, indexed_at)
SELECT user_id, 'draft', id, '', substr(to_email || ' ' || to_json, 1, 4096), substr(cc || ' ' || cc_json, 1, 4096),
  substr(subject, 1, 1024), substr(body, 1, 16384), 'Draft', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM workspace_drafts WHERE 1 = 1
ON CONFLICT(user_id, entity_kind, entity_id) DO UPDATE SET
  from_text = excluded.from_text, to_text = excluded.to_text, cc_text = excluded.cc_text,
  subject_text = excluded.subject_text, body_text = excluded.body_text, labels_text = excluded.labels_text,
  indexed_at = excluded.indexed_at;`;

export const rebuildSearchIndexSql = `
DELETE FROM workspace_search_documents AS d WHERE
  (d.entity_kind = 'inbound' AND NOT EXISTS (SELECT 1 FROM email_messages AS e WHERE e.id = d.entity_id AND e.owner_user_id = d.user_id)) OR
  (d.entity_kind = 'message' AND NOT EXISTS (SELECT 1 FROM workspace_messages AS m WHERE m.id = d.entity_id AND m.user_id = d.user_id)) OR
  (d.entity_kind = 'draft' AND NOT EXISTS (SELECT 1 FROM workspace_drafts AS w WHERE w.id = d.entity_id AND w.user_id = d.user_id));
${inboundProjection}
${messageProjection}
${draftProjection}
INSERT INTO workspace_search_fts(workspace_search_fts) VALUES('rebuild');
`;

export const prepareSearchExportSql = `
DROP TRIGGER IF EXISTS workspace_search_documents_ai;
DROP TRIGGER IF EXISTS workspace_search_documents_ad;
DROP TRIGGER IF EXISTS workspace_search_documents_au;
DROP TABLE IF EXISTS workspace_search_fts;
`;

export const restoreSearchExportSql = `
CREATE VIRTUAL TABLE IF NOT EXISTS workspace_search_fts USING fts5(
  from_text, to_text, cc_text, subject_text, body_text, labels_text,
  content='workspace_search_documents', content_rowid='id', tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS workspace_search_documents_ai AFTER INSERT ON workspace_search_documents BEGIN
  INSERT INTO workspace_search_fts(rowid, from_text, to_text, cc_text, subject_text, body_text, labels_text)
  VALUES (new.id, new.from_text, new.to_text, new.cc_text, new.subject_text, new.body_text, new.labels_text);
END;
CREATE TRIGGER IF NOT EXISTS workspace_search_documents_ad AFTER DELETE ON workspace_search_documents BEGIN
  INSERT INTO workspace_search_fts(workspace_search_fts, rowid, from_text, to_text, cc_text, subject_text, body_text, labels_text)
  VALUES ('delete', old.id, old.from_text, old.to_text, old.cc_text, old.subject_text, old.body_text, old.labels_text);
END;
CREATE TRIGGER IF NOT EXISTS workspace_search_documents_au AFTER UPDATE ON workspace_search_documents BEGIN
  INSERT INTO workspace_search_fts(workspace_search_fts, rowid, from_text, to_text, cc_text, subject_text, body_text, labels_text)
  VALUES ('delete', old.id, old.from_text, old.to_text, old.cc_text, old.subject_text, old.body_text, old.labels_text);
  INSERT INTO workspace_search_fts(rowid, from_text, to_text, cc_text, subject_text, body_text, labels_text)
  VALUES (new.id, new.from_text, new.to_text, new.cc_text, new.subject_text, new.body_text, new.labels_text);
END;
INSERT INTO workspace_search_fts(workspace_search_fts) VALUES('rebuild');
`;

function rows(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.flatMap((entry) => rows(entry));
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.results)) return record.results.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object');
  if (Array.isArray(record.result)) return record.result.flatMap((entry) => rows(entry));
  return [];
}

function parseJsonOutput(output: string): unknown {
  const trimmed = output.trim();
  try { return JSON.parse(trimmed); } catch { /* Fall through to prefixed output. */ }
  const lines = trimmed.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try { return JSON.parse(lines[index]!); } catch { /* Wrangler may prefix progress output. */ }
  }
  throw new Error('Wrangler did not return JSON.');
}

async function execute(options: SearchIndexOptions, sql: string) {
  const child = Bun.spawn([
    'bun', 'x', 'wrangler', 'd1', 'execute', options.database,
    options.remote ? '--remote' : '--local', '--config', options.config, '--command', sql, '--json',
    ...(options.apply ? ['--yes'] : [])
  ], {
    stdout: 'pipe', stderr: 'pipe',
    env: options.remote ? inheritWranglerEnvironment() : createLocalWranglerEnvironment()
  });
  const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (exitCode !== 0) throw new Error(`Wrangler command failed with exit code ${exitCode}.`);
  return parseJsonOutput(stdout);
}

export async function runSearchIndex(options: SearchIndexOptions) {
  const sql = options.mode === 'verify' ? verifySearchIndexSql
    : options.mode === 'rebuild' ? rebuildSearchIndexSql
      : options.mode === 'prepare-export' ? prepareSearchExportSql
        : restoreSearchExportSql;
  const output = await execute(options, sql);
  const first = rows(output)[0] ?? {};
  return {
    mode: options.mode,
    target: options.remote ? 'remote' : 'local',
    applied: options.mode !== 'verify',
    ...(options.mode === 'verify' ? {
      expectedDocuments: Number(first.expected_documents ?? 0),
      projectedDocuments: Number(first.projected_documents ?? 0),
      missingDocuments: Number(first.missing_documents ?? 0),
      orphanedDocuments: Number(first.orphaned_documents ?? 0)
    } : {})
  };
}

if (import.meta.main) {
  try {
    const options = parseSearchIndexArgs(process.argv.slice(2));
    const report = await runSearchIndex(options);
    console.log(options.json ? JSON.stringify(report) : report);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Search index command failed.');
    process.exit(1);
  }
}
