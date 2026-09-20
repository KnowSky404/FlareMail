export interface OwnerBootstrapSelection {
  userId: string;
  createUser: boolean;
}

export function selectOwnerForBootstrap(input: {
  userIds: string[];
  mappedOwnerId: string | null;
  requestedOwnerId: string | null;
  generatedOwnerId: string;
}): OwnerBootstrapSelection {
  const userIds = [...new Set(input.userIds)];
  const requestedOwnerId = input.requestedOwnerId?.trim() || null;

  if (input.mappedOwnerId) {
    if (!userIds.includes(input.mappedOwnerId)) throw new Error('The configured Owner mapping points to a missing workspace user.');
    if (requestedOwnerId && requestedOwnerId !== input.mappedOwnerId) {
      throw new Error('The Owner is already initialized; changing it requires a separate ownership migration.');
    }
    return { userId: input.mappedOwnerId, createUser: false };
  }

  if (requestedOwnerId) {
    if (userIds.includes(requestedOwnerId)) return { userId: requestedOwnerId, createUser: false };
    if (userIds.length === 0) return { userId: requestedOwnerId, createUser: true };
    throw new Error('FLAREMAIL_OWNER_USER_ID does not identify an existing workspace user.');
  }

  if (userIds.length === 1) return { userId: userIds[0]!, createUser: false };
  if (userIds.length > 1) throw new Error('Multiple historical users exist; set FLAREMAIL_OWNER_USER_ID to choose one explicitly.');
  return { userId: input.generatedOwnerId, createUser: true };
}

export function extractD1Rows(output: string): Array<Record<string, unknown>> {
  const startCandidates = [output.indexOf('['), output.indexOf('{')].filter((index) => index >= 0);
  const start = Math.min(...startCandidates);
  if (!Number.isFinite(start)) throw new Error('Wrangler returned no JSON result.');

  let parsed: unknown;
  try {
    parsed = JSON.parse(output.slice(start));
  } catch {
    throw new Error('Wrangler returned an unreadable JSON result.');
  }

  const rows: Array<Record<string, unknown>> = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.results)) {
      for (const row of record.results) {
        if (row && typeof row === 'object' && !Array.isArray(row)) rows.push(row as Record<string, unknown>);
      }
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(parsed);
  return rows;
}

function sqlText(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

export function buildLocalCredentialResetStatements(input: {
  userId: string;
  username: string;
  credentialHash: string;
  timestamp: string;
}) {
  const userId = sqlText(input.userId);
  const username = sqlText(input.username);
  const credentialHash = sqlText(input.credentialHash);
  const timestamp = sqlText(input.timestamp);
  return [
    `UPDATE workspace_sessions
     SET revoked_at = ${timestamp}, updated_at = ${timestamp}
     WHERE user_id = ${userId} AND auth_method = 'local' AND revoked_at IS NULL;`,
    `INSERT INTO workspace_auth_credentials (user_id, username, credential_hash, updated_at)
     VALUES (${userId}, ${username}, ${credentialHash}, ${timestamp})
     ON CONFLICT(user_id) DO UPDATE SET
       username = excluded.username,
       credential_hash = excluded.credential_hash,
       updated_at = excluded.updated_at;`
  ];
}
