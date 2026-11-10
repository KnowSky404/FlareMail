export const FLAREMAIL_SCHEMA_VERSION = 28;

// Migration 0029 is additive; this bridge keeps schema 28 usable during upgrade and rollback.
export function isSupportedWorkspaceSchemaVersion(version: number | undefined): boolean {
  return version === FLAREMAIL_SCHEMA_VERSION || version === 29;
}
