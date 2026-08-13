import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '../..');
const argument = (name: string, fallback: string) => {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};

const port = argument('--port', '4173');
const persistTo = resolve(argument('--persist-to', '/tmp/flaremail-e2e-state'));
if (!persistTo.startsWith('/tmp/flaremail-e2e-')) {
  throw new Error(`Refusing to clear non-isolated E2E persistence path: ${persistTo}`);
}
const adminEmail = process.env.FLAREMAIL_E2E_EMAIL ?? 'e2e-admin@flaremail.test';
const adminPassword = process.env.FLAREMAIL_E2E_PASSWORD ?? 'FlareMail-E2E-password-2026!';
const userId = 'e2e-admin-user';
const inboxId = 'e2e-inbox-message';
const timestamp = '2026-08-13T08:00:00.000Z';
const webhookSecret = `whsec_${btoa('FlareMail E2E webhook secret 2026')}`;

type Child = { exited: Promise<number>; kill: (signal?: string) => void };

async function run(command: string, args: string[], env?: Record<string, string>) {
  const child = Bun.spawn([command, ...args], {
    cwd: root,
    env: { ...process.env, XDG_CONFIG_HOME: '/tmp', WRANGLER_LOG_PATH: '/tmp/flaremail-e2e-wrangler.log', ...env },
    stdout: 'inherit',
    stderr: 'inherit'
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`${command} ${args.join(' ')} exited with ${exitCode}`);
}

const sql = (value: string) => `'${value.replaceAll("'", "''")}'`;

await rm(persistTo, { recursive: true, force: true });
await run('bun', ['run', 'build']);
await run('bunx', [
  'wrangler', 'd1', 'migrations', 'apply', 'flaremail-db', '--local', '--config', 'wrangler.toml', '--persist-to', persistTo
]);

const { hashPassword, PASSWORD_HASH_ITERATIONS } = await import('../../src/lib/server/auth/password');
const credentialHash = await hashPassword(adminPassword);
const seed = `
INSERT INTO workspace_users (
  id, login_email, name, role, email, company, location, timezone,
  forwarding_enabled, signature, incoming_sequence, credential_hash,
  credential_iterations, credential_updated_at, created_at, updated_at
) VALUES (
  ${sql(userId)}, ${sql(adminEmail)}, 'E2E Administrator', 'Workspace Owner', ${sql(adminEmail)},
  'FlareMail E2E', '', 'UTC', 1, '', 0, ${sql(credentialHash)}, ${PASSWORD_HASH_ITERATIONS},
  ${sql(timestamp)}, ${sql(timestamp)}, ${sql(timestamp)}
);
INSERT INTO workspace_settings (user_id, theme, settings_json, created_at, updated_at)
VALUES (${sql(userId)}, 'system', '{}', ${sql(timestamp)}, ${sql(timestamp)});
INSERT INTO workspace_messages (
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
`;

await run('bunx', [
  'wrangler', 'd1', 'execute', 'flaremail-db', '--local', '--config', 'wrangler.toml', '--persist-to', persistTo,
  '--command', seed
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
    env: { ...process.env, XDG_CONFIG_HOME: '/tmp', WRANGLER_LOG_PATH: '/tmp/flaremail-e2e-wrangler.log' },
    stdout: 'inherit',
    stderr: 'inherit'
  }
) as unknown as Child;

const stop = () => worker.kill('SIGTERM');
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
process.on('exit', stop);
await worker.exited;
