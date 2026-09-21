import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractD1Rows } from './bootstrap-owner';
import { createLocalWranglerEnvironment } from './wrangler-environment';
import { buildMailIdentityDryRunReport, parseMailIdentityAuditArguments, type MailIdentityAuditRow } from './mail-identity-audit-core';

const options = parseMailIdentityAuditArguments(process.argv.slice(2));
const config = 'wrangler.toml';
const environment = createLocalWranglerEnvironment();

async function wranglerD1(extraArguments: string[]) {
  const child = Bun.spawn([
    'bun', 'x', 'wrangler', 'd1', 'execute', 'flaremail-db',
    '--local', '--config', config, '--json',
    ...(options.persistTo ? ['--persist-to', options.persistTo] : []), ...extraArguments
  ], {
    stdout: 'pipe',
    stderr: 'inherit',
    env: environment
  });
  const stdout = await new Response(child.stdout).text();
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error('Wrangler local D1 read-only audit failed (' + exitCode + ').');
  return stdout;
}

const catalogRows = extractD1Rows(await wranglerD1([
  '--command',
  "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
]));
const tables = new Set(catalogRows.map((row) => String(row.name ?? '')));

async function columnsFor(table: string) {
  if (!tables.has(table)) return new Set<string>();
  const rows = extractD1Rows(await wranglerD1(['--command', `PRAGMA table_info("${table}")`]));
  return new Set(rows.map((row) => String(row.name ?? '')));
}

const columnEntries = await Promise.all([
  'workspace_users', 'workspace_owner', 'workspace_auth_credentials', 'email_messages',
  'workspace_messages', 'workspace_drafts', 'workspace_attachments', 'mail_body_objects',
  'workspace_telegram_bindings', 'workspace_telegram_deliveries', 'mail_domains'
].map(async (table) => [table, await columnsFor(table)] as const));
const columns = new Map(columnEntries);
const has = (table: string, column: string) => columns.get(table)?.has(column) ?? false;
const sqlName = (column: string | null, fallback = 'NULL') => column ? `"${column}"` : fallback;
const queries: string[] = [];
const add = (sql: string) => queries.push(sql.trim().replace(/;?$/u, ';'));

if (tables.has('workspace_users')) {
  add(`SELECT 'user' AS report_section, id AS user_id,
    ${sqlName(has('workspace_users', 'login_email') ? 'login_email' : null)} AS login_email,
    ${sqlName(has('workspace_users', 'email') ? 'email' : null)} AS profile_email
    FROM workspace_users ORDER BY id`);
}
if (tables.has('workspace_owner')) {
  add("SELECT 'owner_mapping' AS report_section, user_id AS owner_id FROM workspace_owner WHERE singleton = 1");
}
if (tables.has('workspace_auth_credentials') && has('workspace_auth_credentials', 'username')) {
  add("SELECT 'auth_username' AS report_section, user_id AS owner_id, username FROM workspace_auth_credentials ORDER BY username");
}
if (tables.has('mail_domains')) {
  add("SELECT 'configured_domain' AS report_section, domain_name, unknown_recipient_policy FROM mail_domains ORDER BY domain_name");
}

if (tables.has('email_messages')) {
  const owner = sqlName(has('email_messages', 'owner_user_id') ? 'owner_user_id' : null);
  add('SELECT \'inbound_total\' AS report_section, COUNT(*) AS count FROM email_messages');
  add(`SELECT 'inbound_owner_count' AS report_section, ${owner} AS owner_id, COUNT(*) AS count
    FROM email_messages GROUP BY ${owner}`);
  if (has('email_messages', 'to')) {
    add(`SELECT 'inbound_recipient' AS report_section, ${owner} AS owner_id, "to" AS email,
      COUNT(*) AS count, MIN("timestamp") AS first_seen, MAX("timestamp") AS last_seen
      FROM email_messages WHERE trim("to") <> '' GROUP BY ${owner}, "to" ORDER BY lower("to")`);
  }
  if (has('email_messages', 'mail_address_id') && has('email_messages', 'recipient_status')) {
    add("SELECT 'legacy_unmapped' AS report_section, COUNT(*) AS count FROM email_messages WHERE recipient_status = 'legacy-unmapped'");
  }
}

if (tables.has('workspace_messages')) {
  const owner = sqlName(has('workspace_messages', 'user_id') ? 'user_id' : null);
  add("SELECT 'outbound_total' AS report_section, COUNT(*) AS count FROM workspace_messages WHERE folder = 'sent'");
  add(`SELECT 'outbound_owner_count' AS report_section, ${owner} AS owner_id, COUNT(*) AS count
    FROM workspace_messages WHERE folder = 'sent' GROUP BY ${owner}`);
  if (has('workspace_messages', 'from_email')) {
    add(`SELECT 'outbound_sender' AS report_section, ${owner} AS owner_id, from_email AS email, COUNT(*) AS count
      FROM workspace_messages WHERE folder = 'sent' AND trim(from_email) <> ''
      GROUP BY ${owner}, from_email ORDER BY lower(from_email)`);
  }
}

if (tables.has('workspace_drafts')) {
  const owner = sqlName(has('workspace_drafts', 'user_id') ? 'user_id' : null);
  add("SELECT 'draft_total' AS report_section, COUNT(*) AS count FROM workspace_drafts WHERE deleted_at IS NULL");
  add(`SELECT 'draft_owner_count' AS report_section, ${owner} AS owner_id, COUNT(*) AS count
    FROM workspace_drafts WHERE deleted_at IS NULL GROUP BY ${owner}`);
  if (has('workspace_drafts', 'to_email')) {
    add(`SELECT 'draft_recipient' AS report_section, ${owner} AS owner_id, to_email AS email, COUNT(*) AS count
      FROM workspace_drafts WHERE deleted_at IS NULL AND trim(to_email) <> ''
      GROUP BY ${owner}, to_email ORDER BY lower(to_email)`);
  }
  if (has('workspace_drafts', 'from_email')) {
    add("SELECT 'draft_sender_schema' AS report_section, 1 AS available");
    add(`SELECT 'draft_sender' AS report_section, ${owner} AS owner_id, from_email AS email, COUNT(*) AS count
      FROM workspace_drafts WHERE deleted_at IS NULL AND trim(from_email) <> ''
      GROUP BY ${owner}, from_email ORDER BY lower(from_email)`);
  }
}

if (tables.has('workspace_attachments')) {
  const owner = sqlName(has('workspace_attachments', 'user_id') ? 'user_id' : null);
  const relation = sqlName(has('workspace_attachments', 'relation_type') ? 'relation_type' : null);
  add(`SELECT 'attachment_ownership' AS report_section, ${owner} AS owner_id, ${relation} AS relation_type, COUNT(*) AS count
    FROM workspace_attachments GROUP BY ${owner}, ${relation}`);
  if (tables.has('email_messages') && tables.has('workspace_messages') && tables.has('workspace_drafts') && has('workspace_attachments', 'relation_type')) {
    add(`SELECT 'orphan_attachments' AS report_section, COUNT(*) AS count FROM workspace_attachments a
      LEFT JOIN email_messages e ON a.relation_type = 'inbound' AND e.id = a.message_id
      LEFT JOIN workspace_messages m ON a.relation_type = 'message' AND m.id = a.message_id
      LEFT JOIN workspace_drafts d ON a.relation_type = 'draft' AND d.id = a.message_id
      WHERE (a.relation_type = 'inbound' AND e.id IS NULL)
         OR (a.relation_type = 'message' AND m.id IS NULL)
         OR (a.relation_type = 'draft' AND d.id IS NULL)`);
  }
}

if (tables.has('mail_body_objects')) {
  add("SELECT 'body_ownership' AS report_section, owner_user_id AS owner_id, entity_type, COUNT(*) AS count FROM mail_body_objects GROUP BY owner_user_id, entity_type");
  if (tables.has('email_messages') && tables.has('workspace_messages') && tables.has('workspace_drafts')) {
    add(`SELECT 'orphan_body_objects' AS report_section, COUNT(*) AS count FROM mail_body_objects b
      LEFT JOIN email_messages e ON b.entity_type = 'email_message' AND e.id = b.entity_id
      LEFT JOIN workspace_messages m ON b.entity_type = 'workspace_message' AND m.id = b.entity_id
      LEFT JOIN workspace_drafts d ON b.entity_type = 'draft' AND d.id = b.entity_id
      WHERE (b.entity_type = 'email_message' AND e.id IS NULL)
         OR (b.entity_type = 'workspace_message' AND m.id IS NULL)
         OR (b.entity_type = 'draft' AND d.id IS NULL)`);
  }
}

if (tables.has('workspace_telegram_bindings')) {
  add("SELECT 'telegram_binding_ownership' AS report_section, user_id AS owner_id, state, COUNT(*) AS count FROM workspace_telegram_bindings GROUP BY user_id, state");
}
if (tables.has('workspace_telegram_deliveries')) {
  add("SELECT 'telegram_delivery_ownership' AS report_section, owner_user_id AS owner_id, status, COUNT(*) AS count FROM workspace_telegram_deliveries GROUP BY owner_user_id, status");
}

let resultRows: MailIdentityAuditRow[] = [];
if (queries.length) {
  const directory = await mkdtemp(join(tmpdir(), 'flaremail-identity-audit-'));
  const sqlFile = join(directory, 'audit.sql');
  try {
    await writeFile(sqlFile, queries.join('\n'), { mode: 0o600 });
    const output = await wranglerD1(['--file', sqlFile]);
    resultRows = extractD1Rows(output) as MailIdentityAuditRow[];
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const report = buildMailIdentityDryRunReport(resultRows, options.domains);
if (!options.json) console.log('Local read-only migration audit. No D1 mutation statements or object storage changes were performed.');
console.log(JSON.stringify(report, null, 2));
