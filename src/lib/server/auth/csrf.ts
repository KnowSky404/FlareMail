export type CsrfMethod = 'GET' | 'HEAD' | 'OPTIONS' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface CsrfCheckOptions {
  /** Webhook handlers must set this only after their provider signature check. */
  webhook?: boolean;
}

export interface CsrfCheckResult {
  ok: boolean;
  reason?: 'safe-method' | 'webhook' | 'missing-origin' | 'invalid-origin' | 'origin-mismatch';
}

function requestOrigin(request: Request): string | null {
  try {
    const parsed = new URL(request.url);
    if (!/^https?:$/u.test(parsed.protocol)) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

/**
 * Require state-changing browser requests to be same-origin with the actual
 * incoming URL. This automatically supports every hostname routed to the
 * Worker without maintaining a separate hostname allowlist.
 */
export function validateCsrfOrigin(request: Request, options: CsrfCheckOptions = {}): CsrfCheckResult {
  const method = request.method.toUpperCase();
  if (SAFE_METHODS.has(method)) return { ok: true, reason: 'safe-method' };
  if (options.webhook) {
    // Webhook callers explicitly skip Origin only after signature verification.
    return { ok: true, reason: 'webhook' };
  }

  const origin = request.headers.get('Origin');
  if (!origin) return { ok: false, reason: 'missing-origin' };
  const expected = requestOrigin(request);
  if (!expected) return { ok: false, reason: 'invalid-origin' };
  try {
    return new URL(origin).origin === expected
      ? { ok: true }
      : { ok: false, reason: 'origin-mismatch' };
  } catch {
    return { ok: false, reason: 'invalid-origin' };
  }
}

export function isValidCsrfOrigin(request: Request, options: CsrfCheckOptions = {}): boolean {
  return validateCsrfOrigin(request, options).ok;
}

export function assertCsrfOrigin(request: Request, options: CsrfCheckOptions = {}): void {
  const result = validateCsrfOrigin(request, options);
  if (!result.ok) throw new Error(`CSRF origin validation failed: ${result.reason ?? 'unknown'}.`);
}

export const checkCsrfOrigin = validateCsrfOrigin;
export const requireSameOrigin = assertCsrfOrigin;
export const validateOrigin = validateCsrfOrigin;
export const assertOrigin = assertCsrfOrigin;
