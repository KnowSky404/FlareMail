import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractD1Rows } from './bootstrap-owner';
import { createLocalWranglerEnvironment, inheritWranglerEnvironment } from './wrangler-environment';
import {
  normalizeCloudflareZoneId,
  normalizeEmailWorkerName,
  normalizeMailDomain
} from '../src/lib/server/mail-identities/validation';

const remote = process.argv.includes('--remote');
const domainName = normalizeMailDomain(process.env.FLAREMAIL_MAIL_DOMAIN_NAME ?? '');
const zoneId = normalizeCloudflareZoneId(process.env.FLAREMAIL_CLOUDFLARE_ZONE_ID ?? '');
const workerName = normalizeEmailWorkerName(process.env.FLAREMAIL_EMAIL_WORKER_NAME ?? '');
const cloudflareAccountId = process.env.FLAREMAIL_CLOUDFLARE_ACCOUNT_ID?.trim() || null;
const policy = process.env.FLAREMAIL_UNKNOWN_RECIPIENT_POLICY?.trim().toLowerCase() || 'reject';
if (policy !== 'reject' && policy !== 'collect') {
  throw new Error('FLAREMAIL_UNKNOWN_RECIPIENT_POLICY must be reject or collect.');
}
if (cloudflareAccountId && !/^[a-f0-9]{32}$/iu.test(cloudflareAccountId)) {
  throw new Error('FLAREMAIL_CLOUDFLARE_ACCOUNT_ID must be a 32-character hexadecimal ID when supplied.');
}

const config = remote ? 'wrangler.deploy.toml' : 'wrangler.toml';
const wranglerEnvironment = remote ? inheritWranglerEnvironment() : createLocalWranglerEnvironment();
const sqlText = (value: string) => "'" + value.replaceAll("'", "''") + "'";

async function executeWrangler(extraArguments: string[]) {
  const child = Bun.spawn([
    'bun', 'x', 'wrangler', 'd1', 'execute', 'flaremail-db',
    remote ? '--remote' : '--local', '--config', config, '--json', ...extraArguments
  ], {
    stdout: 'pipe',
    stderr: 'inherit',
    env: wranglerEnvironment
  });
  const stdout = await new Response(child.stdout).text();
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error('Wrangler D1 ' + (remote ? 'remote' : 'local') + ' command failed (' + exitCode + ').');
  return extractD1Rows(stdout);
}

const ownerRows = await executeWrangler([
  '--command',
  'SELECT user_id FROM workspace_owner WHERE singleton = 1'
]);
const ownerId = ownerRows[0]?.user_id;
if (typeof ownerId !== 'string' || !ownerId) {
  throw new Error('Initialize the stable workspace Owner before configuring a mail domain.');
}

const existingRows = await executeWrangler([
  '--command',
  'SELECT id, owner_user_id, cloudflare_zone_id, cloudflare_account_id, worker_name, unknown_recipient_policy ' +
    'FROM mail_domains WHERE lower(domain_name) = ' + sqlText(domainName)
]);
const existing = existingRows[0];
if (existing) {
  const matches = existing.owner_user_id === ownerId &&
    existing.cloudflare_zone_id === zoneId &&
    (existing.cloudflare_account_id ?? null) === cloudflareAccountId &&
    existing.worker_name === workerName &&
    existing.unknown_recipient_policy === policy;
  if (!matches) throw new Error('This domain already has different routing configuration; use a separate reviewed migration to change it.');
  console.log('The mail domain is already configured in ' + (remote ? 'remote' : 'local') + ' D1.');
  process.exit(0);
}

const timestamp = new Date().toISOString();
const statement = `
  INSERT INTO mail_domains (
    id, owner_user_id, domain_name, cloudflare_zone_id, cloudflare_account_id,
    worker_name, unknown_recipient_policy, created_at, updated_at
  ) VALUES (
    ${sqlText(crypto.randomUUID())}, ${sqlText(ownerId)}, ${sqlText(domainName)}, ${sqlText(zoneId)},
    ${cloudflareAccountId ? sqlText(cloudflareAccountId) : 'NULL'}, ${sqlText(workerName)},
    ${sqlText(policy)}, ${sqlText(timestamp)}, ${sqlText(timestamp)}
  );
`;
const directory = await mkdtemp(join(tmpdir(), 'flaremail-mail-domain-'));
const sqlFile = join(directory, 'configure.sql');
try {
  await writeFile(sqlFile, statement, { mode: 0o600 });
  await chmod(sqlFile, 0o600);
  await executeWrangler(['--file', sqlFile]);
} finally {
  await rm(directory, { recursive: true, force: true });
}

console.log('Configured ' + domainName + ' for the stable Owner in ' + (remote ? 'remote' : 'local') + ' D1.');
console.log('The stored zone and Worker will be used only for this explicit domain. Unknown recipients default to reject.');
