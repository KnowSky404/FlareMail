import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashPassword } from '../src/lib/server/auth/password';
import { isValidLoginUsername, normalizeLoginUsername } from '../src/lib/server/auth/rate-limit';
import { buildLocalCredentialResetStatements, extractD1Rows, selectOwnerForBootstrap } from './bootstrap-owner';
import { createLocalWranglerEnvironment, inheritWranglerEnvironment } from './wrangler-environment';

const remote = process.argv.includes('--remote');
const accessOnly = process.argv.includes('--access-only');
const username = normalizeLoginUsername(process.env.FLAREMAIL_ADMIN_USERNAME ?? '');
const password = process.env.FLAREMAIL_ADMIN_PASSWORD;
const name = process.env.FLAREMAIL_ADMIN_NAME?.trim() || 'FlareMail Owner';
const profileEmail = process.env.FLAREMAIL_PROFILE_EMAIL?.trim().toLowerCase() || '';
const requestedOwnerId = process.env.FLAREMAIL_OWNER_USER_ID?.trim() || null;

if (accessOnly) {
  if (username || password) {
    console.error('Do not set local username or password when using --access-only.');
    process.exit(1);
  }
} else {
  if (!isValidLoginUsername(username) || !password) {
    console.error('Set FLAREMAIL_ADMIN_USERNAME and FLAREMAIL_ADMIN_PASSWORD in the current shell.');
    process.exit(1);
  }
  if (password.length < 12) {
    console.error('FLAREMAIL_ADMIN_PASSWORD must be at least 12 characters.');
    process.exit(1);
  }
}

if (profileEmail && (!/^[^\s@\r\n]+@[^\s@\r\n]+\.[^\s@\r\n]+$/u.test(profileEmail) || profileEmail.length > 254)) {
  console.error('FLAREMAIL_PROFILE_EMAIL must be a valid email address when supplied.');
  process.exit(1);
}
if (!name || name.length > 128) {
  console.error('FLAREMAIL_ADMIN_NAME must contain 1 to 128 characters.');
  process.exit(1);
}

const sqlText = (value: string) => `'${value.replaceAll("'", "''")}'`;
const ownerStateQuery = `
  SELECT 'user' AS kind, id AS value FROM workspace_users
  UNION ALL
  SELECT 'owner' AS kind, user_id AS value FROM workspace_owner WHERE singleton = 1
`;
const config = remote ? 'wrangler.deploy.toml' : 'wrangler.toml';
const wranglerEnvironment = remote ? inheritWranglerEnvironment() : createLocalWranglerEnvironment();

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
  if (exitCode !== 0) throw new Error(`Wrangler D1 ${remote ? 'remote' : 'local'} command failed (${exitCode}).`);
  return stdout;
}

const stateRows = extractD1Rows(await executeWrangler(['--command', ownerStateQuery]));
const userIds = stateRows.filter((row) => row.kind === 'user' && typeof row.value === 'string').map((row) => row.value as string);
const mappedOwnerId = stateRows.find((row) => row.kind === 'owner' && typeof row.value === 'string')?.value as string | undefined;
const selection = selectOwnerForBootstrap({
  userIds,
  mappedOwnerId: mappedOwnerId ?? null,
  requestedOwnerId,
  generatedOwnerId: crypto.randomUUID()
});

const timestamp = new Date().toISOString();
const credentialHash = accessOnly ? null : await hashPassword(password!);
const statements = [
  ...(selection.createUser ? [`
    INSERT INTO workspace_users (
      id, login_email, name, role, email, company, location, timezone,
      forwarding_enabled, signature, incoming_sequence, created_at, updated_at
    ) VALUES (
      ${sqlText(selection.userId)}, NULL, ${sqlText(name)}, 'Workspace Owner', ${sqlText(profileEmail)},
      '', '', 'UTC', 0, '', 0, ${sqlText(timestamp)}, ${sqlText(timestamp)}
    );
  `] : []),
  `INSERT INTO workspace_owner (singleton, user_id) VALUES (1, ${sqlText(selection.userId)})
   ON CONFLICT(singleton) DO NOTHING;`,
  ...(process.env.FLAREMAIL_ADMIN_NAME?.trim() && !selection.createUser ? [`
    UPDATE workspace_users SET name = ${sqlText(name)}, updated_at = ${sqlText(timestamp)}
    WHERE id = ${sqlText(selection.userId)};
  `] : []),
  ...(profileEmail && !selection.createUser ? [`
    UPDATE workspace_users SET email = ${sqlText(profileEmail)}, updated_at = ${sqlText(timestamp)}
    WHERE id = ${sqlText(selection.userId)};
  `] : []),
  ...(!accessOnly ? buildLocalCredentialResetStatements({
    userId: selection.userId,
    username,
    credentialHash: credentialHash!,
    timestamp
  }) : [])
];

const temporaryDirectory = await mkdtemp(join(tmpdir(), 'flaremail-owner-bootstrap-'));
const sqlFile = join(temporaryDirectory, 'bootstrap.sql');
try {
  await writeFile(sqlFile, statements.join('\n'), { mode: 0o600 });
  await chmod(sqlFile, 0o600);
  await executeWrangler(['--file', sqlFile]);
  const verificationRows = extractD1Rows(await executeWrangler([
    '--command', 'SELECT user_id AS owner_id FROM workspace_owner WHERE singleton = 1'
  ]));
  if (verificationRows[0]?.owner_id !== selection.userId) {
    throw new Error('The Owner mapping did not persist as requested; no success was reported.');
  }
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

console.log(`Owner ${selection.userId} is ready for ${accessOnly ? 'Cloudflare Access' : 'local username/password'} in ${remote ? 'remote' : 'local'} D1.`);
if (accessOnly) console.log(`Set ACCESS_OWNER_USER_ID=${selection.userId} in the protected Worker configuration.`);
