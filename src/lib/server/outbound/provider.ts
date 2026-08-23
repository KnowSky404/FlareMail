import type { CloudflareEnv } from '$lib/server/cloudflare';
import {
  FakeOutboundGateway,
  OutboundGatewayError,
  ResendOutboundGateway,
  type OutboundMailGateway
} from './gateway';
import { parseBoolean, resolveOutboundFromEmail } from '$lib/server/config/env';

const timeoutMs = (value: string | undefined) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
};

export function createOutboundGateway(env: CloudflareEnv | undefined): OutboundMailGateway {
  const provider = env?.OUTBOUND_PROVIDER?.trim().toLowerCase();
  if (provider === 'resend') {
    if (!env?.RESEND_API_KEY?.trim()) {
      throw new OutboundGatewayError('configuration', 'Resend API key is not configured.', { retryable: false });
    }
    if (env.APP_ENV === 'production' && !resolveOutboundFromEmail(env)) {
      throw new OutboundGatewayError('configuration', 'Outbound sender is not configured.', { retryable: false });
    }
    return new ResendOutboundGateway({
      apiKey: env?.RESEND_API_KEY,
      apiBaseUrl: env?.RESEND_API_BASE_URL,
      timeoutMs: timeoutMs(env?.RESEND_TIMEOUT_MS)
    });
  }

  const appEnv = env?.APP_ENV ?? 'development';
  if ((provider === 'demo' || provider === 'fake') && (appEnv === 'development' || appEnv === 'test') && parseBoolean(env?.ALLOW_FAKE_SERVICES)) {
    return new FakeOutboundGateway();
  }

  throw new OutboundGatewayError(
    'configuration',
    'Outbound email is unavailable because a supported provider is not configured.',
    { retryable: false }
  );
}

export function outboundProviderName(env: CloudflareEnv | undefined) {
  const provider = env?.OUTBOUND_PROVIDER?.trim().toLowerCase();
  return provider === 'resend' ? 'resend' : provider === 'demo' || provider === 'fake' ? 'fake' : 'unconfigured';
}
