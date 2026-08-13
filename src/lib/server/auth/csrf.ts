export type CsrfMethod = 'GET' | 'HEAD' | 'OPTIONS' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface CsrfCheckOptions {
  /** The configured public origin, or an environment object containing APP_ORIGIN. */
  appOrigin?: string | { APP_ORIGIN?: unknown };
  /** Webhook handlers must set this only after their provider signature check. */
  webhook?: boolean;
}

export type CsrfOptionsInput = CsrfCheckOptions | string | { APP_ORIGIN?: unknown };

export interface CsrfCheckResult {
  ok: boolean;
  reason?: 'safe-method' | 'webhook' | 'missing-origin' | 'invalid-origin' | 'origin-mismatch';
}

function configuredOrigin(request: Request, appOrigin?: string | { APP_ORIGIN?: unknown }): string | null {
  const configured = typeof appOrigin === 'object' ? appOrigin.APP_ORIGIN : appOrigin;
  const value = typeof configured === 'string' && configured.trim() ? configured.trim() : new URL(request.url).origin;
  try {
    const parsed = new URL(value);
    if (!/^https?:$/u.test(parsed.protocol)) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function normalizeOptions(options: CsrfOptionsInput): CsrfCheckOptions {
  if (typeof options === 'string') return { appOrigin: options };
  if ('APP_ORIGIN' in options && !('appOrigin' in options)) return { appOrigin: options };
  return options as CsrfCheckOptions;
}

/** Check Origin for state-changing browser requests. */
export function validateCsrfOrigin(request: Request, options: CsrfOptionsInput = {}): CsrfCheckResult {
  options = normalizeOptions(options);
  const method = request.method.toUpperCase();
  if (SAFE_METHODS.has(method)) return { ok: true, reason: 'safe-method' };
  if (options.webhook) {
    // Webhook callers explicitly skip Origin only after signature verification.
    return { ok: true, reason: 'webhook' };
  }

  const origin = request.headers.get('Origin');
  if (!origin) return { ok: false, reason: 'missing-origin' };
  const expected = configuredOrigin(request, options.appOrigin);
  if (!expected) return { ok: false, reason: 'invalid-origin' };
  try {
    return new URL(origin).origin === expected
      ? { ok: true }
      : { ok: false, reason: 'origin-mismatch' };
  } catch {
    return { ok: false, reason: 'invalid-origin' };
  }
}

export function isValidCsrfOrigin(request: Request, options: CsrfOptionsInput = {}): boolean {
  return validateCsrfOrigin(request, options).ok;
}

export function assertCsrfOrigin(request: Request, options: CsrfOptionsInput = {}): void {
  const result = validateCsrfOrigin(request, options);
  if (!result.ok) throw new Error(`CSRF origin validation failed: ${result.reason ?? 'unknown'}.`);
}

export const checkCsrfOrigin = validateCsrfOrigin;
export const requireSameOrigin = assertCsrfOrigin;
export const validateOrigin = validateCsrfOrigin;
export const assertOrigin = assertCsrfOrigin;
