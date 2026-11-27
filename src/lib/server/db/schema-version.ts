export const FLAREMAIL_SCHEMA_VERSION = 43;

export function isSupportedWorkspaceSchemaVersion(version: number | null | undefined): version is number {
  return version === FLAREMAIL_SCHEMA_VERSION;
}

/** Schema 43 only adds optional MCP tables. Deploy this runtime before applying 0043. */
export function isWorkspaceRuntimeSchemaVersion(version: number | null | undefined): version is number {
  return version === 42 || isSupportedWorkspaceSchemaVersion(version);
}
