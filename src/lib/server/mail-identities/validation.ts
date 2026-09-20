export type MailIdentityValidationCode =
  | 'domain_invalid'
  | 'zone_id_invalid'
  | 'worker_name_invalid'
  | 'address_invalid'
  | 'address_domain_mismatch'
  | 'address_too_long'
  | 'display_name_too_long'
  | 'signature_too_long';

export class MailIdentityValidationError extends Error {
  constructor(readonly code: MailIdentityValidationCode) {
    super(code);
    this.name = 'MailIdentityValidationError';
  }
}

const isIpLiteral = (value: string) =>
  /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(value) || value.startsWith('[') || value.includes(':');

export function normalizeMailDomain(input: string): string {
  const source = input.trim().replace(/\.$/u, '');
  if (!source || ['\\', '/', '@', '?', '#', ':'].some((character) => source.includes(character)) || /\s/u.test(source)) {
    throw new MailIdentityValidationError('domain_invalid');
  }

  let domain: string;
  try {
    domain = new URL('https://' + source).hostname.toLowerCase().replace(/\.$/u, '');
  } catch {
    throw new MailIdentityValidationError('domain_invalid');
  }
  const labels = domain.split('.');
  if (
    domain.length > 253 ||
    labels.length < 2 ||
    isIpLiteral(domain) ||
    labels.some((label) => label.length < 1 || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label))
  ) throw new MailIdentityValidationError('domain_invalid');
  return domain;
}

export function normalizeCloudflareZoneId(input: string): string {
  const value = input.trim().toLowerCase();
  if (!/^[a-f0-9]{32}$/u.test(value)) throw new MailIdentityValidationError('zone_id_invalid');
  return value;
}

export function normalizeEmailWorkerName(input: string): string {
  const value = input.trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,252}$/iu.test(value)) {
    throw new MailIdentityValidationError('worker_name_invalid');
  }
  return value;
}

export function normalizeManagedAddress(input: string, configuredDomain: string): { email: string; localPart: string } {
  const domain = normalizeMailDomain(configuredDomain);
  const candidate = input.trim().toLowerCase();
  const parts = candidate.split('@');
  let localPart: string;
  if (parts.length === 1) {
    localPart = parts[0] ?? '';
  } else if (parts.length === 2) {
    localPart = parts[0] ?? '';
    if (normalizeMailDomain(parts[1] ?? '') !== domain) {
      throw new MailIdentityValidationError('address_domain_mismatch');
    }
  } else {
    throw new MailIdentityValidationError('address_invalid');
  }

  if (
    localPart.length < 1 ||
    localPart.length > 64 ||
    localPart.startsWith('.') ||
    localPart.endsWith('.') ||
    localPart.includes('..') ||
    !/^[a-z0-9.!#$%&'*+/=?^_{|}~-]+$/u.test(localPart)
  ) throw new MailIdentityValidationError('address_invalid');

  const email = localPart + '@' + domain;
  if (new TextEncoder().encode(email).byteLength > 90) {
    throw new MailIdentityValidationError('address_too_long');
  }
  return { email, localPart };
}

export function normalizeDisplayName(input: string): string {
  const value = input.trim();
  if (value.length > 128 || /[\r\n]/u.test(value)) {
    throw new MailIdentityValidationError('display_name_too_long');
  }
  return value;
}

export function normalizeAddressSignature(input: string): string {
  const value = input.replace(/\r\n?/gu, '\n');
  if (new TextEncoder().encode(value).byteLength > 16 * 1024) {
    throw new MailIdentityValidationError('signature_too_long');
  }
  return value;
}
