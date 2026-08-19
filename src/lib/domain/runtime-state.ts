export const RUNTIME_ERROR_CODES = [
  'CONFIG_INVALID',
  'AUTHENTICATION_UNAVAILABLE',
  'SCHEMA_NOT_READY',
  'D1_UNAVAILABLE',
  'R2_UNAVAILABLE',
  'NETWORK_FAILURE',
  'INTERNAL_ERROR'
] as const;

export type RuntimeErrorCode = (typeof RUNTIME_ERROR_CODES)[number];

export type RuntimeUnavailableState = {
  state: 'unavailable';
  code: RuntimeErrorCode;
  retryable: boolean;
  requestId: string;
};

export type RuntimeState =
  | { state: 'unauthenticated'; requestId: string }
  | { state: 'ready'; requestId: string }
  | RuntimeUnavailableState;

export function isRuntimeErrorCode(value: string): value is RuntimeErrorCode {
  return (RUNTIME_ERROR_CODES as readonly string[]).includes(value);
}

export function unavailableState(
  code: RuntimeErrorCode,
  retryable: boolean,
  requestId: string
): RuntimeUnavailableState {
  return { state: 'unavailable', code, retryable, requestId };
}
