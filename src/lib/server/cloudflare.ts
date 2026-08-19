/**
 * Wrangler's generated binding/runtime contract is authoritative. These
 * optional fields are deployment-only vars/secrets intentionally absent from
 * the public local wrangler.toml template and are kept as a narrow extension.
 */
declare global {
  interface CloudflareEnv {
    APP_ORIGIN?: string;
    APP_VERSION?: string;
    RESEND_API_KEY?: string;
    RESEND_API_BASE_URL?: string;
    RESEND_TIMEOUT_MS?: string;
    RESEND_WEBHOOK_SECRET?: string;
  }
}

type GeneratedCloudflareEnv = globalThis.CloudflareEnv;
type FlexibleGeneratedCloudflareEnv = {
  [Key in keyof GeneratedCloudflareEnv]?: GeneratedCloudflareEnv[Key] extends string
    ? string
    : GeneratedCloudflareEnv[Key];
};

/** Keep D1/R2 required while allowing isolated tests and secret-only deploy vars. */
export type CloudflareEnv = Omit<FlexibleGeneratedCloudflareEnv, 'DB' | 'BUCKET'> &
  Pick<GeneratedCloudflareEnv, 'DB' | 'BUCKET'>;
