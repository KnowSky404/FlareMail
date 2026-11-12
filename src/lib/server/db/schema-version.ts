export const FLAREMAIL_SCHEMA_VERSION = 31;

export function isSupportedWorkspaceSchemaVersion(version: number | null | undefined): version is number {
  // Keep ordinary mail usable while the additive Telegram migration is pending.
  return version === 30 || version === FLAREMAIL_SCHEMA_VERSION;
}
