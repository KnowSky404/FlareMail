import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { createLocalWranglerEnvironment } from '../wrangler-environment';

const root = resolve(import.meta.dir, '../..');
const argument = (name: string, fallback: string) => {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};

const port = argument('--port', '4173');
const persistenceRoot = resolve(join(tmpdir(), 'flaremail-e2e'));
const persistTo = resolve(argument(
  '--persist-to',
  process.env.FLAREMAIL_E2E_STATE_DIR ?? join(persistenceRoot, 'state')
));
const relativePersistencePath = relative(persistenceRoot, persistTo);
if (
  !relativePersistencePath ||
  relativePersistencePath.startsWith('..') ||
  isAbsolute(relativePersistencePath)
) {
  throw new Error(`Refusing to clear non-isolated E2E persistence path: ${persistTo}`);
}
const adminEmail = process.env.FLAREMAIL_E2E_EMAIL ?? 'e2e-admin@flaremail.test';
const adminPassword = process.env.FLAREMAIL_E2E_PASSWORD ?? 'FlareMail-E2E-password-2026!';
const userId = 'e2e-admin-user';
const inboxId = 'e2e-inbox-message';
const htmlInboxId = 'e2e-html-inbox-message';
const htmlCidKey = 'e2e/html-cid.png';
const htmlCidBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const timestamp = '2026-08-13T08:00:00.000Z';
const webhookSecret = `whsec_${btoa('FlareMail E2E webhook secret 2026')}`;

type Child = { exited: Promise<number>; kill: (signal?: string) => void };

async function run(command: string, args: string[], env?: Record<string, string>) {
  const child = Bun.spawn([command, ...args], {
    cwd: root,
    env: {
      ...createLocalWranglerEnvironment(process.env, { logFileName: 'flaremail-e2e-wrangler.log' }),
      ...env
    },
    stdout: 'inherit',
    stderr: 'inherit'
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`${command} ${args.join(' ')} exited with ${exitCode}`);
}

const sql = (value: string) => `'${value.replaceAll("'", "''")}'`;
const bulkInboxSeed = Array.from({ length: 45 }, (_, index) => {
  const ordinal = String(index + 1).padStart(2, '0');
  const id = `e2e-bulk-${ordinal}`;
  const sentAt = new Date(Date.parse(timestamp) - (index + 1) * 60_000).toISOString();
  return `INSERT OR IGNORE INTO workspace_messages (
    id, user_id, folder, from_name, from_email, to_name, to_email, subject, preview, body,
    sent_at, labels_json, is_read, is_starred, message_id, thread_key, direction, text_body,
    html_body, cc, dedupe_key, created_at, updated_at
  ) VALUES (
    ${sql(id)}, ${sql(userId)}, 'inbox', 'Bulk Sender', 'bulk@flaremail.test', 'E2E Administrator',
    ${sql(adminEmail)}, ${sql(`E2E Bulk ${ordinal}`)}, 'Paginated fixture', 'Paginated fixture body',
    ${sql(sentAt)}, '[]', ${index % 2}, 0, ${sql(`<${id}@flaremail.test>`)}, ${sql(`legacy:${id}`)},
    'inbound', 'Paginated fixture body', '', '', ${sql(`legacy:${id}`)}, ${sql(sentAt)}, ${sql(sentAt)}
  );`;
}).join('\n');
const draftSubjects = [
  'E2E Existing Concurrent',
  'E2E Conflict Load',
  'E2E Conflict Copy',
  'E2E Conflict Overwrite',
  'E2E Mobile Existing'
];
const draftSeed = draftSubjects.map((subject, index) => `INSERT OR IGNORE INTO workspace_drafts (
  id, user_id, to_email, cc, subject, body, is_starred, created_at, updated_at
) VALUES (
  ${sql(`e2e-draft-${index + 1}`)}, ${sql(userId)}, 'draft-recipient@flaremail.test', '', ${sql(subject)},
  ${sql(`Initial body for ${subject}`)}, 0, ${sql(timestamp)}, ${sql(timestamp)}
);`).join('\n');

await rm(persistTo, { recursive: true, force: true });
await run('bun', ['run', 'build']);
await run('bunx', [
  'wrangler', 'd1', 'migrations', 'apply', 'flaremail-db', '--local', '--config', 'wrangler.toml', '--persist-to', persistTo
]);

const { hashPassword, PASSWORD_HASH_ITERATIONS } = await import('../../src/lib/server/auth/password');
const credentialHash = await hashPassword(adminPassword);
const seed = `
INSERT OR IGNORE INTO workspace_users (
  id, login_email, name, role, email, company, location, timezone,
  forwarding_enabled, signature, incoming_sequence, credential_hash,
  credential_iterations, credential_updated_at, created_at, updated_at
) VALUES (
  ${sql(userId)}, ${sql(adminEmail)}, 'E2E Administrator', 'Workspace Owner', ${sql(adminEmail)},
  'FlareMail E2E', '', 'UTC', 1, '', 0, ${sql(credentialHash)}, ${PASSWORD_HASH_ITERATIONS},
  ${sql(timestamp)}, ${sql(timestamp)}, ${sql(timestamp)}
);
INSERT OR IGNORE INTO workspace_settings (user_id, theme, settings_json, created_at, updated_at)
VALUES (${sql(userId)}, 'system', '{}', ${sql(timestamp)}, ${sql(timestamp)});
INSERT OR IGNORE INTO workspace_messages (
  id, user_id, folder, from_name, from_email, to_name, to_email, subject, preview, body,
  sent_at, labels_json, is_read, is_starred, message_id, thread_key, direction,
  text_body, html_body, cc, dedupe_key, created_at, updated_at
) VALUES (
  ${sql(inboxId)}, ${sql(userId)}, 'inbox', 'E2E Sender', 'sender@flaremail.test',
  'E2E Administrator', ${sql(adminEmail)}, 'E2E Inbox Welcome',
  'A deterministic local inbox message for browser tests.',
  'This message is seeded in the isolated local D1 database.', ${sql(timestamp)}, '[]', 0, 0,
  '<e2e-inbox-message@flaremail.test>', 'legacy:e2e-inbox-message', 'inbound',
  'This message is seeded in the isolated local D1 database.', '', '', ${sql(`legacy:${inboxId}`)},
  ${sql(timestamp)}, ${sql(timestamp)}
);
INSERT OR IGNORE INTO email_messages (
  id, message_id, "from", "to", subject, "timestamp", snippet, raw_key, raw_size,
  direction, text_body, html_body, cc, to_json, cc_json, reply_to_json, return_path,
  delivered_to, headers_json, authentication_results_json, dedupe_key, owner_user_id, created_at
) VALUES (
  ${sql(htmlInboxId)}, '<e2e-html-inbox-message@flaremail.test>',
  'HTML Safety Sender <html-sender@flaremail.test>', ${sql(adminEmail)}, 'E2E HTML Safety',
  ${sql(timestamp)}, 'A malicious HTML fixture for isolated browser QA.', 'e2e/html-message.eml', 512,
  'inbound', 'Safe HTML fixture text fallback.',
  ${sql('<p onclick="alert(1)"><strong>Safe HTML fixture</strong> <a href="https://example.com/login">https://different.example/login</a></p><script>alert(1)</script><img src="cid:e2e-logo@flaremail.test" alt="inline logo"><img src="https://tracker.example/pixel.png" alt="tracking pixel"><img src="http://insecure.example/pixel.png" alt="insecure pixel">')},
  'Team <team@flaremail.test>',
  ${sql(JSON.stringify([{ name: 'E2E Administrator', email: adminEmail }, { name: 'Observer', email: 'observer@flaremail.test' }]))},
  ${sql(JSON.stringify([{ name: 'Team', email: 'team@flaremail.test' }]))},
  ${sql(JSON.stringify([{ name: 'Support', email: 'support@flaremail.test' }]))},
  'bounce@flaremail.test', ${sql(adminEmail)},
  ${sql(JSON.stringify([{ name: 'authentication-results', value: 'mx.flaremail.test; spf=pass; dkim=pass; dmarc=pass' }]))},
  ${sql(JSON.stringify([{ method: 'spf', result: 'pass' }, { method: 'dkim', result: 'pass' }, { method: 'dmarc', result: 'pass' }]))},
  ${sql(`legacy:${htmlInboxId}`)}, ${sql(userId)}, ${sql(timestamp)}
);
INSERT OR IGNORE INTO workspace_attachments (
  id, user_id, message_id, filename, content_type, size, inline, content_id, r2_key
) VALUES (
  'e2e-html-cid', ${sql(userId)}, ${sql(htmlInboxId)}, 'logo.png', 'image/png',
  ${htmlCidBytes.byteLength}, 1, '<e2e-logo@flaremail.test>', ${sql(htmlCidKey)}
);
${bulkInboxSeed}
INSERT OR IGNORE INTO workspace_messages (
  id, user_id, folder, from_name, from_email, to_name, to_email, subject, preview, body,
  sent_at, labels_json, is_read, is_starred, message_id, thread_key, direction,
  text_body, html_body, cc, dedupe_key, created_at, updated_at
) VALUES (
  'e2e-sent-message', ${sql(userId)}, 'sent', 'E2E Administrator', ${sql(adminEmail)},
  'Recipient', 'recipient@flaremail.test', 'E2E Seeded Sent', 'Seeded sent preview', 'Seeded sent body',
  ${sql(timestamp)}, '[]', 1, 0, '<e2e-sent-message@flaremail.test>', 'legacy:e2e-sent-message',
  'outbound', 'Seeded sent body', '', '', 'legacy:e2e-sent-message', ${sql(timestamp)}, ${sql(timestamp)}
);
${draftSeed}
`;

await run('bunx', [
  'wrangler', 'd1', 'execute', 'flaremail-db', '--local', '--config', 'wrangler.toml', '--persist-to', persistTo,
  '--command', seed
]);

const htmlCidFile = join(persistenceRoot, 'html-cid.png');
await Bun.write(htmlCidFile, htmlCidBytes);
await run('bunx', [
  'wrangler', 'r2', 'object', 'put', `flaremail-bucket-preview/${htmlCidKey}`,
  '--file', htmlCidFile, '--content-type', 'image/png', '--local', '--config', 'wrangler.toml', '--persist-to', persistTo
]);

const worker = Bun.spawn(
  [
    'bunx', 'wrangler', 'dev', '--config', 'wrangler.toml', '--local', '--persist-to', persistTo,
    '--port', port, '--ip', '127.0.0.1', '--show-interactive-dev-session=false',
    '--var', 'APP_ENV:development', '--var', 'ALLOW_FAKE_SERVICES:true', '--var', 'OUTBOUND_PROVIDER:demo',
    '--var', 'OUTBOUND_FROM_EMAIL:e2e@flaremail.test', '--var', 'OUTBOUND_FROM_NAME:FlareMail E2E',
    '--var', `RESEND_WEBHOOK_SECRET:${webhookSecret}`
  ],
  {
    cwd: root,
    env: createLocalWranglerEnvironment(process.env, { logFileName: 'flaremail-e2e-wrangler.log' }),
    stdout: 'inherit',
    stderr: 'inherit'
  }
) as unknown as Child;

const stop = () => worker.kill('SIGTERM');
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
process.on('exit', stop);
await worker.exited;
