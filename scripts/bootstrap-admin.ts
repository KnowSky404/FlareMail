import { hashPassword, PASSWORD_HASH_COST } from '../src/lib/server/auth/password';
import {
  createLocalWranglerEnvironment,
  inheritWranglerEnvironment
} from './wrangler-environment';

const remote = process.argv.includes('--remote');
const email = process.env.FLAREMAIL_ADMIN_EMAIL?.trim().toLowerCase();
const password = process.env.FLAREMAIL_ADMIN_PASSWORD;
const name = process.env.FLAREMAIL_ADMIN_NAME?.trim() || 'FlareMail Administrator';

if (!email || !password) {
  console.error('Set FLAREMAIL_ADMIN_EMAIL and FLAREMAIL_ADMIN_PASSWORD in the current shell.');
  process.exit(1);
}
if (password.length < 12) {
  console.error('FLAREMAIL_ADMIN_PASSWORD must be at least 12 characters.');
  process.exit(1);
}
if (!/^\S+@\S+\.\S+$/u.test(email)) {
  console.error('FLAREMAIL_ADMIN_EMAIL must be a valid email address.');
  process.exit(1);
}

const sqlText = (value: string) => `'${value.replaceAll("'", "''")}'`;
const timestamp = new Date().toISOString();
const credentialHash = await hashPassword(password);
const id = crypto.randomUUID();
const statement = `
  INSERT INTO workspace_users (
    id, login_email, name, role, email, company, location, timezone,
    forwarding_enabled, signature, incoming_sequence, credential_hash,
    credential_iterations, credential_updated_at, created_at, updated_at
  ) VALUES (
    ${sqlText(id)}, ${sqlText(email)}, ${sqlText(name)}, 'Workspace Owner', ${sqlText(email)},
    '', '', 'UTC', 0, '', 0, ${sqlText(credentialHash)}, ${PASSWORD_HASH_COST},
    ${sqlText(timestamp)}, ${sqlText(timestamp)}, ${sqlText(timestamp)}
  )
  ON CONFLICT(login_email) DO UPDATE SET
    credential_hash = excluded.credential_hash,
    credential_iterations = excluded.credential_iterations,
    credential_updated_at = excluded.credential_updated_at,
    updated_at = excluded.updated_at
`;

const config = remote ? 'wrangler.deploy.toml' : 'wrangler.toml';
const child = Bun.spawn([
  'bun', 'x', 'wrangler', 'd1', 'execute', 'flaremail-db', remote ? '--remote' : '--local',
  '--config', config, '--command', statement
], {
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
  env: remote ? inheritWranglerEnvironment() : createLocalWranglerEnvironment()
});
const exitCode = await child.exited;
if (exitCode !== 0) process.exit(exitCode);
console.log(`Administrator credential updated for ${email} (${remote ? 'remote' : 'local'} D1).`);
