export const FLAREMAIL_SCHEMA_VERSION = 35;

export function isSupportedWorkspaceSchemaVersion(version: number | null | undefined): version is number {
  return version === FLAREMAIL_SCHEMA_VERSION;
}
