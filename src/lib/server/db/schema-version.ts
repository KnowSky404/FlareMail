export const FLAREMAIL_SCHEMA_VERSION = 32;

export function isSupportedWorkspaceSchemaVersion(version: number | null | undefined): version is number {
  return version === FLAREMAIL_SCHEMA_VERSION;
}
